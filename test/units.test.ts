import assert from "node:assert/strict";
import { test } from "node:test";
import { checkChapters, isoDurationSeconds } from "../src/ai/brief.js";
import { parseCaptions, timestampedText, toSrt } from "../src/ai/transcript.js";
import {
  upsertCodexToml,
  upsertHermesYaml,
  type LaunchSpec,
} from "../src/clients.js";
import { normaliseChunkSize } from "../src/config.js";
import { canonicalJson, decrypt, encrypt } from "../src/crypto.js";
import { classifyGoogleError } from "../src/errors.js";
import { nextReset, quotaDay } from "../src/quota.js";
import { applyTemplate, tagsLength, TemplateStore } from "../src/templates.js";
import { privateLockWarning, type UploadMetadata } from "../src/upload/jobs.js";
import { isPrivateAddress } from "../src/upload/sources.js";
import { applyVideoChanges } from "../src/mcp/tools/videos.js";
import { queryAnalytics } from "../src/mcp/tools/channel.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const spec: LaunchSpec = {
  command: "/usr/local/bin/node",
  args: ["/opt/ytp/cli.js"],
  env: { PATH: "/usr/local/bin:/usr/bin" },
};

test("Hermes YAML: adds a youtube server under an existing mcp_servers block, keeping the rest", () => {
  const before = `model: x\nmcp_servers:\n  firecrawl:\n    command: npx\n    args:\n      - -y\n# trailing comment\nother: 1\n`;
  const after = upsertHermesYaml(before, spec);
  assert.match(
    after,
    /mcp_servers:\n  youtube-channel:\n    command: "\/usr\/local\/bin\/node"/,
  );
  assert.match(after, /  firecrawl:\n    command: npx/);
  assert.match(after, /other: 1\n$/);
  // Idempotent: installing twice leaves one block.
  const twice = upsertHermesYaml(after, spec);
  assert.equal(twice.match(/  youtube-channel:/g)?.length, 1);
  // Removal restores the original servers.
  const removed = upsertHermesYaml(twice, null);
  assert.ok(!removed.includes("youtube-channel:"));
  assert.match(removed, /firecrawl:/);
});

test("Hermes YAML: creates mcp_servers when missing or inline-empty", () => {
  assert.match(
    upsertHermesYaml("model: x\n", spec),
    /model: x\n\nmcp_servers:\n  youtube-channel:/,
  );
  assert.match(
    upsertHermesYaml("mcp_servers: {}\n", spec),
    /^mcp_servers:\n  youtube-channel:/,
  );
});

test("Codex TOML: upsert and remove the table", () => {
  const base = `model = "o5"\n\n[mcp_servers.other]\ncommand = "x"\n`;
  const added = upsertCodexToml(base, spec);
  assert.match(
    added,
    /\[mcp_servers\.youtube-channel\]\ncommand = "\/usr\/local\/bin\/node"/,
  );
  assert.match(added, /\[mcp_servers\.youtube-channel\.env\]\nPATH = /);
  const again = upsertCodexToml(added, spec);
  assert.equal(again.match(/\[mcp_servers\.youtube-channel\]/g)?.length, 1);
  const removed = upsertCodexToml(again, null);
  assert.ok(!removed.includes("youtube"));
  assert.match(removed, /\[mcp_servers\.other\]/);
});

