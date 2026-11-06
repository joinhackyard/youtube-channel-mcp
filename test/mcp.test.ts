import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createApp, type App } from "../src/app.js";
import { confirmGate } from "../src/mcp/helpers.js";
import { buildServer } from "../src/mcp/server.js";

let app: App;
let client: Client;

const text = (r: unknown) =>
  (r as { content: { text: string }[] }).content[0]?.text ?? "";

before(async () => {
  const home = mkdtempSync(join(tmpdir(), "ytp-mcp-"));
  app = await createApp({
    YT_MCP_HOME: home,
    YT_MCP_VAULT: "file",
    GOOGLE_CLIENT_ID: "id.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "secret",
  });
  const server = buildServer(app);
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
});

after(async () => {
  await client.close();
  app.connector.close();
  app.db.close();
});

test("exposes the full tool set with annotations", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  for (const n of [
    "auth_status",
    "connect_channel",
    "upload_video",
    "get_upload_status",
    "set_thumbnail",
    "update_video",
    "set_visibility",
    "delete_video",
    "list_my_videos",
    "list_playlists",
    "add_to_playlist",
    "upload_captions",
    "generate_metadata",
    "preview_metadata",
    "list_templates",
    "save_template",
    "quota_status",
    "transcribe_video",
    "resume_upload",
    "cancel_upload",
  ])
    assert.ok(names.includes(n), `missing ${n}`);
  assert.equal(
    tools.find((t) => t.name === "delete_video")?.annotations?.destructiveHint,
    true,
  );
  assert.equal(
    tools.find((t) => t.name === "list_my_videos")?.annotations?.readOnlyHint,
    true,
  );
  const { prompts } = await client.listPrompts();
  assert.ok(prompts.some((p) => p.name === "publish_video"));
});

test("auth_status reports no channels and next steps", async () => {
  const r = await client.callTool({ name: "auth_status", arguments: {} });
  const data = JSON.parse(text(r));
  assert.equal(data.google_oauth_configured, true);
  assert.deepEqual(data.channels, []);
  assert.ok(data.next_steps[0].includes("connect_channel"));
  assert.equal(data.token_storage, "encrypted-file");
});

test("upload_video without a connected channel returns a helpful error", async () => {
  const r = await client.callTool({
    name: "upload_video",
    arguments: { file_path: "/tmp/none.mp4", title: "x" },
  });
  assert.equal(r.isError, true);
  assert.equal(JSON.parse(text(r)).code, "not_connected");
});

test("preview_metadata applies templates and limits without quota", async () => {
  await client.callTool({
    name: "save_template",
    arguments: {
      name: "show",
      title_format: "{title} | Show",
      description_footer: "Footer line",
      tags: ["show"],
    },
  });
  const r = await client.callTool({
    name: "preview_metadata",
    arguments: {
      title: "Ep 1",
      description: "0:00 Intro\n0:30 Middle\n1:30 End",
      template: "show",
    },
  });
  const m = JSON.parse(text(r));
  assert.equal(m.title, "Ep 1 | Show");
  assert.ok(m.description.endsWith("Footer line"));
  assert.deepEqual(m.warnings, []);
  assert.equal(app.quota.status().units_used, 0);
});

test("generate_metadata builds a brief from a transcript", async () => {
  const r = await client.callTool({
    name: "generate_metadata",
    arguments: { transcript: "We built a robot in 24 hours.", format: "short" },
  });
  const brief = JSON.parse(text(r));
  assert.ok(brief.instructions.some((s: string) => s.includes("Short")));
  assert.equal(brief.transcript, "We built a robot in 24 hours.");
});

test("connect_channel returns a Google sign-in URL with PKCE and a loopback redirect", async () => {
  const r = await client.callTool({ name: "connect_channel", arguments: { wait_seconds: 0, open_browser: false } });
  const data = JSON.parse(text(r).slice(text(r).indexOf("{")));
  const u = new URL(data.sign_in_url);
  assert.equal(u.hostname, "accounts.google.com");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.match(u.searchParams.get("redirect_uri") ?? "", /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.match(u.searchParams.get("scope") ?? "", /youtube\.upload/);
  assert.equal(u.searchParams.get("access_type"), "offline");
});

test("confirmation gate: token is required, bound to the arguments, single use", async () => {
  const fakeServer = {
    server: { getClientCapabilities: () => undefined },
  } as never;
  const args = { video_id: "abc", privacy: "public" };
  const first = await confirmGate(
    app,
    fakeServer,
    "set_visibility",
    args,
    "Make abc PUBLIC",
    { publicFacing: true },
  );
  assert.ok(first && text(first).includes("CONFIRMATION REQUIRED"));
  const token = JSON.parse(text(first).split("\n\n").pop()!)
    .confirmation_token as string;
  await assert.rejects(
    confirmGate(
      app,
      fakeServer,
      "set_visibility",
      { ...args, privacy: "unlisted", confirmation_token: token },
      "s",
      { publicFacing: true },
    ),
    /changed/,
  );
  assert.equal(
    await confirmGate(
      app,
      fakeServer,
      "set_visibility",
      { ...args, confirmation_token: token },
      "s",
      { publicFacing: true },
    ),
    null,
  );
  await assert.rejects(
    confirmGate(
      app,
      fakeServer,
      "set_visibility",
      { ...args, confirmation_token: token },
      "s",
      { publicFacing: true },
    ),
    /invalid or expired/,
  );
  // Private actions pass straight through under the default policy.
  assert.equal(
    await confirmGate(
      app,
      fakeServer,
      "upload_video",
      { privacy: "private" },
      "s",
      { publicFacing: false },
    ),
    null,
  );
});
