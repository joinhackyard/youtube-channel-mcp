import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { queryAnalytics } from "./analytics.js";
import type { Channels } from "./channels.js";
import type { Config } from "./config.js";
import { newId } from "./crypto.js";
import type { Db } from "./db.js";
import { YtError } from "./errors.js";
import type { YouTubeApi } from "./google/youtube.js";
import { log } from "./log.js";
import { applyVideoChanges } from "./mcp/tools/videos.js";
import { quotaDay } from "./quota.js";
import { mean, ols, round } from "./stats.js";
import { inspectThumbnail } from "./upload/sources.js";
import { setThumbnail } from "./videoOps.js";

export const AB_METRICS = [
  "views",
  "watch_time",
  "avg_view_percentage",
  "avg_view_duration",
  "subscribers",
  "engagement",
] as const;
export type AbMetric = (typeof AB_METRICS)[number];

/** Analytics data for a day is usually complete about 2-3 days later. */
const DATA_LAG_DAYS = 3;
/** A variant applied more than this many hours into the (Pacific) day is not a clean exposure. */
const CLEAN_WITHIN_HOURS = 3;

export interface VariantInput {
  title?: string;
  description?: string;
  thumbnail_path?: string;
}

interface ExperimentRow {
  id: string;
  channel_row_id: string;
  video_id: string;
  status: "scheduled" | "running" | "collecting" | "completed" | "stopped" | "failed";
  metric: AbMetric;
  starts_on: string;
  ends_on: string;
  schedule: string;
  current_variant: string | null;
  live_thumb: string | null;
  failures: number;
  auto_apply: number;
  winner: string | null;
  result: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
}

interface VariantRow {
  experiment_id: string;
  label: string;
  title: string | null;
  description: string | null;
  thumbnail_path: string | null;
  is_original: number;
}

const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Hours elapsed since midnight Pacific Time (YouTube Analytics days are Pacific). */
function hoursIntoPacificDay(at = new Date()): number {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  return (
    Number(p.find((x) => x.type === "hour")?.value ?? 0) +
    Number(p.find((x) => x.type === "minute")?.value ?? 0) / 60
  );
}

/** Each block of k days shows every variant once in random order, so weekday effects average out. */
export function blockSchedule(
  labels: string[],
  startDay: string,
  days: number,
  rand = Math.random,
): { day: string; variant: string }[] {
  const out: { day: string; variant: string }[] = [];
  while (out.length < days) {
    const block = [...labels];
    for (let i = block.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [block[i], block[j]] = [block[j], block[i]];
    }
    for (const v of block)
      if (out.length < days) out.push({ day: addDays(startDay, out.length), variant: v });
  }
  return out;
}

export interface DayPoint {
  day: string;
  variant: string;
  value: number;
}

/**
 * Compare variants on daily values with one regression: value ~ intercept + day + one dummy per challenger.
 * Counts (views, watch time, subscribers) are log-transformed. The day term absorbs the video's natural drift
 * (daily views usually decline), so each challenger's coefficient is its effect at the same point in time.
 * P-values are Bonferroni-corrected for the number of challengers before a winner is declared.
 */
