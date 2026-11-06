import type { Credentials } from "google-auth-library";
import type { Config } from "./config.js";
import { newId } from "./crypto.js";
import type { Db } from "./db.js";
import { YtError } from "./errors.js";
import { googleClient, grantedScopes, missingYoutubeScopes } from "./google/oauth.js";
import { YouTubeApi } from "./google/youtube.js";
import { log } from "./log.js";
import type { Quota } from "./quota.js";
import type { TokenVault } from "./vault.js";

export interface ChannelRow {
  id: string;
  channel_id: string;
  title: string | null;
  handle: string | null;
  thumbnail_url: string | null;
  google_email: string | null;
  uploads_playlist_id: string | null;
  scopes: string | null;
  status: "ok" | "needs_reconnect";
  status_detail: string | null;
  is_default: number;
  connected_at: number;
  refreshed_at: number | null;
}

const vaultKey = (rowId: string) => `channel:${rowId}`;

export function describeChannel(c: ChannelRow) {
  return {
    channel_id: c.channel_id,
    title: c.title,
    handle: c.handle,
    url: c.handle
      ? `https://www.youtube.com/${c.handle}`
      : `https://www.youtube.com/channel/${c.channel_id}`,
    google_account: c.google_email,
    default: Boolean(c.is_default),
    status: c.status,
    status_detail: c.status_detail ?? undefined,
    connected_at: new Date(c.connected_at).toISOString(),
  };
}

export class Channels {
  private readonly apis = new Map<string, YouTubeApi>();

  constructor(
    private readonly db: Db,
    private readonly vault: TokenVault,
    private readonly cfg: Config,
    private readonly quota: Quota,
  ) {}

  list(): ChannelRow[] {
    return this.db.all<ChannelRow>("select * from channels order by is_default desc, connected_at");
  }

  byRowId(rowId: string): ChannelRow | undefined {
    return this.db.get<ChannelRow>("select * from channels where id = ?", rowId);
  }

  /** Resolve a channel by UC id, @handle or title; default channel when `ref` is empty. */
  resolve(ref?: string | null): ChannelRow {
    const all = this.list();
    if (!all.length) {
      throw new YtError("not_connected", "No YouTube channel is connected yet.", {
        hint: "Call connect_channel and finish the Google sign-in.",
      });
    }
    let found: ChannelRow | undefined;
    if (ref) {
      const r = ref.trim().toLowerCase();
      found =
        all.find((c) => c.channel_id.toLowerCase() === r || c.id.toLowerCase() === r) ??
        all.find((c) => (c.handle ?? "").toLowerCase() === (r.startsWith("@") ? r : `@${r}`)) ??
        all.find((c) => (c.title ?? "").toLowerCase() === r) ??
        all.find((c) => (c.title ?? "").toLowerCase().includes(r));
      if (!found) {
        throw new YtError("not_found", `No connected channel matches "${ref}".`, {
          hint: `Connected: ${all.map((c) => `${c.title} (${c.channel_id})`).join(", ")}`,
        });
      }
    } else {
      found = all.find((c) => c.is_default) ?? all[0];
    }
    if (found.status === "needs_reconnect") {
      throw new YtError("auth_expired", `The Google sign-in for "${found.title}" has expired.`, {
        hint: "Call connect_channel to sign in again. Uploads that were in progress resume automatically after reconnecting.",
      });
    }
    return found;
  }

  async api(row: ChannelRow): Promise<YouTubeApi> {
    const cached = this.apis.get(row.id);
    if (cached) return cached;
    const refresh = await this.vault.get(vaultKey(row.id));
    if (!refresh) {
      this.markNeedsReconnect(row.id, "No stored Google token");
      throw new YtError("auth_expired", `No stored Google token for "${row.title}".`, {
        hint: "Call connect_channel to sign in again.",
      });
    }
    const client = googleClient(this.cfg);
    client.setCredentials({ refresh_token: refresh });
    client.on("tokens", (t) => {
      if (t.refresh_token && t.refresh_token !== refresh)
        void this.vault.set(vaultKey(row.id), t.refresh_token);
      this.db.run("update channels set refreshed_at = ? where id = ?", Date.now(), row.id);
    });
    const api = new YouTubeApi(client, this.quota, (e) =>
      this.markNeedsReconnect(row.id, e.message),
    );
    this.apis.set(row.id, api);
    return api;
  }