test("templates: title format, footer, hashtags, tags", () => {
  const dir = mkdtempSync(join(tmpdir(), "ytp-tpl-"));
  writeFileSync(
    join(dir, "show.json"),
    JSON.stringify({
      name: "show",
      title_format: "{title} | My Show",
      description_footer: "Subscribe: https://x.y",
      hashtags: ["#MyShow"],
      tags: ["show"],
      playlists: ["Episodes"],
    }),
  );
  writeFileSync(
    join(dir, "clip.json"),
    JSON.stringify({ name: "clip", extends: "show", hashtags: ["#Clip"] }),
  );
  writeFileSync(join(dir, "broken.json"), "{nope");
  const store = new TemplateStore(dir);
  assert.equal(store.errors.length, 1);
  const m = applyTemplate(
    { title: "Episode 1", description: "Hello", tags: ["a"] },
    store.get("clip"),
  );
  assert.equal(m.title, "Episode 1 | My Show");
  assert.equal(
    m.description,
    "Hello\n\nSubscribe: https://x.y\n\n#Clip #MyShow",
  );
  assert.deepEqual(m.tags, ["a", "show"]);
  assert.deepEqual(m.playlists, ["Episodes"]);
  // Does not double-apply the title suffix.
  assert.equal(
    applyTemplate({ title: "Ep | My Show" }, store.get("show")).title,
    "Ep | My Show",
  );
  assert.throws(() => applyTemplate({ title: "a <b>" }), /rejects/);
  const many = Array.from({ length: 80 }, (_, i) => `tag number ${i}`);
  assert.ok(tagsLength(applyTemplate({ title: "t", tags: many }).tags) <= 500);
  const saved = store.save({ name: "new-one", description: "x", tags: ["z"] });
  assert.ok(saved.endsWith("new-one.json"));
  assert.equal(store.get("new-one").tags?.[0], "z");
  assert.ok(store.remove("new-one"));
});

test("chapters validation", () => {
  assert.deepEqual(checkChapters("No chapters here"), []);
  assert.deepEqual(checkChapters("0:00 Intro\n1:00 Part\n2:30 End"), []);
  assert.ok(
    checkChapters("0:05 Intro\n1:00 Part\n2:00 End").some((x) =>
      x.includes("0:00"),
    ),
  );
  assert.ok(
    checkChapters("0:00 Intro\n0:05 Part\n2:00 End").some((x) =>
      x.includes("10 seconds"),
    ),
  );
  assert.equal(isoDurationSeconds("PT1H2M3S"), 3723);
});

test("captions parsing and SRT output", () => {
  const srt =
    "1\n00:00:01,000 --> 00:00:04,500\nHello there\n\n2\n00:00:25,000 --> 00:00:27,000\n<i>Second</i> line\n";
  const segs = parseCaptions(srt);
  assert.equal(segs.length, 2);
  assert.equal(segs[1].text, "Second line");
  assert.equal(segs[0].end, 4.5);
  assert.match(timestampedText(segs), /^\[0:01\] Hello there/);
  assert.match(toSrt(segs), /00:00:01,000 --> 00:00:04,500/);
  const vtt = parseCaptions("WEBVTT\n\n00:01.000 --> 00:02.000\nHi\n");
  assert.equal(vtt[0].text, "Hi");
  assert.equal(parseCaptions("just words")[0].text, "just words");
});

test("quota day and reset are in Pacific Time", () => {
  const at = new Date("2026-07-01T06:59:00Z"); // 23:59 PDT on Jun 30
  assert.equal(quotaDay(at), "2026-06-30");
  assert.equal(nextReset(at).toISOString(), "2026-07-01T07:00:00.000Z");
  assert.equal(
    nextReset(new Date("2026-01-15T12:00:00Z")).toISOString(),
    "2026-01-16T08:00:00.000Z",
  );
});

test("error classification", () => {
  const q = classifyGoogleError({
    response: {
      status: 403,
      data: { error: { errors: [{ reason: "quotaExceeded" }], message: "x" } },
    },
  });
  assert.equal(q.code, "quota_exceeded");
  assert.equal(q.retryable, false);
  assert.equal(
    classifyGoogleError({
      response: { status: 400, data: { error: "invalid_grant" } },
    }).code,
    "auth_expired",
  );
  assert.equal(
    classifyGoogleError({ response: { status: 503, data: {} } }).retryable,
    true,
  );
  assert.equal(
    classifyGoogleError(new TypeError("fetch failed")).code,
    "network",
  );
});

test("private lock detection", () => {
  const meta = {
    requested_privacy: "public",
    warnings: [],
    resource: {},
    notify_subscribers: true,
  } as UploadMetadata;
  assert.ok(privateLockWarning(meta, { status: { privacyStatus: "private" } }));
  assert.equal(
    privateLockWarning(meta, { status: { privacyStatus: "public" } }),
    null,
  );
  assert.equal(
    privateLockWarning(
      { ...meta, requested_privacy: "private" },
      { status: { privacyStatus: "private" } },
    ),
    null,
  );
});

