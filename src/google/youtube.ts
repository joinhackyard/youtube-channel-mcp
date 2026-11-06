import { youtube, type youtube_v3 } from "@googleapis/youtube";
import type { OAuth2Client } from "google-auth-library";
import { classifyGoogleError, YtError } from "../errors.js";
import type { Quota } from "../quota.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Thin wrapper over the YouTube Data API: quota accounting, error classification, retries for safe calls. */
export class YouTubeApi {
  readonly yt: youtube_v3.Youtube;

  constructor(
    readonly auth: OAuth2Client,
    private readonly quota: Quota,
    private readonly onAuthExpired: (e: YtError) => void,
  ) {
    this.yt = youtube({ version: "v3", auth });
  }

  /** Run one API call. `idempotent` calls are retried on 5xx / rate limits / network drops. */
  async call<T>(
    cost: number,
    label: string,
    fn: () => Promise<{ data: T }>,
    idempotent = true,
  ): Promise<T> {
    if (cost > 0) this.quota.assertAvailable("units");
    let attempt = 0;
    for (;;) {
      try {
        const r = await fn();
        this.quota.charge(cost);
        return r.data;
      } catch (err) {
        const e = classifyGoogleError(err, label);
        if (e.code === "quota_exceeded") this.quota.markExhausted("units");
        if (e.code === "upload_limit_exceeded") this.quota.markExhausted("uploads");
        if (e.code === "auth_expired" && e.opts.reason === "invalid_grant") this.onAuthExpired(e);
        if (idempotent && e.retryable && e.code !== "auth_expired" && attempt < 3) {
          attempt++;
          await sleep(500 * 2 ** attempt + Math.random() * 300);
          continue;
        }
        this.quota.charge(Math.min(cost, 1));
        throw e;
      }
    }
  }

  async accessToken(): Promise<string> {
    try {
      const t = await this.auth.getAccessToken();
      if (!t.token) throw new YtError("auth_expired", "Google returned no access token.");
      return t.token;
    } catch (err) {
      const e = classifyGoogleError(err, "token refresh");
      if (e.code === "auth_expired") this.onAuthExpired(e);
      throw e;
    }
  }

  /** Force a fresh access token on the next call (after a 401). */
  invalidateAccessToken() {
    this.auth.credentials = {
      ...this.auth.credentials,
      access_token: undefined,
      expiry_date: 0,
    };
  }

  async myChannel(): Promise<youtube_v3.Schema$Channel | undefined> {
    const data = await this.call(1, "channels.list", () =>
      this.yt.channels.list({
        part: ["snippet", "contentDetails", "status"],
        mine: true,
      }),
    );
    return data.items?.[0];
  }

  async getVideos(
    ids: string[],
    parts = ["snippet", "status", "contentDetails", "statistics", "processingDetails"],
  ) {
    if (!ids.length) return [];
    const out: youtube_v3.Schema$Video[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const data = await this.call(1, "videos.list", () =>
        this.yt.videos.list({
          part: parts,
          id: ids.slice(i, i + 50),
          maxResults: 50,
        }),
      );
      out.push(...(data.items ?? []));
    }
    return out;
  }

  async getVideo(id: string, parts?: string[]): Promise<youtube_v3.Schema$Video> {
    const [v] = await this.getVideos([id], parts);
    if (!v)
      throw new YtError(
        "not_found",
        `Video ${id} was not found on this channel (or is still being created).`,
      );
    return v;
  }
}

export const PRIVACY = ["private", "unlisted", "public"] as const;
export type Privacy = (typeof PRIVACY)[number];

export const videoUrl = (id: string) => `https://youtu.be/${id}`;
export const studioUrl = (id: string) => `https://studio.youtube.com/video/${id}/edit`;

/** Compact, agent-friendly view of a video. */
export function summariseVideo(v: youtube_v3.Schema$Video) {
  return {
    id: v.id,
    url: v.id ? videoUrl(v.id) : undefined,
    studio_url: v.id ? studioUrl(v.id) : undefined,
    title: v.snippet?.title,
    description: v.snippet?.description,
    tags: v.snippet?.tags ?? [],
    category_id: v.snippet?.categoryId,
    default_language: v.snippet?.defaultLanguage,
    default_audio_language: v.snippet?.defaultAudioLanguage,
    published_at: v.snippet?.publishedAt,
    thumbnail:
      v.snippet?.thumbnails?.maxres?.url ??
      v.snippet?.thumbnails?.high?.url ??
      v.snippet?.thumbnails?.default?.url,
    privacy: v.status?.privacyStatus,
    publish_at: v.status?.publishAt,
    upload_status: v.status?.uploadStatus,
    failure_reason: v.status?.failureReason,
    rejection_reason: v.status?.rejectionReason,
    made_for_kids: v.status?.madeForKids,
    self_declared_made_for_kids: v.status?.selfDeclaredMadeForKids,
    embeddable: v.status?.embeddable,
    license: v.status?.license,
    contains_synthetic_media: v.status?.containsSyntheticMedia,
    duration: v.contentDetails?.duration,
    definition: v.contentDetails?.definition,
    caption: v.contentDetails?.caption,
    processing: v.processingDetails
      ? {
          status: v.processingDetails.processingStatus,
          progress: v.processingDetails.processingProgress,
          failure_reason: v.processingDetails.processingFailureReason,
          thumbnails_available: v.processingDetails.thumbnailsAvailability,
        }
      : undefined,
    statistics: v.statistics
      ? {
          views: v.statistics.viewCount,
          likes: v.statistics.likeCount,
          comments: v.statistics.commentCount,
        }
      : undefined,
  };
}