  markNeedsReconnect(rowId: string, detail: string) {
    this.apis.delete(rowId);
    this.db.run(
      "update channels set status = 'needs_reconnect', status_detail = ? where id = ?",
      detail,
      rowId,
    );
    log.warn("channel needs reconnect", { rowId, detail });
  }

  /** Store a freshly granted Google token: look up which channel it belongs to and upsert it. */
  async saveFromTokens(tokens: Credentials, googleEmail: string | null): Promise<ChannelRow> {
    if (!tokens.refresh_token) {
      throw new YtError("auth_expired", "Google did not return a refresh token.", {
        hint: "Remove the app at https://myaccount.google.com/permissions and connect again.",
      });
    }
    const scopes = grantedScopes(tokens);
    const missing = missingYoutubeScopes(scopes);
    if (missing.length) {
      throw new YtError("forbidden", "Some YouTube permissions were not granted.", {
        hint: `Connect again and tick every box on the Google consent screen. Missing: ${missing.join(", ")}`,
      });
    }
    const client = googleClient(this.cfg);
    client.setCredentials(tokens);
    const probe = new YouTubeApi(client, this.quota, () => undefined);
    const ch = await probe.myChannel();
    if (!ch?.id) {
      throw new YtError("forbidden", "This Google account has no YouTube channel.", {
        hint: "When Google asks you to choose an account, pick the channel (brand account) you manage.",
      });
    }
    const existing = this.db.get<ChannelRow>("select * from channels where channel_id = ?", ch.id);
    const rowId = existing?.id ?? newId();
    const hasDefault = this.db.get("select 1 from channels where is_default = 1");
    const custom = ch.snippet?.customUrl;
    const fields = [
      ch.snippet?.title ?? null,
      custom ? (custom.startsWith("@") ? custom : `@${custom}`) : null,
      ch.snippet?.thumbnails?.default?.url ?? null,
      googleEmail,
      ch.contentDetails?.relatedPlaylists?.uploads ?? null,
      scopes.join(" "),
    ] as const;
    if (existing) {
      this.db.run(
        `update channels set title = ?, handle = ?, thumbnail_url = ?, google_email = coalesce(?, google_email),
           uploads_playlist_id = ?, scopes = ?, status = 'ok', status_detail = null, refreshed_at = ? where id = ?`,
        ...fields,
        Date.now(),
        rowId,
      );
    } else {
      this.db.run(
        `insert into channels(id, channel_id, title, handle, thumbnail_url, google_email, uploads_playlist_id, scopes,
           is_default, connected_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        rowId,
        ch.id,
        ...fields,
        hasDefault ? 0 : 1,
        Date.now(),
      );
    }
    await this.vault.set(vaultKey(rowId), tokens.refresh_token);
    this.apis.delete(rowId);
    this.db.audit("channel.connected", { title: ch.snippet?.title }, ch.id);
    return this.byRowId(rowId)!;
  }

  setDefault(rowId: string) {
    this.db.tx(() => {
      this.db.run("update channels set is_default = case when id = ? then 1 else 0 end", rowId);
    });
  }

  async disconnect(rowId: string) {
    const row = this.byRowId(rowId);
    if (!row) throw new YtError("not_found", "Channel not found.");
    const refresh = await this.vault.get(vaultKey(rowId));
    if (refresh) {
      try {
        await googleClient(this.cfg).revokeToken(refresh);
      } catch (e) {
        log.warn("google token revoke failed", { error: String(e) });
      }
    }
    await this.vault.delete(vaultKey(rowId));
    this.apis.delete(rowId);
    this.db.tx(() => {
      this.db.run("delete from channels where id = ?", rowId);
      if (row.is_default) {
        this.db.run(
          "update channels set is_default = 1 where id = (select id from channels order by connected_at limit 1)",
        );
      }
    });
    this.db.audit("channel.disconnected", { title: row.title }, row.channel_id);
  }
}
