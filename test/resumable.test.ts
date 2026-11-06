import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { nextOffsetFromRange, resumableUpload } from "../src/upload/resumable.js";
import { YtError } from "../src/errors.js";

const CHUNK = 256 * 1024;

function tempVideo(size: number) {
  const dir = mkdtempSync(join(tmpdir(), "ytp-test-"));
  const path = join(dir, "v.mp4");
  const data = randomBytes(size);
  writeFileSync(path, data);
  return { path, data };
}

/** A fake YouTube resumable endpoint. `faults` lets a test break specific calls. */
function fakeYouTube(
  total: number,
  faults: {
    dropChunk?: number;
    quotaOnStart?: boolean;
    expireSessionOnChunk?: number;
  } = {},
) {
  const received: Buffer[] = [];
  let stored = 0;
  let sessions = 0;
  let chunkCalls = 0;
  const calls: string[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const headers = new Headers(init?.headers);
    if (init?.method === "POST") {
      calls.push("start");
      if (faults.quotaOnStart) {
        return new Response(
          JSON.stringify({
            error: {
              code: 403,
              message: "quota",
              errors: [{ reason: "quotaExceeded" }],
            },
          }),
          { status: 403 },
        );
      }
      sessions++;
      return new Response(null, {
        status: 200,
        headers: { Location: `https://upload.example/session/${sessions}` },
      });
    }
    const range = headers.get("content-range") ?? "";
    if (!u.endsWith(`/${sessions}`)) return new Response(null, { status: 404 });
    if (range.startsWith("bytes */")) {
      calls.push("query");
      if (stored >= total) return new Response(JSON.stringify({ id: "vid123" }), { status: 200 });
      return new Response(null, {
        status: 308,
        headers: stored ? { Range: `bytes=0-${stored - 1}` } : {},
      });
    }
    chunkCalls++;
    calls.push(`chunk:${range}`);
    if (faults.dropChunk === chunkCalls) throw new TypeError("fetch failed");
    if (faults.expireSessionOnChunk === chunkCalls) {
      received.length = 0;
      stored = 0;
      return new Response(null, { status: 404 });
    }
    const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(range)!;
    const start = Number(m[1]);
    assert.equal(start, stored, "chunk must start where the server left off");
    const body = Buffer.from(init!.body as Uint8Array);
    received.push(body);
    stored += body.length;
    if (stored >= total)
      return new Response(JSON.stringify({ id: "vid123", status: { privacyStatus: "private" } }), {
        status: 201,
      });
    return new Response(null, {
      status: 308,
      headers: { Range: `bytes=0-${stored - 1}` },
    });
  }) as typeof fetch;
  return {
    impl,
    received,
    calls,
    get stored() {
      return stored;
    },
  };
}

const base = (path: string, size: number, impl: typeof fetch) => ({
  filePath: path,
  fileSize: size,
  contentType: "video/mp4",
  resource: { snippet: { title: "t" }, status: { privacyStatus: "private" } },
  parts: ["snippet", "status"],
  notifySubscribers: true,
  chunkSize: CHUNK,
  getAccessToken: async () => "token",
  invalidateToken: () => undefined,
  onSession: () => undefined,
  onProgress: () => undefined,
  fetchImpl: impl,
  sleep: async () => undefined,
});

test("parses Range headers", () => {
  assert.equal(nextOffsetFromRange(null), 0);
  assert.equal(nextOffsetFromRange("bytes=0-262143"), 262144);
});

test("uploads a file in chunks and returns the video", async () => {
  const size = CHUNK * 3 + 1234;
  const { path, data } = tempVideo(size);
  const yt = fakeYouTube(size);
  const progress: number[] = [];
  const v = await resumableUpload({
    ...base(path, size, yt.impl),
    onProgress: (s) => progress.push(s),
  });
  assert.equal(v.id, "vid123");
  assert.deepEqual(Buffer.concat(yt.received), data);
  assert.equal(progress.at(-1), size);
});

test("recovers from a dropped connection by asking YouTube for the offset", async () => {
  const size = CHUNK * 4;
  const { path, data } = tempVideo(size);
  const yt = fakeYouTube(size, { dropChunk: 2 });
  const v = await resumableUpload(base(path, size, yt.impl));
  assert.equal(v.id, "vid123");
  assert.ok(yt.calls.includes("query"), "should query the upload status after the drop");
  assert.deepEqual(Buffer.concat(yt.received), data);
});

test("resumes an existing session from a checkpoint", async () => {
  const size = CHUNK * 3;
  const { path, data } = tempVideo(size);
  const yt = fakeYouTube(size);
  // First process: upload one chunk, then "crash".
  let session = "";
  await assert.rejects(
    resumableUpload({
      ...base(path, size, yt.impl),
      onSession: (u) => (session = u),
      onProgress: (s) => {
        if (s >= CHUNK) throw new YtError("cancelled", "simulated crash");
      },
    }),
  );
  assert.equal(yt.stored, CHUNK);
  // Second process resumes with the saved session URI.
  const v = await resumableUpload({
    ...base(path, size, yt.impl),
    sessionUri: session,
  });
  assert.equal(v.id, "vid123");
  assert.equal(yt.calls.filter((c) => c === "start").length, 1, "must not start a new session");
  assert.deepEqual(Buffer.concat(yt.received), data);
});

test("stops immediately on quotaExceeded", async () => {
  const { path } = tempVideo(1000);
  const yt = fakeYouTube(1000, { quotaOnStart: true });
  await assert.rejects(
    resumableUpload(base(path, 1000, yt.impl)),
    (e: YtError) => e.code === "quota_exceeded",
  );
  assert.equal(yt.calls.length, 1, "no retries on quota errors");
});

test("starts a new session when the old one expired", async () => {
  const size = CHUNK * 2;
  const { path, data } = tempVideo(size);
  const yt = fakeYouTube(size, { expireSessionOnChunk: 2 });
  const v = await resumableUpload(base(path, size, yt.impl));
  assert.equal(v.id, "vid123");
  assert.equal(yt.calls.filter((c) => c === "start").length, 2);
  assert.deepEqual(Buffer.concat(yt.received), data);
});
