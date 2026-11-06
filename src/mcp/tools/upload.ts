import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { youtube_v3 } from "@googleapis/youtube";
import { z } from "zod";
import type { App } from "../../app.js";
import { checkChapters } from "../../ai/brief.js";
import { YtError } from "../../errors.js";
import { PRIVACY, summariseVideo } from "../../google/youtube.js";
import { applyTemplate } from "../../templates.js";
import {
  describeJob,
  privateLockWarning,
  type UploadMetadata,
} from "../../upload/jobs.js";
import {
  expandPath,
  inspectThumbnail,
  inspectVideoFile,
} from "../../upload/sources.js";
import {
  channelArg,
  confirmArg,
  confirmGate,
  ok,
  progressReporter,
  safe,
} from "../helpers.js";

const fmtBytes = (n: number) =>
  n > 1024 ** 3
    ? `${(n / 1024 ** 3).toFixed(2)} GB`
    : `${(n / 1024 ** 2).toFixed(1)} MB`;

export const metadataShape = {
  title: z
    .string()
    .min(1)
    .max(100)
    .describe("Video title (max 100 characters; about 70 show on mobile)."),
  description: z
    .string()
    .max(5000)
    .optional()
    .describe(
      "Description. Template header/footer/hashtags are added automatically.",
    ),
  tags: z
    .array(z.string())
    .optional()
    .describe("Tags (total under 500 characters)."),
  category_id: z
    .string()
    .optional()
    .describe(
      "YouTube category id, e.g. 22 People & Blogs, 27 Education, 28 Science & Technology. See list_categories.",
    ),
  default_language: z
    .string()
    .optional()
    .describe('Language of title/description, e.g. "en".'),
  default_audio_language: z
    .string()
    .optional()
    .describe('Spoken language, e.g. "en", "hi".'),
  made_for_kids: z
    .boolean()
    .optional()
    .describe(
      "COPPA: is this video made for kids? Defaults to false (or the template value).",
    ),
  contains_synthetic_media: z
    .boolean()
    .optional()
    .describe(
      "Altered or synthetic content disclosure: true if realistic content was made or altered with AI.",
    ),
  license: z.enum(["youtube", "creativeCommon"]).optional(),
  embeddable: z.boolean().optional(),
  template: z
    .string()
    .optional()
    .describe(
      "Template name from list_templates (adds title format, footer, tags, hashtags, playlists).",
    ),
};

function publishAtCheck(publishAt?: string) {
  if (!publishAt) return undefined;
  const t = Date.parse(publishAt);
  if (Number.isNaN(t))
    throw new YtError(
      "invalid_request",
      `publish_at "${publishAt}" is not a valid ISO 8601 date-time.`,
    );
  if (t < Date.now() + 60_000)
    throw new YtError("invalid_request", "publish_at must be in the future.");
  return new Date(t).toISOString();
}

