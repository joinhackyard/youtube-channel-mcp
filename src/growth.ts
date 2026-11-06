import type { youtube_v3 } from "@googleapis/youtube";
import { checkChapters, isoDurationSeconds } from "./ai/brief.js";
import { YtError } from "./errors.js";
import type { YouTubeApi } from "./google/youtube.js";
import { queryAnalytics } from "./analytics.js";
import { COST, quotaDay } from "./quota.js";
import { median, round } from "./stats.js";
import { tagsLength } from "./templates.js";

// ---- SEO ------------------------------------------------------------------------------------------

export interface SeoInput {
  title: string;
  description: string;
  tags?: string[];
  keyword?: string;
  durationSeconds?: number;
}

/** Deterministic packaging/SEO checklist, 0-100. No API calls. */
export function seoCheck(m: SeoInput) {
  const checks: { id: string; ok: boolean; weight: number; message: string }[] = [];
  const add = (id: string, ok: boolean, weight: number, message: string) =>
    checks.push({ id, ok, weight, message });
  const t = m.title.trim();
  const d = m.description ?? "";
  const kw = m.keyword?.trim().toLowerCase();
  const firstLine = d.split("\n").find((l) => l.trim()) ?? "";
  const letters = t.replace(/[^A-Za-z]/g, "");
  const upper = letters.replace(/[^A-Z]/g, "").length;
  const hashtags = d.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? [];
  const tags = m.tags ?? [];

  add(
    "title_length",
    t.length >= 20 && t.length <= 70,
    12,
    `Title is ${t.length} characters; aim for 20-70 (about 60 shows fully on most screens).`,
  );
  if (kw) {
    const pos = t.toLowerCase().indexOf(kw);
    add(
      "keyword_in_title",
      pos >= 0,
      14,
      pos >= 0 ? "Main keyword is in the title." : `Put "${m.keyword}" in the title.`,
    );
    add(
      "keyword_early",
      pos >= 0 && pos <= 30,
      6,
      "Front-load the keyword (within the first ~30 characters).",
    );
    add(
      "keyword_in_description",
      d.slice(0, 200).toLowerCase().includes(kw),
      10,
      "Use the keyword in the first two lines of the description.",
    );
  }
  add(
    "description_length",
    d.length >= 250,
    10,
    `Description is ${d.length} characters; 250+ gives YouTube more context.`,
  );
  add(
    "first_line",
    firstLine.length > 0 && firstLine.length <= 150,
    6,
    "First description line should be a short hook (shown in search and above the fold).",
  );
  if ((m.durationSeconds ?? 0) >= 300) {
    const issues = checkChapters(d);
    const hasChapters = /^\s*\(?(?:\d+:)?\d{1,2}:\d{2}\)?\s+\S/m.test(d);
    add(
      "chapters",
      hasChapters && !issues.length,
      10,
      hasChapters
        ? (issues[0] ?? "Chapters look valid.")
        : "Add chapters (0:00 first, at least 3) for videos over 5 minutes.",
    );
  }
  add(
    "tags",
    tags.length >= 5 && tags.length <= 20 && tagsLength(tags) <= 500,
    8,
    `${tags.length} tags; 5-15 relevant tags, under 500 characters.`,
  );
  add(
    "hashtags",
    hashtags.length >= 1 && hashtags.length <= 5,
    6,
    hashtags.length > 15
      ? "More than 15 hashtags: YouTube ignores all of them."
      : `${hashtags.length} hashtags; use 1-5.`,
  );
  add(
    "no_shouting",
    letters.length < 8 || upper / letters.length < 0.35,
    6,
    "Avoid ALL CAPS titles; they read as spam.",
  );
  add("no_bait_punctuation", !/[!?]{2,}/.test(t), 4, "Avoid repeated !!! or ???.");
  add(
    "call_to_action",
    /https?:\/\/|subscribe|link|comment/i.test(d),
    4,
    "Add a link or a call to action.",
  );
  add(
    "not_truncated_ellipsis",
    !/\.{3}$|…$/.test(t),
    4,
    "Don't end titles with an ellipsis; finish the thought.",
  );

  const total = checks.reduce((a, c) => a + c.weight, 0);
  const got = checks.reduce((a, c) => a + (c.ok ? c.weight : 0), 0);
  const score = Math.round((got / total) * 100);
  return {
    score,
    grade: score >= 85 ? "A" : score >= 70 ? "B" : score >= 55 ? "C" : "D",
    fixes: checks
      .filter((c) => !c.ok)
      .sort((a, b) => b.weight - a.weight)
      .map((c) => c.message),
    passed: checks.filter((c) => c.ok).map((c) => c.id),
  };
}

