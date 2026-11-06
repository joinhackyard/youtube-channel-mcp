import { createWriteStream } from "node:fs";
import { open, rm, stat } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { extname, isAbsolute, resolve } from "node:path";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import { pipeline } from "node:stream/promises";
import { YtError } from "../errors.js";

const VIDEO_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
  ".wmv": "video/x-ms-wmv",
  ".flv": "video/x-flv",
  ".mpg": "video/mpeg",
  ".mpeg": "video/mpeg",
  ".3gp": "video/3gpp",
  ".ts": "video/mp2t",
  ".mts": "video/mp2t",
  ".ogv": "video/ogg",
};

export function expandPath(p: string): string {
  const t = p.trim();
  const expanded = t === "~" ? homedir() : t.startsWith("~/") ? resolve(homedir(), t.slice(2)) : t;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

export function videoContentType(path: string): string {
  return VIDEO_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export interface LocalFile {
  path: string;
  size: number;
  mtimeMs: number;
  contentType: string;
}

export async function inspectVideoFile(path: string, maxBytes: number): Promise<LocalFile> {
  const full = expandPath(path);
  let s;
  try {
    s = await stat(full);
  } catch {
    throw new YtError("file_error", `File not found: ${full}`, {
      hint: "Pass an absolute path, e.g. ~/Videos/recap.mp4.",
    });
  }
  if (!s.isFile()) throw new YtError("file_error", `Not a file: ${full}`);
  if (s.size === 0) throw new YtError("file_error", `File is empty: ${full}`);
  if (s.size > maxBytes)
    throw new YtError(
      "file_error",
      `File is ${(s.size / 1024 ** 3).toFixed(1)} GB; the limit is ${(maxBytes / 1024 ** 3).toFixed(0)} GB.`,
    );
  const contentType = videoContentType(full);
  if (contentType === "application/octet-stream") {
    const head = await readHead(full, 16);
    if (!looksLikeVideo(head)) {
      throw new YtError("file_error", `${full} does not look like a video file.`, {
        hint: `Supported: ${Object.keys(VIDEO_TYPES).join(" ")}`,
      });
    }
  }
  return {
    path: full,
    size: s.size,
    mtimeMs: Math.floor(s.mtimeMs),
    contentType: contentType === "application/octet-stream" ? "video/*" : contentType,
  };
}

export async function readHead(path: string, n: number): Promise<Buffer> {
  const fh = await open(path, "r");
  try {
    const b = Buffer.alloc(n);
    const { bytesRead } = await fh.read(b, 0, n, 0);
    return b.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

function looksLikeVideo(b: Buffer): boolean {
  if (b.length >= 8 && b.toString("latin1", 4, 8) === "ftyp") return true; // mp4/mov
  if (b.length >= 4 && b.readUInt32BE(0) === 0x1a45dfa3) return true; // mkv/webm
  if (
    b.length >= 12 &&
    b.toString("latin1", 0, 4) === "RIFF" &&
    b.toString("latin1", 8, 12) === "AVI "
  )
    return true;
  return false;
}

export type ImageKind = "image/jpeg" | "image/png";

/** Thumbnails: JPG or PNG, max 2 MB (YouTube limit). */
export async function inspectThumbnail(
  path: string,
): Promise<{ path: string; size: number; mime: ImageKind }> {
  const full = expandPath(path);
  let s;
  try {
    s = await stat(full);
  } catch {
    throw new YtError("file_error", `Thumbnail not found: ${full}`);
  }
  const head = await readHead(full, 8);
  const mime: ImageKind | null =
    head[0] === 0xff && head[1] === 0xd8
      ? "image/jpeg"
      : head.toString("latin1", 1, 4) === "PNG"
        ? "image/png"
        : null;
  if (!mime) throw new YtError("file_error", "Thumbnails must be JPG or PNG.");
  if (s.size > 2 * 1024 * 1024) {
    throw new YtError(
      "file_error",
      `Thumbnail is ${(s.size / 1024 / 1024).toFixed(2)} MB; YouTube allows 2 MB.`,
      {
        hint: "Export as JPG at 1280x720, quality around 85.",
      },
    );
  }
  return { path: full, size: s.size, mime };
}

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v = ip.toLowerCase();
  // IPv4-mapped (::ffff:1.2.3.4 or ::ffff:7f00:1) and NAT64 (64:ff9b::/96): check the embedded IPv4.
  const mapped = /^(?:::ffff:|64:ff9b::)(.+)$/.exec(v);
  if (mapped) {
    const tail = mapped[1];
    if (isIP(tail) === 4) return isPrivateAddress(tail);
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
    if (hex) {
      const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16);
      return isPrivateAddress([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."));
    }
    return true;
  }
  return (
    v === "::1" ||
    v === "::" ||
    /^f[cd]/.test(v) ||
    /^fe[89ab]/.test(v) ||
    /^fe[c-f]/.test(v) ||
    v.startsWith("2002:") ||
    v.startsWith("ff")
  );
}

/** Validate a URL and return the (public) address to connect to, so DNS cannot change between check and connect. */
async function resolvePublic(raw: string): Promise<{ url: URL; address: string; family: number }> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new YtError("invalid_request", `Not a valid URL: ${raw}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:")
    throw new YtError("invalid_request", "Only http(s) URLs can be fetched.");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new YtError("invalid_request", `Cannot resolve ${host}.`);
  if (addrs.some((a) => isPrivateAddress(a.address))) {
    throw new YtError(
      "forbidden",
      "URLs pointing at private or internal addresses are not allowed.",
    );
  }
  return { url: u, address: addrs[0].address, family: addrs[0].family };
}

const STALL_MS = 60_000;

function request(
  target: { url: URL; address: string; family: number },
  signal?: AbortSignal,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const mod = target.url.protocol === "https:" ? https : http;
    const req = mod.get(
      target.url,
      {
        headers: { "User-Agent": "youtube-channel-mcp" },
        signal,
        // Pin the connection to the address that passed the private-network check.
        lookup: ((_h: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) =>
          opts?.all
            ? cb(null, [{ address: target.address, family: target.family }])
            : cb(null, target.address, target.family)) as never,
      },
      resolve,
    );
    req.setTimeout(STALL_MS, () =>
      req.destroy(
        new YtError("network", "The download stalled for 60 seconds.", { retryable: true }),
      ),
    );
    req.on("error", reject);
  });
}

/** Download a public video URL to `dest`, following up to 5 redirects with SSRF checks on every hop. */
export async function downloadUrl(
  raw: string,
  dest: string,
  maxBytes: number,
  onProgress: (got: number, total: number | null) => void,
  signal?: AbortSignal,
): Promise<{ size: number; contentType: string | null; filename: string }> {
  let target = await resolvePublic(raw);
  let res: IncomingMessage | undefined;
  for (let hop = 0; hop < 6; hop++) {
    res = await request(target, signal);
    const loc = res.headers.location;
    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && loc) {
      res.resume();
      target = await resolvePublic(new URL(loc, target.url).toString());
      continue;
    }
    break;
  }
  if (!res || !res.statusCode || res.statusCode >= 300) {
    res?.resume();
    throw new YtError(
      "file_error",
      `Download failed: HTTP ${res?.statusCode ?? "no response"} from ${target.url.hostname}.`,
    );
  }
  const contentType = res.headers["content-type"] ?? null;
  if (contentType && /^text\/html/i.test(contentType)) {
    res.resume();
    throw new YtError("file_error", "That URL returned a web page, not a video file.", {
      hint: "Use a direct download link to the video file.",
    });
  }
  const total = Number(res.headers["content-length"]) || null;
  if (total && total > maxBytes) {
    res.resume();
    throw new YtError("file_error", "The remote file is larger than the upload limit.");
  }
  let got = 0;
  let lastTick = 0;
  res.on("data", (chunk: Buffer) => {
    got += chunk.length;
    if (got > maxBytes)
      res!.destroy(new YtError("file_error", "The remote file is larger than the upload limit."));
    if (Date.now() - lastTick > 1000) {
      lastTick = Date.now();
      onProgress(got, total);
    }
  });
  try {
    await pipeline(res, createWriteStream(dest));
  } catch (e) {
    await rm(dest, { force: true });
    throw e instanceof YtError
      ? e
      : new YtError("network", `Download interrupted: ${(e as Error).message}`, {
          retryable: true,
        });
  }
  onProgress(got, total);
  let name = target.url.pathname.split("/").pop() || "video";
  try {
    name = decodeURIComponent(name);
  } catch {
    /* keep the raw name */
  }
  return { size: got, contentType, filename: name };
}