export function analyse(points: DayPoint[], metric: AbMetric, labels: string[]) {
  const logScale = metric === "views" || metric === "watch_time" || metric === "subscribers";
  const first = points.length ? Date.parse(`${points[0].day}T12:00:00Z`) : 0;
  const dayNo = (d: string) => Math.round((Date.parse(`${d}T12:00:00Z`) - first) / 86_400_000);
  const ys = points.map((p) => (logScale ? Math.log1p(p.value) : p.value));
  const challengers = labels.slice(1);
  const X = points.map((p) => [
    1,
    dayNo(p.day),
    ...challengers.map((l) => (p.variant === l ? 1 : 0)),
  ]);
  const fit = points.length > X[0]?.length + 1 ? ols(X, ys) : null;
  const raw = (l: string) => points.filter((p) => p.variant === l).map((p) => p.value);
  const controlMean = mean(raw(labels[0]));
  const m = challengers.length;
  const variants = labels.map((l, i) => {
    const days = raw(l).length;
    if (i === 0)
      return {
        variant: l,
        days,
        mean_per_day: round(controlMean, 2),
        lift_vs_original: null,
        p_value: null,
        p_adjusted: null,
      };
    const b = fit?.beta[1 + i];
    const p = fit?.p[1 + i];
    const lift = b === undefined ? NaN : logScale ? Math.expm1(b) : b / Math.abs(controlMean || 1);
    return {
      variant: l,
      days,
      mean_per_day: round(mean(raw(l)), 2),
      lift_vs_original: round(lift * 100, 1),
      p_value: p === undefined ? null : round(p, 4),
      p_adjusted: p === undefined || !Number.isFinite(p) ? null : round(Math.min(1, p * m), 4),
    };
  });
  const enough = variants.every((v) => v.days >= 3) && fit !== null;
  const tested = variants.slice(1).filter((v) => v.p_adjusted !== null);
  const best = [...tested].sort(
    (a, b) => (b.lift_vs_original ?? -Infinity) - (a.lift_vs_original ?? -Infinity),
  )[0];
  let winner: string | null = null;
  let verdict: string;
  if (!enough) verdict = "Not enough clean days yet (need at least 3 per variant).";
  else if (best && (best.lift_vs_original ?? 0) > 0 && (best.p_adjusted ?? 1) < 0.05) {
    winner = best.variant;
    verdict = `Variant ${best.variant} beat the original by ${best.lift_vs_original}% (adjusted p=${best.p_adjusted}).`;
  } else if (
    tested.length &&
    tested.every((c) => (c.lift_vs_original ?? 0) < 0 && (c.p_adjusted ?? 1) < 0.05)
  ) {
    winner = labels[0];
    verdict = "The original beat every challenger.";
  } else {
    verdict = "No significant difference: keep the original, or run longer / test a bolder change.";
  }
  const trend = fit?.beta[1];
  return {
    metric,
    winner,
    verdict,
    significant: winner !== null,
    trend_per_day:
      trend === undefined ? null : round(logScale ? Math.expm1(trend) * 100 : trend, 2),
    method:
      "OLS: value ~ day + variant (log scale for counts), Bonferroni-corrected across challengers",
    variants,
  };
}

const METRIC_SOURCE: Record<AbMetric, string> = {
  views: "views",
  watch_time: "estimatedMinutesWatched",
  avg_view_percentage: "averageViewPercentage",
  avg_view_duration: "averageViewDuration",
  subscribers: "subscribersGained",
  engagement: "views,likes,comments,shares",
};

export class Experiments {
  constructor(
    private readonly db: Db,
    private readonly cfg: Config,
    private readonly channels: Channels,
  ) {}

  private dir(id: string) {
    const d = join(this.cfg.home, "experiments", id);
    mkdirSync(d, { recursive: true });
    return d;
  }

  get(id: string): ExperimentRow {
    const e = this.db.get<ExperimentRow>("select * from experiments where id = ?", id);
    if (!e)
      throw new YtError("not_found", `No A/B test ${id}.`, { hint: "list_ab_tests shows them." });
    return e;
  }

  variants(id: string): VariantRow[] {
    return this.db.all<VariantRow>(
      "select * from experiment_variants where experiment_id = ? order by label",
      id,
    );
  }

  list(status?: string): ExperimentRow[] {
    return status
      ? this.db.all<ExperimentRow>(
          "select * from experiments where status = ? order by created_at desc",
          status,
        )
      : this.db.all<ExperimentRow>("select * from experiments order by created_at desc limit 50");
  }

  activeFor(videoId: string) {
    return this.db.get<ExperimentRow>(
      "select * from experiments where video_id = ? and status in ('scheduled','running','collecting')",
      videoId,
    );
  }

