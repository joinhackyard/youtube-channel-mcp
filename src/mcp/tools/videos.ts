import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { youtube_v3 } from "@googleapis/youtube";
import { z } from "zod";
import type { App } from "../../app.js";
import { checkChapters } from "../../ai/brief.js";
import { YtError } from "../../errors.js";
import {
  PRIVACY,
  summariseVideo,
  videoUrl,
  type Privacy,
  type YouTubeApi,
} from "../../google/youtube.js";
import { COST } from "../../quota.js";
import { applyTemplate, tagsLength, validateText } from "../../templates.js";
import { setThumbnail } from "../../videoOps.js";
import { channelArg, confirmArg, confirmGate, ok, safe } from "../helpers.js";

interface VideoChanges {
  title?: string;
  description?: string;
  tags?: string[];
  category_id?: string;
  default_language?: string;
  default_audio_language?: string;
  made_for_kids?: boolean;
  contains_synthetic_media?: boolean;
  embeddable?: boolean;
  license?: "youtube" | "creativeCommon";
  public_stats_viewable?: boolean;
  privacy?: Privacy;
  publish_at?: string | null;
}

/** videos.update replaces whole parts, so merge the changes into the current snippet/status. */
export async function applyVideoChanges(
  api: YouTubeApi,
  videoId: string,
  c: VideoChanges,
) {
  const cur = await api.getVideo(videoId, ["snippet", "status"]);
  const touchesSnippet = [
    "title",
    "description",
    "tags",
    "category_id",
    "default_language",
    "default_audio_language",
  ].some((k) => k in c && c[k as keyof VideoChanges] !== undefined);
  const touchesStatus = [
    "made_for_kids",
    "contains_synthetic_media",
    "embeddable",
    "license",
    "public_stats_viewable",
    "privacy",
    "publish_at",
  ].some((k) => k in c && c[k as keyof VideoChanges] !== undefined);
  if (!touchesSnippet && !touchesStatus)
    throw new YtError("invalid_request", "Nothing to change.");
  const body: youtube_v3.Schema$Video = { id: videoId };
  const parts: string[] = [];
  if (touchesSnippet) {
    const s = cur.snippet ?? {};
    body.snippet = {
      title: c.title ?? s.title,
      description: c.description ?? s.description,
      tags: c.tags ?? s.tags,
      categoryId: c.category_id ?? s.categoryId,
      defaultLanguage: c.default_language ?? s.defaultLanguage,
      defaultAudioLanguage: c.default_audio_language ?? s.defaultAudioLanguage,
    };
    validateText(body.snippet.title ?? "", body.snippet.description ?? "");
    if (tagsLength(body.snippet.tags ?? []) > 500)
      throw new YtError(
        "invalid_request",
        "Tags exceed the 500-character limit.",
      );
    parts.push("snippet");
  }
  if (touchesStatus) {
    const s = cur.status ?? {};
    let privacy = c.privacy ?? s.privacyStatus;
    let publishAt =
      c.publish_at === null ? undefined : (c.publish_at ?? s.publishAt);
    if (c.publish_at) privacy = "private";
    if (c.privacy && c.privacy !== "private") publishAt = undefined;
    body.status = {
      privacyStatus: privacy,
      publishAt: publishAt ?? undefined,
      selfDeclaredMadeForKids:
        c.made_for_kids ?? s.selfDeclaredMadeForKids ?? undefined,
      containsSyntheticMedia:
        c.contains_synthetic_media ?? s.containsSyntheticMedia ?? undefined,
      embeddable: c.embeddable ?? s.embeddable,
      license: c.license ?? s.license,
      publicStatsViewable: c.public_stats_viewable ?? s.publicStatsViewable,
    };
    parts.push("status");
  }
  const updated = await api.call(
    COST.videosUpdate,
    "videos.update",
    () => api.yt.videos.update({ part: parts, requestBody: body }),
    false,
  );
  return { before: cur, after: updated };
}

function lockNote(wanted: Privacy | undefined, after: youtube_v3.Schema$Video) {
  if (
    wanted &&
    wanted !== "private" &&
    after.status?.privacyStatus === "private"
  ) {
    return `YouTube kept the video private. If your Google Cloud project has not passed the YouTube API audit, visibility changes through the API are blocked; change it in YouTube Studio: https://studio.youtube.com/video/${after.id}/edit`;
  }
  return undefined;
}

