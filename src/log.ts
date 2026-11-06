// All logs go to stderr: in stdio mode stdout carries the MCP protocol.
type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};
const threshold =
  order[(process.env.LOG_LEVEL as Level) ?? "info"] ?? order.info;

const SECRET =
  /(ya29\.[\w-]+|1\/\/[\w-]{20,}|4\/[\w-]{20,}|GOCSPX-[\w-]+|cf_[\w-]{10,}|Bearer\s+[\w.-]+)/g;

export function redact(s: string): string {
  return s.replace(SECRET, "[redacted]");
}

function write(level: Level, msg: string, extra?: Record<string, unknown>) {
  if (order[level] < threshold) return;
  const line = { t: new Date().toISOString(), level, msg, ...extra };
  process.stderr.write(redact(JSON.stringify(line)) + "\n");
}

export const log = {
  debug: (m: string, e?: Record<string, unknown>) => write("debug", m, e),
  info: (m: string, e?: Record<string, unknown>) => write("info", m, e),
  warn: (m: string, e?: Record<string, unknown>) => write("warn", m, e),
  error: (m: string, e?: Record<string, unknown>) => write("error", m, e),
};
