import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { App } from "../../app.js";
import { parseCaptions, timestampedText, transcribeFile } from "../../ai/transcript.js";
import {
  AI_NOT_CONFIGURED_HINT,
  describeAi,
  generateImage,
  parseModelRef,
  PROVIDERS,
  resolveModel,
  saveModels,
  type ImageInput,
} from "../../ai/providers.js";
import {
  contentIdeas,
  critiqueThumbnails,
  diagnoseVideo,
  suggestShorts,
  thumbnailConcepts,
  translateMetadata,
  triageComments,
} from "../../ai/writer.js";
import { AI_TASKS, type AiTask } from "../../config.js";
import { YtError } from "../../errors.js";
import { channelVideos, outlierScores, videoFacts } from "../../growth.js";
import { cutShort, extractFrames, requireFfmpeg, toThumbnail } from "../../media.js";
import { COST } from "../../quota.js";
import { expandPath, inspectVideoFile } from "../../upload/sources.js";
import { downloadCaptions } from "../../videoOps.js";
import { channelArg, ok, safe } from "../helpers.js";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Read a local image for a vision/image model. Only real JPG/PNG/WebP files under 20 MB are accepted. */
function imageInput(path: string): ImageInput {
  const full = expandPath(path);
  const st = statSync(full, { throwIfNoEntry: false });
  if (!st?.isFile()) throw new YtError("file_error", `Image not found: ${full}`);
  if (st.size > MAX_IMAGE_BYTES) throw new YtError("file_error", `${full} is larger than 20 MB.`);
  const data = readFileSync(full);
  const mime: ImageInput["mime"] | null =
    data[0] === 0xff && data[1] === 0xd8
      ? "image/jpeg"
      : data.toString("latin1", 1, 4) === "PNG"
        ? "image/png"
        : data.toString("latin1", 0, 4) === "RIFF" && data.toString("latin1", 8, 12) === "WEBP"
          ? "image/webp"
          : null;
  if (!mime) throw new YtError("file_error", `${full} is not a JPG, PNG or WebP image.`);
  return { mime, data: data.toString("base64") };
}

/** Output files must be new .mp4 files (unless overwrite), in an existing or creatable folder. */
function safeOutput(path: string, overwrite: boolean): string {
  const full = expandPath(path);
  if (extname(full).toLowerCase() !== ".mp4")
    throw new YtError("invalid_request", "output_path must end in .mp4.");
  if (existsSync(full) && !overwrite)
    throw new YtError("file_error", `${full} already exists. Pass overwrite: true to replace it.`);
  mkdirSync(dirname(full), { recursive: true });
  return full;
}

/** Read a captions/transcript file: .srt, .vtt or .txt under 5 MB. */
function readTranscript(path: string): string {
  const full = expandPath(path);
  if (!/\.(srt|vtt|txt|sbv)$/i.test(full))
    throw new YtError("file_error", "Transcripts must be .srt, .vtt, .sbv or .txt files.");
  const st = statSync(full, { throwIfNoEntry: false });
  if (!st?.isFile()) throw new YtError("file_error", `Transcript not found: ${full}`);
  if (st.size > 5 * 1024 * 1024)
    throw new YtError("file_error", "Transcript file is larger than 5 MB.");
  return readFileSync(full, "utf8");
}

