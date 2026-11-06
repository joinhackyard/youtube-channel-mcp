import { classifyGoogleError, YtError } from "./errors.js";
import type { YouTubeApi } from "./google/youtube.js";

/** YouTube Analytics API v2 report as rows of named columns. Uses the channel's own OAuth token. */
export async function queryAnalytics(api: YouTubeApi, params: Record<string, string | number>) {
  try {
    const res = await api.auth.request<{
      columnHeaders?: { name: string }[];
      rows?: unknown[][];
    }>({
      url: "https://youtubeanalytics.googleapis.com/v2/reports",
      params: { ids: "channel==MINE", ...params },
    });
    const cols = (res.data.columnHeaders ?? []).map((c) => c.name);
    return (res.data.rows ?? []).map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
  } catch (err) {
    const e = classifyGoogleError(err, "YouTube Analytics");
    if (e.code === "forbidden" || e.opts.status === 403) {
      throw new YtError("forbidden", `YouTube Analytics refused the request: ${e.message}`, {
        hint: 'Make sure the "YouTube Analytics API" is enabled in your Google Cloud project (https://console.cloud.google.com/apis/library/youtubeanalytics.googleapis.com), then run connect_channel again so the analytics permission is granted.',
      });
    }
    throw e;
  }
}
