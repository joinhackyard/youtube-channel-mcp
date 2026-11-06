import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { App } from "../../app.js";
import { describeChannel } from "../../channels.js";
import { VERSION } from "../../config.js";
import { openBrowser } from "../../connect.js";
import { channelArg, confirmArg, confirmGate, ok, safe } from "../helpers.js";

export function registerAccountTools(server: McpServer, app: App) {
  server.registerTool(
    "auth_status",
    {
      title: "Connection status",
      description:
        "Show whether Google OAuth is configured, which YouTube channels are connected (and whether their sign-in is healthy), the default channel, today’s quota use, and known project limitations. Call this first in a new conversation.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async () => {
      const channels = app.channels.list().map(describeChannel);
      const configured = Boolean(
        app.cfg.google.clientId && app.cfg.google.clientSecret,
      );
      const lock = app.db.setting("private_lock_observed");
      const next: string[] = [];
      if (!configured)
        next.push(
          "Google OAuth is not set up. Ask the user to run `npx youtube-channel-mcp setup` in a terminal.",
        );
      else if (!channels.length)
        next.push("No channel connected. Call connect_channel.");
      for (const c of channels)
        if (c.status !== "ok")
          next.push(
            `"${c.title}" needs to be reconnected: call connect_channel.`,
          );
      return ok({
        version: VERSION,
        google_oauth_configured: configured,
        token_storage: app.vault.kind,
        channels,
        quota: app.quota.status(),
        confirm_policy: app.cfg.confirmPolicy,
        transcription_configured: Boolean(app.cfg.transcription.apiKey),
        known_limits: [
          lock
            ? `Uploads from this Google Cloud project were observed being locked to private (${lock}). Until the project passes the YouTube API audit, publish manually in YouTube Studio.`
            : "Google Cloud projects that have not passed the YouTube API audit may have uploads locked to private.",
          'While the OAuth consent screen is in "Testing" mode, Google expires sign-ins after 7 days; just reconnect.',
          "Custom thumbnails and videos over 15 minutes need a phone-verified channel (youtube.com/verify).",
        ],
        next_steps: next,
      });
    }),
  );

  server.registerTool(
    "connect_channel",
    {
      title: "Connect a YouTube channel",
      description:
        "Start Google sign-in to connect (or reconnect) a YouTube channel. Opens the browser on this computer and returns the sign-in link; the user picks the Google account and channel (brand accounts work). Waits up to wait_seconds for them to finish.",
      inputSchema: {
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(110)
          .default(90)
          .describe(
            "How long to wait for the sign-in to finish before returning.",
          ),
        open_browser: z.boolean().default(true),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    safe(async ({ wait_seconds, open_browser }) => {
      const { url, done, reused } = await app.connector.start();
      const opened = open_browser && !reused ? openBrowser(url) : false;
      const result = await Promise.race([
        done.then((row) => ({ row })),
        done.catch((e: Error) => ({ error: e })),
        new Promise<null>((r) =>
          setTimeout(() => r(null), wait_seconds * 1000).unref(),
        ),
      ]);
      if (result && "row" in result && result.row) {
        return ok(
          { connected: describeChannel(result.row) },
          `Connected "${result.row.title}". Uploads that were waiting on this sign-in resume automatically.`,
        );
      }
      if (result && "error" in result && result.error) throw result.error;
      return ok(
        { pending: true, sign_in_url: url, browser_opened: opened },
        `Waiting for the user to finish Google sign-in. ${opened ? "A browser tab was opened." : "Give the user this link to open on this computer:"} ${url}\nAfter they finish, call auth_status (or connect_channel again to keep waiting).`,
      );
    }),
  );

  server.registerTool(
    "list_channels",
    {
      title: "List connected channels",
      description: "List the YouTube channels connected to this server.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    safe(async () =>
      ok({ channels: app.channels.list().map(describeChannel) }),
    ),
  );

  server.registerTool(
    "set_default_channel",
    {
      title: "Set the default channel",
      description:
        "Choose which connected channel is used when a tool call does not name one.",
      inputSchema: {
        channel: z.string().describe("Channel ID, @handle or name."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    safe(async ({ channel }) => {
      const row = app.channels.resolve(channel);
      app.channels.setDefault(row.id);
      return ok({ default: describeChannel(app.channels.byRowId(row.id)!) });
    }),
  );

  server.registerTool(
    "disconnect_channel",
    {
      title: "Disconnect a channel",
      description:
        "Remove a connected channel and revoke this app’s Google access to it. Needs the user’s confirmation.",
      inputSchema: { channel: channelArg, confirmation_token: confirmArg },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    safe(async (args) => {
      const all = app.channels.list();
      const row =
        all.find(
          (c) =>
            args.channel &&
            [c.channel_id, c.handle, c.title].includes(args.channel),
        ) ?? app.channels.resolve(args.channel);
      const gate = await confirmGate(
        app,
        server,
        "disconnect_channel",
        args,
        `Disconnect "${row.title}" (${row.channel_id}) and revoke access.`,
        {
          publicFacing: false,
          destructive: true,
        },
      );
      if (gate) return gate;
      await app.channels.disconnect(row.id);
      return ok({ disconnected: row.channel_id, title: row.title });
    }),
  );
}
