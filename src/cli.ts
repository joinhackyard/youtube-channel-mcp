#!/usr/bin/env node
import "./quiet.js";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  clearAi,
  describeAi,
  isConfigured,
  listModels,
  loadAiSettings,
  parseModelRef,
  PROVIDERS,
  removeProvider,
  resolveModel,
  saveModels,
  saveProvider,
  testAi,
} from "./ai/providers.js";
import { AI_PROVIDERS, AI_TASKS, type AiProviderId, type AiTask } from "./config.js";
import { installService, serviceStatus, uninstallService } from "./service.js";
import { hasFfmpeg } from "./ai/transcript.js";
import { createApp, type App } from "./app.js";
import { describeChannel } from "./channels.js";
import { CLIENTS, launchSpec, manualSnippets } from "./clients.js";
import { APP, PACKAGE, SECRET, VERSION } from "./config.js";
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
  npx ${PACKAGE} setup            Guided setup: Google credentials, connect a channel, add to your AI apps

${bold("Commands")}
  setup                        Run the guided setup (safe to re-run)
  connect                      Connect or reconnect a YouTube channel (opens Google sign-in)
  status                       Show connected channels, quota and configuration
  install [client...]          Add the server to AI apps: ${CLIENTS.map((c) => c.id).join(", ")}, or "all"
  uninstall [client...]        Remove it from AI apps
  ai                           Connect AI providers: Claude, OpenAI, Azure OpenAI, Gemini, OpenRouter, Groq, Ollama
  config                       Print config snippets for any other MCP client
  doctor                       Check everything and explain what to fix
  serve                        Run the MCP server over stdio (what AI apps start)
  daemon                       Run background work only: uploads and A/B test rotations
  service install|uninstall|status
                               Keep the daemon running in the background (launchd / systemd / Task Scheduler)

${bold("Options for install")}
  --npx                        Launch with "npx -y ${PACKAGE}@latest" (always latest)
  --node                       Launch this installed copy directly with node

Docs: https://github.com/joinhackyard/${APP}#readme`;

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
  const a = (await rl.question(`${q} ${dim(def ? "[Y/n]" : "[y/N]")} `)).trim().toLowerCase();
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

