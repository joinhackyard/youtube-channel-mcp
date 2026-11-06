import { EventEmitter } from "node:events";
import { mkdirSync, unlinkSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { youtube_v3 } from "@googleapis/youtube";
import type { Channels } from "../channels.js";
import type { Config } from "../config.js";
import { newId } from "../crypto.js";
import type { Db } from "../db.js";
import { classifyGoogleError, YtError, type ErrorCode } from "../errors.js";
import { summariseVideo, type Privacy } from "../google/youtube.js";
import { log } from "../log.js";
import { nextReset, type Quota } from "../quota.js";
import {
  addToPlaylist,
  resolvePlaylists,
  setThumbnail,
  uploadCaptions,
  type CaptionInput,
} from "../videoOps.js";
import { resumableUpload } from "./resumable.js";
import { downloadUrl, inspectVideoFile, videoContentType } from "./sources.js";

export type JobStatus =
  | "queued"
  | "downloading"
  | "uploading"
  | "finishing"
  | "done"
  | "failed"
  | "stopped"
  | "cancelled";
const ACTIVE: JobStatus[] = ["downloading", "uploading", "finishing"];

export interface UploadMetadata {
  resource: youtube_v3.Schema$Video;
  notify_subscribers: boolean;
  requested_privacy: Privacy;
  publish_at?: string;
  template?: string;
  warnings: string[];
}

export interface PostSteps {
  thumbnail_path?: string;
  playlists?: string[];
  create_missing_playlists?: boolean;
  captions?: CaptionInput;
}

export interface JobRow {
  id: string;
  channel_row_id: string;
  status: JobStatus;
  source_kind: "file" | "url";
  source_ref: string;
  file_path: string | null;
  file_size: number | null;
  file_mtime: number | null;
  content_type: string | null;
  metadata: string;
  post_steps: string;
  session_uri: string | null;
  bytes_sent: number;
  upload_charged: number;
  video_id: string | null;
  error: string | null;
  error_code: ErrorCode | null;
  attempts: number;
  lease_owner: string | null;
  lease_until: number | null;
  result: string | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
}

export interface ProgressEvent {
  status: JobStatus;
  sent: number;
  total: number;
}

/** Errors that stop a job but leave it resumable (session URI and byte offset are kept). */
const RESUMABLE: ErrorCode[] = [
  "quota_exceeded",
  "upload_limit_exceeded",
  "auth_expired",
  "network",
  "server_error",
  "rate_limited",
  "not_connected",
];

const LEASE_MS = 60_000;

/**
 * Persistent upload queue. Jobs live in SQLite, so an upload survives the MCP client closing:
 * the next server process (any client) picks it up from the last confirmed byte.
 * Leases make it safe for several MCP clients to run the server against the same data folder.
 */
export class JobManager extends EventEmitter {
  private readonly owner = `${process.pid}-${newId()}`;
  private readonly running = new Map<string, AbortController>();
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private readonly downloadsDir: string;

  constructor(
    private readonly db: Db,
    private readonly cfg: Config,
    private readonly channels: Channels,
    private readonly quota: Quota,
    private readonly concurrency = 1,
  ) {
    super();
    this.setMaxListeners(100);
    this.downloadsDir = join(cfg.home, "downloads");
  }

  start() {
    this.stopped = false;
    this.tick();
    this.timer = setInterval(() => {
      this.heartbeat();
      this.tick();
    }, 5_000);
    this.timer.unref();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const c of this.running.values()) c.abort();
  }

  create(input: {
    channelRowId: string;
    source:
      | {
          kind: "file";
          path: string;
          size: number;
          mtimeMs: number;
          contentType: string;
        }
      | { kind: "url"; url: string };
    metadata: UploadMetadata;
    post: PostSteps;
  }): JobRow {
    const id = `up_${newId()}`;
    const t = Date.now();
    const s = input.source;
    this.db.run(
      `insert into jobs(id, channel_row_id, status, source_kind, source_ref, file_path, file_size, file_mtime, content_type,
         metadata, post_steps, created_at, updated_at) values (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.channelRowId,
      s.kind,
      s.kind === "file" ? s.path : s.url,
      s.kind === "file" ? s.path : null,
      s.kind === "file" ? s.size : null,
      s.kind === "file" ? s.mtimeMs : null,
      s.kind === "file" ? s.contentType : null,
      JSON.stringify(input.metadata),
      JSON.stringify(input.post),
      t,
      t,
    );
    this.db.audit("upload.queued", {
      job: id,
      title: input.metadata.resource.snippet?.title,
      privacy: input.metadata.requested_privacy,
    });
    setImmediate(() => this.tick());
    return this.get(id)!;
  }

  get(id: string): JobRow | undefined {
    return this.db.get<JobRow>("select * from jobs where id = ?", id);
  }

  list(limit = 20, status?: string): JobRow[] {
    return status
      ? this.db.all<JobRow>(
          "select * from jobs where status = ? order by created_at desc limit ?",
          status,
          limit,
        )
      : this.db.all<JobRow>(
          "select * from jobs order by created_at desc limit ?",
          limit,
        );
  }

  cancel(id: string): JobRow {
    const job = this.mustGet(id);
    if (job.status === "done")
      throw new YtError(
        "invalid_request",
        "This upload already finished; use delete_video to remove the video.",
      );
    this.running.get(id)?.abort();
    this.db.run(
      `update jobs set status = 'cancelled', lease_owner = null, updated_at = ?, finished_at = ?,
         file_path = case when source_kind = 'url' then null else file_path end where id = ?`,
      Date.now(),
      Date.now(),
      id,
    );
    this.cleanupDownload(job);
    this.emitProgress(id);
    return this.get(id)!;
  }

  resume(id: string): JobRow {
    const job = this.mustGet(id);
    if (!["stopped", "failed", "cancelled"].includes(job.status)) {
      throw new YtError(
        "invalid_request",
        `Upload is ${job.status}; only stopped, failed or cancelled uploads can be resumed.`,
      );
    }
    this.db.run(
      "update jobs set status = 'queued', error = null, error_code = null, lease_owner = null, attempts = 0, updated_at = ? where id = ?",
      Date.now(),
      id,
    );
    setImmediate(() => this.tick());
    return this.get(id)!;
  }

  /** After a channel is reconnected, re-queue uploads that stopped because its sign-in expired. */
  requeueForChannel(channelRowId: string) {
    const n = this.db.run(
      "update jobs set status = 'queued', error = null, error_code = null, updated_at = ? where channel_row_id = ? and status = 'stopped' and error_code in ('auth_expired', 'not_connected')",
      Date.now(),
      channelRowId,
    ).changes;
    if (n) setImmediate(() => this.tick());
    return n;
  }

  /** Resolve when the job changes status or finishes, or after `ms`. Reports byte progress meanwhile. */
  async waitFor(
    id: string,
    ms: number,
    onProgress?: (e: ProgressEvent) => void,
  ): Promise<JobRow> {
    const start = this.get(id);
    if (!start || ms <= 0 || !this.isActiveOrQueued(start.status))
      return this.mustGet(id);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        clearInterval(poll);
        this.off(`progress:${id}`, listener);
        resolve(this.mustGet(id));
      };
      const listener = (e: ProgressEvent) => {
        onProgress?.(e);
        if (!this.isActiveOrQueued(e.status)) done();
      };
      // Another process may own the job: poll the database too.
      const poll = setInterval(() => {
        const j = this.get(id);
        if (!j) return done();
        onProgress?.({
          status: j.status,
          sent: j.bytes_sent,
          total: j.file_size ?? 0,
        });
        if (!this.isActiveOrQueued(j.status)) done();
      }, 3_000);
      const timer = setTimeout(done, ms);
      this.on(`progress:${id}`, listener);
    });
  }

  private isActiveOrQueued(s: JobStatus) {
    return s === "queued" || ACTIVE.includes(s);
  }

  private mustGet(id: string): JobRow {
    const j = this.get(id);
    if (!j)
      throw new YtError("not_found", `No upload job ${id}.`, {
        hint: "list_uploads shows recent jobs.",
      });
    return j;
  }

  private emitProgress(id: string) {
    const j = this.get(id);
    if (j)
      this.emit(`progress:${id}`, {
        status: j.status,
        sent: j.bytes_sent,
        total: j.file_size ?? 0,
      } satisfies ProgressEvent);
  }

  /**
   * Renew leases. If another process took the job over (our lease expired, e.g. after the laptop slept)
   * or it was cancelled elsewhere, stop the local run so two processes never upload the same job.
   */
  private heartbeat() {
    for (const [id, ctl] of this.running) {
      const n = this.db.run(
        "update jobs set lease_until = ? where id = ? and lease_owner = ? and status in ('downloading', 'uploading', 'finishing')",
        Date.now() + LEASE_MS,
        id,
        this.owner,
      ).changes;
      if (n === 0 && !ctl.signal.aborted) {
        log.warn("upload lease lost or job cancelled elsewhere; stopping local run", { job: id });
        ctl.abort();
      }
    }
  }

  /** Throw if this process no longer owns the job. Checked before every side effect after the upload. */
  private assertOwned(id: string, signal: AbortSignal) {
    const j = this.get(id);
    if (signal.aborted || !j || j.lease_owner !== this.owner || !ACTIVE.includes(j.status)) {
      this.running.get(id)?.abort();
      throw new YtError("cancelled", "This process no longer owns the upload.");
    }
  }

  /** Claim queued jobs, or active jobs whose owner process died (expired lease). */
  private claim(): JobRow | undefined {
    return this.db.tx(() => {
      const t = Date.now();
      const lastReset = nextReset().getTime() - 24 * 3600_000;
      const row = this.db.get<JobRow>(
        `select * from jobs where status = 'queued'
            or (status in ('downloading', 'uploading', 'finishing') and (lease_until is null or lease_until < ?))
            or (status = 'stopped' and error_code in ('network', 'server_error', 'rate_limited') and updated_at < ? and attempts < 20)
            or (status = 'stopped' and error_code in ('quota_exceeded', 'upload_limit_exceeded') and updated_at < ?)
         order by created_at limit 1`,
        t,
        t - 5 * 60_000,
        lastReset,
      );
      if (!row) return undefined;
      this.db.run(
        `update jobs set lease_owner = ?, lease_until = ?, attempts = attempts + 1, updated_at = ?,
           status = case when status in ('queued', 'stopped') then 'uploading' else status end, error = null, error_code = null where id = ?`,
        this.owner,
        Date.now() + LEASE_MS,
        Date.now(),
        row.id,
      );
      return this.get(row.id);
    });
  }

  private tick() {
    if (this.stopped) return;
    while (this.running.size < this.concurrency) {
      let job: JobRow | undefined;
      try {
        job = this.claim();
      } catch (e) {
        log.warn("job claim failed", { error: String(e) });
        return;
      }
      if (!job) return;
      const ctl = new AbortController();
      this.running.set(job.id, ctl);
      void this.run(job, ctl.signal).finally(() => {
        this.running.delete(job!.id);
        setImmediate(() => this.tick());
      });
    }
  }

  private update(
    id: string,
    fields: Partial<Record<keyof JobRow, string | number | null>>,
  ) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    const n = this.db.run(
      `update jobs set ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? where id = ? and lease_owner = ?`,
      ...keys.map((k) => fields[k as keyof JobRow] as string | number | null),
      Date.now(),
      id,
      this.owner,
    ).changes;
    if (n === 0) this.running.get(id)?.abort();
    this.emitProgress(id);
  }

  private async run(job: JobRow, signal: AbortSignal) {
    const meta = JSON.parse(job.metadata) as UploadMetadata;
    const post = JSON.parse(job.post_steps) as PostSteps;
    try {
      const row = this.channels.byRowId(job.channel_row_id);
      if (!row)
        throw new YtError(
          "not_connected",
          "The channel for this upload is no longer connected.",
          { hint: "Reconnect it, then resume_upload." },
        );
      if (row.status === "needs_reconnect")
        throw new YtError(
          "auth_expired",
          `The Google sign-in for "${row.title}" expired.`,
          {
            hint: "Call connect_channel; the upload resumes on its own afterwards.",
          },
        );
      const api = await this.channels.api(row);

      let video: youtube_v3.Schema$Video | undefined;
      if (!job.video_id) {
        // 1. Make sure we have a local file.
        if (job.source_kind === "url" && !job.file_path) {
          this.update(job.id, { status: "downloading" });
          mkdirSync(this.downloadsDir, { recursive: true });
          const dest = join(this.downloadsDir, `${job.id}.video`);
          let lastWrite = 0;
          const d = await downloadUrl(
            job.source_ref,
            dest,
            this.cfg.maxUploadBytes,
            (got, total) => {
              if (Date.now() - lastWrite > 2000) {
                lastWrite = Date.now();
                this.update(job.id, { bytes_sent: got, file_size: total });
              }
            },
            signal,
          );
          const s = await stat(dest);
          const ct = d.contentType?.startsWith("video/")
            ? d.contentType
            : videoContentType(d.filename);
          this.update(job.id, {
            file_path: dest,
            file_size: s.size,
            file_mtime: Math.floor(s.mtimeMs),
            content_type: ct,
            bytes_sent: 0,
            status: "uploading",
          });
          job = this.get(job.id)!;
        }
        const f = await inspectVideoFile(
          job.file_path!,
          this.cfg.maxUploadBytes,
        );
        if (
          job.file_size !== f.size ||
          (job.file_mtime && Math.abs(job.file_mtime - f.mtimeMs) > 1000)
        ) {
          if (job.session_uri)
            throw new YtError(
              "file_error",
              "The video file changed since the upload started.",
              { hint: "Start a new upload_video for the new file." },
            );
          this.update(job.id, { file_size: f.size, file_mtime: f.mtimeMs });
          job = this.get(job.id)!;
        }

        // 2. Resumable upload.
        if (!job.upload_charged) this.quota.assertAvailable("uploads");
        this.update(job.id, { status: "uploading" });
        let lastWrite = 0;
        video = await resumableUpload({
          filePath: f.path,
          fileSize: f.size,
          contentType: job.content_type ?? f.contentType,
          resource: meta.resource,
          parts: Object.keys(meta.resource).filter((k) => k !== "id"),
          notifySubscribers: meta.notify_subscribers,
          chunkSize: this.cfg.chunkSize,
          sessionUri: job.session_uri,
          getAccessToken: () => api.accessToken(),
          invalidateToken: () => api.invalidateAccessToken(),
          signal,
          beforeChunk: () => this.assertOwned(job.id, signal),
          onSession: (uri) => {
            if (!this.get(job.id)?.upload_charged) {
              this.quota.chargeUpload();
              this.update(job.id, { session_uri: uri, upload_charged: 1 });
            } else this.update(job.id, { session_uri: uri });
          },
          onProgress: (sent) => {
            if (Date.now() - lastWrite > 1500 || sent === f.size) {
              lastWrite = Date.now();
              this.update(job.id, { bytes_sent: sent });
            }
          },
        });
        if (!video.id)
          throw new YtError(
            "server_error",
            "YouTube finished the upload but returned no video id.",
          );
        this.update(job.id, {
          video_id: video.id,
          status: "finishing",
          bytes_sent: f.size,
        });
        this.db.audit(
          "upload.completed",
          { job: job.id },
          row.channel_id,
          video.id,
        );
      }

      // 3. Post-upload steps. Each is independent: one failing does not undo the upload.
      // Completed steps are saved as they finish, so a re-claimed job never adds playlist items or captions twice.
      const videoId = job.video_id ?? video!.id!;
      const prev = job.result ? ((JSON.parse(job.result) as { steps?: Record<string, { ok?: boolean }> }).steps ?? {}) : {};
      const steps: Record<string, unknown> = { ...prev };
      const step = async (name: string, wanted: unknown, fn: () => Promise<Record<string, unknown>>) => {
        if (!wanted || prev[name]?.ok) return;
        this.assertOwned(job.id, signal);
        try {
          steps[name] = { ok: true, ...(await fn()) };
        } catch (e) {
          steps[name] = stepError(e);
        }
        this.update(job.id, { result: JSON.stringify({ steps }) });
      };
      await step("thumbnail", post.thumbnail_path, () => setThumbnail(api, videoId, post.thumbnail_path!));
      await step("playlists", post.playlists?.length, async () => {
        const r = await resolvePlaylists(api, post.playlists!, post.create_missing_playlists ?? true);
        const added = [];
        for (const pid of r.ids) added.push(await addToPlaylist(api, pid, videoId));
        return { added, created: r.created, missing: r.missing };
      });
      await step("captions", post.captions, () => uploadCaptions(api, videoId, post.captions!));
      this.assertOwned(job.id, signal);

      // 4. Final state, including the "unaudited project forces private" check.
      const warnings = [...meta.warnings];
      let summary: ReturnType<typeof summariseVideo> | undefined;
      try {
        const v = await api.getVideo(videoId, [
          "snippet",
          "status",
          "processingDetails",
        ]);
        summary = summariseVideo(v);
        const lock = privateLockWarning(meta, v);
        if (lock) {
          warnings.push(lock);
          this.db.setSetting("private_lock_observed", new Date().toISOString());
        }
      } catch (e) {
        warnings.push(
          `Could not read the video back yet: ${(e as Error).message}`,
        );
      }
      this.update(job.id, {
        status: "done",
        finished_at: Date.now(),
        error: null,
        error_code: null,
        result: JSON.stringify({
          video: summary ?? { id: videoId, url: `https://youtu.be/${videoId}` },
          steps,
          warnings,
        }),
      });
      this.cleanupDownload(job);
      log.info("upload done", { job: job.id, video: videoId });
    } catch (err) {
      const e =
        err instanceof YtError ? err : classifyGoogleError(err, "upload");
      if (e.code === "cancelled" || signal.aborted) {
        log.info("upload cancelled", { job: job.id });
        return;
      }
      if (e.code === "quota_exceeded") this.quota.markExhausted("units");
      if (e.code === "upload_limit_exceeded") this.quota.markExhausted("uploads");
      const status: JobStatus = RESUMABLE.includes(e.code)
        ? "stopped"
        : "failed";
      this.update(job.id, {
        status,
        error: e.hint ? `${e.message} ${e.hint}` : e.message,
        error_code: e.code,
        lease_owner: null,
        finished_at: status === "failed" ? Date.now() : null,
      });
      if (status === "failed") this.cleanupDownload(job);
      log.warn("upload stopped", {
        job: job.id,
        code: e.code,
        error: e.message,
      });
    }
  }

  private cleanupDownload(job: JobRow) {
    if (
      job.source_kind === "url" &&
      job.file_path?.startsWith(this.downloadsDir)
    ) {
      try {
        unlinkSync(job.file_path);
      } catch {
        /* already gone */
      }
    }
  }
}