export function registerVideoTools(server: McpServer, app: App) {
  const api = async (channel?: string) =>
    app.channels.api(app.channels.resolve(channel));

  server.registerTool(
    "list_my_videos",
    {
      title: "List channel videos",
      description:
        "List videos on the channel, newest first (including private, unlisted and scheduled ones), with privacy, schedule, duration and view counts. Paginate with page_token.",
      inputSchema: {
        channel: channelArg,
        max_results: z.number().int().min(1).max(50).default(25),
        page_token: z.string().optional(),
        privacy: z
          .enum(PRIVACY)
          .optional()
          .describe(
            "Only return videos with this privacy (filters the current page).",
          ),
        query: z
          .string()
          .optional()
          .describe(
            "Only return videos whose title contains this text (filters the current page).",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (args) => {
      const row = app.channels.resolve(args.channel);
      const a = await app.channels.api(row);
      let uploads = row.uploads_playlist_id;
      if (!uploads)
        uploads =
          (await a.myChannel())?.contentDetails?.relatedPlaylists?.uploads ??
          null;
      if (!uploads)
        throw new YtError(
          "not_found",
          "Could not find the channel’s uploads list.",
        );
      const page = await a.call(COST.list, "playlistItems.list", () =>
        a.yt.playlistItems.list({
          part: ["contentDetails"],
          playlistId: uploads!,
          maxResults: args.max_results,
          pageToken: args.page_token,
        }),
      );
      const ids = (page.items ?? [])
        .map((i) => i.contentDetails?.videoId)
        .filter((x): x is string => Boolean(x));
      let videos = (
        await a.getVideos(ids, [
          "snippet",
          "status",
          "contentDetails",
          "statistics",
        ])
      ).map((v) => ({
        id: v.id,
        url: v.id ? videoUrl(v.id) : undefined,
        title: v.snippet?.title,
        privacy: v.status?.privacyStatus,
        publish_at: v.status?.publishAt ?? undefined,
        published_at: v.snippet?.publishedAt,
        upload_status: v.status?.uploadStatus,
        duration: v.contentDetails?.duration,
        views: v.statistics?.viewCount,
        likes: v.statistics?.likeCount,
        comments: v.statistics?.commentCount,
      }));
      if (args.privacy)
        videos = videos.filter((v) => v.privacy === args.privacy);
      if (args.query)
        videos = videos.filter((v) =>
          (v.title ?? "").toLowerCase().includes(args.query!.toLowerCase()),
        );
      return ok({
        channel: row.title,
        total_on_channel: page.pageInfo?.totalResults,
        videos,
        next_page_token: page.nextPageToken ?? null,
      });
    }),
  );

  server.registerTool(
    "get_video",
    {
      title: "Get video details",
      description:
        "Full details of one video: metadata, privacy and schedule, processing state, duration, captions flag and statistics.",
      inputSchema: { video_id: z.string(), channel: channelArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ video_id, channel }) =>
      ok(summariseVideo(await (await api(channel)).getVideo(video_id))),
    ),
  );

  server.registerTool(
    "update_video",
    {
      title: "Edit video metadata",
      description:
        "Change a video’s title, description, tags, category, languages, audience and other settings. Only the fields you pass change. Optionally apply a template to the fields you pass (title format; footer and hashtags when you pass description; template tags when you pass tags). Changing visibility to public/unlisted or scheduling needs the user’s confirmation (or use set_visibility).",
      inputSchema: {
        video_id: z.string(),
        title: z.string().max(100).optional(),
        description: z.string().max(5000).optional(),
        tags: z.array(z.string()).optional(),
        category_id: z.string().optional(),
        default_language: z.string().optional(),
        default_audio_language: z.string().optional(),
        made_for_kids: z.boolean().optional(),
        contains_synthetic_media: z.boolean().optional(),
        embeddable: z.boolean().optional(),
        license: z.enum(["youtube", "creativeCommon"]).optional(),
        public_stats_viewable: z.boolean().optional(),
        privacy: z.enum(PRIVACY).optional(),
        publish_at: z
          .string()
          .optional()
          .describe(
            "ISO 8601 date-time to schedule publishing (keeps the video private until then).",
          ),
        template: z
          .string()
          .optional()
          .describe(
            "Apply this template to the title/description/tags given here.",
          ),
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
      const changes: VideoChanges = { ...args };
      const warnings: string[] = [];
      if (args.template) {
        if (!args.title)
          throw new YtError(
            "invalid_request",
            "Pass the title too when applying a template.",
          );
        const m = applyTemplate({ ...args, title: args.title }, app.templates.get(args.template));
        // Only fields the caller passed change; the template decorates them (title format, footer, extra tags).
        changes.title = m.title;
        if (args.description !== undefined) changes.description = m.description;
        if (args.tags !== undefined) changes.tags = m.tags;
        warnings.push(...m.warnings);
      }
      if (changes.description)
        warnings.push(...checkChapters(changes.description));
      if (args.publish_at && Number.isNaN(Date.parse(args.publish_at)))
        throw new YtError(
          "invalid_request",
          "publish_at is not a valid date-time.",
        );
      const publicFacing =
        Boolean(args.publish_at) ||
        (args.privacy !== undefined && args.privacy !== "private");
      const gate = await confirmGate(
        app,
        server,
        "update_video",
        args,
        `Change video ${args.video_id}: ${Object.keys(args)
          .filter(
            (k) => !["video_id", "channel", "confirmation_token"].includes(k),
          )
          .join(
            ", ",
          )}${args.privacy ? ` → ${args.privacy.toUpperCase()}` : ""}${args.publish_at ? ` → scheduled ${args.publish_at}` : ""}`,
        { publicFacing },
      );
      if (gate) return gate;
      const { after } = await applyVideoChanges(a, args.video_id, changes);
      app.db.audit(
        "video.updated",
        { fields: Object.keys(args) },
        undefined,
        args.video_id,
      );
      const lock = lockNote(args.publish_at ? "public" : args.privacy, after);
      if (lock) warnings.push(lock);
      return ok({ video: summariseVideo(after), warnings });
    }),
  );

  server.registerTool(
    "set_visibility",
    {
      title: "Publish, unlist, hide or schedule",
      description:
        "Change who can see a video: private, unlisted or public, or schedule it with publish_at. Anything other than private needs the user’s confirmation.",
      inputSchema: {
        video_id: z.string(),
        privacy: z.enum(PRIVACY).optional(),
        publish_at: z
          .string()
          .optional()
          .describe(
            "ISO 8601 date-time to go public; the video stays private until then.",
          ),
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
      if (!args.privacy && !args.publish_at)
        throw new YtError("invalid_request", "Pass privacy or publish_at.");
      if (
        args.publish_at &&
        (Number.isNaN(Date.parse(args.publish_at)) ||
          Date.parse(args.publish_at) < Date.now())
      ) {
        throw new YtError(
          "invalid_request",
          "publish_at must be a future ISO 8601 date-time.",
        );
      }
      const a = await api(args.channel);
      const cur = await a.getVideo(args.video_id, ["snippet", "status"]);
      const target = args.publish_at
        ? `SCHEDULED to go public at ${new Date(args.publish_at).toISOString()}`
        : args.privacy!.toUpperCase();
      const gate = await confirmGate(
        app,
        server,
        "set_visibility",
        args,
        `Make "${cur.snippet?.title}" (${args.video_id}) ${target}. Currently: ${cur.status?.privacyStatus}.`,
        {
          publicFacing: Boolean(args.publish_at) || args.privacy !== "private",
        },
      );
      if (gate) return gate;
      const { after } = await applyVideoChanges(a, args.video_id, {
        privacy: args.publish_at ? "private" : args.privacy,
        publish_at: args.publish_at
          ? new Date(args.publish_at).toISOString()
          : args.privacy
            ? null
            : undefined,
      });
      app.db.audit(
        "video.visibility",
        { privacy: args.privacy, publish_at: args.publish_at },
        undefined,
        args.video_id,
      );
      const lock = lockNote(args.publish_at ? "public" : args.privacy, after);
      return ok({ video: summariseVideo(after), warning: lock });
    }),
  );

  server.registerTool(
    "delete_video",
    {
      title: "Delete a video",
      description:
        "Permanently delete a video from YouTube. Cannot be undone. Always needs the user’s confirmation.",
      inputSchema: {
        video_id: z.string(),
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
      const cur = await a.getVideo(args.video_id, [
        "snippet",
        "status",
        "statistics",
      ]);
      const gate = await confirmGate(
        app,
        server,
        "delete_video",
        args,
        `PERMANENTLY DELETE "${cur.snippet?.title}" (${args.video_id}, ${cur.status?.privacyStatus}, ${cur.statistics?.viewCount ?? 0} views). This cannot be undone.`,
        { publicFacing: false, destructive: true },
      );
      if (gate) return gate;
      await a.call(
        COST.videosDelete,
        "videos.delete",
        () => a.yt.videos.delete({ id: args.video_id }),
        false,
      );
      app.db.audit(
        "video.deleted",
        { title: cur.snippet?.title },
        undefined,
        args.video_id,
      );
      return ok({ deleted: args.video_id, title: cur.snippet?.title });
    }),
  );

  server.registerTool(
    "set_thumbnail",
    {
      title: "Set custom thumbnail",
      description:
        "Upload a JPG or PNG (max 2 MB, ideally 1280x720) from this computer as the video’s thumbnail. The channel must be phone-verified.",
      inputSchema: {
        video_id: z.string(),
        image_path: z.string().describe("Absolute path to the image."),
        channel: channelArg,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    safe(async ({ video_id, image_path, channel }) => {
      const r = await setThumbnail(await api(channel), video_id, image_path);
      app.db.audit("video.thumbnail", {}, undefined, video_id);
      return ok(r);
    }),
  );

  server.registerTool(
    "list_categories",
    {
      title: "List video categories",
      description:
        "YouTube video categories you can assign (id and name) for a region.",
      inputSchema: {
        region_code: z.string().length(2).default("US"),
        channel: channelArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ region_code, channel }) => {
      const a = await api(channel);
      const data = await a.call(COST.list, "videoCategories.list", () =>
        a.yt.videoCategories.list({
          part: ["snippet"],
          regionCode: region_code,
        }),
      );
      return ok({
        categories: (data.items ?? [])
          .filter((c) => c.snippet?.assignable)
          .map((c) => ({ id: c.id, name: c.snippet?.title })),
      });
    }),
  );
}
