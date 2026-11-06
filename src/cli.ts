#!/usr/bin/env node
import "./quiet.js";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { hasFfmpeg } from "./ai/transcript.js";
import { createApp, type App } from "./app.js";
import { describeChannel } from "./channels.js";
import { CLIENTS, launchSpec, manualSnippets } from "./clients.js";
import { APP, SECRET, VERSION } from "./config.js";
import { openBrowser } from "./connect.js";
import { YtError } from "./errors.js";
import { log } from "./log.js";
import { buildServer } from "./mcp/server.js";
import { expandPath } from "./upload/sources.js";

const bold = (s: string) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (s: string) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const say = (s = "") => process.stdout.write(s + "\n");

const HELP = `${bold(`${APP} ${VERSION}`)}
Run your YouTube channel from Claude, Hermes, Cursor, Codex and any MCP client.

${bold("Get started")}
  npx ${APP} setup            Guided setup: Google credentials, connect a channel, add to your AI apps

${bold("Commands")}
  setup                        Run the guided setup (safe to re-run)
  connect                      Connect or reconnect a YouTube channel (opens Google sign-in)
  status                       Show connected channels, quota and configuration
  install [client...]          Add the server to AI apps: ${CLIENTS.map((c) => c.id).join(", ")}, or "all"
  uninstall [client...]        Remove it from AI apps
  config                       Print config snippets for any other MCP client
  doctor                       Check everything and explain what to fix
  serve                        Run the MCP server over stdio (what AI apps start)

${bold("Options for install")}
  --npx                        Launch with "npx -y ${APP}@latest" (always latest)
  --node                       Launch this installed copy directly with node

Docs: https://github.com/shyamolkonwar/${APP}#readme`;

async function ask(
  rl: ReturnType<typeof createInterface>,
  q: string,
  def?: string,
): Promise<string> {
  const a = (await rl.question(`${q}${def ? dim(` [${def}]`) : ""} `)).trim();
  return a || def || "";
}

async function askYes(
  rl: ReturnType<typeof createInterface>,
  q: string,
  def = true,
): Promise<boolean> {
  const a = (await rl.question(`${q} ${dim(def ? "[Y/n]" : "[y/N]")} `))
    .trim()
    .toLowerCase();
  return a ? a.startsWith("y") : def;
}

/** Ask for a secret without echoing what is typed. */
async function askSecret(rl: ReturnType<typeof createInterface>, q: string): Promise<string> {
  const r = rl as unknown as { _writeToOutput: (s: string) => void };
  const orig = r._writeToOutput;
  let promptShown = false;
  r._writeToOutput = function (this: unknown, out: string) {
    if (!promptShown || out === "\r\n" || out === "\n") {
      promptShown = true;
      orig.call(this, out);
    }
  };
  try {
    return (await rl.question(`${q} `)).trim();
  } finally {
    r._writeToOutput = orig;
  }
}

function parseClientSecretJson(
  text: string,
): { id: string; secret: string } | null {
  try {
    const j = JSON.parse(text) as Record<
      string,
      { client_id?: string; client_secret?: string }
    >;
    const c =
      j.installed ??
      j.web ??
      (j as unknown as { client_id?: string; client_secret?: string });
    if (c?.client_id && c?.client_secret)
      return { id: c.client_id, secret: c.client_secret };
  } catch {
    /* not JSON */
  }
  return null;
}

const GOOGLE_STEPS = [
  [
    'Create a Google Cloud project (any name, e.g. "YouTube MCP")',
    "https://console.cloud.google.com/projectcreate",
  ],
  [
    "Enable the YouTube Data API v3 for it",
    "https://console.cloud.google.com/apis/library/youtube.googleapis.com",
  ],
  [
    "Enable the YouTube Analytics API too (for channel stats)",
    "https://console.cloud.google.com/apis/library/youtubeanalytics.googleapis.com",
  ],
  [
    'Set up the OAuth consent screen: Get started → app name + your email → Audience: External → finish. Under Audience, add your Google account as a test user (or click "Publish app" so sign-ins do not expire every 7 days; Google then shows an "unverified app" notice you can click through)',
    "https://console.cloud.google.com/auth/overview",
  ],
  [
    'Create an OAuth client: Application type "Desktop app" → Create → Download JSON',
    "https://console.cloud.google.com/auth/clients/create",
  ],
] as const;

