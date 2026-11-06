import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ChannelRow, Channels } from "./channels.js";
import type { Config } from "./config.js";
import { pkcePair, randomToken } from "./crypto.js";
import { YtError } from "./errors.js";
import {
  authUrl,
  exchangeCode,
  googleClient,
  identityFromIdToken,
  YOUTUBE_SCOPES,
} from "./google/oauth.js";
import { log } from "./log.js";

export function openBrowser(url: string): boolean {
  try {
    const [cmd, args] =
      process.platform === "darwin"
        ? ["open", [url]]
        : process.platform === "win32"
          ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
          : ["xdg-open", [url]];
    const p = spawn(cmd, args, { stdio: "ignore", detached: true });
    p.on("error", () => undefined);
    p.unref();
    return true;
  } catch {
    return false;
  }
}

const page = (
  title: string,
  body: string,
) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d12;color:#e8edf5;font:16px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:440px;padding:40px}h1{font-size:22px;font-weight:600;margin:0 0 8px}p{color:#a7b0c0;margin:0}
</style></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

interface Pending {
  url: string;
  done: Promise<ChannelRow>;
  server: Server;
  startedAt: number;
}

/**
 * Google sign-in through a one-shot loopback server (the flow Google recommends for desktop apps):
 * PKCE, random state, 127.0.0.1 only, closes itself after one callback or 10 minutes.
 */
export class Connector {
  private pending?: Pending;

  constructor(
    private readonly cfg: Config,
    private readonly channels: Channels,
    private readonly onConnected: (row: ChannelRow) => void,
  ) {}

  /** Stop a pending sign-in (its loopback server would otherwise keep the process alive). */
  close() {
    this.pending?.server.close();
    this.pending = undefined;
  }

  async start(): Promise<{
    url: string;
    done: Promise<ChannelRow>;
    reused: boolean;
  }> {
    if (this.pending && Date.now() - this.pending.startedAt < 9 * 60_000) {
      return { url: this.pending.url, done: this.pending.done, reused: true };
    }
    this.pending?.server.close();
    googleClient(this.cfg); // fail fast when not configured

    const state = randomToken("", 24);
    const { verifier, challenge } = pkcePair();
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    const client = googleClient(this.cfg, redirectUri);
    const url = authUrl(client, {
      scopes: [...YOUTUBE_SCOPES, "openid", "email"],
      state,
      challenge,
    });

    const done = new Promise<ChannelRow>((resolve, reject) => {
      const timer = setTimeout(() => {
        server.close();
        reject(
          new YtError("cancelled", "Google sign-in timed out after 10 minutes.", {
            hint: "Run connect_channel again.",
          }),
        );
      }, 10 * 60_000);
      timer.unref();
      let handled = false;
      server.on("request", async (req, res) => {
        const u = new URL(req.url ?? "/", redirectUri);
        if (u.pathname !== "/callback") {
          res.writeHead(404).end();
          return;
        }
        const finish = (status: number, title: string, body: string) => {
          res
            .writeHead(status, { "Content-Type": "text/html; charset=utf-8" })
            .end(page(title, body));
          clearTimeout(timer);
          server.close();
        };
        if (handled) {
          res
            .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
            .end(page("Already handled", "You can close this tab."));
          return;
        }
        if (u.searchParams.get("state") !== state) {
          res
            .writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
            .end(page("Sign-in link mismatch", "Start again from your AI app."));
          return;
        }
        handled = true; // a browser retry of the same callback must not race the first one
        const err = u.searchParams.get("error");
        if (err) {
          finish(400, "Sign-in cancelled", escapeHtml(err));
          reject(new YtError("cancelled", `Google sign-in was cancelled (${err}).`));
          return;
        }
        try {
          const tokens = await exchangeCode(client, u.searchParams.get("code") ?? "", verifier);
          const who = await identityFromIdToken(
            client,
            tokens.id_token,
            this.cfg.google.clientId!,
          ).catch(() => null);
          const row = await this.channels.saveFromTokens(tokens, who?.email ?? null);
          finish(
            200,
            `Connected ${escapeHtml(row.title ?? "your channel")}`,
            "You can close this tab and go back to your AI app.",
          );
          this.onConnected(row);
          resolve(row);
        } catch (e) {
          const y = e instanceof YtError ? e : new YtError("unknown", String(e));
          finish(400, "Could not connect", escapeHtml(`${y.message} ${y.hint ?? ""}`));
          reject(y);
        }
      });
    }).finally(() => {
      if (this.pending?.server === server) this.pending = undefined;
    });
    done.catch((e) => log.warn("connect failed", { error: String(e) }));
    this.pending = { url, done, server, startedAt: Date.now() };
    return { url, done, reused: false };
  }
}
