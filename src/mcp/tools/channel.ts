import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { youtube_v3 } from "@googleapis/youtube";
import { z } from "zod";
import type { App } from "../../app.js";
import { classifyGoogleError, YtError } from "../../errors.js";
import { ANALYTICS_SCOPE } from "../../google/oauth.js";
import type { YouTubeApi } from "../../google/youtube.js";
import { COST } from "../../quota.js";
import { expandPath, readHead } from "../../upload/sources.js";
import { channelArg, confirmArg, confirmGate, ok, safe } from "../helpers.js";

async function fullChannel(
  api: YouTubeApi,
): Promise<youtube_v3.Schema$Channel> {
  const data = await api.call(COST.list, "channels.list", () =>
    api.yt.channels.list({
      part: [
        "snippet",
        "statistics",
        "brandingSettings",
        "status",
        "contentDetails",
        "topicDetails",
        "localizations",
      ],
      mine: true,
    }),
  );
  const ch = data.items?.[0];
  if (!ch?.id) throw new YtError("not_found", "Could not read the channel.");
  return ch;
}

async function imageFile(path: string, maxBytes: number) {
  const full = expandPath(path);
  const s = await stat(full).catch(() => null);
  if (!s?.isFile()) throw new YtError("file_error", `Image not found: ${full}`);
  if (s.size > maxBytes)
    throw new YtError(
      "file_error",
      `Image is ${(s.size / 1024 / 1024).toFixed(1)} MB; the limit is ${maxBytes / 1024 / 1024} MB.`,
    );
  const head = await readHead(full, 8);
  const mime =
    head[0] === 0xff && head[1] === 0xd8
      ? "image/jpeg"
      : head.toString("latin1", 1, 4) === "PNG"
        ? "image/png"
        : null;
  if (!mime) throw new YtError("file_error", "Use a JPG or PNG image.");
  return { path: full, mime };
}

const shortComment = (c?: youtube_v3.Schema$Comment) =>
  c
    ? {
        comment_id: c.id,
        author: c.snippet?.authorDisplayName,
        author_channel_id: c.snippet?.authorChannelId?.value,
        text: c.snippet?.textDisplay ?? c.snippet?.textOriginal,
        likes: c.snippet?.likeCount,
        published_at: c.snippet?.publishedAt,
        updated_at:
          c.snippet?.updatedAt !== c.snippet?.publishedAt
            ? c.snippet?.updatedAt
            : undefined,
        moderation_status: c.snippet?.moderationStatus ?? undefined,
      }
    : undefined;

// ---- analytics -----------------------------------------------------------------------------------

const REPORTS = {
  overview: {
    metrics:
      "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,subscribersLost,likes,comments,shares",
  },
  daily: {
    metrics:
      "views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost",
    dimensions: "day",
    sort: "day",
  },
  top_videos: {
    metrics:
      "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,likes",
    dimensions: "video",
    sort: "-views",
    maxResults: 25,
  },
  traffic_sources: {
    metrics: "views,estimatedMinutesWatched",
    dimensions: "insightTrafficSourceType",
    sort: "-views",
  },
  search_terms: {
    metrics: "views",
    dimensions: "insightTrafficSourceDetail",
    filters: "insightTrafficSourceType==YT_SEARCH",
    sort: "-views",
    maxResults: 25,
  },
  geography: {
    metrics: "views,estimatedMinutesWatched,averageViewDuration",
    dimensions: "country",
    sort: "-views",
    maxResults: 25,
  },
  devices: {
    metrics: "views,estimatedMinutesWatched",
    dimensions: "deviceType",
    sort: "-views",
  },
  demographics: {
    metrics: "viewerPercentage",
    dimensions: "ageGroup,gender",
    sort: "-viewerPercentage",
  },
  retention: {
    metrics: "audienceWatchRatio,relativeRetentionPerformance",
    dimensions: "elapsedVideoTimeRatio",
    sort: "elapsedVideoTimeRatio",
  },
  subscribed_status: {
    metrics: "views,estimatedMinutesWatched,averageViewDuration",
    dimensions: "subscribedStatus",
  },
} as const;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export async function queryAnalytics(
  api: YouTubeApi,
  params: Record<string, string | number>,
) {
  try {
    const res = await api.auth.request<{
      columnHeaders?: { name: string }[];
      rows?: unknown[][];
    }>({
      url: "https://youtubeanalytics.googleapis.com/v2/reports",
      params: { ids: "channel==MINE", ...params },
    });
    const cols = (res.data.columnHeaders ?? []).map((c) => c.name);
    return (res.data.rows ?? []).map((r) =>
      Object.fromEntries(cols.map((c, i) => [c, r[i]])),
    );
  } catch (err) {
    const e = classifyGoogleError(err, "YouTube Analytics");
    if (e.code === "forbidden" || e.opts.status === 403) {
      throw new YtError(
        "forbidden",
        `YouTube Analytics refused the request: ${e.message}`,
        {
          hint: 'Make sure the "YouTube Analytics API" is enabled in your Google Cloud project (https://console.cloud.google.com/apis/library/youtubeanalytics.googleapis.com), then run connect_channel again so the analytics permission is granted.',
        },
      );
    }
    throw e;
  }
}