function stepError(e: unknown) {
  const y = e instanceof YtError ? e : classifyGoogleError(e);
  return { ok: false, code: y.code, error: y.message, hint: y.hint };
}

/** Unaudited API projects (created after July 2020) have every upload locked to private. */
export function privateLockWarning(
  meta: UploadMetadata,
  v: youtube_v3.Schema$Video,
): string | null {
  const actual = v.status?.privacyStatus;
  const wanted = meta.requested_privacy;
  if (meta.publish_at) {
    if (!v.status?.publishAt) {
      return "YouTube did not keep the scheduled publish time. This usually means the Google Cloud project has not passed the YouTube API audit, so uploads are locked to private.";
    }
    return null;
  }
  if (wanted !== "private" && actual === "private") {
    return `You asked for ${wanted}, but YouTube kept the video private. Projects that have not passed the YouTube API compliance audit have uploads locked to private. Apply at https://support.google.com/youtube/contact/yt_api_form, or publish it manually in YouTube Studio.`;
  }
  return null;
}

export function describeJob(j: JobRow) {
  const meta = JSON.parse(j.metadata) as UploadMetadata;
  const pct = j.file_size
    ? Math.min(100, Math.round((j.bytes_sent / j.file_size) * 1000) / 10)
    : null;
  return {
    job_id: j.id,
    status: j.status,
    title: meta.resource.snippet?.title,
    requested_privacy: meta.requested_privacy,
    publish_at: meta.publish_at,
    source: j.source_ref,
    progress: j.status === "done" ? 100 : pct,
    bytes_sent: j.bytes_sent,
    bytes_total: j.file_size,
    video_id: j.video_id ?? undefined,
    url: j.video_id ? `https://youtu.be/${j.video_id}` : undefined,
    resumable:
      j.status === "stopped" ||
      j.status === "cancelled" ||
      (j.status === "failed" && Boolean(j.session_uri) && j.error_code !== "file_error"),
    error: j.error ?? undefined,
    error_code: j.error_code ?? undefined,
    result: j.result ? (JSON.parse(j.result) as unknown) : undefined,
    created_at: new Date(j.created_at).toISOString(),
    updated_at: new Date(j.updated_at).toISOString(),
  };
}