  async create(input: {
    channelRowId: string;
    videoId: string;
    variants: VariantInput[];
    days: number;
    metric: AbMetric;
    startOn: string;
    autoApply: boolean;
    /** Image already used as the live thumbnail (e.g. just uploaded), kept as variant A. */
    originalThumbnail?: string;
  }) {
    if (!input.variants.length || input.variants.length > 3)
      throw new YtError(
        "invalid_request",
        "Give 1 to 3 challenger variants (the current version is variant A).",
      );
    if (this.activeFor(input.videoId))
      throw new YtError(
        "invalid_request",
        "This video already has an A/B test running. Stop it first.",
      );
    const row = this.channels.byRowId(input.channelRowId);
    if (!row) throw new YtError("not_connected", "Channel not connected.");
    const api = await this.channels.api(row);
    const v = await api.getVideo(input.videoId, ["snippet", "status"]);
    if (v.status?.privacyStatus === "private" && !v.status.publishAt) {
      throw new YtError(
        "invalid_request",
        "A/B tests need viewers: the video is private. Make it public or unlisted (or schedule it) first.",
      );
    }
    const labels = ["A", ...input.variants.map((_, i) => String.fromCharCode(66 + i))];
    const days = Math.max(input.days, labels.length * 3);
    const id = `ab_${newId()}`;
    const dir = this.dir(id);

    // Variant A is today's live version. Keep a full-size copy of its thumbnail so it can be restored.
    let originalThumb: string | null = null;
    const anyThumb = input.variants.some((x) => x.thumbnail_path);
    if (anyThumb && input.originalThumbnail) {
      const img = await inspectThumbnail(input.originalThumbnail);
      originalThumb = join(dir, `A${extname(img.path).toLowerCase() || ".jpg"}`);
      copyFileSync(img.path, originalThumb);
    } else if (anyThumb) {
      // Only maxres (1280x720) is a faithful copy: smaller sizes are below YouTube's minimum or letterboxed.
      const thumbUrl = v.snippet?.thumbnails?.maxres?.url;
      if (!thumbUrl) {
        throw new YtError(
          "invalid_request",
          "YouTube has no full-size (1280x720) copy of the current thumbnail to restore later.",
          {
            hint: "Pass original_thumbnail_path with the current thumbnail file (JPG/PNG at least 1280x720).",
          },
        );
      }
      const res = await fetch(thumbUrl);
      if (!res.ok)
        throw new YtError(
          "server_error",
          `Could not download the current thumbnail (HTTP ${res.status}).`,
        );
      originalThumb = join(dir, "A.jpg");
      writeFileSync(originalThumb, Buffer.from(await res.arrayBuffer()));
    }
    const rows: VariantRow[] = [
      {
        experiment_id: id,
        label: "A",
        title: v.snippet?.title ?? null,
        description: v.snippet?.description ?? null,
        thumbnail_path: originalThumb,
        is_original: 1,
      },
    ];
    for (const [i, x] of input.variants.entries()) {
      if (!x.title && !x.description && !x.thumbnail_path)
        throw new YtError("invalid_request", `Variant ${labels[i + 1]} changes nothing.`);
      let thumb: string | null = null;
      if (x.thumbnail_path) {
        const img = await inspectThumbnail(x.thumbnail_path);
        thumb = join(dir, `${labels[i + 1]}${extname(img.path).toLowerCase() || ".jpg"}`);
        copyFileSync(img.path, thumb);
      }
      if (x.title && x.title.length > 100)
        throw new YtError(
          "invalid_request",
          `Variant ${labels[i + 1]} title is over 100 characters.`,
        );
      rows.push({
        experiment_id: id,
        label: labels[i + 1],
        title: x.title ?? rows[0].title,
        description: x.description ?? rows[0].description,
        thumbnail_path: thumb ?? originalThumb,
        is_original: 0,
      });
    }
    const schedule = blockSchedule(labels, input.startOn, days);
    const now = Date.now();
    this.db.tx(() => {
      this.db.run(
        `insert into experiments(id, channel_row_id, video_id, status, metric, starts_on, ends_on, schedule, current_variant, live_thumb, auto_apply, created_at, updated_at)
         values (?, ?, ?, 'scheduled', ?, ?, ?, ?, 'A', 'A', ?, ?, ?)`,
        id,
        input.channelRowId,
        input.videoId,
        input.metric,
        input.startOn,
        schedule[schedule.length - 1].day,
        JSON.stringify(schedule),
        input.autoApply ? 1 : 0,
        now,
        now,
      );
      for (const r of rows) {
        this.db.run(
          "insert into experiment_variants(experiment_id, label, title, description, thumbnail_path, is_original) values (?, ?, ?, ?, ?, ?)",
          r.experiment_id,
          r.label,
          r.title,
          r.description,
          r.thumbnail_path,
          r.is_original,
        );
      }
    });
    this.db.audit(
      "abtest.created",
      { id, variants: labels.length, days, metric: input.metric },
      row.channel_id,
      input.videoId,
    );
    return this.describe(id);
  }

