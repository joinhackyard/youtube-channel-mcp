import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { App } from "../../app.js";
import { checkChapters, isoDurationSeconds, metadataBrief } from "../../ai/brief.js";
import { resolveModel } from "../../ai/providers.js";
import { seoCheck } from "../../growth.js";
import { draftMetadata } from "../../ai/writer.js";
import { parseCaptions, saveSrt, timestampedText, transcribeFile } from "../../ai/transcript.js";
import { YtError } from "../../errors.js";
import { PRIVACY } from "../../google/youtube.js";
import { COST } from "../../quota.js";
import { applyTemplate, TemplateSchema } from "../../templates.js";
import { expandPath, inspectVideoFile } from "../../upload/sources.js";
import {
  addToPlaylist,
  createPlaylist,
  downloadCaptions,
  listPlaylists,
  resolvePlaylists,
  uploadCaptions,
} from "../../videoOps.js";
import { channelArg, confirmArg, confirmGate, ok, safe } from "../helpers.js";
import { metadataShape } from "./upload.js";

export function registerLibraryTools(server: McpServer, app: App) {
  const api = async (channel?: string) => app.channels.api(app.channels.resolve(channel));

  // ---- playlists ---------------------------------------------------------------------------------
  server.registerTool(
    "list_playlists",
    {
      title: "List playlists",
      description: "All playlists on the channel with id, title, privacy and video count.",
      inputSchema: { channel: channelArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ channel }) => {
      const items = await listPlaylists(await api(channel));
      return ok({
        playlists: items.map((p) => ({
          id: p.id,
          title: p.snippet?.title,
          privacy: p.status?.privacyStatus,
          videos: p.contentDetails?.itemCount,
          url: `https://www.youtube.com/playlist?list=${p.id}`,
        })),
      });
    }),
  );

  server.registerTool(
    "create_playlist",
    {
      title: "Create a playlist",
      description: "Create a new playlist on the channel.",
      inputSchema: {
        title: z.string().min(1).max(150),
        description: z.string().max(5000).optional(),
        privacy: z.enum(PRIVACY).default("private"),
        channel: channelArg,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    safe(async ({ title, description, privacy, channel }) => {
      const p = await createPlaylist(await api(channel), title, description, privacy);
      return ok({
        id: p.id,
        title: p.snippet?.title,
        privacy: p.status?.privacyStatus,
        url: `https://www.youtube.com/playlist?list=${p.id}`,
      });
    }),
  );

  server.registerTool(
    "add_to_playlist",
    {
      title: "Add a video to a playlist",
      description:
        "Add a video to a playlist by playlist id or exact title. Optionally at a position (0 = first).",
      inputSchema: {
        video_id: z.string(),
        playlist: z.string().describe("Playlist id (PL...) or exact title."),
        position: z.number().int().min(0).optional(),
        create_if_missing: z
          .boolean()
          .default(false)
          .describe("Create a private playlist with this title if none exists."),
        channel: channelArg,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    safe(async ({ video_id, playlist, position, create_if_missing, channel }) => {
      const a = await api(channel);
      const r = await resolvePlaylists(a, [playlist], create_if_missing);
      if (!r.ids.length)
        throw new YtError("not_found", `No playlist titled "${playlist}".`, {
          hint: "Use list_playlists, or pass create_if_missing: true.",
        });
      return ok({
        ...(await addToPlaylist(a, r.ids[0], video_id, position)),
        created: r.created.length > 0,
      });
    }),
  );

  server.registerTool(
    "remove_from_playlist",
    {
      title: "Remove a video from a playlist",
      description: "Remove a video from a playlist (the video itself is not deleted).",
      inputSchema: {
        video_id: z.string(),
        playlist: z.string().describe("Playlist id or exact title."),
        channel: channelArg,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async ({ video_id, playlist, channel }) => {
      const a = await api(channel);
      const r = await resolvePlaylists(a, [playlist], false);
      if (!r.ids.length) throw new YtError("not_found", `No playlist titled "${playlist}".`);
      const items = await a.call(COST.list, "playlistItems.list", () =>
        a.yt.playlistItems.list({
          part: ["id"],
          playlistId: r.ids[0],
          videoId: video_id,
          maxResults: 50,
        }),
      );
      const ids = (items.items ?? []).map((i) => i.id).filter((x): x is string => Boolean(x));
      if (!ids.length) throw new YtError("not_found", "That video is not in this playlist.");
      for (const id of ids)
        await a.call(
          COST.playlistItemsDelete,
          "playlistItems.delete",
          () => a.yt.playlistItems.delete({ id }),
          false,
        );
      return ok({ removed: ids.length, playlist_id: r.ids[0], video_id });
    }),
  );

  server.registerTool(
    "update_playlist",
    {
      title: "Edit a playlist",
      description:
        "Rename a playlist, change its description or privacy. Making it public or unlisted needs the user’s confirmation.",
      inputSchema: {
        playlist: z.string().describe("Playlist id or exact title."),
        title: z.string().min(1).max(150).optional(),
        description: z.string().max(5000).optional(),
        privacy: z.enum(PRIVACY).optional(),
        channel: channelArg,
        confirmation_token: confirmArg,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const a = await api(args.channel);
      const all = await listPlaylists(a);
      const p = all.find(
        (x) =>
          x.id === args.playlist || x.snippet?.title?.toLowerCase() === args.playlist.toLowerCase(),
      );
      if (!p?.id) throw new YtError("not_found", `No playlist "${args.playlist}".`);
      if (args.privacy && args.privacy !== "private" && args.privacy !== p.status?.privacyStatus) {
        const gate = await confirmGate(
          app,
          server,
          "update_playlist",
          args,
          `Make playlist "${p.snippet?.title}" ${args.privacy.toUpperCase()}.`,
          { publicFacing: true },
        );
        if (gate) return gate;
      }
      const upd = await a.call(
        COST.playlistsUpdate,
        "playlists.update",
        () =>
          a.yt.playlists.update({
            part: ["snippet", "status"],
            requestBody: {
              id: p.id,
              snippet: {
                title: args.title ?? p.snippet?.title,
                description: args.description ?? p.snippet?.description,
                defaultLanguage: p.snippet?.defaultLanguage,
              },
              status: { privacyStatus: args.privacy ?? p.status?.privacyStatus },
            },
          }),
        false,
      );
      return ok({ id: upd.id, title: upd.snippet?.title, privacy: upd.status?.privacyStatus });
    }),
  );

  server.registerTool(
    "delete_playlist",
    {
      title: "Delete a playlist",
      description:
        "Delete a playlist (the videos in it are not deleted). Needs the user’s confirmation.",
      inputSchema: {
        playlist: z.string().describe("Playlist id or exact title."),
        channel: channelArg,
        confirmation_token: confirmArg,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const a = await api(args.channel);
      const r = await resolvePlaylists(a, [args.playlist], false);
      if (!r.ids.length) throw new YtError("not_found", `No playlist "${args.playlist}".`);
      const gate = await confirmGate(
        app,
        server,
        "delete_playlist",
        args,
        `Delete playlist "${args.playlist}" (${r.ids[0]}). Videos stay on the channel.`,
        { publicFacing: false, destructive: true },
      );
      if (gate) return gate;
      await a.call(
        COST.playlistsDelete,
        "playlists.delete",
        () => a.yt.playlists.delete({ id: r.ids[0] }),
        false,
      );
      app.db.audit("playlist.deleted", { playlist: r.ids[0] });
      return ok({ deleted: r.ids[0] });
    }),
  );

  server.registerTool(
    "move_in_playlist",
    {
      title: "Reorder a playlist",
      description:
        "Move a video to a new position in a playlist (0 = first). Works for playlists sorted manually.",
      inputSchema: {
        playlist: z.string(),
        video_id: z.string(),
        position: z.number().int().min(0),
        channel: channelArg,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async ({ playlist, video_id, position, channel }) => {
      const a = await api(channel);
      const r = await resolvePlaylists(a, [playlist], false);
      if (!r.ids.length) throw new YtError("not_found", `No playlist "${playlist}".`);
      const items = await a.call(COST.list, "playlistItems.list", () =>
        a.yt.playlistItems.list({
          part: ["id", "snippet"],
          playlistId: r.ids[0],
          videoId: video_id,
        }),
      );
      const item = items.items?.[0];
      if (!item?.id) throw new YtError("not_found", "That video is not in this playlist.");
      await a.call(
        COST.playlistItemsUpdate,
        "playlistItems.update",
        () =>
          a.yt.playlistItems.update({
            part: ["snippet"],
            requestBody: {
              id: item.id,
              snippet: { playlistId: r.ids[0], resourceId: item.snippet?.resourceId, position },
            },
          }),
        false,
      );
      return ok({ playlist_id: r.ids[0], video_id, position });
    }),
  );

  server.registerTool(
    "list_playlist_items",
    {
      title: "List videos in a playlist",
      description: "Videos in a playlist, in order.",
      inputSchema: {
        playlist: z.string().describe("Playlist id or exact title."),
        max_results: z.number().int().min(1).max(50).default(50),
        page_token: z.string().optional(),
        channel: channelArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ playlist, max_results, page_token, channel }) => {
      const a = await api(channel);
      const r = await resolvePlaylists(a, [playlist], false);
      if (!r.ids.length) throw new YtError("not_found", `No playlist titled "${playlist}".`);
      const page = await a.call(COST.list, "playlistItems.list", () =>
        a.yt.playlistItems.list({
          part: ["snippet", "contentDetails", "status"],
          playlistId: r.ids[0],
          maxResults: max_results,
          pageToken: page_token,
        }),
      );
      return ok({
        playlist_id: r.ids[0],
        total: page.pageInfo?.totalResults,
        items: (page.items ?? []).map((i) => ({
          position: i.snippet?.position,
          video_id: i.contentDetails?.videoId,
          title: i.snippet?.title,
          privacy: i.status?.privacyStatus,
        })),
        next_page_token: page.nextPageToken ?? null,
      });
    }),
  );

  // ---- captions ----------------------------------------------------------------------------------
  server.registerTool(
    "list_captions",
    {
      title: "List caption tracks",
      description: "Caption tracks on a video (language, name, auto-generated or uploaded, draft).",
      inputSchema: { video_id: z.string(), channel: channelArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ video_id, channel }) => {
      const a = await api(channel);
      const data = await a.call(COST.captionsList, "captions.list", () =>
        a.yt.captions.list({ part: ["snippet"], videoId: video_id }),
      );
      return ok({
        tracks: (data.items ?? []).map((t) => ({
          id: t.id,
          language: t.snippet?.language,
          name: t.snippet?.name,
          kind: t.snippet?.trackKind,
          draft: t.snippet?.isDraft,
          status: t.snippet?.status,
        })),
      });
    }),
  );

  server.registerTool(
    "upload_captions",
    {
      title: "Upload captions",
      description:
        "Add a captions track (.srt, .vtt or other YouTube-supported format) to a video, from a file on this computer or inline content.",
      inputSchema: {
        video_id: z.string(),
        file_path: z.string().optional(),
        content: z.string().optional().describe("Caption file contents, e.g. SRT text."),
        language: z.string().default("en").describe('BCP-47 language, e.g. "en", "hi", "es".'),
        name: z.string().optional().describe("Track name shown to viewers; usually empty."),
        is_draft: z.boolean().default(false),
        replace_existing: z
          .boolean()
          .default(false)
          .describe(
            "Overwrite an existing uploaded track with the same language and name (default: add a new track).",
          ),
        channel: channelArg,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    safe(async ({ channel, video_id, ...c }) => {
      if (c.file_path && !existsSync(expandPath(c.file_path)))
        throw new YtError("file_error", `Captions file not found: ${expandPath(c.file_path)}`);
      return ok(await uploadCaptions(await api(channel), video_id, c));
    }),
  );

  server.registerTool(
    "delete_captions",
    {
      title: "Delete a caption track",
      description:
        "Delete an uploaded caption track (see list_captions for ids). Needs the user’s confirmation.",
      inputSchema: { caption_id: z.string(), channel: channelArg, confirmation_token: confirmArg },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const gate = await confirmGate(
        app,
        server,
        "delete_captions",
        args,
        `Delete caption track ${args.caption_id}.`,
        { publicFacing: false, destructive: true },
      );
      if (gate) return gate;
      const a = await api(args.channel);
      await a.call(
        COST.captionsDelete,
        "captions.delete",
        () => a.yt.captions.delete({ id: args.caption_id }),
        false,
      );
      return ok({ deleted: args.caption_id });
    }),
  );

  server.registerTool(
    "download_captions",
    {
      title: "Download captions",
      description:
        "Download a caption track of your own video as SRT (prefers uploaded tracks, falls back to auto-generated). Costs 250 quota units.",
      inputSchema: {
        video_id: z.string(),
        language: z.string().optional(),
        channel: channelArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ video_id, language, channel }) =>
      ok(await downloadCaptions(await api(channel), video_id, language)),
    ),
  );

  server.registerTool(
    "transcribe_video",
    {
      title: "Transcribe a local video",
      description:
        "Transcribe a video file on this computer with any OpenAI-compatible speech-to-text API (needs ffmpeg and a configured key). Saves an .srt you can pass to upload_video or upload_captions, and returns a timestamped transcript for writing metadata and chapters.",
      inputSchema: {
        file_path: z.string(),
        language: z.string().optional().describe('Spoken language hint, e.g. "en".'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    safe(async ({ file_path, language }) => {
      const f = await inspectVideoFile(file_path, app.cfg.maxUploadBytes);
      const segs = await transcribeFile(app.cfg, f.path, language);
      const dir = join(app.cfg.home, "transcripts");
      mkdirSync(dir, { recursive: true });
      const srtPath = join(dir, `${basename(f.path, extname(f.path))}.srt`);
      await saveSrt(srtPath, segs);
      return ok({
        srt_path: srtPath,
        segments: segs.length,
        duration_seconds: Math.round(segs.at(-1)?.end ?? 0),
        transcript: timestampedText(segs),
      });
    }),
  );

  // ---- metadata & templates ----------------------------------------------------------------------
  server.registerTool(
    "generate_metadata",
    {
      title: "Write titles, description, chapters and tags",
      description:
        "Gets the transcript with timestamps (from text you pass, a .srt/.vtt/.txt file, an uploaded video’s captions, or by transcribing a local file). When an AI writing model is configured (Azure OpenAI, OpenAI…), it returns a finished draft: 3 titles, description with chapters, tags, hashtags, pinned comment and thumbnail text, already merged with the template and checked against YouTube’s limits. Otherwise (or with draft: false) it returns a brief for you to write from. Show the draft to the user before using it.",
      inputSchema: {
        transcript: z.string().optional().describe("Transcript or notes as plain text."),
        transcript_path: z
          .string()
          .optional()
          .describe(".srt, .vtt or .txt file on this computer."),
        video_id: z.string().optional().describe("Use the captions of this video on your channel."),
        file_path: z
          .string()
          .optional()
          .describe("Transcribe this local video first (needs transcription configured)."),
        template: z.string().optional(),
        format: z.enum(["video", "short"]).default("video"),
        language: z.string().optional().describe("Language to write the metadata in."),
        notes: z.string().optional().describe("Anything else: audience, links to include, tone."),
        draft: z
          .boolean()
          .optional()
          .describe(
            "Have the configured AI model write the metadata (default: yes when one is configured).",
          ),
        channel: channelArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (args) => {
      let text = "";
      let duration: number | undefined;
      if (args.transcript) text = args.transcript;
      else if (args.transcript_path) {
        const p = expandPath(args.transcript_path);
        if (!existsSync(p)) throw new YtError("file_error", `Transcript not found: ${p}`);
        const segs = parseCaptions(readFileSync(p, "utf8"));
        text = timestampedText(segs);
        duration = segs.at(-1)?.end || undefined;
      } else if (args.video_id) {
        const a = await api(args.channel);
        const v = await a.getVideo(args.video_id, ["contentDetails"]);
        duration = isoDurationSeconds(v.contentDetails?.duration);
        text = timestampedText(parseCaptions((await downloadCaptions(a, args.video_id)).srt));
      } else if (args.file_path) {
        const f = await inspectVideoFile(args.file_path, app.cfg.maxUploadBytes);
        const segs = await transcribeFile(app.cfg, f.path, args.language);
        text = timestampedText(segs);
        duration = segs.at(-1)?.end;
      } else
        throw new YtError(
          "invalid_request",
          "Pass transcript, transcript_path, video_id or file_path.",
        );
      const input = {
        transcript: text,
        durationSeconds: duration ? Math.round(duration) : undefined,
        template: args.template ? app.templates.get(args.template) : undefined,
        format: args.format,
        language: args.language,
        notes: args.notes,
      };
      if (args.draft !== false && resolveModel(app.cfg.ai, "text")) {
        const result = await draftMetadata(app.cfg.ai, input);
        return ok(
          result,
          "AI draft below. Show it to the user and adjust; `ready_to_use` is exactly what upload_video / update_video would send (template applied).",
        );
      }
      return ok(metadataBrief(input));
    }),
  );

  server.registerTool(
    "preview_metadata",
    {
      title: "Preview final metadata",
      description:
        "Show exactly what would be sent to YouTube (title, description, tags, playlists) after applying a template, check it against YouTube’s limits and chapter rules, and score its SEO/packaging (0-100 with fixes). No API call, no quota.",
      inputSchema: {
        ...metadataShape,
        keyword: z.string().optional().describe("Main search phrase, for the SEO score."),
        duration_seconds: z
          .number()
          .optional()
          .describe("Video length, so the SEO score can check chapters."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async (args) => {
      const m = applyTemplate(args, args.template ? app.templates.get(args.template) : undefined);
      const issues = checkChapters(m.description);
      return ok({
        ...m,
        warnings: [...m.warnings, ...issues],
        title_length: m.title.length,
        description_bytes: Buffer.byteLength(m.description, "utf8"),
        seo: seoCheck({
          title: m.title,
          description: m.description,
          tags: m.tags,
          keyword: args.keyword,
          durationSeconds: args.duration_seconds,
        }),
      });
    }),
  );

  server.registerTool(
    "list_templates",
    {
      title: "List templates",
      description:
        "Metadata templates (title format, description footer, default tags, hashtags, category, playlists, voice guidance) available for uploads.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async () =>
      ok({
        templates_folder: app.cfg.templatesDir,
        templates: app.templates.list(),
        load_errors: app.templates.errors,
      }),
    ),
  );

  server.registerTool(
    "save_template",
    {
      title: "Save a template",
      description:
        "Create or replace a metadata template, saved as JSON in the templates folder. Use {title} in title_format. `extends` inherits another template; tags and hashtags combine.",
      inputSchema: TemplateSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    safe(async (t) => ok({ saved: app.templates.save(t), template: app.templates.get(t.name) })),
  );

  server.registerTool(
    "delete_template",
    {
      title: "Delete a template",
      description: "Delete a saved template file.",
      inputSchema: { name: z.string() },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    safe(async ({ name }) => {
      if (!app.templates.remove(name))
        throw new YtError(
          "not_found",
          `No saved template "${name}" (built-in templates cannot be deleted).`,
        );
      return ok({ deleted: name });
    }),
  );

  server.registerTool(
    "quota_status",
    {
      title: "Quota status",
      description:
        "Estimated YouTube API quota used today (units and uploads) for this Google Cloud project, and when it resets (midnight Pacific Time).",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async () => ok(app.quota.status())),
  );
}