function parseClientSecretJson(text: string): { id: string; secret: string } | null {
  try {
    const j = JSON.parse(text) as Record<string, { client_id?: string; client_secret?: string }>;
    const c =
      j.installed ?? j.web ?? (j as unknown as { client_id?: string; client_secret?: string });
    if (c?.client_id && c?.client_secret) return { id: c.client_id, secret: c.client_secret };
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
    say(`✓ Google OAuth client configured ${dim(`(${app.cfg.google.clientId.slice(0, 18)}…)`)}`);
    if (!(await askYes(rl, "Replace it with a different one?", false))) return;
  }
  say(bold("\nStep 1 · Google credentials") + dim(" (one time, about 3 minutes, free)"));
  say(
    "YouTube only lets apps upload through your own Google Cloud OAuth client, so you create one:\n",
  );
  GOOGLE_STEPS.forEach(([t, url], i) => say(`  ${i + 1}. ${t}\n     ${dim(url)}`));
  say();
  if (await askYes(rl, "Open these pages in your browser now?", true))
    GOOGLE_STEPS.forEach(([, url]) => openBrowser(url));

  for (;;) {
    const input = await ask(
      rl,
      "\nDrag the downloaded client_secret_….json file here (or paste the Client ID):",
    );
    if (!input) continue;
    const path = expandPath(input.replace(/^['"]|['"]$/g, "").replace(/\\ /g, " "));
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
  say(`✓ Connected ${bold(row.title ?? row.channel_id)} ${dim(row.handle ?? "")}`);
}

async function printAiTest(app: App) {
  for (const r of await testAi(app.cfg.ai)) {
    if (!r.target) continue;
    say(`${r.ok ? "✓" : "✗"} ${r.task.padEnd(10)} ${r.target} ${dim(r.detail)}`);
  }
}

const TASK_LABEL: Record<AiTask, string> = {
  text: "Writing & analysis (titles, descriptions, diagnosis, comments)",
  vision: "Vision (judging thumbnails)",
  image: "Image generation (thumbnails)",
  transcribe: "Transcription (captions, Shorts finder)",
};

/** Choose a model per task from the live catalogue of the connected providers. */
async function chooseModels(app: App, rl: ReturnType<typeof createInterface>) {
  const connected = AI_PROVIDERS.filter((id) => isConfigured(app.cfg.ai, id));
  if (!connected.length) return;
  const catalog = new Map<AiProviderId, string[]>();
  for (const id of connected) catalog.set(id, await listModels(app.cfg.ai, id).catch(() => []));
  const chosen: Partial<Record<AiTask, string | null>> = {};
  for (const task of AI_TASKS) {
    const providers = connected.filter((id) => PROVIDERS[id].tasks.includes(task));
    if (!providers.length) continue;
    const cur = resolveModel(app.cfg.ai, task);
    say(`\n${bold(TASK_LABEL[task])}`);
    const options: string[] = [];
    for (const id of providers) {
      const d = PROVIDERS[id].defaults[task];
      if (d) options.push(`${id}:${d}`);
    }
    if (options.length) say(dim(`  suggested: ${options.join("  ")}`));
    for (const id of providers) {
      const list = catalog.get(id) ?? [];
      if (list.length)
        say(dim(`  ${id} models: ${list.slice(0, 25).join(", ")}${list.length > 25 ? ", …" : ""}`));
      else if (id === "azure") say(dim("  azure: type a deployment name, e.g. azure:gpt-5-chat"));
    }
    const ans = await ask(
      rl,
      `  Use (provider:model, "none", or Enter to keep):`,
      cur ? `${cur.provider}:${cur.model}` : "none",
    );
    chosen[task] = ans === "none" ? null : ans;
    if (ans !== "none") app.cfg.ai.models[task] = ans;
    else delete app.cfg.ai.models[task];
  }
  saveModels(app.db, chosen);
}

async function addProviderInteractive(
  app: App,
  rl: ReturnType<typeof createInterface>,
  id: AiProviderId,
) {
  const info = PROVIDERS[id];
  const cur = app.cfg.ai.providers[id] ?? {};
  if (info.keyUrl) say(dim(`Get a key at ${info.keyUrl}`));
  const settings: { apiKey?: string; baseUrl?: string; endpoint?: string; apiVersion?: string } =
    {};
  if (id === "azure") {
    settings.endpoint = (
      await ask(
        rl,
        "Endpoint (https://<resource>.openai.azure.com or .cognitiveservices.azure.com):",
        cur.endpoint,
      )
    ).replace(/\/+$/, "");
    settings.apiVersion = await ask(rl, "API version:", cur.apiVersion ?? "2025-04-01-preview");
  }
  if (id === "custom" || id === "ollama") {
    settings.baseUrl = (
      await ask(rl, "Base URL (ending in /v1):", cur.baseUrl ?? info.baseUrl)
    ).replace(/\/+$/, "");
  }
  if (info.needsKey || id === "custom") {
    const key = await askSecret(
      rl,
      cur.apiKey
        ? "API key (Enter to keep the saved one):"
        : `API key${info.needsKey ? "" : " (optional)"}:`,
    );
    if (key) settings.apiKey = key;
  }
  await saveProvider(app.db, app.vault, id, settings);
  await loadAiSettings(app.cfg.ai, process.env, app.db, app.vault);
  say(`✓ ${info.label} saved${settings.apiKey ? " (key in your keychain)" : ""}.`);
}

async function setupAi(
  app: App,
  rl: ReturnType<typeof createInterface>,
  step = "Step 3 · AI providers",
) {
  say(bold(`\n${step}`) + dim(" (optional)"));
  say(
    "Connect Claude, OpenAI, Azure OpenAI, Gemini, OpenRouter, Groq, Ollama or any OpenAI-compatible API so the server can",
  );
  say(
    "write titles and descriptions, diagnose videos, triage comments, find Shorts, design and judge thumbnails, and transcribe.",
  );
  say("Your AI app can still do the writing itself without this.");
  for (;;) {
    const d = describeAi(app.cfg.ai);
    say(dim(`Connected: ${d.providers.map((p) => p.id).join(", ") || "none"}`));
    const menu = AI_PROVIDERS.map(
      (id, i) => `[${i + 1}] ${PROVIDERS[id].label}${isConfigured(app.cfg.ai, id) ? " ✓" : ""}`,
    ).join("  ");
    say(menu);
    const pick = (
      await ask(rl, "Add or update a provider (number), or Enter when done:", "")
    ).trim();
    if (!pick) break;
    const id = AI_PROVIDERS[Number(pick) - 1];
    if (!id) continue;
    await addProviderInteractive(app, rl, id);
  }
  if (describeAi(app.cfg.ai).providers.length) {
    if (await askYes(rl, "Choose which model does each job now?", true))
      await chooseModels(app, rl);
    say("\nTesting…");
    await printAiTest(app);
    if (resolveModel(app.cfg.ai, "transcribe") && !(await hasFfmpeg()))
      say("Install ffmpeg for transcription and Shorts (macOS: brew install ffmpeg).");
  }
}

/**
 * `ai` with no arguments is interactive. Scriptable forms (keys via stdin so they never reach shell history):
 *   ai add <provider> [--endpoint U] [--base-url U] [--api-version V] [--key-stdin]
 *   ai models [--text p:m] [--vision p:m] [--image p:m] [--transcribe p:m] [--effort E]
 *   ai list <provider> | ai test | ai status | ai remove <provider> | ai off
 */
async function aiCommand(args: string[]) {
  const [sub, ...rest] = args;
  const opt = (name: string) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const readStdin = async () => {
    if (!rest.includes("--key-stdin")) return undefined;
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8").trim() || undefined;
  };
  const app = await createApp();
  const providerArg = () => {
    const id = rest[0] as AiProviderId;
    if (!(AI_PROVIDERS as readonly string[]).includes(id))
      throw new YtError("invalid_request", `Provider must be one of: ${AI_PROVIDERS.join(", ")}`);
    return id;
  };
  try {
    switch (sub) {
      case undefined: {
        if (!process.stdin.isTTY)
          throw new YtError(
            "invalid_request",
            "Run `ai` in a terminal, or use `ai add <provider> --key-stdin`.",
          );
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          await setupAi(app, rl, "AI providers");
        } finally {
          rl.close();
        }
        return;
      }
      case "add": {
        const id = providerArg();
        await saveProvider(app.db, app.vault, id, {
          apiKey: await readStdin(),
          endpoint: opt("endpoint"),
          baseUrl: opt("base-url"),
          apiVersion: opt("api-version"),
        });
        await loadAiSettings(app.cfg.ai, process.env, app.db, app.vault);
        say(`✓ ${PROVIDERS[id].label} saved.`);
        break;
      }
      case "models": {
        const models: Partial<Record<AiTask, string | null>> = {};
        for (const t of AI_TASKS) {
          const v = opt(t);
          if (v !== undefined) models[t] = v === "none" ? null : v;
        }
        for (const [t, v] of Object.entries(models)) {
          if (!v) continue;
          const ref = parseModelRef(v);
          if (!ref)
            throw new YtError(
              "invalid_request",
              `--${t} must be provider:model, e.g. anthropic:claude-opus-5-5`,
            );
          if (!PROVIDERS[ref.provider].tasks.includes(t as AiTask))
            throw new YtError("invalid_request", `${PROVIDERS[ref.provider].label} can't do ${t}.`);
        }
        const effortArg = opt("effort");
        if (effortArg && !["low", "medium", "high", "xhigh", "max"].includes(effortArg))
          throw new YtError("invalid_request", "--effort must be low, medium, high, xhigh or max.");
        const effort = effortArg as "low" | "medium" | "high" | "xhigh" | "max" | undefined;
        saveModels(app.db, models, effort);
        await loadAiSettings(app.cfg.ai, process.env, app.db, app.vault);
        for (const [t, v] of Object.entries(models)) if (v) app.cfg.ai.models[t as AiTask] = v;
        break;
      }
      case "list": {
        const id = providerArg();
        const models = await listModels(app.cfg.ai, id);
        say(
          models.length
            ? models.join("\n")
            : "This provider has no model list (Azure: use your deployment names).",
        );
        return;
      }
      case "remove":
        await removeProvider(app.db, app.vault, providerArg());
        say("Removed.");
        return;
      case "off":
        await clearAi(app.db, app.vault);
        say("All AI providers and keys removed.");
        return;
      case "test":
      case "status":
        break;
      default:
        say(`Usage:
  ${APP} ai                                   interactive setup
  ${APP} ai add <provider> [--endpoint <url>] [--base-url <url>] [--api-version <v>] [--key-stdin]
  ${APP} ai models [--text p:m] [--vision p:m] [--image p:m] [--transcribe p:m] [--effort low|medium|high|xhigh|max]
  ${APP} ai list <provider>                   show the provider's models
  ${APP} ai test | status | remove <provider> | off

Providers: ${AI_PROVIDERS.join(", ")}
Example (Azure key straight from the az CLI, never in shell history):
  az cognitiveservices account keys list -g <rg> -n <resource> --query key1 -o tsv | \\
    ${APP} ai add azure --endpoint https://<resource>.cognitiveservices.azure.com --key-stdin
  ${APP} ai models --text azure:gpt-6-astra --image azure:gpt-image-2 --transcribe azure:whisper`);
        return;
    }
    const d = describeAi(app.cfg.ai);
    say(`Providers:  ${d.providers.map((p) => p.name).join(", ") || "none"}`);
    for (const t of AI_TASKS) say(`${t.padEnd(11)} ${d.models[t] ?? dim("off")}`);
    say(`effort      ${d.effort}`);
    if (sub === "test" && d.providers.length) {
      say("");
      await printAiTest(app);
    }
  } finally {
    app.db.close();
  }
}

async function installClients(ids: string[], mode: "auto" | "npx" | "node") {
  const spec = launchSpec(mode);
  const targets = ids.includes("all")
    ? CLIENTS.filter((c) => c.detect())
    : CLIENTS.filter((c) => ids.includes(c.id));
  const unknown = ids.filter((i) => i !== "all" && !CLIENTS.some((c) => c.id === i));
  if (unknown.length)
    say(`Unknown client(s): ${unknown.join(", ")}. Known: ${CLIENTS.map((c) => c.id).join(", ")}`);
  for (const c of targets) {
    try {
      say(`✓ ${c.install(spec)}`);
    } catch (e) {
      say(`✗ ${c.name}: ${(e as Error).message}`);
    }
  }
  if (!targets.length)
    say("No supported AI apps found. Use `config` to print snippets for your client.");
}

async function setup() {
  const app = await createApp();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    say(bold(`\nYouTube Channel MCP · setup`) + dim(`  (data: ${app.cfg.home})`));
    await setupGoogle(app, rl);

    say(bold("\nStep 2 · Connect your YouTube channel"));
    const existing = app.channels.list();
    for (const c of existing)
      say(`  ✓ ${c.title} ${dim(c.status === "ok" ? "" : "(needs reconnect)")}`);
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

    await setupAi(app, rl);

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
    say(bold("\nStep 5 · Background service") + dim(" (recommended)"));
    say("Keeps uploads going and rotates A/B tests on time even when no AI app is open.");
    if (serviceStatus() === "not installed" && (await askYes(rl, "Install it?", true))) {
      try {
        say(`✓ ${installService()}`);
      } catch (e) {
        say(`✗ ${(e as Error).message}`);
      }
    } else say(dim(`Background service: ${serviceStatus()}`));
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
  say(`Google OAuth:     ${app.cfg.google.clientId ? "configured" : "NOT configured (run setup)"}`);
  say(
    `AI writing:       ${describeAi(app.cfg.ai).writing ?? "off"}\nTranscription:    ${describeAi(app.cfg.ai).transcription ?? "off"}`,
  );
  const ai = describeAi(app.cfg.ai);
  say(`AI providers:     ${ai.providers.map((p) => p.id).join(", ") || "none (run ai)"}`);
  say(`Background:       ${serviceStatus()}`);
  const tests = app.experiments
    .list()
    .filter((e) => ["scheduled", "running", "collecting"].includes(e.status));
  if (tests.length) say(`A/B tests:        ${tests.length} active`);
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
      say(`  ${j.status.padEnd(10)} ${j.video_id ? `https://youtu.be/${j.video_id}` : j.id}`);
  }
  app.db.close();
}

async function doctor() {
  const app = await createApp();
  const check = (okay: boolean, label: string, fix?: string) =>
    say(`${okay ? "✓" : "✗"} ${label}${!okay && fix ? dim(`\n    → ${fix}`) : ""}`);
  const [major, minor] = process.versions.node.split(".").map(Number);
  check(
    major > 22 || (major === 22 && minor >= 13),
    `Node.js ${process.versions.node}`,
    "Install Node.js 22.13 or newer: https://nodejs.org",
  );
  say(
    `✓ Token storage: ${app.vault.kind === "keychain" ? "OS keychain" : `encrypted file in ${app.cfg.home} (no OS keychain found)`}`,
  );
  check(
    Boolean(app.cfg.google.clientId && app.cfg.google.clientSecret),
    "Google OAuth client",
    `Run: npx ${PACKAGE} setup`,
  );
  const chans = app.channels.list();
  check(chans.length > 0, `${chans.length} channel(s) connected`, `Run: npx ${PACKAGE} connect`);
  for (const c of chans) {
    try {
      await (await app.channels.api(c)).accessToken();
      check(true, `  ${c.title}: sign-in valid`);
    } catch (e) {
      check(false, `  ${c.title}: ${(e as Error).message}`, `Run: npx ${PACKAGE} connect`);
    }
  }
  check(
    await hasFfmpeg(),
    "ffmpeg (only needed for transcription)",
    "brew install ffmpeg / apt install ffmpeg / winget install ffmpeg",
  );
  if (describeAi(app.cfg.ai).providers.length) await printAiTest(app);
  else say(dim("  AI providers: none (optional; run `ai`)"));
  for (const c of CLIENTS) if (c.detect()) say(dim(`  found ${c.name}`));
  app.db.close();
}

/** Background-only process for the service: finishes uploads and rotates A/B tests on schedule. */
async function daemon() {
  const app = await createApp();
  app.jobs.start();
  app.scheduler.start(true);
  log.info("daemon running", { version: VERSION, home: app.cfg.home });
  const shutdown = () => {
    app.jobs.stop();
    app.scheduler.stop();
    app.db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function serve() {
  const app = await createApp();
  app.jobs.start();
  app.scheduler.start();
  const server = buildServer(app);
  await server.connect(new StdioServerTransport());
  log.info("stdio server ready", { version: VERSION, home: app.cfg.home });
  const shutdown = () => {
    app.jobs.stop();
    app.scheduler.stop();
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
  const mode = flags.has("--npx") ? "npx" : flags.has("--node") ? "node" : "auto";
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
    case "daemon":
      return daemon();
    case "service": {
      const sub = args[0] ?? "status";
      if (sub === "install") say(`✓ ${installService()}`);
      else if (sub === "uninstall") say(uninstallService());
      else say(`Background service: ${serviceStatus()}`);
      return;
    }
    case "ai":
      return aiCommand(rest);
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