export function registerAiTools(server: McpServer, app: App) {
  const ctx = async (channel?: string) => {
    const row = app.channels.resolve(channel);
    return { row, api: await app.channels.api(row) };
  };
  const outDir = (kind: string) => {
    const d = join(app.cfg.home, kind);
    mkdirSync(d, { recursive: true });
    return d;
  };

  server.registerTool(
    "ai_status",
    {
      title: "AI providers and models",
      description:
        "Which AI providers are connected (Claude, OpenAI, Azure OpenAI, Gemini, OpenRouter, Groq, Ollama, custom) and which model each job uses: text (writing, analysis), vision (judging thumbnails), image (making thumbnails), transcribe. Keys are never shown.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async () =>
      ok({
        ...describeAi(app.cfg.ai),
        capabilities: Object.fromEntries(Object.entries(PROVIDERS).map(([id, p]) => [id, p.tasks])),
        setup:
          "Add or change providers and keys in a terminal: `npx @joinhackyard/youtube-channel-mcp ai`. Keys never go through chat.",
      }),
    ),
  );

  server.registerTool(
    "set_ai_models",
    {
      title: "Choose AI models",
      description:
        'Pick which connected provider and model handle each job, as "provider:model" (Azure: "azure:<deployment>"), e.g. text "anthropic:claude-opus-5-5", image "openai:gpt-image-2", transcribe "groq:whisper-large-v3". Pass null to go back to the automatic choice.',
      inputSchema: {
        text: z.string().nullable().optional(),
        vision: z.string().nullable().optional(),
        image: z.string().nullable().optional(),
        transcribe: z.string().nullable().optional(),
        effort: z
          .enum(["low", "medium", "high", "xhigh", "max"])
          .optional()
          .describe("Reasoning effort for Claude (default medium)."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    safe(async (args) => {
      const models: Partial<Record<AiTask, string | null>> = {};
      for (const t of AI_TASKS) {
        const v = args[t];
        if (v === undefined) continue;
        if (v !== null) {
          const ref = parseModelRef(v);
          if (!ref) throw new YtError("invalid_request", `"${v}" is not provider:model.`);
          if (!PROVIDERS[ref.provider].tasks.includes(t))
            throw new YtError("invalid_request", `${PROVIDERS[ref.provider].label} can't do ${t}.`);
        }
        models[t] = v;
        if (v) app.cfg.ai.models[t] = v;
        else delete app.cfg.ai.models[t];
      }
      if (args.effort) app.cfg.ai.effort = args.effort;
      saveModels(app.db, models, args.effort);
      return ok(describeAi(app.cfg.ai));
    }),
  );

  server.registerTool(
    "analyze_video",
    {
      title: "Diagnose a video and suggest fixes",
      description:
        "Full performance picture for one video: views vs this channel's usual (outlier score), watch time, average view percentage, hook retention at 30 s and the retention curve, traffic sources, YouTube search terms, subscribers gained, SEO score. With an AI model connected it adds a diagnosis: what's working, what's hurting, title variants and thumbnail ideas ready to A/B test, and next actions.",
      inputSchema: {
        video_id: z.string(),
        diagnose: z
          .boolean()
          .default(true)
          .describe("Ask the AI model for a diagnosis when one is connected."),
        template: z
          .string()
          .optional()
          .describe("Template whose voice guidance the suggestions should follow."),
        channel: channelArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (args) => {
      const { row, api } = await ctx(args.channel);
      const peers = row.uploads_playlist_id
        ? await channelVideos(api, row.uploads_playlist_id, 50)
        : [];
      const facts = await videoFacts(api, args.video_id, peers);
      if (!args.diagnose || !resolveModel(app.cfg.ai, "text")) {
        return ok({
          facts,
          diagnosis: null,
          note: resolveModel(app.cfg.ai, "text")
            ? undefined
            : `No AI model connected: write the diagnosis yourself from these facts. ${AI_NOT_CONFIGURED_HINT}`,
        });
      }
      const d = await diagnoseVideo(
        app.cfg.ai,
        facts,
        args.template ? app.templates.get(args.template) : undefined,
      );
      return ok({
        facts,
        diagnosis: d.data,
        model: d.model,
        next: "To test the title or thumbnail ideas, call create_ab_test with them.",
      });
    }),
  );

  server.registerTool(
    "triage_comments",
    {
      title: "Sort comments and draft replies",
      description:
        "Reads recent comments (one video or the whole channel) and returns sentiment, themes, unanswered questions with draft replies, comments worth a reply, spam or abuse to moderate, and video ideas the audience is asking for. Drafts only: nothing is posted. Without an AI model it returns the comments for you to triage.",
      inputSchema: {
        video_id: z.string().optional(),
        max_comments: z.number().int().min(10).max(500).default(150),
        include_held: z.boolean().default(true).describe("Also include comments held for review."),
        channel: channelArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (args) => {
      const { row, api } = await ctx(args.channel);
      const comments: {
        id: string;
        text: string;
        likes?: number;
        author?: string;
        video?: string;
        held?: boolean;
      }[] = [];
      for (const status of args.include_held ? ["heldForReview", "published"] : ["published"]) {
        let pageToken: string | undefined;
        do {
          const page = await api.call(COST.list, "commentThreads.list", () =>
            api.yt.commentThreads.list({
              part: ["snippet"],
              ...(args.video_id
                ? { videoId: args.video_id }
                : { allThreadsRelatedToChannelId: row.channel_id }),
              moderationStatus: status,
              order: "time",
              maxResults: 100,
              pageToken,
              textFormat: "plainText",
            }),
          );
          for (const t of page.items ?? []) {
            const c = t.snippet?.topLevelComment;
            if (!c?.id) continue;
            comments.push({
              id: c.id,
              text: (c.snippet?.textDisplay ?? "").slice(0, 600),
              likes: c.snippet?.likeCount ?? 0,
              author: c.snippet?.authorDisplayName ?? undefined,
              video: t.snippet?.videoId ?? undefined,
              held: status !== "published" || undefined,
            });
          }
          pageToken = page.nextPageToken ?? undefined;
        } while (pageToken && comments.length < args.max_comments);
      }
      const sample = comments.slice(0, args.max_comments);
      if (!sample.length) return ok({ comments: 0, note: "No comments found." });
      if (!resolveModel(app.cfg.ai, "text"))
        return ok({
          comments: sample,
          note: `No AI model connected: triage these yourself. ${AI_NOT_CONFIGURED_HINT}`,
        });
      const r = await triageComments(app.cfg.ai, sample);
      return ok({
        analysed: sample.length,
        model: r.model,
        ...r.data,
        next: "Post replies with reply_to_comment and moderate with moderate_comments; both ask the user first.",
      });
    }),
  );

  server.registerTool(
    "translate_video_metadata",
    {
      title: "Draft translated titles and descriptions",
      description:
        "Drafts the video's title and description in other languages so it can reach viewers who search in them. Returns drafts only; apply them with set_video_localizations after the user approves.",
      inputSchema: {
        video_id: z.string(),
        languages: z
          .array(z.string())
          .min(1)
          .max(20)
          .describe('BCP-47 codes, e.g. ["hi", "es", "pt-BR"]'),
        channel: channelArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ video_id, languages, channel }) => {
      const { api } = await ctx(channel);
      const v = await api.getVideo(video_id, ["snippet"]);
      if (!resolveModel(app.cfg.ai, "text")) {
        return ok({
          title: v.snippet?.title,
          description: v.snippet?.description,
          languages,
          note: `No AI model connected: translate these yourself, then call set_video_localizations. ${AI_NOT_CONFIGURED_HINT}`,
        });
      }
      const r = await translateMetadata(
        app.cfg.ai,
        v.snippet?.title ?? "",
        v.snippet?.description ?? "",
        languages,
      );
      return ok({
        model: r.model,
        default_language: v.snippet?.defaultLanguage ?? null,
        ...r.data,
        next: "Apply with set_video_localizations (the video needs a default_language).",
      });
    }),
  );

  server.registerTool(
    "suggest_shorts",
    {
      title: "Find Shorts in a long video",
      description:
        "Finds the moments in a long video that work as standalone Shorts (hook in the first seconds, one idea, a payoff) with start/end times, hook line, title and a score. Use a local file (transcribed), an uploaded video's captions, or a transcript file. Then cut them with create_short.",
      inputSchema: {
        file_path: z.string().optional(),
        video_id: z.string().optional(),
        transcript_path: z.string().optional(),
        count: z.number().int().min(1).max(15).default(5),
        max_seconds: z.number().int().min(15).max(180).default(60),
        channel: channelArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (args) => {
      let text: string;
      if (args.transcript_path)
        text = timestampedText(parseCaptions(readTranscript(args.transcript_path)), 10);
      else if (args.video_id) {
        const { api } = await ctx(args.channel);
        text = timestampedText(parseCaptions((await downloadCaptions(api, args.video_id)).srt), 10);
      } else if (args.file_path) {
        const f = await inspectVideoFile(args.file_path, app.cfg.maxUploadBytes);
        text = timestampedText(await transcribeFile(app.cfg, f.path), 10);
      } else throw new YtError("invalid_request", "Pass file_path, video_id or transcript_path.");
      if (!resolveModel(app.cfg.ai, "text")) {
        return ok({
          transcript: text,
          note: `No AI model connected: pick ${args.count} clips (15-${args.max_seconds} s, strong first line) from the transcript yourself, then call create_short. ${AI_NOT_CONFIGURED_HINT}`,
        });
      }
      const r = await suggestShorts(app.cfg.ai, text, args.count, args.max_seconds);
      return ok({
        model: r.model,
        clips: r.data.clips.sort((a, b) => b.score - a.score),
        next: "Cut a clip with create_short(file_path, start, end), then upload_video it with the shorts template.",
      });
    }),
  );

  server.registerTool(
    "create_short",
    {
      title: "Cut a vertical Short",
      description:
        "Cuts start-end (seconds) from a local video into a vertical 1080x1920 MP4 for YouTube Shorts (max 180 s). layout crop fills the frame from the centre (talking heads); blur shows the whole frame over a blurred fill; original keeps the aspect ratio. Needs ffmpeg.",
      inputSchema: {
        file_path: z.string(),
        start: z.number().min(0),
        end: z.number().positive(),
        layout: z.enum(["crop", "blur", "original"]).default("crop"),
        overwrite: z.boolean().default(false).describe("Replace output_path if it already exists."),
        output_path: z
          .string()
          .optional()
          .describe("Where to save; default is the shorts folder in the data directory."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    safe(async (args) => {
      const f = await inspectVideoFile(args.file_path, app.cfg.maxUploadBytes);
      const out = args.output_path
        ? safeOutput(args.output_path, args.overwrite)
        : join(
            outDir("shorts"),
            `${basename(f.path, extname(f.path))}-${Math.round(args.start)}-${Math.round(args.end)}.mp4`,
          );
      const r = await cutShort(f.path, args.start, args.end, out, args.layout);
      return ok({ ...r, next: 'Upload with upload_video(file_path, template: "shorts").' });
    }),
  );

  server.registerTool(
    "extract_frames",
    {
      title: "Grab stills for thumbnails",
      description:
        "Saves evenly spaced stills (or stills at given seconds) from a local video as 1280-wide JPGs, as thumbnail candidates or as references for generate_thumbnails. Needs ffmpeg.",
      inputSchema: {
        file_path: z.string(),
        count: z.number().int().min(1).max(24).default(8),
        at_seconds: z.array(z.number().min(0)).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    safe(async ({ file_path, count, at_seconds }) => {
      const f = await inspectVideoFile(file_path, app.cfg.maxUploadBytes);
      const frames = await extractFrames(
        f.path,
        join(outDir("frames"), basename(f.path, extname(f.path))),
        count,
        at_seconds,
      );
      return ok({
        frames,
        next: "Judge them with critique_thumbnails, or pass one to generate_thumbnails as reference_image.",
      });
    }),
  );

  server.registerTool(
    "generate_thumbnails",
    {
      title: "Design and generate thumbnails",
      description:
        "Designs thumbnail concepts for a title (text overlay + image prompt) with the text model, then renders them with the image model (OpenAI gpt-image, Azure OpenAI image deployments, Gemini image). Optionally builds on a video frame. Saves 1280x720 JPGs under 2 MB, ready for set_thumbnail or create_ab_test. Without an image model it returns the concepts only.",
      inputSchema: {
        title: z.string(),
        context: z
          .string()
          .optional()
          .describe("What the video is about, the subject, the audience."),
        count: z.number().int().min(1).max(4).default(3),
        style: z
          .string()
          .optional()
          .describe('e.g. "bold, high contrast, face on the left, dark background"'),
        reference_image: z.string().optional().describe("Path to a frame or photo to build on."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safe(async (args) => {
      if (!resolveModel(app.cfg.ai, "text"))
        throw new YtError("not_configured", "No AI text model connected to design thumbnails.", {
          hint: AI_NOT_CONFIGURED_HINT,
        });
      const concepts = await thumbnailConcepts(
        app.cfg.ai,
        args.title,
        args.context ?? "",
        args.count,
        args.style,
      );
      if (!resolveModel(app.cfg.ai, "image")) {
        return ok({
          concepts: concepts.data.concepts,
          images: [],
          note: "No image model connected (OpenAI, Azure OpenAI or Gemini). Use the prompts in any image tool, or connect one with `ai`.",
        });
      }
      const ref = args.reference_image ? imageInput(args.reference_image) : undefined;
      const dir = outDir("thumbnails");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const images = [];
      for (const [i, c] of concepts.data.concepts.entries()) {
        try {
          const img = await generateImage(app.cfg.ai, c.image_prompt, ref);
          if (!img) break;
          const raw = join(dir, `${stamp}-${i + 1}.${img.mime.includes("jpeg") ? "jpg" : "png"}`);
          writeFileSync(raw, img.data);
          let path = raw;
          try {
            await requireFfmpeg();
            path = (await toThumbnail(raw, join(dir, `${stamp}-${i + 1}-thumb.jpg`))).path;
          } catch {
            /* keep the original if ffmpeg is missing; set_thumbnail checks size */
          }
          images.push({ path, text_on_image: c.text_on_image, why: c.why, model: img.model });
        } catch (e) {
          images.push({ error: (e as Error).message, concept: c.text_on_image });
        }
      }
      return ok({
        images,
        concepts: concepts.data.concepts,
        next: "Show them to the user, rank them with critique_thumbnails, then set_thumbnail or create_ab_test.",
      });
    }),
  );

  server.registerTool(
    "critique_thumbnails",
    {
      title: "Judge and rank thumbnails",
      description:
        "Scores 1-4 thumbnail images as a phone viewer sees them (readability at small size, emotion, subject clarity, fit with the title), ranks them and lists fixes. Needs a vision model (Claude, OpenAI, Gemini, Azure).",
      inputSchema: { image_paths: z.array(z.string()).min(1).max(4), title: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ image_paths, title }) => {
      if (!resolveModel(app.cfg.ai, "vision"))
        throw new YtError("not_configured", "No vision model connected.", {
          hint: AI_NOT_CONFIGURED_HINT,
        });
      const r = await critiqueThumbnails(app.cfg.ai, image_paths.map(imageInput), title);
      return ok({
        model: r.model,
        ...r.data,
        files: image_paths.map((p, i) => ({ index: i, path: expandPath(p) })),
      });
    }),
  );

  server.registerTool(
    "content_ideas",
    {
      title: "What to make next",
      description:
        "Next video ideas grounded in this channel's data: its outliers (what over-performed vs its usual), underperformers, and optionally a topic to research. With an AI model it returns ideas with angle, why now, thumbnail concept and confidence; otherwise the data for you to reason from.",
      inputSchema: {
        count: z.number().int().min(3).max(20).default(10),
        focus: z.string().optional().describe("A theme or audience to focus on."),
        template: z.string().optional(),
        channel: channelArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (args) => {
      const { row, api } = await ctx(args.channel);
      if (!row.uploads_playlist_id)
        throw new YtError("not_found", "Could not find the channel's uploads.");
      const scored = outlierScores(await channelVideos(api, row.uploads_playlist_id, 100)).filter(
        (v) => v.outlier_score !== null,
      );
      const top = [...scored]
        .sort((a, b) => (b.outlier_score ?? 0) - (a.outlier_score ?? 0))
        .slice(0, 12);
      const bottom = [...scored]
        .filter((v) => v.age_days > 14)
        .sort((a, b) => (a.outlier_score ?? 0) - (b.outlier_score ?? 0))
        .slice(0, 6);
      const facts = {
        focus: args.focus,
        outperformers: top.map((v) => ({
          title: v.title,
          outlier_score: v.outlier_score,
          views: v.views,
          short: v.is_short,
        })),
        underperformers: bottom.map((v) => ({ title: v.title, outlier_score: v.outlier_score })),
      };
      if (!resolveModel(app.cfg.ai, "text"))
        return ok({
          facts,
          note: `No AI model connected: suggest ideas from these facts. ${AI_NOT_CONFIGURED_HINT}`,
        });
      const r = await contentIdeas(
        app.cfg.ai,
        facts,
        args.count,
        args.template ? app.templates.get(args.template) : undefined,
      );
      return ok({ model: r.model, ...r.data, based_on: facts });
    }),
  );
}
