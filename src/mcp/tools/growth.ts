import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { App } from "../../app.js";
import { isoDurationSeconds } from "../../ai/brief.js";
import { YtError } from "../../errors.js";
import { AB_METRICS, resolveStartDay } from "../../experiments.js";
import {
  bestPublishTime,
  channelVideos,
  outlierScores,
  researchTopic,
  seoCheck,
} from "../../growth.js";
import { expandPath, inspectThumbnail } from "../../upload/sources.js";
import { channelArg, confirmArg, confirmGate, ok, safe } from "../helpers.js";

const variantShape = z.object({
  title: z.string().max(100).optional(),
  thumbnail_path: z.string().optional().describe("JPG/PNG up to 2 MB on this computer."),
  description: z.string().max(5000).optional(),
});

export function registerGrowthTools(server: McpServer, app: App) {
  const ctx = async (channel?: string) => {
    const row = app.channels.resolve(channel);
    return { row, api: await app.channels.api(row) };
  };

  // ---- A/B tests -----------------------------------------------------------------------------------
  server.registerTool(
    "create_ab_test",
    {
      title: "A/B test titles, thumbnails or descriptions",
      description: [
        "Tests 1-3 challenger versions of a live video against its current version (A). The server rotates which version is live one full day at a time (Pacific days, matching YouTube Analytics), in balanced random order so weekdays even out,",
        "then compares daily views, watch time, average view percentage, subscribers or engagement, adjusting for the video's natural decline in daily views, with a significance test.",
        "At the end it restores A, waits ~3 days for analytics to land, and (if auto_apply_winner) puts a significant winner live.",
        "YouTube Studio's own Test & Compare (with impressions click-through rate) has no API; this works on any channel through the official APIs.",
        "Each variant can change title, thumbnail and/or description. Changes are public, so the user confirms first.",
      ].join(" "),
      inputSchema: {
        video_id: z.string(),
        variants: z
          .array(variantShape)
          .min(1)
          .max(3)
          .describe("Challengers B, C, D. Fields left out stay as in A."),
        days: z
          .number()
          .int()
          .min(6)
          .max(60)
          .default(14)
          .describe("Test length; at least 3 days per version."),
        metric: z.enum(AB_METRICS).default("views").describe("What decides the winner."),
        start: z
          .string()
          .default("tomorrow")
          .describe('"tomorrow" (recommended: full clean days), "today", or YYYY-MM-DD (Pacific).'),
        auto_apply_winner: z.boolean().default(true),
        original_thumbnail_path: z
          .string()
          .optional()
          .describe(
            "The current thumbnail file (needed for thumbnail tests when YouTube has no 1280x720 copy of it).",
          ),
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
      const row = app.channels.resolve(args.channel);
      const startOn = resolveStartDay(args.start);
      // Check every file before asking the user, so approval is never wasted on a bad path.
      for (const v of args.variants) if (v.thumbnail_path) await inspectThumbnail(v.thumbnail_path);
      if (args.original_thumbnail_path) await inspectThumbnail(args.original_thumbnail_path);
      const summary = [
        `A/B test on video ${args.video_id} ("${row.title}"), starting ${startOn} (Pacific) for ${Math.max(args.days, (args.variants.length + 1) * 3)} days, winner by ${args.metric}.`,
        ...args.variants.map(
          (v, i) =>
            `${String.fromCharCode(66 + i)}: ${[v.title && `title "${v.title}"`, v.thumbnail_path && `thumbnail ${v.thumbnail_path}`, v.description && "new description"].filter(Boolean).join(", ")}`,
        ),
        `Viewers will see these versions on different days.${args.auto_apply_winner ? " A significant winner is applied automatically at the end." : ""}`,
      ].join("\n");
      const gate = await confirmGate(app, server, "create_ab_test", args, summary, {
        publicFacing: true,
      });
      if (gate) return gate;
      const out = await app.experiments.create({
        channelRowId: row.id,
        videoId: args.video_id,
        variants: args.variants,
        days: args.days,
        metric: args.metric,
        startOn,
        autoApply: args.auto_apply_winner,
        originalThumbnail: args.original_thumbnail_path
          ? expandPath(args.original_thumbnail_path)
          : undefined,
      });
      if (startOn === out.starts_on) await app.scheduler.tick();
      return ok(
        out,
        "A/B test created. Keep the background service running (`npx @joinhackyard/youtube-channel-mcp service install`) so rotations happen even when no AI app is open.",
      );
    }),
  );

  server.registerTool(
    "list_ab_tests",
    {
      title: "List A/B tests",
      description:
        "A/B tests with their status (scheduled, running, collecting results, completed, stopped), live variant and winner.",
      inputSchema: {
        status: z
          .enum(["scheduled", "running", "collecting", "completed", "stopped", "failed"])
          .optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async ({ status }) =>
      ok({
        tests: app.experiments.list(status).map((e) => ({
          test_id: e.id,
          video_id: e.video_id,
          status: e.status,
          metric: e.metric,
          starts_on: e.starts_on,
          ends_on: e.ends_on,
          live_variant: e.current_variant,
          winner: e.winner,
          error: e.error ?? undefined,
        })),
      }),
    ),
  );

  server.registerTool(
    "get_ab_test",
    {
      title: "A/B test details and results",
      description:
        "Schedule, live variant and results so far (per-variant daily averages, lift vs the original, p-values, verdict). Results become reliable once every version has 3+ clean days; analytics lag about 2 days.",
      inputSchema: {
        test_id: z.string(),
        refresh: z
          .boolean()
          .default(true)
          .describe("Rotate now if due, and compute fresh interim results."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    safe(async ({ test_id, refresh }) => {
      if (refresh) await app.scheduler.tick();
      return ok(await app.experiments.describe(test_id, refresh));
    }),
  );

  server.registerTool(
    "stop_ab_test",
    {
      title: "Stop an A/B test",
      description:
        "Stops a test and puts the chosen version live (A = original). Public change, so the user confirms first.",
      inputSchema: {
        test_id: z.string(),
        keep: z.string().default("A").describe("Variant to leave live: A, B, C or D."),
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
      const gate = await confirmGate(
        app,
        server,
        "stop_ab_test",
        args,
        `Stop A/B test ${args.test_id} and keep variant ${args.keep} live.`,
        { publicFacing: true },
      );
      if (gate) return gate;
      return ok(await app.experiments.stop(args.test_id, args.keep.toUpperCase()));
    }),
  );

  // ---- research & optimisation ---------------------------------------------------------------------
  server.registerTool(
    "seo_check",
    {
      title: "SEO and packaging score",
      description:
        "Scores a video's (or draft's) title, description, tags, hashtags and chapters against YouTube best practice, 0-100 with fixes in order of impact. No AI needed; 1 quota unit for a video_id, none for a draft.",
      inputSchema: {
        video_id: z.string().optional(),
        title: z.string().optional(),
        description: z.string().optional(),
        tags: z.array(z.string()).optional(),
        keyword: z.string().optional().describe("The main search phrase you want to rank for."),
        duration_seconds: z.number().optional(),
        channel: channelArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (args) => {
      if (args.video_id) {
        const { api } = await ctx(args.channel);
        const v = await api.getVideo(args.video_id, ["snippet", "contentDetails"]);
        return ok({
          video_id: args.video_id,
          ...seoCheck({
            title: v.snippet?.title ?? "",
            description: v.snippet?.description ?? "",
            tags: v.snippet?.tags ?? [],
            keyword: args.keyword,
            durationSeconds: isoDurationSeconds(v.contentDetails?.duration),
          }),
        });
      }
      if (!args.title)
        throw new YtError(
          "invalid_request",
          "Pass video_id, or title (and description/tags) of a draft.",
        );
      return ok(
        seoCheck({
          title: args.title,
          description: args.description ?? "",
          tags: args.tags,
          keyword: args.keyword,
          durationSeconds: args.duration_seconds,
        }),
      );
    }),
  );

  server.registerTool(
    "find_outliers",
    {
      title: "Channel outliers",
      description:
        "Ranks the channel's videos by outlier score (views ÷ the median of neighbouring uploads of the same format). Shows what over-performed (repeat it) and what under-performed (fix packaging or drop the topic). Shorts and long videos are compared separately.",
      inputSchema: {
        max_videos: z.number().int().min(10).max(500).default(100),
        format: z.enum(["all", "long", "short"]).default("all"),
        channel: channelArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ max_videos, format, channel }) => {
      const { row, api } = await ctx(channel);
      if (!row.uploads_playlist_id)
        throw new YtError("not_found", "Could not find the channel's uploads.");
      let scored = outlierScores(
        await channelVideos(api, row.uploads_playlist_id, max_videos),
      ).filter((v) => v.outlier_score !== null);
      if (format !== "all") scored = scored.filter((v) => v.is_short === (format === "short"));
      const by = [...scored].sort((a, b) => (b.outlier_score ?? 0) - (a.outlier_score ?? 0));
      const view = (v: (typeof by)[number]) => ({
        id: v.id,
        url: `https://youtu.be/${v.id}`,
        title: v.title,
        published_at: v.published_at,
        short: v.is_short,
        views: v.views,
        expected_views: v.expected_views,
        outlier_score: v.outlier_score,
      });
      return ok({
        analysed: scored.length,
        top: by.slice(0, 10).map(view),
        bottom: by
          .filter((v) => v.age_days > 14)
          .slice(-10)
          .reverse()
          .map(view),
        note: "3.0 = three times this channel's usual views. Recent videos are still growing; judge them after 2-4 weeks.",
      });
    }),
  );

  server.registerTool(
    "research_topic",
    {
      title: "Research a topic on YouTube",
      description:
        "Searches YouTube for recent videos on a topic and ranks them by breakout ratio (views ÷ the uploader's subscribers: above 1 means it reached far beyond its audience), with title patterns (length, numbers, questions, common words) and typical duration. Costs about 102+ quota units per call.",
      inputSchema: {
        query: z.string().min(2),
        days: z.number().int().min(1).max(365).default(90),
        region_code: z.string().length(2).optional(),
        max_results: z.number().int().min(5).max(50).default(25),
        order: z.enum(["viewCount", "relevance", "date"]).default("viewCount"),
        duration: z
          .enum(["short", "medium", "long"])
          .optional()
          .describe("short <4 min, medium 4-20, long >20."),
        channel: channelArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async (args) => {
      const { api } = await ctx(args.channel);
      return ok(
        await researchTopic(api, {
          query: args.query,
          days: args.days,
          regionCode: args.region_code,
          max: args.max_results,
          order: args.order,
          duration: args.duration,
        }),
      );
    }),
  );

  server.registerTool(
    "best_publish_time",
    {
      title: "Best day and time to publish",
      description:
        "Compares first-week views of the channel's recent public uploads by weekday and time of day they were published (in your time zone), relative to the channel median. Uses YouTube Analytics; needs 6+ videos older than a week.",
      inputSchema: {
        time_zone: z
          .string()
          .default(Intl.DateTimeFormat().resolvedOptions().timeZone)
          .describe("IANA time zone, e.g. Asia/Kolkata."),
        sample: z.number().int().min(6).max(60).default(30),
        channel: channelArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    safe(async ({ time_zone, sample, channel }) => {
      const { row, api } = await ctx(channel);
      if (!row.uploads_playlist_id)
        throw new YtError("not_found", "Could not find the channel's uploads.");
      const vids = await channelVideos(api, row.uploads_playlist_id, Math.max(sample * 2, 50));
      return ok(await bestPublishTime(api, vids, time_zone, sample));
    }),
  );
}