// ---- channel videos & outliers --------------------------------------------------------------------

export interface VideoStat {
  id: string;
  title: string;
  published_at: string;
  age_days: number;
  duration_seconds?: number;
  is_short: boolean;
  privacy?: string;
  views: number;
  likes: number;
  comments: number;
  views_per_day: number;
}

export async function channelVideos(
  api: YouTubeApi,
  uploadsPlaylistId: string,
  max = 50,
): Promise<VideoStat[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = await api.call(COST.list, "playlistItems.list", () =>
      api.yt.playlistItems.list({
        part: ["contentDetails"],
        playlistId: uploadsPlaylistId,
        maxResults: 50,
        pageToken,
      }),
    );
    for (const i of page.items ?? [])
      if (i.contentDetails?.videoId) ids.push(i.contentDetails.videoId);
    pageToken = page.nextPageToken ?? undefined;
  } while (pageToken && ids.length < max);
  const videos = await api.getVideos(ids.slice(0, max), [
    "snippet",
    "statistics",
    "contentDetails",
    "status",
  ]);
  return videos.map(toStat).filter((v): v is VideoStat => Boolean(v));
}

function toStat(v: youtube_v3.Schema$Video): VideoStat | null {
  if (!v.id || !v.snippet?.publishedAt) return null;
  const age = Math.max(1 / 24, (Date.now() - Date.parse(v.snippet.publishedAt)) / 86_400_000);
  const dur = isoDurationSeconds(v.contentDetails?.duration);
  const views = Number(v.statistics?.viewCount ?? 0);
  return {
    id: v.id,
    title: v.snippet.title ?? "",
    published_at: v.snippet.publishedAt,
    age_days: round(age, 1) ?? 0,
    duration_seconds: dur,
    is_short: dur !== undefined && dur <= 180,
    privacy: v.status?.privacyStatus ?? undefined,
    views,
    likes: Number(v.statistics?.likeCount ?? 0),
    comments: Number(v.statistics?.commentCount ?? 0),
    views_per_day: round(views / age, 1) ?? 0,
  };
}

/**
 * Outlier score = views / median views of the channel's neighbouring uploads of the same format
 * (long vs Short), so a 3.0 means "three times what this channel usually gets".
 */
export function outlierScores(videos: VideoStat[], window = 10) {
  const sorted = [...videos]
    .filter((v) => v.privacy !== "private")
    .sort((a, b) => a.published_at.localeCompare(b.published_at));
  return sorted.map((v, i) => {
    const peers = sorted
      .filter((p, j) => j !== i && p.is_short === v.is_short && Math.abs(j - i) <= window)
      .map((p) => p.views);
    const base = median(peers);
    return {
      ...v,
      expected_views: Number.isFinite(base) ? Math.round(base) : null,
      outlier_score: base > 0 ? round(v.views / base, 2) : null,
    };
  });
}

// ---- topic research -------------------------------------------------------------------------------

