import { open } from "node:fs/promises";
import type { youtube_v3 } from "@googleapis/youtube";
import { classifyGoogleError, errorFromResponse, YtError } from "../errors.js";

export const UPLOAD_ENDPOINT =
  "https://www.googleapis.com/upload/youtube/v3/videos";

export interface ResumableOptions {
  filePath: string;
  fileSize: number;
  contentType: string;
  /** videos.insert resource body (snippet, status, ...). */
  resource: youtube_v3.Schema$Video;
  parts: string[];
  notifySubscribers: boolean;
  chunkSize: number;
  /** Existing session to resume (from a checkpoint). */
  sessionUri?: string | null;
  getAccessToken: () => Promise<string>;
  invalidateToken: () => void;
  onSession: (uri: string) => void;
  onProgress: (sent: number, total: number) => void;
  /** Called before every chunk; throw to stop (e.g. the job was cancelled or taken over by another process). */
  beforeChunk?: () => void;
  signal?: AbortSignal;
  /** Consecutive failures tolerated before giving up (progress resets the counter). */
  maxRetries?: number;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

/** Parse a `Range: bytes=0-1234` header into the next byte offset. No header means nothing was stored. */
export function nextOffsetFromRange(range: string | null): number {
  if (!range) return 0;
  const m = /bytes=\d+-(\d+)/.exec(range);
  return m ? Number(m[1]) + 1 : 0;
}

class SessionGone extends Error {}

/**
 * YouTube resumable upload with checkpointing: the session URI and byte offset survive restarts,
 * network drops resume from the last stored byte, and quota errors stop immediately.
 */
export async function resumableUpload(
  o: ResumableOptions,
): Promise<youtube_v3.Schema$Video> {
  const f = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? defaultSleep;
  const maxRetries = o.maxRetries ?? 12;
  let failures = 0;

  const auth = async () => `Bearer ${await o.getAccessToken()}`;
  const checkAbort = () => {
    if (o.signal?.aborted) throw new YtError("cancelled", "Upload cancelled.");
  };
  let restarts = 0;
  const backoff = async (e: YtError) => {
    if (!e.retryable && e.code !== "auth_expired") throw e;
    if (e.code === "auth_expired" && e.opts.reason === "invalid_grant") throw e;
    failures++;
    if (failures > maxRetries) throw e;
    const delay =
      Math.min(60_000, 1000 * 2 ** Math.min(failures, 6)) +
      Math.random() * 1000;
    await sleep(delay);
  };

  const startSession = async (): Promise<string> => {
    for (;;) {
      checkAbort();
      const url = `${o.endpoint ?? UPLOAD_ENDPOINT}?uploadType=resumable&part=${encodeURIComponent(o.parts.join(","))}&notifySubscribers=${o.notifySubscribers}`;
      let res: Response;
      try {
        res = await f(url, {
          method: "POST",
          headers: {
            Authorization: await auth(),
            "Content-Type": "application/json; charset=UTF-8",
            "X-Upload-Content-Length": String(o.fileSize),
            "X-Upload-Content-Type": o.contentType,
          },
          body: JSON.stringify(o.resource),
          signal: o.signal,
        });
      } catch (err) {
        checkAbort();
        await backoff(classifyGoogleError(err, "start upload"));
        continue;
      }
      if (res.ok) {
        const loc = res.headers.get("location");
        if (!loc)
          throw new YtError(
            "server_error",
            "YouTube did not return an upload session.",
          );
        o.onSession(loc);
        return loc;
      }
      const e = await errorFromResponse(res, "start upload");
      if (res.status === 401) {
        o.invalidateToken();
        await backoff(e);
        continue;
      }
      if (e.retryable) {
        await backoff(e);
        continue;
      }
      throw e;
    }
  };

  /** Ask YouTube how many bytes it has. Returns the finished video when the upload is already complete. */
  const queryOffset = async (
    uri: string,
  ): Promise<number | youtube_v3.Schema$Video> => {
    for (;;) {
      checkAbort();
      let res: Response;
      try {
        res = await f(uri, {
          method: "PUT",
          headers: {
            Authorization: await auth(),
            "Content-Range": `bytes */${o.fileSize}`,
          },
          body: new Uint8Array(0),
          signal: o.signal,
        });
      } catch (err) {
        checkAbort();
        await backoff(classifyGoogleError(err, "upload status"));
        continue;
      }
      if (res.status === 308)
        return nextOffsetFromRange(res.headers.get("range"));
      if (res.status === 200 || res.status === 201)
        return (await res.json()) as youtube_v3.Schema$Video;
      if (res.status === 404 || res.status === 410) throw new SessionGone();
      const e = await errorFromResponse(res, "upload status");
      if (res.status === 401) {
        o.invalidateToken();
        await backoff(e);
        continue;
      }
      if (e.retryable) {
        await backoff(e);
        continue;
      }
      throw e;
    }
  };

  const fh = await open(o.filePath, "r");
  try {
    let uri = o.sessionUri ?? null;
    let offset = 0;
    if (uri) {
      try {
        const r = await queryOffset(uri);
        if (typeof r !== "number") return r;
        offset = r;
      } catch (e) {
        if (!(e instanceof SessionGone)) throw e;
        uri = null;
      }
    }
    if (!uri) {
      uri = await startSession();
      offset = 0;
    }
    o.onProgress(offset, o.fileSize);

    const buf = Buffer.allocUnsafe(
      Math.min(o.chunkSize, Math.max(o.fileSize, 1)),
    );
    for (;;) {
      checkAbort();
      o.beforeChunk?.();
      const len = Math.min(o.chunkSize, o.fileSize - offset);
      const { bytesRead } = await fh.read(buf, 0, len, offset);
      if (bytesRead !== len)
        throw new YtError(
          "file_error",
          "The video file changed or shrank while uploading.",
        );
      const end = offset + len - 1;
      let res: Response;
      try {
        res = await f(uri, {
          method: "PUT",
          headers: {
            Authorization: await auth(),
            "Content-Range":
              len > 0
                ? `bytes ${offset}-${end}/${o.fileSize}`
                : `bytes */${o.fileSize}`,
          },
          body: buf.subarray(0, len),
          signal: o.signal,
        });
      } catch (err) {
        checkAbort();
        await backoff(classifyGoogleError(err, "upload chunk"));
        const r = await requery();
        if (typeof r !== "number") return r;
        offset = r;
        continue;
      }
      if (res.status === 308) {
        const next = nextOffsetFromRange(res.headers.get("range"));
        if (next > offset) failures = 0;
        else await backoff(new YtError("server_error", "YouTube accepted a chunk but stored no new bytes.", { retryable: true }));
        offset = next;
        o.onProgress(offset, o.fileSize);
        continue;
      }
      if (res.status === 200 || res.status === 201) {
        o.onProgress(o.fileSize, o.fileSize);
        return (await res.json()) as youtube_v3.Schema$Video;
      }
      if (res.status === 404 || res.status === 410) {
        // Session expired (they last about a week): start over, but never loop.
        if (++restarts > 3) throw new YtError("server_error", "YouTube kept discarding the upload session.", { retryable: true });
        uri = await startSession();
        offset = 0;
        o.onProgress(0, o.fileSize);
        continue;
      }
      const e = await errorFromResponse(res, "upload chunk");
      if (res.status === 401) o.invalidateToken();
      if (res.status === 401 || e.retryable) {
        await backoff(e);
        const r = await requery();
        if (typeof r !== "number") return r;
        offset = r;
        continue;
      }
      throw e;
    }

    async function requery(): Promise<number | youtube_v3.Schema$Video> {
      try {
        return await queryOffset(uri!);
      } catch (e) {
        if (!(e instanceof SessionGone)) throw e;
        if (++restarts > 3) throw new YtError("server_error", "YouTube kept discarding the upload session.", { retryable: true });
        uri = await startSession();
        return 0;
      }
    }
  } finally {
    await fh.close();
  }
}
