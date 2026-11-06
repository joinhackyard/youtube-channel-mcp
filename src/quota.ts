import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { YtError } from "./errors.js";

/** Approximate YouTube Data API v3 unit costs. One Google project's quota is shared by every connected channel. */
export const COST = {
  list: 1,
  videosUpdate: 50,
  videosDelete: 50,
  thumbnailsSet: 50,
  playlistsInsert: 50,
  playlistsUpdate: 50,
  playlistItemsInsert: 50,
  playlistItemsDelete: 50,
  captionsList: 50,
  captionsInsert: 400,
  captionsUpdate: 450,
  captionsDownload: 200,
  captionsDelete: 50,
  search: 100,
  channelsUpdate: 50,
  channelBannersInsert: 50,
  watermarks: 50,
  commentsInsert: 50,
  commentsModerate: 50,
  playlistsDelete: 50,
  playlistItemsUpdate: 50,
} as const;

const PT = "America/Los_Angeles";

/** YYYY-MM-DD in Pacific Time: YouTube quotas reset at midnight PT. */
export function quotaDay(at = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: PT,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** Next midnight Pacific Time as a Date. */
export function nextReset(at = new Date()): Date {
  const [y, m, d] = quotaDay(at).split("-").map(Number);
  for (const offsetHours of [8, 7]) {
    const candidate = new Date(Date.UTC(y, m - 1, d + 1, offsetHours, 0, 0));
    const hour = new Intl.DateTimeFormat("en-US", {
      timeZone: PT,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(candidate);
    if (hour === "00") return candidate;
  }
  return new Date(Date.UTC(y, m - 1, d + 1, 8, 0, 0));
}

export interface QuotaStatus {
  day: string;
  units_used: number;
  units_limit: number;
  uploads_used: number;
  uploads_limit: number;
  exhausted: string | null;
  resets_at: string;
  note: string;
}

export class Quota {
  constructor(
    private readonly db: Db,
    private readonly cfg: Config,
  ) {}

  private ensure(day: string) {
    this.db.run(
      "insert into quota(day) values (?) on conflict(day) do nothing",
      day,
    );
  }

  charge(units: number) {
    if (units <= 0) return;
    const day = quotaDay();
    this.ensure(day);
    this.db.run("update quota set units = units + ? where day = ?", units, day);
  }

  chargeUpload() {
    const day = quotaDay();
    this.ensure(day);
    this.db.run(
      "update quota set uploads = uploads + 1, units = units + ? where day = ?",
      this.cfg.quota.uploadUnitCost,
      day,
    );
  }

  markExhausted(kind: "units" | "uploads") {
    const day = quotaDay();
    this.ensure(day);
    this.db.run(
      "update quota set exhausted_kind = ?, exhausted_at = ? where day = ?",
      kind,
      Date.now(),
      day,
    );
  }

  /** Refuse to call YouTube when we already know today's budget is gone. */
  assertAvailable(kind: "units" | "uploads") {
    const s = this.status();
    if (
      kind === "uploads" &&
      (s.exhausted === "uploads" || s.uploads_used >= s.uploads_limit)
    ) {
      throw new YtError(
        "upload_limit_exceeded",
        `Daily upload budget used (${s.uploads_used}/${s.uploads_limit}).`,
        {
          hint: `Uploads reset at ${s.resets_at}. Queue it with resume_upload after the reset.`,
        },
      );
    }
    if (s.exhausted === "units") {
      throw new YtError(
        "quota_exceeded",
        "YouTube reported the daily API quota as exhausted.",
        { hint: `Quota resets at ${s.resets_at}.` },
      );
    }
  }

  status(): QuotaStatus {
    const day = quotaDay();
    const row = this.db.get<{
      units: number;
      uploads: number;
      exhausted_kind: string | null;
    }>("select units, uploads, exhausted_kind from quota where day = ?", day);
    return {
      day,
      units_used: row?.units ?? 0,
      units_limit: this.cfg.quota.dailyUnits,
      uploads_used: row?.uploads ?? 0,
      uploads_limit: this.cfg.quota.dailyUploads,
      exhausted: row?.exhausted_kind ?? null,
      resets_at: nextReset().toISOString(),
      note: "Counts are this server’s own estimate across all connected channels; Google Cloud Console → APIs → YouTube Data API v3 → Quotas is the source of truth.",
    };
  }
}