  /**
   * Put a variant live. Title and description are compared with what is actually live on YouTube (so a half-finished
   * earlier rotation or a manual edit is corrected); the thumbnail is tracked separately because it can't be read back.
   * current_variant only changes once everything is live.
   */
  private async apply(api: YouTubeApi, e: ExperimentRow, label: string) {
    const vs = this.variants(e.id);
    const target = vs.find((v) => v.label === label);
    if (!target) throw new YtError("not_found", `Variant ${label} not found.`);
    const live = await api.getVideo(e.video_id, ["snippet"]);
    const changes: { title?: string; description?: string } = {};
    if (target.title && target.title !== live.snippet?.title) changes.title = target.title;
    if (target.description !== null && target.description !== (live.snippet?.description ?? ""))
      changes.description = target.description;
    if (Object.keys(changes).length) await applyVideoChanges(api, e.video_id, changes);
    const liveThumb = vs.find((v) => v.label === (this.get(e.id).live_thumb ?? "A"));
    if (target.thumbnail_path && target.thumbnail_path !== liveThumb?.thumbnail_path) {
      await setThumbnail(api, e.video_id, target.thumbnail_path);
      this.db.run("update experiments set live_thumb = ? where id = ?", label, e.id);
    }
    this.db.run(
      "update experiments set current_variant = ?, updated_at = ? where id = ?",
      label,
      Date.now(),
      e.id,
    );
  }

  /** Move to `to` only if the test is still in `from` (several processes may share the database). */
  private transition(id: string, from: string[], to: string, extra = ""): boolean {
    return (
      this.db.run(
        `update experiments set status = ?, updated_at = ?${extra} where id = ? and status in (${from.map(() => "?").join(",")})`,
        to,
        Date.now(),
        id,
        ...from,
      ).changes === 1
    );
  }

  private isActive(id: string) {
    const st = this.db.get<{ status: string }>(
      "select status from experiments where id = ?",
      id,
    )?.status;
    return st === "scheduled" || st === "running" || st === "collecting";
  }

  /**
   * Advance active tests: rotate today's variant, end finished ones (restore A), analyse once data has landed.
   * `keepAlive` is called between tests so the scheduler can renew its lease; returning false stops the tick.
   */
  async tick(keepAlive: () => boolean = () => true) {
    const active = this.db.all<ExperimentRow>(
      "select * from experiments where status in ('scheduled','running','collecting')",
    );
    const today = quotaDay();
    for (const e of active) {
      if (!keepAlive()) return;
      if (
        e.failures > 0 &&
        Date.now() - e.updated_at < Math.min(3_600_000, 300_000 * 2 ** (e.failures - 1))
      )
        continue;
      try {
        const row = this.channels.byRowId(e.channel_row_id);
        if (!row) throw new YtError("not_connected", "Channel no longer connected.");
        const api = await this.channels.api(row);
        const schedule = JSON.parse(e.schedule) as { day: string; variant: string }[];
        if (today > e.ends_on) {
          if (e.status !== "collecting") {
            if (!this.isActive(e.id)) continue;
            if (this.get(e.id).current_variant !== "A" || this.get(e.id).live_thumb !== "A")
              await this.apply(api, e, "A");
            this.transition(e.id, ["scheduled", "running"], "collecting");
          }
          if (today >= addDays(e.ends_on, DATA_LAG_DAYS)) await this.finish(api, this.get(e.id));
        } else {
          const planned = schedule.find((s) => s.day === today);
          if (!planned) continue; // not started yet
          this.transition(e.id, ["scheduled"], "running");
          const already = this.db.get(
            "select 1 from experiment_exposures where experiment_id = ? and day = ?",
            e.id,
            today,
          );
          if (!already && this.isActive(e.id)) {
            const before = this.get(e.id);
            const wasLive = before.current_variant === planned.variant;
            // Always apply: it checks the live video and fixes drift (manual edits, a half-finished rotation).
            await this.apply(api, before, planned.variant);
            const clean = wasLive || hoursIntoPacificDay() <= CLEAN_WITHIN_HOURS;
            this.db.run(
              "insert or ignore into experiment_exposures(experiment_id, label, day, applied_at, clean) values (?, ?, ?, ?, ?)",
              e.id,
              planned.variant,
              today,
              Date.now(),
              clean ? 1 : 0,
            );
            log.info("abtest rotated", { id: e.id, day: today, variant: planned.variant, clean });
          }
        }
        if (e.failures)
          this.db.run("update experiments set failures = 0, error = null where id = ?", e.id);
      } catch (err) {
        await this.recordFailure(e, err);
      }
    }
  }

