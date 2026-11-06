import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { youtube_v3 } from "@googleapis/youtube";
import { YtError } from "./errors.js";
import type { Privacy, YouTubeApi } from "./google/youtube.js";
import { COST } from "./quota.js";
import { expandPath, inspectThumbnail } from "./upload/sources.js";

export async function setThumbnail(
  api: YouTubeApi,
  videoId: string,
  imagePath: string,
) {
  const img = await inspectThumbnail(imagePath);
  const data = await api.call(
    COST.thumbnailsSet,
    "thumbnails.set",
    () =>
      api.yt.thumbnails.set({
        videoId,
        media: { mimeType: img.mime, body: createReadStream(img.path) },
      }),
    false,
  );
  const t = data.items?.[0];
  return {
    video_id: videoId,
    thumbnail: t?.maxres?.url ?? t?.high?.url ?? t?.default?.url ?? null,
  };
}

export async function listPlaylists(
  api: YouTubeApi,
  max = 200,
): Promise<youtube_v3.Schema$Playlist[]> {
  const out: youtube_v3.Schema$Playlist[] = [];
  let pageToken: string | undefined;
  do {
    const data = await api.call(COST.list, "playlists.list", () =>
      api.yt.playlists.list({
        part: ["snippet", "status", "contentDetails"],
        mine: true,
        maxResults: 50,
        pageToken,
      }),
    );
    out.push(...(data.items ?? []));
    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken && out.length < max);
  return out;
}

export async function createPlaylist(
  api: YouTubeApi,
  title: string,
  description = "",
  privacy: Privacy = "private",
) {
  return api.call(
    COST.playlistsInsert,
    "playlists.insert",
    () =>
      api.yt.playlists.insert({
        part: ["snippet", "status"],
        requestBody: {
          snippet: { title, description },
          status: { privacyStatus: privacy },
        },
      }),
    false,
  );
}

/** Playlist names → ids. Missing names are created (private) when `create` is true. */
export async function resolvePlaylists(
  api: YouTubeApi,
  refs: string[],
  create: boolean,
) {
  const ids: string[] = [];
  const created: string[] = [];
  const missing: string[] = [];
  const needLookup = refs.filter((r) => !/^PL[\w-]{10,}$/.test(r));
  const existing = needLookup.length ? await listPlaylists(api) : [];
  for (const ref of refs) {
    if (/^PL[\w-]{10,}$/.test(ref)) {
      ids.push(ref);
      continue;
    }
    const hit = existing.find(
      (p) => p.snippet?.title?.toLowerCase() === ref.toLowerCase(),
    );
    if (hit?.id) ids.push(hit.id);
    else if (create) {
      const p = await createPlaylist(api, ref);
      if (p.id) {
        ids.push(p.id);
        created.push(ref);
        existing.push(p);
      }
    } else missing.push(ref);
  }
  return { ids, created, missing };
}

export async function addToPlaylist(
  api: YouTubeApi,
  playlistId: string,
  videoId: string,
  position?: number,
) {
  const item = await api.call(
    COST.playlistItemsInsert,
    "playlistItems.insert",
    () =>
      api.yt.playlistItems.insert({
        part: ["snippet"],
        requestBody: {
          snippet: {
            playlistId,
            position,
            resourceId: { kind: "youtube#video", videoId },
          },
        },
      }),
    false,
  );
  return {
    playlist_id: playlistId,
    video_id: videoId,
    item_id: item.id,
    position: item.snippet?.position,
  };
}

export interface CaptionInput {
  file_path?: string;
  content?: string;
  language: string;
  name?: string;
  is_draft?: boolean;
  replace_existing?: boolean;
}

export async function uploadCaptions(
  api: YouTubeApi,
  videoId: string,
  c: CaptionInput,
) {
  if (!c.file_path && !c.content)
    throw new YtError(
      "invalid_request",
      "Provide captions as file_path or content.",
    );
  const body = () =>
    c.file_path
      ? createReadStream(expandPath(c.file_path))
      : Readable.from([Buffer.from(c.content!, "utf8")]);
  const name = c.name ?? "";
  if (c.replace_existing) {
    const list = await api.call(COST.captionsList, "captions.list", () =>
      api.yt.captions.list({ part: ["snippet"], videoId }),
    );
    const same = list.items?.find(
      (t) =>
        t.snippet?.language === c.language &&
        (t.snippet?.name ?? "") === name &&
        t.snippet?.trackKind !== "asr",
    );
    if (same?.id) {
      const upd = await api.call(
        COST.captionsUpdate,
        "captions.update",
        () =>
          api.yt.captions.update({
            part: ["snippet"],
            requestBody: {
              id: same.id,
              snippet: { isDraft: c.is_draft ?? false },
            },
            media: { mimeType: "application/octet-stream", body: body() },
          }),
        false,
      );
      return { caption_id: upd.id, language: c.language, name, replaced: true };
    }
  }
  const res = await api.call(
    COST.captionsInsert,
    "captions.insert",
    () =>
      api.yt.captions.insert({
        part: ["snippet"],
        requestBody: {
          snippet: {
            videoId,
            language: c.language,
            name,
            isDraft: c.is_draft ?? false,
          },
        },
        media: { mimeType: "application/octet-stream", body: body() },
      }),
    false,
  );
  return { caption_id: res.id, language: c.language, name, replaced: false };
}

/** Download a caption track (owner only). Returns SRT text. */
export async function downloadCaptions(
  api: YouTubeApi,
  videoId: string,
  language?: string,
): Promise<{ srt: string; language: string; kind: string }> {
  const list = await api.call(COST.captionsList, "captions.list", () =>
    api.yt.captions.list({ part: ["snippet"], videoId }),
  );
  const tracks = list.items ?? [];
  const pick =
    tracks.find(
      (t) =>
        t.snippet?.trackKind !== "asr" &&
        (!language || t.snippet?.language === language),
    ) ??
    tracks.find((t) => !language || t.snippet?.language === language) ??
    tracks[0];
  if (!pick?.id)
    throw new YtError(
      "not_found",
      "This video has no caption tracks yet (auto-captions appear a while after processing).",
    );
  const data = await api.call(
    COST.captionsDownload,
    "captions.download",
    () =>
      api.yt.captions.download(
        { id: pick.id!, tfmt: "srt" },
        { responseType: "text" },
      ) as Promise<{ data: unknown }>,
  );
  return {
    srt: String(data),
    language: pick.snippet?.language ?? "und",
    kind: pick.snippet?.trackKind ?? "standard",
  };
}