async function setupGoogle(app: App, rl: ReturnType<typeof createInterface>) {
  if (app.cfg.google.clientId && app.cfg.google.clientSecret) {
    say(
      `✓ Google OAuth client configured ${dim(`(${app.cfg.google.clientId.slice(0, 18)}…)`)}`,
    );
    if (!(await askYes(rl, "Replace it with a different one?", false))) return;
  }
  say(
    bold("\nStep 1 · Google credentials") +
      dim(" (one time, about 3 minutes, free)"),
  );
  say(
    "YouTube only lets apps upload through your own Google Cloud OAuth client, so you create one:\n",
  );
  GOOGLE_STEPS.forEach(([t, url], i) =>
    say(`  ${i + 1}. ${t}\n     ${dim(url)}`),
  );
  say();
  if (await askYes(rl, "Open these pages in your browser now?", true))
    GOOGLE_STEPS.forEach(([, url]) => openBrowser(url));

  for (;;) {
    const input = await ask(
      rl,
      "\nDrag the downloaded client_secret_….json file here (or paste the Client ID):",
    );
    if (!input) continue;
    const path = expandPath(
      input.replace(/^['"]|['"]$/g, "").replace(/\\ /g, " "),
    );
    let creds = existsSync(path)
      ? parseClientSecretJson(readFileSync(path, "utf8"))
      : parseClientSecretJson(input);
    if (!creds && /\.apps\.googleusercontent\.com$/.test(input)) {
      const secret = await askSecret(rl, "Client secret:");
      creds = secret ? { id: input, secret } : null;
    }
    if (!creds) {
      say(
        "That did not look like a client_secret JSON file or a Client ID ending in .apps.googleusercontent.com. Try again.",
      );
      continue;
    }
    await app.vault.set(SECRET.googleClientId, creds.id);
    await app.vault.set(SECRET.googleClientSecret, creds.secret);
    app.cfg.google.clientId = creds.id;
    app.cfg.google.clientSecret = creds.secret;
    say(
      `✓ Saved in ${app.vault.kind === "keychain" ? "your OS keychain" : `an encrypted file in ${app.cfg.home}`}.`,
    );
    if (existsSync(path)) say(dim(`  You can delete ${path} now.`));
    return;
  }
}

async function connectInteractive(app: App) {
  const { url, done } = await app.connector.start();
  say(
    "\nOpening Google sign-in. Pick the Google account, then the YouTube channel (brand accounts are fine).",
  );
  say(dim(`If no browser opens, visit:\n${url}\n`));
  openBrowser(url);
  const row = await done;
  say(
    `✓ Connected ${bold(row.title ?? row.channel_id)} ${dim(row.handle ?? "")}`,
  );
}

async function setupTranscription(
  app: App,
  rl: ReturnType<typeof createInterface>,
) {
  say(bold("\nStep 3 · Automatic transcripts") + dim(" (optional)"));
  say(
    "Lets your AI transcribe a video to write titles, descriptions, chapters and captions.",
  );
  say(
    "Works with any OpenAI-compatible speech-to-text API (OpenAI, Azure OpenAI, Groq, local Whisper) and needs ffmpeg.",
  );
  if (
    !(await askYes(
      rl,
      app.cfg.transcription.apiKey
        ? "Change transcription settings?"
        : "Set it up now?",
      false,
    ))
  )
    return;
  const base = await ask(rl, "API base URL:", app.cfg.transcription.baseUrl);
  const model = await ask(rl, "Model:", app.cfg.transcription.model);
  const key = await askSecret(rl, "API key:");
  if (key) await app.vault.set(SECRET.transcribeKey, key);
  app.db.setSetting("transcribe_base_url", base.replace(/\/+$/, ""));
  app.db.setSetting("transcribe_model", model);
  say(
    "✓ Saved." +
      ((await hasFfmpeg())
        ? ""
        : " Install ffmpeg too (macOS: brew install ffmpeg)."),
  );
}

async function installClients(ids: string[], mode: "auto" | "npx" | "node") {
  const spec = launchSpec(mode);
  const targets = ids.includes("all")
    ? CLIENTS.filter((c) => c.detect())
    : CLIENTS.filter((c) => ids.includes(c.id));
  const unknown = ids.filter(
    (i) => i !== "all" && !CLIENTS.some((c) => c.id === i),
  );
  if (unknown.length)
    say(
      `Unknown client(s): ${unknown.join(", ")}. Known: ${CLIENTS.map((c) => c.id).join(", ")}`,
    );
  for (const c of targets) {
    try {
      say(`✓ ${c.install(spec)}`);
    } catch (e) {
      say(`✗ ${c.name}: ${(e as Error).message}`);
    }
  }
  if (!targets.length)
    say(
      "No supported AI apps found. Use `config` to print snippets for your client.",
    );
}

async function setup() {
  const app = await createApp();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    say(
      bold(`\nYouTube Channel MCP · setup`) +
        dim(`  (data: ${app.cfg.home})`),
    );
    await setupGoogle(app, rl);

    say(bold("\nStep 2 · Connect your YouTube channel"));
    const existing = app.channels.list();
    for (const c of existing)
      say(
        `  ✓ ${c.title} ${dim(c.status === "ok" ? "" : "(needs reconnect)")}`,
      );
    if (
      !existing.length || existing.some((c) => c.status !== "ok")
        ? true
        : await askYes(rl, "Connect another channel?", false)
    ) {
      rl.pause();
      try {
        await connectInteractive(app);
      } catch (e) {
        const y = e as YtError;
        say(`✗ ${y.message} ${y.hint ?? ""}`);
      }
      rl.resume();
    }

    await setupTranscription(app, rl);

    say(bold("\nStep 4 · Add to your AI apps"));
    const found = CLIENTS.filter((c) => c.detect());
    if (found.length) {
      say(`Found: ${found.map((c) => c.name).join(", ")}`);
      const pick = await ask(
        rl,
        'Install into which? (comma-separated ids, "all", or "none")',
        "all",
      );
      if (pick !== "none")
        await installClients(
          pick.split(",").map((s) => s.trim()),
          "auto",
        );
    } else say("No supported apps detected.");
    say(dim("\nOther clients:\n") + dim(manualSnippets(launchSpec())));
    say(
      bold("\nDone.") +
        ' Restart your AI app and ask: "Check my YouTube connection" or "How did my channel do this month?".\n',
    );
  } finally {
    rl.close();
    app.db.close();
  }
}

async function status() {
  const app = await createApp();
  const chans = app.channels.list().map(describeChannel);
  say(bold(`${APP} ${VERSION}`));
  say(`Data folder:      ${app.cfg.home}`);
  say(`Token storage:    ${app.vault.kind}`);
  say(
    `Google OAuth:     ${app.cfg.google.clientId ? "configured" : "NOT configured (run setup)"}`,
  );
  say(
    `Transcription:    ${app.cfg.transcription.apiKey ? `${app.cfg.transcription.baseUrl} (${app.cfg.transcription.model})` : "off"}`,
  );
  say(`Channels:${chans.length ? "" : "         none (run connect)"}`);
  for (const c of chans)
    say(
      `  ${c.default ? "★" : " "} ${c.title} ${dim(`${c.handle ?? c.channel_id} · ${c.status}`)}`,
    );
  const q = app.quota.status();
  say(
    `Quota today:      ${q.units_used}/${q.units_limit} units · ${q.uploads_used}/${q.uploads_limit} uploads · resets ${q.resets_at}`,
  );
  const jobs = app.jobs.list(5);
  if (jobs.length) {
    say("Recent uploads:");
    for (const j of jobs)
      say(
        `  ${j.status.padEnd(10)} ${j.video_id ? `https://youtu.be/${j.video_id}` : j.id}`,
      );
  }
  app.db.close();
}

async function doctor() {
  const app = await createApp();
  const check = (okay: boolean, label: string, fix?: string) =>
    say(
      `${okay ? "✓" : "✗"} ${label}${!okay && fix ? dim(`\n    → ${fix}`) : ""}`,
    );
  const [major, minor] = process.versions.node.split(".").map(Number);
  check(
    major > 22 || (major === 22 && minor >= 13),
    `Node.js ${process.versions.node}`,
    "Install Node.js 22.13 or newer: https://nodejs.org",
  );
  say(`✓ Token storage: ${app.vault.kind === "keychain" ? "OS keychain" : `encrypted file in ${app.cfg.home} (no OS keychain found)`}`);
  check(
    Boolean(app.cfg.google.clientId && app.cfg.google.clientSecret),
    "Google OAuth client",
    `Run: npx ${APP} setup`,
  );
  const chans = app.channels.list();
  check(
    chans.length > 0,
    `${chans.length} channel(s) connected`,
    `Run: npx ${APP} connect`,
  );
  for (const c of chans) {
    try {
      await (await app.channels.api(c)).accessToken();
      check(true, `  ${c.title}: sign-in valid`);
    } catch (e) {
      check(
        false,
        `  ${c.title}: ${(e as Error).message}`,
        `Run: npx ${APP} connect`,
      );
    }
  }
  check(
    await hasFfmpeg(),
    "ffmpeg (only needed for transcription)",
    "brew install ffmpeg / apt install ffmpeg / winget install ffmpeg",
  );
  for (const c of CLIENTS) if (c.detect()) say(dim(`  found ${c.name}`));
  app.db.close();
}

async function serve() {
  const app = await createApp();
  app.jobs.start();
  const server = buildServer(app);
  await server.connect(new StdioServerTransport());
  log.info("stdio server ready", { version: VERSION, home: app.cfg.home });
  const shutdown = () => {
    app.jobs.stop();
    app.connector.close();
    void server.close().finally(() => {
      app.db.close();
      process.exit(0);
    });
  };
  process.stdin.on("close", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = new Set(rest.filter((a) => a.startsWith("--")));
  const args = rest.filter((a) => !a.startsWith("--"));
  const mode = flags.has("--npx")
    ? "npx"
    : flags.has("--node")
      ? "node"
      : "auto";
  switch (cmd) {
    case undefined:
      if (process.stdin.isTTY) {
        say(HELP);
        return;
      }
      return serve();
    case "serve":
    case "stdio":
      return serve();
    case "setup":
      return setup();
    case "connect": {
      const app = await createApp();
      await connectInteractive(app);
      app.db.close();
      process.exit(0);
    }
    // falls through (process.exit above)
    case "status":
      return status();
    case "doctor":
      return doctor();
    case "install":
      return installClients(args.length ? args : ["all"], mode);
    case "uninstall":
      for (const c of CLIENTS.filter(
        (x) => args.includes("all") || !args.length || args.includes(x.id),
      )) {
        try {
          say(c.remove());
        } catch (e) {
          say(`✗ ${c.name}: ${(e as Error).message}`);
        }
      }
      return;
    case "config":
      say(manualSnippets(launchSpec(mode)));
      return;
    case "-v":
    case "--version":
    case "version":
      say(VERSION);
      return;
    case "-h":
    case "--help":
    case "help":
      say(HELP);
      return;
    default:
      say(`Unknown command "${cmd}".\n`);
      say(HELP);
      process.exitCode = 1;
  }
}

main().catch((e: unknown) => {
  const y = e instanceof YtError ? e : null;
  process.stderr.write(
    `✗ ${y ? `${y.message}${y.hint ? `\n  ${y.hint}` : ""}` : e instanceof Error ? e.stack : String(e)}\n`,
  );
  process.exit(1);
});
