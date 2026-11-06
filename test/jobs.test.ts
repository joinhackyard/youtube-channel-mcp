import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadConfig } from "../src/config.js";
import { Db } from "../src/db.js";
import { Quota } from "../src/quota.js";
import { describeJob, JobManager, type UploadMetadata } from "../src/upload/jobs.js";

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

function setup(opts: { quotaFailures?: number; chunkDelayMs?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), "ytp-jobs-"));
  const cfg = loadConfig({ YT_MCP_HOME: home, YT_CHUNK_MB: "1" });
  const db = new Db(join(home, "state.db"));
  const quota = new Quota(db, cfg);
  const file = join(home, "clip.mp4");
  const data = randomBytes(1024 * 1024 * 2 + 777);
  writeFileSync(file, data);

  let stored = 0;
  let quotaFailures = opts.quotaFailures ?? 0;
  const got: Buffer[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (init?.method === "POST") {
      if (quotaFailures > 0) {
        quotaFailures--;
        return new Response(
          JSON.stringify({
            error: {
              code: 403,
              message: "q",
              errors: [{ reason: "quotaExceeded" }],
            },
          }),
          { status: 403 },
        );
      }
      return new Response(null, {
        status: 200,
        headers: { Location: "https://upload.test/s/1" },
      });
    }
    const range = headers.get("content-range") ?? "";
    if (range.startsWith("bytes */"))
      return new Response(null, {
        status: 308,
        headers: stored ? { Range: `bytes=0-${stored - 1}` } : {},
      });
    if (opts.chunkDelayMs) await new Promise((r) => setTimeout(r, opts.chunkDelayMs));
    const body = Buffer.from(init!.body as Uint8Array);
    got.push(body);
    stored += body.length;
    if (stored >= data.length)
      return new Response(JSON.stringify({ id: "vidXYZ" }), { status: 201 });
    return new Response(null, {
      status: 308,
      headers: { Range: `bytes=0-${stored - 1}` },
    });
  }) as typeof fetch;

  const calls: string[] = [];
  const fakeApi = {
    accessToken: async () => "tok",
    invalidateAccessToken: () => undefined,
    getVideo: async (id: string) => ({
      id,
      snippet: { title: "T" },
      status: { privacyStatus: "private" },
    }),
    call: async (_cost: number, label: string) => {
      calls.push(label);
      if (label === "playlists.list")
        return {
          items: [{ id: "PLexisting12345", snippet: { title: "Episodes" } }],
        };
      if (label === "playlistItems.insert") return { id: "item1", snippet: { position: 0 } };
      return {};
    },
    yt: {
      playlists: { list: () => undefined },
      playlistItems: { insert: () => undefined },
    },
  };
  const channels = {
    byRowId: () => ({
      id: "row1",
      channel_id: "UC1",
      title: "Chan",
      status: "ok",
    }),
    api: async () => fakeApi,
  };
  const jobs = new JobManager(db, cfg, channels as never, quota);
  const meta: UploadMetadata = {
    resource: { snippet: { title: "T" }, status: { privacyStatus: "public" } },
    notify_subscribers: true,
    requested_privacy: "public",
    warnings: [],
  };
  const create = () =>
    jobs.create({
      channelRowId: "row1",
      source: {
        kind: "file",
        path: file,
        size: data.length,
        mtimeMs: 0,
        contentType: "video/mp4",
      },
      metadata: meta,
      post: { playlists: ["Episodes"] },
    });
  return { jobs, db, quota, data, got, calls, create, cfg, channels };
}

test("a job uploads, runs post steps, and flags the private lock", async () => {
  const s = setup();
  s.jobs.start();
  const job = s.create();
  const done = await s.jobs.waitFor(job.id, 20_000);
  s.jobs.stop();
  const d = describeJob(done);
  assert.equal(d.status, "done", d.error);
  assert.equal(d.video_id, "vidXYZ");
  assert.deepEqual(Buffer.concat(s.got), s.data);
  const result = d.result as {
    steps: { playlists: { ok: boolean } };
    warnings: string[];
  };
  assert.equal(result.steps.playlists.ok, true);
  assert.ok(s.calls.includes("playlistItems.insert"));
  assert.ok(result.warnings.some((w) => w.includes("kept the video private")));
  assert.equal(s.quota.status().uploads_used, 1);
  s.db.close();
});

test("quotaExceeded stops the job; resume_upload finishes it", async () => {
  const s = setup({ quotaFailures: 1 });
  s.jobs.start();
  const job = s.create();
  const stopped = await s.jobs.waitFor(job.id, 20_000);
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.error_code, "quota_exceeded");
  // Quota marked exhausted locally; a new upload is refused without calling YouTube.
  assert.throws(() => s.quota.assertAvailable("units"), /exhausted/);
  s.db.run("update quota set exhausted_kind = null");
  s.jobs.resume(job.id);
  const done = await s.jobs.waitFor(job.id, 20_000);
  s.jobs.stop();
  assert.equal(done.status, "done", done.error ?? "");
  s.db.close();
});

test("cancelling from another process stops the running upload", async () => {
  const s = setup({ chunkDelayMs: 400 });
  s.jobs.start();
  const job = s.create();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(s.jobs.get(job.id)?.status, "uploading");
  // A second MCP process (another JobManager on the same database) cancels it.
  const other = new JobManager(s.db, s.cfg, s.channels as never, s.quota);
  other.cancel(job.id);
  await new Promise((r) => setTimeout(r, 2000));
  s.jobs.stop();
  const j = s.jobs.get(job.id)!;
  assert.equal(j.status, "cancelled");
  assert.equal(j.video_id, null);
  assert.ok(Buffer.concat(s.got).length < s.data.length, "upload must stop before completing");
  s.db.close();
});