export function registerChannelTools(server: McpServer, app: App) {
  const api = async (channel?: string) =>
    app.channels.api(app.channels.resolve(channel));

  // ---- channel profile & branding ----------------------------------------------------------------
  server.registerTool(
    "get_channel",
    {
      title: "Channel profile and stats",
      description:
        "The channel’s title, handle, description, keywords, country, default language, trailer, subscriber/view/video counts, banner and settings.",
      inputSchema: { channel: channelArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ channel }) => {
      const ch = await fullChannel(await api(channel));
      const b = ch.brandingSettings?.channel;
      return ok({
        channel_id: ch.id,
        title: ch.snippet?.title,
        handle: ch.snippet?.customUrl,
        url: ch.snippet?.customUrl
          ? `https://www.youtube.com/${ch.snippet.customUrl}`
          : `https://www.youtube.com/channel/${ch.id}`,
        description: b?.description ?? ch.snippet?.description,
        keywords: b?.keywords,
        country: b?.country ?? ch.snippet?.country,
        default_language: b?.defaultLanguage ?? ch.snippet?.defaultLanguage,
        unsubscribed_trailer: b?.unsubscribedTrailer,
        created_at: ch.snippet?.publishedAt,
        subscribers: ch.statistics?.hiddenSubscriberCount
          ? "hidden"
          : ch.statistics?.subscriberCount,
        views: ch.statistics?.viewCount,
        videos: ch.statistics?.videoCount,
        banner: ch.brandingSettings?.image?.bannerExternalUrl,
        avatar:
          ch.snippet?.thumbnails?.high?.url ??
          ch.snippet?.thumbnails?.default?.url,
        made_for_kids: ch.status?.madeForKids,
        long_uploads: ch.status?.longUploadsStatus,
        privacy: ch.status?.privacyStatus,
        topics: ch.topicDetails?.topicCategories,
        localizations: ch.localizations ?? undefined,
      });
    }),
  );

  server.registerTool(
    "update_channel",
    {
      title: "Edit channel profile",
      description:
        "Change the channel description, keywords, country, default language or the trailer shown to non-subscribers. Only the fields you pass change. These are public, so the user confirms first. (The channel name and handle can only be changed in YouTube Studio.)",
      inputSchema: {
        description: z.string().max(1000).optional(),
        keywords: z
          .string()
          .max(500)
          .optional()
          .describe(
            'Space-separated; wrap multi-word keywords in quotes, e.g. hackathon "startup India".',
          ),
        country: z
          .string()
          .length(2)
          .optional()
          .describe("ISO country code, e.g. IN, US."),
        default_language: z.string().optional().describe('e.g. "en".'),
        unsubscribed_trailer: z
          .string()
          .optional()
          .describe("Video id to show non-subscribers as the channel trailer."),
        localizations: z
          .record(
            z.string(),
            z.object({
              title: z.string().optional(),
              description: z.string().optional(),
            }),
          )
          .optional()
          .describe(
            'Channel title/description per language, e.g. {"hi": {"description": "..."}}. Merged with existing ones.',
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
      const ch = await fullChannel(a);
      const fields = [
        "description",
        "keywords",
        "country",
        "default_language",
        "unsubscribed_trailer",
        "localizations",
      ].filter((k) => args[k as keyof typeof args] !== undefined);
      if (!fields.length)
        throw new YtError("invalid_request", "Nothing to change.");
      const gate = await confirmGate(
        app,
        server,
        "update_channel",
        args,
        `Update the public profile of "${ch.snippet?.title}": ${fields.join(", ")}.`,
        { publicFacing: true },
      );
      if (gate) return gate;
      const cur = ch.brandingSettings?.channel ?? {};
      const out: youtube_v3.Schema$Channel = { id: ch.id };
      const parts: string[] = [];
      if (fields.some((f) => f !== "localizations")) {
        // channels.update replaces the whole brandingSettings part: start from what is there now.
        out.brandingSettings = {
          channel: {
            description: args.description ?? cur.description,
            keywords: args.keywords ?? cur.keywords,
            country: args.country ?? cur.country,
            defaultLanguage: args.default_language ?? cur.defaultLanguage,
            unsubscribedTrailer:
              args.unsubscribed_trailer ?? cur.unsubscribedTrailer,
            defaultTab: cur.defaultTab,
            moderateComments: cur.moderateComments,
            showRelatedChannels: cur.showRelatedChannels,
            showBrowseView: cur.showBrowseView,
            featuredChannelsTitle: cur.featuredChannelsTitle,
            featuredChannelsUrls: cur.featuredChannelsUrls,
            profileColor: cur.profileColor,
            trackingAnalyticsAccountId: cur.trackingAnalyticsAccountId,
          },
          image: ch.brandingSettings?.image,
          watch: ch.brandingSettings?.watch,
        };
        parts.push("brandingSettings");
      }
      if (args.localizations) {
        const merged: Record<string, youtube_v3.Schema$ChannelLocalization> = {
          ...(ch.localizations ?? {}),
        };
        for (const [lang, l] of Object.entries(args.localizations))
          merged[lang] = { ...merged[lang], ...l };
        out.localizations = merged;
        parts.push("localizations");
      }
      await a.call(
        COST.channelsUpdate,
        "channels.update",
        () => a.yt.channels.update({ part: parts, requestBody: out }),
        false,
      );
      app.db.audit("channel.updated", { fields }, ch.id ?? undefined);
      return ok({ updated: fields, channel_id: ch.id });
    }),
  );

  server.registerTool(
    "set_channel_banner",
    {
      title: "Set channel banner",
      description:
        "Upload a channel banner (JPG/PNG, 16:9, at least 2048x1152, ideally 2560x1440, max 6 MB). Public, so the user confirms first.",
      inputSchema: {
        image_path: z.string(),
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
      const img = await imageFile(args.image_path, 6 * 1024 * 1024);
      const a = await api(args.channel);
      const ch = await fullChannel(a);
      const gate = await confirmGate(
        app,
        server,
        "set_channel_banner",
        args,
        `Replace the banner of "${ch.snippet?.title}" with ${img.path}.`,
        { publicFacing: true },
      );
      if (gate) return gate;
      const banner = await a.call(
        COST.channelBannersInsert,
        "channelBanners.insert",
        () =>
          a.yt.channelBanners.insert({
            media: { mimeType: img.mime, body: createReadStream(img.path) },
          }),
        false,
      );
      if (!banner.url)
        throw new YtError(
          "server_error",
          "YouTube did not return a banner URL.",
        );
      await a.call(
        COST.channelsUpdate,
        "channels.update",
        () =>
          a.yt.channels.update({
            part: ["brandingSettings"],
            requestBody: {
              id: ch.id,
              brandingSettings: {
                channel: ch.brandingSettings?.channel,
                watch: ch.brandingSettings?.watch,
                image: {
                  ...ch.brandingSettings?.image,
                  bannerExternalUrl: banner.url,
                },
              },
            },
          }),
        false,
      );
      app.db.audit("channel.banner", {}, ch.id ?? undefined);
      return ok({
        banner_url: banner.url,
        note: "YouTube can take a few minutes to show the new banner.",
      });
    }),
  );

  server.registerTool(
    "set_watermark",
    {
      title: "Set or remove the video watermark",
      description:
        "Set the subscribe watermark shown on all channel videos (square JPG/PNG, at least 150x150, max 1 MB), or remove it with remove: true.",
      inputSchema: {
        image_path: z.string().optional(),
        remove: z.boolean().default(false),
        show: z
          .enum(["entire_video", "end", "custom"])
          .default("entire_video")
          .describe(
            "entire_video, the last 15 seconds (end), or from offset_seconds (custom).",
          ),
        offset_seconds: z.number().int().min(0).optional(),
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
      const row = app.channels.resolve(args.channel);
      const gate = await confirmGate(
        app,
        server,
        "set_watermark",
        args,
        args.remove ? `Remove the watermark from all videos on "${row.title}".` : `Show ${args.image_path} as a watermark on all videos of "${row.title}" (${args.show}).`,
        { publicFacing: true },
      );
      if (gate) return gate;
      const a = await app.channels.api(row);
      if (args.remove) {
        await a.call(
          COST.watermarks,
          "watermarks.unset",
          () => a.yt.watermarks.unset({ channelId: row.channel_id }),
          false,
        );
        return ok({ removed: true });
      }
      if (!args.image_path)
        throw new YtError(
          "invalid_request",
          "Pass image_path, or remove: true.",
        );
      const img = await imageFile(args.image_path, 1024 * 1024);
      const timing: youtube_v3.Schema$InvideoTiming =
        args.show === "end"
          ? { type: "offsetFromEnd", offsetMs: "15000" }
          : {
              type: "offsetFromStart",
              offsetMs: String(
                (args.show === "custom" ? (args.offset_seconds ?? 0) : 0) *
                  1000,
              ),
            };
      await a.call(
        COST.watermarks,
        "watermarks.set",
        () =>
          a.yt.watermarks.set({
            channelId: row.channel_id,
            requestBody: { timing },
            media: { mimeType: img.mime, body: createReadStream(img.path) },
          }),
        false,
      );
      return ok({ watermark_set: true, timing });
    }),
  );

  // ---- comments ------------------------------------------------------------------------------------
  server.registerTool(
    "list_comments",
    {
      title: "List comments",
      description:
        "Comment threads on one video, or across the whole channel (newest first). Filter by moderation state (published, held_for_review, likely_spam) or search text. Includes replies.",
      inputSchema: {
        video_id: z
          .string()
          .optional()
          .describe("Omit for comments across all channel videos."),
        status: z
          .enum(["published", "held_for_review", "likely_spam"])
          .default("published"),
        search: z.string().optional(),
        order: z.enum(["time", "relevance"]).default("time"),
        max_results: z.number().int().min(1).max(100).default(30),
        page_token: z.string().optional(),
        channel: channelArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (args) => {
      const row = app.channels.resolve(args.channel);
      const a = await app.channels.api(row);
      const status = {
        published: "published",
        held_for_review: "heldForReview",
        likely_spam: "likelySpam",
      }[args.status];
      const data = await a.call(COST.list, "commentThreads.list", () =>
        a.yt.commentThreads.list({
          part: ["snippet", "replies"],
          ...(args.video_id
            ? { videoId: args.video_id }
            : { allThreadsRelatedToChannelId: row.channel_id }),
          moderationStatus: status,
          searchTerms: args.search,
          order: args.order,
          maxResults: args.max_results,
          pageToken: args.page_token,
          textFormat: "plainText",
        }),
      );
      return ok({
        threads: (data.items ?? []).map((t) => ({
          thread_id: t.id,
          video_id: t.snippet?.videoId,
          ...shortComment(t.snippet?.topLevelComment),
          reply_count: t.snippet?.totalReplyCount,
          can_reply: t.snippet?.canReply,
          replies: (t.replies?.comments ?? []).map(shortComment),
        })),
        next_page_token: data.nextPageToken ?? null,
      });
    }),
  );

  server.registerTool(
    "reply_to_comment",
    {
      title: "Reply or comment as the channel",
      description:
        "Post a public reply to a comment (comment_id = the top-level comment or thread id) or a new top-level comment on a video (video_id). Posts publicly as the channel, so the user confirms the exact text first.",
      inputSchema: {
        text: z.string().min(1).max(10000),
        comment_id: z.string().optional(),
        video_id: z.string().optional(),
        channel: channelArg,
        confirmation_token: confirmArg,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      if (!args.comment_id === !args.video_id)
        throw new YtError(
          "invalid_request",
          "Pass exactly one of comment_id (reply) or video_id (new comment).",
        );
      const row = app.channels.resolve(args.channel);
      const gate = await confirmGate(
        app,
        server,
        "reply_to_comment",
        args,
        `Post publicly as "${row.title}" ${args.comment_id ? `in reply to comment ${args.comment_id}` : `on video ${args.video_id}`}:\n"${args.text}"`,
        { publicFacing: true },
      );
      if (gate) return gate;
      const a = await app.channels.api(row);
      if (args.comment_id) {
        const c = await a.call(
          COST.commentsInsert,
          "comments.insert",
          () =>
            a.yt.comments.insert({
              part: ["snippet"],
              requestBody: {
                snippet: { parentId: args.comment_id, textOriginal: args.text },
              },
            }),
          false,
        );
        app.db.audit(
          "comment.reply",
          { parent: args.comment_id },
          row.channel_id,
        );
        return ok({ posted: shortComment(c) });
      }
      const t = await a.call(
        COST.commentsInsert,
        "commentThreads.insert",
        () =>
          a.yt.commentThreads.insert({
            part: ["snippet"],
            requestBody: {
              snippet: {
                videoId: args.video_id,
                topLevelComment: { snippet: { textOriginal: args.text } },
              },
            },
          }),
        false,
      );
      app.db.audit("comment.posted", {}, row.channel_id, args.video_id);
      return ok({
        posted: shortComment(t.snippet?.topLevelComment),
        note: "Pin it in YouTube Studio if needed; the API cannot pin comments.",
      });
    }),
  );

  server.registerTool(
    "moderate_comments",
    {
      title: "Moderate comments",
      description:
        "Publish held comments, hold comments for review, or remove (reject) them; optionally ban the author from commenting on the channel. Removing or banning needs the user’s confirmation.",
      inputSchema: {
        comment_ids: z.array(z.string()).min(1).max(50),
        action: z.enum(["publish", "hold", "remove"]),
        ban_author: z
          .boolean()
          .default(false)
          .describe(
            "Only with remove: also hide this person’s future comments.",
          ),
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
      if (args.ban_author && args.action !== "remove")
        throw new YtError(
          "invalid_request",
          "ban_author only works with action: remove.",
        );
      const destructive = args.action === "remove";
      const gate = await confirmGate(
        app,
        server,
        "moderate_comments",
        args,
        `${args.action.toUpperCase()} ${args.comment_ids.length} comment(s)${args.ban_author ? " and BAN their authors" : ""}.`,
        { publicFacing: false, destructive },
      );
      if (gate) return gate;
      const a = await api(args.channel);
      const status = {
        publish: "published",
        hold: "heldForReview",
        remove: "rejected",
      }[args.action];
      await a.call(
        COST.commentsModerate,
        "comments.setModerationStatus",
        () =>
          a.yt.comments.setModerationStatus({
            id: args.comment_ids,
            moderationStatus: status,
            banAuthor: args.ban_author || undefined,
          }),
        false,
      );
      app.db.audit("comments.moderated", {
        action: args.action,
        count: args.comment_ids.length,
        ban: args.ban_author,
      });
      return ok({
        moderated: args.comment_ids.length,
        action: args.action,
        banned: args.ban_author,
      });
    }),
  );

  server.registerTool(
    "delete_comment",
    {
      title: "Delete the channel’s own comment",
      description:
        "Delete a comment or reply that the channel itself wrote (other people’s comments are removed with moderate_comments). Needs the user’s confirmation.",
      inputSchema: {
        comment_id: z.string(),
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
      const gate = await confirmGate(
        app,
        server,
        "delete_comment",
        args,
        `Delete the channel’s comment ${args.comment_id}.`,
        { publicFacing: false, destructive: true },
      );
      if (gate) return gate;
      const a = await api(args.channel);
      await a.call(
        COST.commentsModerate,
        "comments.delete",
        () => a.yt.comments.delete({ id: args.comment_id }),
        false,
      );
      return ok({ deleted: args.comment_id });
    }),
  );

  // ---- analytics -----------------------------------------------------------------------------------
  server.registerTool(
    "get_analytics",
    {
      title: "Channel and video analytics",
      description: [
        "YouTube Analytics for the channel or one video. Reports:",
        "overview (views, watch time, average view duration, subscribers gained/lost, likes, comments, shares),",
        "daily (trend by day), top_videos (best performers with titles), traffic_sources, search_terms (YouTube search queries),",
        "geography, devices, demographics (age/gender), retention (audience retention curve, needs video_id), subscribed_status,",
        "or custom (your own metrics/dimensions). Defaults to the last 28 days. Data lags about 2 days.",
      ].join(" "),
      inputSchema: {
        report: z
          .enum([
            "overview",
            "daily",
            "top_videos",
            "traffic_sources",
            "search_terms",
            "geography",
            "devices",
            "demographics",
            "retention",
            "subscribed_status",
            "custom",
          ])
          .default("overview"),
        video_id: z
          .string()
          .optional()
          .describe("Limit the report to one video."),
        start_date: z
          .string()
          .optional()
          .describe("YYYY-MM-DD; default 28 days before end_date."),
        end_date: z.string().optional().describe("YYYY-MM-DD; default today."),
        metrics: z
          .string()
          .optional()
          .describe(
            "custom only: comma-separated metrics, e.g. views,likes,cardClickRate.",
          ),
        dimensions: z
          .string()
          .optional()
          .describe("custom only: e.g. day,country."),
        filters: z
          .string()
          .optional()
          .describe("custom only: e.g. country==IN;video==abc."),
        sort: z.string().optional(),
        max_results: z.number().int().min(1).max(200).optional(),
        channel: channelArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (args) => {
      const row = app.channels.resolve(args.channel);
      if (row.scopes && !row.scopes.split(" ").includes(ANALYTICS_SCOPE)) {
        throw new YtError(
          "forbidden",
          "This channel was connected without the analytics permission.",
          {
            hint: "Run connect_channel again (and enable the YouTube Analytics API in Google Cloud).",
          },
        );
      }
      const a = await app.channels.api(row);
      const end = args.end_date ?? isoDay(new Date());
      const start =
        args.start_date ?? isoDay(new Date(Date.parse(end) - 28 * 86_400_000));
      let spec: {
        metrics: string;
        dimensions?: string;
        filters?: string;
        sort?: string;
        maxResults?: number;
      };
      if (args.report === "custom") {
        if (!args.metrics)
          throw new YtError("invalid_request", "custom reports need metrics.");
        spec = {
          metrics: args.metrics,
          dimensions: args.dimensions,
          filters: args.filters,
          sort: args.sort,
          maxResults: args.max_results,
        };
      } else {
        spec = { ...REPORTS[args.report] };
        if (args.sort) spec.sort = args.sort;
        if (args.max_results) spec.maxResults = args.max_results;
      }
      if (args.report === "retention" && !args.video_id)
        throw new YtError(
          "invalid_request",
          "The retention report needs video_id.",
        );
      if (args.video_id) {
        if (args.report === "top_videos")
          throw new YtError(
            "invalid_request",
            "top_videos is channel-wide; omit video_id.",
          );
        spec.filters = [spec.filters, `video==${args.video_id}`]
          .filter(Boolean)
          .join(";");
      }
      const params: Record<string, string | number> = {
        startDate: start,
        endDate: end,
        metrics: spec.metrics,
      };
      if (spec.dimensions) params.dimensions = spec.dimensions;
      if (spec.filters) params.filters = spec.filters;
      if (spec.sort) params.sort = spec.sort;
      if (spec.maxResults) params.maxResults = spec.maxResults;
      let rows = await queryAnalytics(a, params);
      if (spec.dimensions?.split(",").includes("video") && rows.length) {
        const vids = await a.getVideos(
          rows.map((r) => String(r.video)),
          ["snippet"],
        );
        const titles = new Map(vids.map((v) => [v.id, v.snippet?.title]));
        rows = rows.map((r) => ({
          title: titles.get(String(r.video)),
          url: `https://youtu.be/${r.video}`,
          ...r,
        }));
      }
      return ok({
        report: args.report,
        channel: row.title,
        video_id: args.video_id,
        start_date: start,
        end_date: end,
        rows,
        note: rows.length
          ? undefined
          : "No data for this range yet (analytics lag about 2 days).",
      });
    }),
  );
}
