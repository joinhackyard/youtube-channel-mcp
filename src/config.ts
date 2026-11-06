import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

export const APP = "youtube-channel-mcp";
/** npm package name (published under the joinhackyard organisation). */
export const PACKAGE = "@joinhackyard/youtube-channel-mcp";
/** Single source of truth: the version in package.json. */
export const VERSION: string = (
  createRequire(import.meta.url)("../../package.json") as { version: string }
).version;

export type ConfirmPolicy = "public" | "always" | "never";

export interface Config {
  home: string;
  google: { clientId?: string; clientSecret?: string };
  confirmPolicy: ConfirmPolicy;
  quota: { dailyUnits: number; dailyUploads: number; uploadUnitCost: number };
  chunkSize: number;
  maxUploadBytes: number;
  templatesDir: string;
  /** Kept so a generic GOOGLE_CLIENT_ID meant for another app never overrides the client saved by setup. */
  googleEnvFallback: { clientId?: string; clientSecret?: string };
  ai: AiSettings;
}

/** AI providers the server can call itself. All optional: without them, tools return briefs for your AI app. */
export const AI_PROVIDERS = [
  "anthropic",
  "openai",
  "azure",
  "gemini",
  "openrouter",
  "groq",
  "ollama",
  "custom",
] as const;
export type AiProviderId = (typeof AI_PROVIDERS)[number];

/** What a model is used for. text: writing and analysis; vision: judging thumbnails; image: making thumbnails. */
export const AI_TASKS = ["text", "vision", "image", "transcribe"] as const;
export type AiTask = (typeof AI_TASKS)[number];

export interface AiProviderSettings {
  apiKey?: string;
  /** OpenAI-compatible base URL (OpenRouter, Groq, Ollama, custom) or override. */
  baseUrl?: string;
  /** Azure OpenAI resource endpoint, e.g. https://name.openai.azure.com */
  endpoint?: string;
  apiVersion?: string;
}

export interface AiSettings {
  providers: Partial<Record<AiProviderId, AiProviderSettings>>;
  /** Per task: "provider:model" (for Azure the model is the deployment name). */
  models: Partial<Record<AiTask, string>>;
  /** Reasoning effort for Claude and OpenAI reasoning models. */
  effort: "low" | "medium" | "high" | "xhigh" | "max";
}

const int = (v: string | undefined, d: number) => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

/** YouTube resumable chunks must be multiples of 256 KiB. */
export function normaliseChunkSize(mb: number): number {
  const unit = 256 * 1024;
  return Math.max(unit, Math.floor((Math.max(1, mb) * 1024 * 1024) / unit) * unit);
}

const trimUrl = (u?: string) => (u ? u.trim().replace(/\/+$/, "") : undefined);

export function defaultHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.YT_MCP_HOME) return env.YT_MCP_HOME;
  if (process.platform === "linux" && env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, APP);
  return join(homedir(), `.${APP}`);
}

/** Environment variables override; secrets not in the environment are read from the vault at startup. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = defaultHome(env);
  const policy = (env.YT_CONFIRM ?? "public").toLowerCase();
  return {
    home,
    google: {
      clientId: env.YT_MCP_GOOGLE_CLIENT_ID || undefined,
      clientSecret: env.YT_MCP_GOOGLE_CLIENT_SECRET || undefined,
    },
    googleEnvFallback: {
      clientId: env.GOOGLE_CLIENT_ID || undefined,
      clientSecret: env.GOOGLE_CLIENT_SECRET || undefined,
    },
    confirmPolicy: policy === "always" || policy === "never" ? policy : "public",
    quota: {
      dailyUnits: int(env.YT_DAILY_UNIT_LIMIT, 10_000),
      dailyUploads: int(env.YT_DAILY_UPLOAD_LIMIT, 100),
      uploadUnitCost: int(env.YT_UPLOAD_UNIT_COST, 0),
    },
    chunkSize: normaliseChunkSize(int(env.YT_CHUNK_MB, 16)),
    maxUploadBytes: int(env.YT_MAX_UPLOAD_GB, 256) * 1024 ** 3,
    templatesDir: env.YT_TEMPLATES_DIR || join(home, "templates"),
    ai: aiFromEnv(env),
  };
}

/** AI settings from the environment. Values saved with `ai` (keychain + database) fill in what is missing. */
export function aiFromEnv(env: NodeJS.ProcessEnv): AiSettings {
  const p: AiSettings["providers"] = {};
  const set = (id: AiProviderId, v: AiProviderSettings) => {
    const clean = Object.fromEntries(Object.entries(v).filter(([, x]) => x)) as AiProviderSettings;
    if (Object.keys(clean).length) p[id] = clean;
  };
  set("anthropic", { apiKey: env.ANTHROPIC_API_KEY });
  set("openai", { apiKey: env.OPENAI_API_KEY, baseUrl: trimUrl(env.OPENAI_BASE_URL) });
  set("azure", {
    apiKey: env.AZURE_OPENAI_API_KEY,
    endpoint: trimUrl(env.AZURE_OPENAI_ENDPOINT),
    apiVersion: env.AZURE_OPENAI_API_VERSION,
  });
  set("gemini", { apiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY });
  set("openrouter", { apiKey: env.OPENROUTER_API_KEY });
  set("groq", { apiKey: env.GROQ_API_KEY });
  set("ollama", { baseUrl: trimUrl(env.OLLAMA_BASE_URL) });
  set("custom", { apiKey: env.AI_CUSTOM_API_KEY, baseUrl: trimUrl(env.AI_CUSTOM_BASE_URL) });
  const models: AiSettings["models"] = {};
  if (env.YT_AI_TEXT_MODEL) models.text = env.YT_AI_TEXT_MODEL;
  if (env.YT_AI_VISION_MODEL) models.vision = env.YT_AI_VISION_MODEL;
  if (env.YT_AI_IMAGE_MODEL) models.image = env.YT_AI_IMAGE_MODEL;
  if (env.YT_AI_TRANSCRIBE_MODEL) models.transcribe = env.YT_AI_TRANSCRIBE_MODEL;
  const effort = env.YT_AI_EFFORT;
  return {
    providers: p,
    models,
    effort:
      effort === "low" || effort === "high" || effort === "xhigh" || effort === "max"
        ? effort
        : "medium",
  };
}

/** Names of secrets kept in the OS keychain (or encrypted file) by `setup`. */
export const SECRET = {
  googleClientId: "config:google-client-id",
  googleClientSecret: "config:google-client-secret",
  /** Per-provider AI keys: `ai-key:anthropic`, `ai-key:openai`, ... */
  aiKey: (provider: string) => `ai-key:${provider}`,
  /** 1.0 name for the transcription key; read once and moved to ai-key:openai. */
  legacyTranscribeKey: "config:transcribe-api-key",
} as const;