  /** Back off on errors; give up (and try to restore A) on permanent ones or after 12 attempts. */
  private async recordFailure(e: ExperimentRow, err: unknown) {
    const y = err instanceof YtError ? err : new YtError("unknown", String(err));
    const failures = e.failures + 1;
    const permanent = ["not_found", "forbidden", "not_connected"].includes(y.code);
    log.warn("abtest tick failed", { id: e.id, error: y.message, failures });
    this.db.run(
      "update experiments set error = ?, failures = ?, updated_at = ? where id = ?",
      y.message,
      failures,
      Date.now(),
      e.id,
    );
    if (permanent || failures >= 12) {
      if (
        this.transition(
          e.id,
          ["scheduled", "running", "collecting"],
          "failed",
          ", finished_at = " + Date.now(),
        )
      ) {
        this.db.audit("abtest.failed", { id: e.id, error: y.message }, undefined, e.video_id);
        try {
          const row = this.channels.byRowId(e.channel_row_id);
          if (row && this.get(e.id).current_variant !== "A")
            await this.apply(await this.channels.api(row), e, "A");
        } catch (restoreErr) {
          this.db.run(
            "update experiments set error = ? where id = ?",
            `${y.message} | Could not restore A: ${(restoreErr as Error).message}`,
            e.id,
          );
        }
      }
    }
  }

  async results(api: YouTubeApi, e: ExperimentRow) {
    const exposures = this.db.all<{ label: string; day: string; clean: number }>(
      "select label, day, clean from experiment_exposures where experiment_id = ? order by day",
      e.id,
    );
    const labels = this.variants(e.id).map((v) => v.label);
    const lastDay = [e.ends_on, addDays(quotaDay(), -2)].sort()[0];
    if (!exposures.length || lastDay < e.starts_on)
      return { status: "waiting_for_data", note: "No measured days yet." };
    const rows = await queryAnalytics(api, {
      startDate: e.starts_on,
      endDate: lastDay,
      metrics: METRIC_SOURCE[e.metric],
      dimensions: "day",
      filters: `video==${e.video_id}`,
      sort: "day",
    });
    const byDay = new Map(rows.map((r) => [String(r.day), r]));
    // YouTube omits days with no activity: for counts that is a real zero, for ratios it is no data.
    const zeroFill =
      e.metric === "views" || e.metric === "watch_time" || e.metric === "subscribers";
    const points: DayPoint[] = [];
    for (const x of exposures) {
      if (!x.clean || x.day > lastDay) continue;
      const r = byDay.get(x.day);
      if (!r && !zeroFill) continue;
      const value = !r
        ? 0
        : e.metric === "engagement"
          ? (Number(r.likes ?? 0) + Number(r.comments ?? 0) + Number(r.shares ?? 0)) /
            Math.max(1, Number(r.views ?? 0))
          : Number(r[METRIC_SOURCE[e.metric]] ?? 0);
      points.push({ day: x.day, variant: x.label, value });
    }
    return {
      ...analyse(points, e.metric, labels),
      measured_days: points.length,
      excluded_days: exposures.length - points.length,
      daily: points,
    };
  }