export function registerUploadTools(server: McpServer, app: App) {
  server.registerTool(
    "upload_video",
    {
      title: "Upload a video",
      description: [
        "Upload a video file from this computer (file_path) or a public URL to YouTube with a resumable, checkpointed upload that survives network drops and restarts.",
        "Optionally schedule it (publish_at), set a thumbnail, add it to playlists and attach captions in the same call.",
        "Runs in the background: returns a job_id right away (or the finished video if it completes within wait_seconds). Poll get_upload_status.",
        "Private uploads start immediately; public, unlisted and scheduled uploads need the user’s confirmation first.",
        "Tip: write metadata first (generate_metadata, then preview_metadata).",
      ].join(" "),
      inputSchema: {
        file_path: z
          .string()
          .optional()
          .describe(
            "Absolute path to the video on this computer, e.g. ~/Videos/recap.mp4.",
          ),
        url: z
          .string()
          .url()
          .optional()
          .describe(
            "Public http(s) URL to download the video from instead of a file.",
          ),
        ...metadataShape,
        privacy: z
          .enum(PRIVACY)
          .default("private")
          .describe("private (default), unlisted or public."),
        publish_at: z
          .string()
          .optional()
          .describe(
            "Schedule: ISO 8601 date-time when the video goes public. Uploads as private until then.",
          ),
        notify_subscribers: z.boolean().default(true),
        recording_date: z
          .string()
          .optional()
          .describe("ISO date the video was recorded."),
        thumbnail_path: z
          .string()
          .optional()
          .describe(
            "JPG/PNG up to 2 MB to set as the custom thumbnail after upload.",
          ),
        playlists: z
          .array(z.string())
          .optional()
          .describe("Playlist ids or exact names to add the video to."),
        create_missing_playlists: z
          .boolean()
          .default(true)
          .describe(
            "Create (private) playlists named in `playlists` that do not exist yet.",
          ),
        captions_path: z
          .string()
          .optional()
          .describe(".srt or .vtt captions file to attach."),
        captions_language: z
          .string()
          .optional()
          .describe(
            'Captions language, e.g. "en". Defaults to default_audio_language or "en".',
          ),
        channel: channelArg,
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(110)
          .default(20)
          .describe(
            "Wait this long for the upload before returning the job status.",
          ),
        confirmation_token: confirmArg,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    safe(async (args, extra) => {
      if (!args.file_path === !args.url)
        throw new YtError(
          "invalid_request",
          "Provide exactly one of file_path or url.",
        );
      const row = app.channels.resolve(args.channel);
      const template = args.template
        ? app.templates.get(args.template)
        : undefined;
      const meta = applyTemplate(args, template);
      const publishAt = publishAtCheck(args.publish_at);
      const warnings = [...meta.warnings, ...checkChapters(meta.description)];

      const file = args.file_path
        ? await inspectVideoFile(args.file_path, app.cfg.maxUploadBytes)
        : undefined;
      if (args.thumbnail_path) await inspectThumbnail(args.thumbnail_path);
      if (args.captions_path && !existsSync(expandPath(args.captions_path))) {
        throw new YtError("file_error", `Captions file not found: ${expandPath(args.captions_path)}`);
      }
      app.quota.assertAvailable("uploads");

      const resource: youtube_v3.Schema$Video = {
        snippet: {
          title: meta.title,
          description: meta.description,
          tags: meta.tags.length ? meta.tags : undefined,
          categoryId: meta.category_id,
          defaultLanguage: meta.default_language,
          defaultAudioLanguage: meta.default_audio_language,
        },
        status: {
          privacyStatus: publishAt ? "private" : args.privacy,
          publishAt,
          selfDeclaredMadeForKids: meta.made_for_kids,
          license: meta.license,
          embeddable: meta.embeddable,
          containsSyntheticMedia: args.contains_synthetic_media,
        },
      };
      if (args.recording_date)
        resource.recordingDetails = {
          recordingDate: new Date(args.recording_date).toISOString(),
        };
      const requested = publishAt ? "public" : args.privacy;

      const playlists = [
        ...new Set([...(args.playlists ?? []), ...meta.playlists]),
      ];
      const summary = [
        `Upload to YouTube channel "${row.title}" as ${publishAt ? `SCHEDULED, going public at ${publishAt}` : requested.toUpperCase()}:`,
        `Title: ${meta.title}`,
        `Source: ${file ? `${file.path} (${fmtBytes(file.size)})` : args.url}`,
        meta.template ? `Template: ${meta.template}` : "",
        playlists.length ? `Playlists: ${playlists.join(", ")}` : "",
        args.thumbnail_path
          ? `Thumbnail: ${expandPath(args.thumbnail_path)}`
          : "",
        `Made for kids: ${meta.made_for_kids ? "yes" : "no"}${args.notify_subscribers === false ? " · subscribers not notified" : ""}`,
      ]
        .filter(Boolean)
        .join("\n");
      const gate = await confirmGate(
        app,
        server,
        "upload_video",
        args,
        summary,
        { publicFacing: requested !== "private" },
      );
      if (gate) return gate;

      const metadata: UploadMetadata = {
        resource,
        notify_subscribers: args.notify_subscribers,
        requested_privacy: requested,
        publish_at: publishAt,
        template: meta.template,
        warnings,
      };
      const job = app.jobs.create({
        channelRowId: row.id,
        source: file
          ? {
              kind: "file",
              path: file.path,
              size: file.size,
              mtimeMs: file.mtimeMs,
              contentType: file.contentType,
            }
          : { kind: "url", url: args.url! },
        metadata,
        post: {
          thumbnail_path: args.thumbnail_path
            ? expandPath(args.thumbnail_path)
            : undefined,
          playlists,
          create_missing_playlists: args.create_missing_playlists,
          captions: args.captions_path
            ? {
                file_path: expandPath(args.captions_path),
                language:
                  args.captions_language ?? meta.default_audio_language ?? "en",
              }
            : undefined,
        },
      });
      const after = await app.jobs.waitFor(
        job.id,
        args.wait_seconds * 1000,
        progressReporter(extra),
      );
      const d = describeJob(after);
      const note =
        after.status === "done"
          ? `Uploaded: ${d.url}`
          : after.status === "failed" || after.status === "stopped"
            ? `Upload ${after.status}: ${after.error}`
            : `Upload running in the background (${d.progress ?? 0}%). Call get_upload_status with job_id "${job.id}" to follow it; it keeps going while this MCP server runs and resumes from the last byte if interrupted.`;
      return ok(d, note);
    }),
  );

  server.registerTool(
    "get_upload_status",
    {
      title: "Upload and processing status",
      description:
        'Status of an upload job (progress, errors, resulting video) and/or a video’s YouTube processing state (processing, failed, rejected), plus a check for the "locked to private" restriction. Can wait for changes.',
      inputSchema: {
        job_id: z.string().optional(),
        video_id: z.string().optional(),
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(110)
          .default(0)
          .describe("Wait up to this long for the job to change state."),
        channel: channelArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (args, extra) => {
      if (!args.job_id && !args.video_id)
        throw new YtError("invalid_request", "Provide job_id or video_id.");
      const jobId =
        args.job_id ??
        app.db.get<{ id: string }>("select id from jobs where video_id = ? order by created_at desc limit 1", args.video_id!)?.id;
      let job = jobId ? app.jobs.get(jobId) : undefined;
      if (args.job_id && !job)
        throw new YtError("not_found", `No upload job ${args.job_id}.`);
      if (job && args.wait_seconds)
        job = await app.jobs.waitFor(
          job.id,
          args.wait_seconds * 1000,
          progressReporter(extra),
        );
      const out: Record<string, unknown> = {};
      if (job) out.job = describeJob(job);
      const videoId = args.video_id ?? job?.video_id;
      if (videoId) {
        const row = job
          ? (app.channels.byRowId(job.channel_row_id) ??
            app.channels.resolve(args.channel))
          : app.channels.resolve(args.channel);
        const api = await app.channels.api(row);
        const v = await api.getVideo(videoId, [
          "snippet",
          "status",
          "processingDetails",
          "contentDetails",
        ]);
        out.video = summariseVideo(v);
        if (job) {
          const lock = privateLockWarning(
            JSON.parse(job.metadata) as UploadMetadata,
            v,
          );
          if (lock) out.warning = lock;
        }
        const p = v.processingDetails?.processingStatus;
        out.ready = v.status?.uploadStatus === "processed" || p === "succeeded";
        if (
          v.status?.uploadStatus === "failed" ||
          v.status?.uploadStatus === "rejected" ||
          p === "failed"
        ) {
          out.problem =
            v.status?.failureReason ??
            v.status?.rejectionReason ??
            v.processingDetails?.processingFailureReason;
        }
      }
      return ok(out);
    }),
  );

  server.registerTool(
    "list_uploads",
    {
      title: "List upload jobs",
      description:
        "Recent upload jobs from this computer, newest first, with progress and results.",
      inputSchema: {
        status: z
          .enum([
            "queued",
            "downloading",
            "uploading",
            "finishing",
            "done",
            "failed",
            "stopped",
            "cancelled",
          ])
          .optional(),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async ({ status, limit }) =>
      ok({
        uploads: app.jobs
          .list(limit, status)
          .map((j) => ({ ...describeJob(j), result: undefined })),
      }),
    ),
  );

  server.registerTool(
    "cancel_upload",
    {
      title: "Cancel an upload",
      description:
        "Stop an upload job that has not finished. It can be resumed later with resume_upload.",
      inputSchema: { job_id: z.string() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    safe(async ({ job_id }) => ok(describeJob(app.jobs.cancel(job_id)))),
  );

  server.registerTool(
    "resume_upload",
    {
      title: "Resume an upload",
      description:
        "Resume a stopped, failed or cancelled upload from the last byte YouTube confirmed (for example after a quota reset or reconnecting the channel). Network drops and quota resets are also retried automatically.",
      inputSchema: {
        job_id: z.string(),
        wait_seconds: z.number().int().min(0).max(110).default(10),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    safe(async ({ job_id, wait_seconds }, extra) => {
      app.jobs.resume(job_id);
      return ok(
        describeJob(
          await app.jobs.waitFor(
            job_id,
            wait_seconds * 1000,
            progressReporter(extra),
          ),
        ),
      );
    }),
  );
}
