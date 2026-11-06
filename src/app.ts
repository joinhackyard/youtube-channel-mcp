import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Channels } from "./channels.js";
import { loadConfig, SECRET, type Config } from "./config.js";
import { Connector } from "./connect.js";
import { Db } from "./db.js";
import { Quota } from "./quota.js";
import { TemplateStore } from "./templates.js";
import { JobManager } from "./upload/jobs.js";
import { openVault, type TokenVault } from "./vault.js";

export interface App {
  cfg: Config;
  db: Db;
  vault: TokenVault;
  quota: Quota;
  channels: Channels;
  templates: TemplateStore;
  jobs: JobManager;
  connector: Connector;
}

export async function createApp(env: NodeJS.ProcessEnv = process.env): Promise<App> {
  const cfg = loadConfig(env);
  mkdirSync(cfg.home, { recursive: true, mode: 0o700 });
  const vault = openVault(cfg.home, env.YT_MCP_VAULT);
  cfg.google.clientId ??= (await vault.get(SECRET.googleClientId)) ?? undefined;
  cfg.google.clientSecret ??= (await vault.get(SECRET.googleClientSecret)) ?? undefined;
  cfg.transcription.apiKey ??= (await vault.get(SECRET.transcribeKey)) ?? undefined;

  const db = new Db(join(cfg.home, "state.db"));
  if (!env.TRANSCRIBE_BASE_URL && !env.OPENAI_BASE_URL)
    cfg.transcription.baseUrl = db.setting("transcribe_base_url") ?? cfg.transcription.baseUrl;
  if (!env.TRANSCRIBE_MODEL)
    cfg.transcription.model = db.setting("transcribe_model") ?? cfg.transcription.model;

  const quota = new Quota(db, cfg);
  const channels = new Channels(db, vault, cfg, quota);
  const templates = new TemplateStore(cfg.templatesDir);
  const jobs = new JobManager(db, cfg, channels, quota);
  const connector = new Connector(cfg, channels, (row) => jobs.requeueForChannel(row.id));
  return { cfg, db, vault, quota, channels, templates, jobs, connector };
}
