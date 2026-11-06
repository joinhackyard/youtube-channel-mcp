import { homedir } from "node:os";
import { join } from "node:path";

export const APP = "youtube-publisher-mcp";
export const VERSION = "1.0.0";

export type ConfirmPolicy = "public" | "always" | "never";

export interface Config {
  home: string;
  google: { clientId?: string; clientSecret?: string };
  confirmPolicy: ConfirmPolicy;
  quota: { dailyUnits: number; dailyUploads: number; uploadUnitCost: number };
  chunkSize: number;
  maxUploadBytes: number;
  templatesDir: string;
  transcription: { apiKey?: string; baseUrl: string; model: string };
}

const int = (v: string | undefined, d: number) => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : d;
};

/** YouTube resumable chunks must be multiples of 256 KiB. */
export function normaliseChunkSize(mb: number): number {
  const unit = 256 * 1024;
  return Math.max(
    unit,
    Math.floor((Math.max(1, mb) * 1024 * 1024) / unit) * unit,
  );
}

export function defaultHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.YT_MCP_HOME) return env.YT_MCP_HOME;
  if (process.platform === "linux" && env.XDG_CONFIG_HOME)
    return join(env.XDG_CONFIG_HOME, APP);
  return join(homedir(), `.${APP}`);
}

/** Environment variables override; secrets not in the environment are read from the vault at startup. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = defaultHome(env);
  const policy = (env.YT_CONFIRM ?? "public").toLowerCase();
  return {
    home,
    google: {
      clientId: env.GOOGLE_CLIENT_ID || undefined,
      clientSecret: env.GOOGLE_CLIENT_SECRET || undefined,
    },
    confirmPolicy:
      policy === "always" || policy === "never" ? policy : "public",
    quota: {
      dailyUnits: int(env.YT_DAILY_UNIT_LIMIT, 10_000),
      dailyUploads: int(env.YT_DAILY_UPLOAD_LIMIT, 100),
      uploadUnitCost: int(env.YT_UPLOAD_UNIT_COST, 0),
    },
    chunkSize: normaliseChunkSize(int(env.YT_CHUNK_MB, 16)),
    maxUploadBytes: int(env.YT_MAX_UPLOAD_GB, 256) * 1024 ** 3,
    templatesDir: env.YT_TEMPLATES_DIR || join(home, "templates"),
    transcription: {
      apiKey: env.TRANSCRIBE_API_KEY || env.OPENAI_API_KEY || undefined,
      baseUrl: (
        env.TRANSCRIBE_BASE_URL ||
        env.OPENAI_BASE_URL ||
        "https://api.openai.com/v1"
      ).replace(/\/+$/, ""),
      model: env.TRANSCRIBE_MODEL || "whisper-1",
    },
  };
}

/** Names of secrets kept in the OS keychain (or encrypted file) by `setup`. */
export const SECRET = {
  googleClientId: "config:google-client-id",
  googleClientSecret: "config:google-client-secret",
  transcribeKey: "config:transcribe-api-key",
} as const;