  private async finish(api: YouTubeApi, e: ExperimentRow) {
    if (e.status !== "collecting") return;
    const res = await this.results(api, e);
    const winner = "winner" in res ? res.winner : null;
    const applyWinner = Boolean(e.auto_apply && winner && winner !== "A");
    if (
      !this.transition(
        e.id,
        ["collecting"],
        "completed",
        `, winner = ${winner ? `'${winner}'` : "null"}, finished_at = ${Date.now()}, error = null`,
      )
    )
      return;
    this.db.run("update experiments set result = ? where id = ?", JSON.stringify(res), e.id);
    if (applyWinner) await this.apply(api, e, winner!);
    this.db.audit(
      "abtest.completed",
      { id: e.id, winner, applied: applyWinner },
      undefined,
      e.video_id,
    );
  }

  async stop(id: string, keep: string) {
    const e = this.get(id);
    if (!this.variants(id).some((v) => v.label === keep))
      throw new YtError("invalid_request", `No variant ${keep}.`);
    const row = this.channels.byRowId(e.channel_row_id);
    if (!row) throw new YtError("not_connected", "Channel no longer connected.");
    // Mark stopped first so no other process rotates it meanwhile.
    if (
      !this.transition(
        id,
        ["scheduled", "running", "collecting", "failed"],
        "stopped",
        `, winner = '${keep}', finished_at = ${Date.now()}`,
      )
    ) {
      throw new YtError("invalid_request", `Test is already ${this.get(id).status}.`);
    }
    const api = await this.channels.api(row);
    await this.apply(api, this.get(id), keep);
    const res = await this.results(api, this.get(id)).catch((err: Error) => ({
      status: "unavailable",
      note: err.message,
    }));
    this.db.run(
      "update experiments set result = ?, error = null where id = ?",
      JSON.stringify(res),
      id,
    );
    return this.describe(id);
  }

  async describe(id: string, withResults = false) {
    const e = this.get(id);
    const variants = this.variants(id).map((v) => ({
      label: v.label,
      original: Boolean(v.is_original),
      title: v.title,
      description_changed: !v.is_original && v.description !== this.variants(id)[0]?.description,
      thumbnail: v.thumbnail_path,
    }));
    let results: unknown = e.result ? JSON.parse(e.result) : undefined;
    if (withResults && !results && e.status !== "scheduled") {
      const row = this.channels.byRowId(e.channel_row_id);
      if (row)
        results = await this.results(await this.channels.api(row), e).catch((err: Error) => ({
          status: "unavailable",
          note: err.message,
        }));
    }
    const schedule = JSON.parse(e.schedule) as { day: string; variant: string }[];
    return {
      test_id: e.id,
      video_id: e.video_id,
      url: `https://youtu.be/${e.video_id}`,
      status: e.status,
      metric: e.metric,
      starts_on: e.starts_on,
      ends_on: e.ends_on,
      results_expected_on: addDays(e.ends_on, DATA_LAG_DAYS),
      live_variant: e.current_variant,
      auto_apply_winner: Boolean(e.auto_apply),
      winner: e.winner,
      variants,
      schedule,
      last_error: e.error ?? undefined,
      results,
      note: "Days are Pacific Time (YouTube Analytics days). Rotation happens while this server runs: install the background service with `service install` so no day is missed; missed or late days are excluded from the statistics.",
    };
  }
}

export function resolveStartDay(start: "today" | "tomorrow" | string): string {
  const today = quotaDay();
  if (start === "today") return today;
  if (start === "tomorrow") return addDays(today, 1);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start))
    throw new YtError(
      "invalid_request",
      'start must be "today", "tomorrow" or YYYY-MM-DD (Pacific Time).',
    );
  if (start < today) throw new YtError("invalid_request", "start can't be in the past.");
  return start;
}