test("crypto helpers", () => {
  const key = randomBytes(32);
  assert.equal(decrypt(key, encrypt(key, "refresh-token")), "refresh-token");
  assert.equal(
    canonicalJson({ b: 1, a: [2, { d: 1, c: undefined }] }),
    '{"a":[2,{"d":1}],"b":1}',
  );
  assert.equal(normaliseChunkSize(16) % (256 * 1024), 0);
});

test("config writers: tolerant matching and clean removal", () => {
  // Quoted / commented TOML headers are replaced, not duplicated.
  const toml = `[mcp_servers."youtube-channel"]  # mine\ncommand = "old"\n\n[mcp_servers.youtube-channel.env]\nX = "1"\n`;
  const t = upsertCodexToml(toml, spec);
  assert.equal(t.match(/youtube-channel\]/g)?.length, 1);
  assert.ok(!t.includes('"old"'));
  // Inline YAML entry and `mcp_servers: ~` are handled.
  const inline = upsertHermesYaml('mcp_servers:\n  youtube-channel: {command: old}\n  other:\n    command: x\n', spec);
  assert.equal(inline.match(/youtube-channel:/g)?.length, 1);
  assert.ok(!inline.includes("command: old"));
  assert.match(upsertHermesYaml("mcp_servers: ~\n", spec), /^mcp_servers:\n  youtube-channel:/);
  // Removing the only server leaves a valid empty mapping, not null.
  assert.equal(upsertHermesYaml(upsertHermesYaml("a: 1\n", spec), null), "a: 1\n\nmcp_servers: {}\n");
  // Another server called "youtube" is never touched.
  const foreign = "mcp_servers:\n  youtube:\n    command: someone-else\n";
  assert.match(upsertHermesYaml(foreign, spec), /  youtube:\n    command: someone-else/);
});

test("SSRF guard blocks private, mapped and NAT64 addresses", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.1.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a9fe:a9fe", "2002::1"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["142.250.183.14", "2607:f8b0:4004:c07::64"]) assert.equal(isPrivateAddress(ip), false, ip);
});

test("video updates merge into the current snippet and status", async () => {
  let sent: { part: string[]; requestBody: Record<string, any> } | undefined;
  const api = {
    getVideo: async () => ({
      id: "v1",
      snippet: { title: "Old", description: "Long description", tags: ["a", "b"], categoryId: "22" },
      status: { privacyStatus: "private", publishAt: "2030-01-01T00:00:00Z", selfDeclaredMadeForKids: false, embeddable: true },
    }),
    call: async (_c: number, _l: string, fn: () => unknown) => {
      fn();
      return { id: "v1", status: { privacyStatus: "private" } };
    },
    yt: { videos: { update: (args: typeof sent) => (sent = args) } },
  };
  await applyVideoChanges(api as never, "v1", { title: "New" });
  assert.deepEqual(sent!.part, ["snippet"]);
  assert.equal(sent!.requestBody.snippet.description, "Long description");
  assert.deepEqual(sent!.requestBody.snippet.tags, ["a", "b"]);
  assert.equal(sent!.requestBody.snippet.categoryId, "22");
  await applyVideoChanges(api as never, "v1", { embeddable: false });
  assert.equal(sent!.requestBody.status.publishAt, "2030-01-01T00:00:00Z", "keeps the schedule");
  assert.equal(sent!.requestBody.status.embeddable, false);
  await applyVideoChanges(api as never, "v1", { privacy: "public" });
  assert.equal(sent!.requestBody.status.publishAt, undefined, "publishing now clears the schedule");
});

test("analytics rows are mapped to named columns", async () => {
  let params: Record<string, unknown> = {};
  const api = {
    auth: {
      request: async (o: { params: Record<string, unknown> }) => {
        params = o.params;
        return { data: { columnHeaders: [{ name: "day" }, { name: "views" }], rows: [["2026-11-01", 120], ["2026-11-02", 98]] } };
      },
    },
  };
  const rows = await queryAnalytics(api as never, { startDate: "2026-11-01", endDate: "2026-11-02", metrics: "views", dimensions: "day" });
  assert.deepEqual(rows, [{ day: "2026-11-01", views: 120 }, { day: "2026-11-02", views: 98 }]);
  assert.equal(params.ids, "channel==MINE");
});
