import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadAiSettings } from "./ai/providers.js";
import { Channels } from "./channels.js";
import { loadConfig, SECRET, type Config } from "./config.js";
import { Connector } from "./connect.js";
import { Db } from "./db.js";
import { Quota } from "./quota.js";
import { TemplateStore } from "./templates.js";
import { JobManager } from "./upload/jobs.js";
import { AB_METRICS, Experiments, type AbMetric } from "./experiments.js";
import { quotaDay } from "./quota.js";
import { Scheduler } from "./scheduler.js";
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
  experiments: Experiments;
  scheduler: Scheduler;
}

export async function createApp(env: NodeJS.ProcessEnv = process.env): Promise<App> {
  const cfg = loadConfig(env);
  mkdirSync(cfg.home, { recursive: true, mode: 0o700 });
  const vault = openVault(cfg.home, env.YT_MCP_VAULT);
  // Priority: YT_MCP_GOOGLE_* env, then the client saved by setup, then generic GOOGLE_* env.
  cfg.google.clientId ??=
    (await vault.get(SECRET.googleClientId)) ?? cfg.googleEnvFallback.clientId;
  cfg.google.clientSecret ??=
    (await vault.get(SECRET.googleClientSecret)) ?? cfg.googleEnvFallback.clientSecret;

  const db = new Db(join(cfg.home, "state.db"));
  await loadAiSettings(cfg.ai, env, db, vault);

  const quota = new Quota(db, cfg);
  const channels = new Channels(db, vault, cfg, quota);
  const templates = new TemplateStore(cfg.templatesDir);
  const jobs = new JobManager(db, cfg, channels, quota);
  const connector = new Connector(cfg, channels, (row) => jobs.requeueForChannel(row.id));
  const experiments = new Experiments(db, cfg, channels);
  const scheduler = new Scheduler(db, experiments);
  jobs.abTestStarter = async ({ channelRowId, videoId, spec, publishAt, originalThumbnail }) => {
    // Start the day after the video goes live, so every measured day is a full day.
    const live = publishAt ? quotaDay(new Date(publishAt)) : quotaDay();
    const dayAfterLive = new Date(Date.parse(`${live}T12:00:00Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);
    // A job that resumes late must not schedule a test in the past.
    const tomorrow = new Date(Date.parse(`${quotaDay()}T12:00:00Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);
    const startOn = dayAfterLive > tomorrow ? dayAfterLive : tomorrow;
    const r = await experiments.create({
      channelRowId,
      videoId,
      variants: spec.variants,
      days: spec.days,
      metric: (AB_METRICS as readonly string[]).includes(spec.metric)
        ? (spec.metric as AbMetric)
        : "views",
      startOn,
      autoApply: spec.auto_apply_winner,
      originalThumbnail,
    });
    return { test_id: r.test_id, starts_on: r.starts_on, ends_on: r.ends_on };
  };
  return { cfg, db, vault, quota, channels, templates, jobs, connector, experiments, scheduler };
}