export async function researchTopic(
  api: YouTubeApi,
  opts: {
    query: string;
    regionCode?: string;
    days: number;
    max: number;
    order: "viewCount" | "relevance" | "date";
    duration?: "short" | "medium" | "long";
  },
) {
  const after = new Date(Date.now() - opts.days * 86_400_000).toISOString();
  const search = await api.call(COST.search, "search.list", () =>
    api.yt.search.list({
      part: ["snippet"],
      q: opts.query,
      type: ["video"],
      order: opts.order,
      publishedAfter: after,
      regionCode: opts.regionCode,
      maxResults: Math.min(50, opts.max),
      videoDuration:
        opts.duration === "short"
          ? "short"
          : opts.duration === "long"
            ? "long"
            : opts.duration === "medium"
              ? "medium"
              : undefined,
    }),
  );
  const ids = (search.items ?? []).map((i) => i.id?.videoId).filter((x): x is string => Boolean(x));
  const videos = await api.getVideos(ids, ["snippet", "statistics", "contentDetails"]);
  const channelIds = [
    ...new Set(videos.map((v) => v.snippet?.channelId).filter((x): x is string => Boolean(x))),
  ];
  const subs = new Map<string, number>();
  for (let i = 0; i < channelIds.length; i += 50) {
    const ch = await api.call(COST.list, "channels.list", () =>
      api.yt.channels.list({
        part: ["statistics"],
        id: channelIds.slice(i, i + 50),
        maxResults: 50,
      }),
    );
    for (const c of ch.items ?? [])
      if (c.id) subs.set(c.id, Number(c.statistics?.subscriberCount ?? 0));
  }
  const rows = videos
    .map((v) => {
      const s = toStat(v);
      if (!s) return null;
      const subscribers = subs.get(v.snippet?.channelId ?? "") ?? 0;
      return {
        ...s,
        url: `https://youtu.be/${s.id}`,
        channel: v.snippet?.channelTitle,
        channel_subscribers: subscribers,
        /** Views relative to the channel's size: above 1 means the video reached beyond its subscribers. */
        breakout_ratio: subscribers > 0 ? round(s.views / subscribers, 2) : null,
      };
    })
    .filter(<T>(x: T | null): x is T => Boolean(x))
    .sort((a, b) => (b.breakout_ratio ?? 0) - (a.breakout_ratio ?? 0));
  const titles = rows.map((r) => r.title);
  const words = new Map<string, number>();
  for (const t of titles) {
    for (const w of new Set(t.toLowerCase().match(/[\p{L}\p{N}']{3,}/gu) ?? []))
      words.set(w, (words.get(w) ?? 0) + 1);
  }
  const stop = new Set([
    "the",
    "and",
    "for",
    "with",
    "this",
    "that",
    "you",
    "your",
    "how",
    "what",
    "are",
    "from",
    "why",
    "was",
    "has",
    "have",
    "into",
    "about",
  ]);
  return {
    query: opts.query,
    since: after.slice(0, 10),
    quota_units_used: COST.search + 1 + Math.ceil(channelIds.length / 50),
    breakouts: rows.filter((r) => (r.breakout_ratio ?? 0) >= 2).length,
    patterns: {
      median_title_length: Math.round(median(titles.map((t) => t.length))) || null,
      share_with_numbers: round(
        titles.filter((t) => /\d/.test(t)).length / (titles.length || 1),
        2,
      ),
      share_questions: round(
        titles.filter((t) => t.includes("?")).length / (titles.length || 1),
        2,
      ),
      median_duration_seconds:
        Math.round(median(rows.map((r) => r.duration_seconds ?? 0).filter(Boolean))) || null,
      common_words: [...words.entries()]
        .filter(([w]) => !stop.has(w))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([w, n]) => ({ word: w, videos: n })),
    },
    videos: rows,
  };
}

// ---- best publish time ----------------------------------------------------------------------------

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export async function bestPublishTime(
  api: YouTubeApi,
  videos: VideoStat[],
  timeZone: string,
  sample = 30,
) {
  const eligible = videos.filter((v) => v.age_days >= 8 && v.privacy === "public").slice(0, sample);
  if (eligible.length < 6) {
    throw new YtError(
      "invalid_request",
      `Only ${eligible.length} public videos older than a week; need at least 6 for a useful answer.`,
    );
  }
  const rows: { weekday: string; hour: number; first_week_views: number; short: boolean }[] = [];
  for (const v of eligible) {
    // YouTube Analytics days are Pacific Time.
    const start = quotaDay(new Date(v.published_at));
    const end = new Date(Date.parse(`${start}T12:00:00Z`) + 6 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const r = await queryAnalytics(api, {
      startDate: start,
      endDate: end,
      metrics: "views",
      filters: `video==${v.id}`,
    });
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(v.published_at));
    rows.push({
      weekday: parts.find((p) => p.type === "weekday")?.value ?? "?",
      hour: Number(parts.find((p) => p.type === "hour")?.value ?? 0),
      first_week_views: Number(r[0]?.views ?? 0),
      short: v.is_short,
    });
  }
  const base = median(rows.map((r) => r.first_week_views)) || 1;
  const group = (key: (r: (typeof rows)[number]) => string) => {
    const m = new Map<string, number[]>();
    for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r.first_week_views / base]);
    return [...m.entries()]
      .map(([k, xs]) => ({
        slot: k,
        videos: xs.length,
        relative_first_week_views: round(median(xs), 2),
      }))
      .sort((a, b) => (b.relative_first_week_views ?? 0) - (a.relative_first_week_views ?? 0));
  };
  const bucket = (h: number) => (h < 6 ? "00-06" : h < 12 ? "06-12" : h < 18 ? "12-18" : "18-24");
  return {
    time_zone: timeZone,
    videos_analysed: rows.length,
    by_weekday: group((r) => r.weekday).sort(
      (a, b) => (b.relative_first_week_views ?? 0) - (a.relative_first_week_views ?? 0),
    ),
    by_time_of_day: group((r) => bucket(r.hour)),
    note:
      "1.0 = this channel's median first-week views. Slots with 1-2 videos are anecdotes; topic matters more than timing. Days listed: " +
      DAYS.join(", "),
  };
}

// ---- one video's full picture ---------------------------------------------------------------------

export async function videoFacts(api: YouTubeApi, videoId: string, channelVideosList: VideoStat[]) {
  const v = await api.getVideo(videoId, ["snippet", "statistics", "contentDetails", "status"]);
  const stat = toStat(v);
  if (!stat) throw new YtError("not_found", "Video has no publish date yet.");
  const start = quotaDay(new Date(stat.published_at));
  const today = quotaDay();
  const warnings: string[] = [];
  const soft = (what: string) => (err: Error) => {
    warnings.push(`${what} unavailable: ${err.message}`);
    return [] as Record<string, unknown>[];
  };
  const totals = await queryAnalytics(api, {
    startDate: start,
    endDate: today,
    metrics:
      "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,subscribersLost,likes,comments,shares",
    filters: `video==${videoId}`,
  }).catch(soft("Totals"));
  const retention = await queryAnalytics(api, {
    startDate: start,
    endDate: today,
    metrics: "audienceWatchRatio,relativeRetentionPerformance",
    dimensions: "elapsedVideoTimeRatio",
    filters: `video==${videoId}`,
  }).catch(soft("Analytics"));
  const traffic = await queryAnalytics(api, {
    startDate: start,
    endDate: today,
    metrics: "views",
    dimensions: "insightTrafficSourceType",
    filters: `video==${videoId}`,
    sort: "-views",
  }).catch(soft("Analytics"));
  const searchTerms = await queryAnalytics(api, {
    startDate: start,
    endDate: today,
    metrics: "views",
    dimensions: "insightTrafficSourceDetail",
    filters: `video==${videoId};insightTrafficSourceType==YT_SEARCH`,
    sort: "-views",
    maxResults: 10,
  }).catch(soft("Analytics"));
  const dur = stat.duration_seconds ?? 0;
  const at = (ratio: number) => {
    const p = retention.reduce<{ d: number; r: Record<string, unknown> } | null>((best, r) => {
      const d = Math.abs(Number(r.elapsedVideoTimeRatio) - ratio);
      return !best || d < best.d ? { d, r } : best;
    }, null);
    return p ? round(Number(p.r.audienceWatchRatio), 3) : null;
  };
  const peers = channelVideosList.filter(
    (p) => p.id !== videoId && p.is_short === stat.is_short && p.privacy === "public",
  );
  const scored = outlierScores([...peers, stat]).find((s) => s.id === videoId);
  return {
    video: {
      id: videoId,
      title: v.snippet?.title,
      published_at: stat.published_at,
      age_days: stat.age_days,
      duration_seconds: dur,
      is_short: stat.is_short,
      privacy: v.status?.privacyStatus,
    },
    stats: {
      views: stat.views,
      likes: stat.likes,
      comments: stat.comments,
      views_per_day: stat.views_per_day,
    },
    analytics: totals[0] ?? null,
    retention: retention.length
      ? {
          hook_30s: dur ? at(Math.min(1, 30 / dur)) : null,
          at_25_percent: at(0.25),
          at_50_percent: at(0.5),
          at_75_percent: at(0.75),
          end: at(1),
          note: "audienceWatchRatio: share of viewers still watching (can exceed 1 with rewatches). relativeRetentionPerformance vs similar-length videos is in the curve.",
          curve: retention
            .filter((_, i) => i % 5 === 0)
            .map((r) => ({
              at: Number(r.elapsedVideoTimeRatio),
              watching: round(Number(r.audienceWatchRatio), 3),
              vs_similar: round(Number(r.relativeRetentionPerformance), 2),
            })),
        }
      : null,
    traffic_sources: traffic,
    youtube_search_terms: searchTerms,
    channel_baseline: {
      compared_with: peers.length,
      median_views: Math.round(median(peers.map((p) => p.views))) || null,
      median_views_per_day: round(median(peers.map((p) => p.views_per_day)), 1),
      outlier_score: scored?.outlier_score ?? null,
    },
    warnings,
    seo: seoCheck({
      title: v.snippet?.title ?? "",
      description: v.snippet?.description ?? "",
      tags: v.snippet?.tags ?? [],
      durationSeconds: dur,
    }),
    metadata: {
      title: v.snippet?.title,
      description: v.snippet?.description,
      tags: v.snippet?.tags ?? [],
    },
  };
}
