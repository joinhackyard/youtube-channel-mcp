import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { z } from "zod";
import {
  describeAi,
  generateJson,
  loadAiSettings,
  parseModelRef,
  resolveModel,
  saveModels,
  saveProvider,
  setAiFetchForTests,
} from "../src/ai/providers.js";
import { aiFromEnv, type AiSettings } from "../src/config.js";
import { Db } from "../src/db.js";
import { analyse, blockSchedule } from "../src/experiments.js";
import { outlierScores, seoCheck, type VideoStat } from "../src/growth.js";
import { median, tTestP, welch } from "../src/stats.js";
import { EncryptedFileVault } from "../src/vault.js";

after(() => setAiFetchForTests(undefined));

const settings = (env: Record<string, string>): AiSettings => aiFromEnv(env);

test("model resolution: explicit choice, auto default, capability checks", () => {
  const ai = settings({ ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" });
  assert.deepEqual(resolveModel(ai, "text"), { provider: "anthropic", model: "claude-opus-5-5" });
  assert.deepEqual(resolveModel(ai, "image"), { provider: "openai", model: "gpt-image-2" });
  assert.equal(
    resolveModel(settings({ ANTHROPIC_API_KEY: "a" }), "image"),
    null,
    "Claude has no image generation",
  );
  ai.models.text = "openai:gpt-5.5";
  assert.deepEqual(resolveModel(ai, "text"), { provider: "openai", model: "gpt-5.5" });
  ai.models.transcribe = "anthropic:claude-opus-5-5";
  assert.equal(
    resolveModel(ai, "transcribe")?.provider,
    "openai",
    "falls back when the chosen provider can't do the task",
  );
  assert.deepEqual(parseModelRef("ollama:llama3.2:8b"), {
    provider: "ollama",
    model: "llama3.2:8b",
  });
  assert.equal(parseModelRef("nope:x"), null);
  assert.equal(describeAi(settings({})).providers.length, 0);
});

test("settings: keys in the vault, choices in the database, env wins", async () => {
  const home = mkdtempSync(join(tmpdir(), "ytp-ai-"));
  const db = new Db(join(home, "state.db"));
  const vault = new EncryptedFileVault(home);
  await saveProvider(db, vault, "azure", {
    apiKey: "secret",
    endpoint: "https://r.openai.azure.com",
  });
  saveModels(db, { text: "azure:gpt-6-astra", image: "azure:gpt-image-2" }, "high");
  const ai = settings({});
  await loadAiSettings(ai, {}, db, vault);
  assert.equal(ai.providers.azure?.apiKey, "secret");
  assert.equal(ai.effort, "high");
  assert.deepEqual(resolveModel(ai, "image"), { provider: "azure", model: "gpt-image-2" });
  assert.ok(!db.setting("ai")?.includes("secret"), "keys never go into the database");
  const env = settings({});
  await loadAiSettings(env, { YT_AI_TEXT_MODEL: "azure:other" }, db, vault);
  assert.equal(env.models.text, "azure:other");
  db.close();
});

function fakeFetch(handler: (url: string, body: any) => unknown) {
  const calls: { url: string; body: any; headers: Headers }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = init?.body && typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, body, headers: new Headers(init?.headers) });
    return new Response(JSON.stringify(handler(url, body)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { f, calls };
}

const Schema = z.object({ title: z.string(), score: z.number() });

test("Claude: structured output via the Anthropic SDK, fallbacks and effort set", async () => {
  const { f, calls } = fakeFetch(() => ({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text: '{"title":"Hi","score":7}' }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  }));
  setAiFetchForTests(f);
  const r = await generateJson(settings({ ANTHROPIC_API_KEY: "k" }), "text", {
    system: "s",
    prompt: "p",
    schema: Schema,
  });
  assert.deepEqual(r?.data, { title: "Hi", score: 7 });
  assert.match(calls[0].url, /\/v1\/messages/);
  assert.equal(calls[0].body.model, "claude-opus-5-5");
  assert.equal(calls[0].body.fallbacks, "default");
  assert.equal(calls[0].body.output_config.effort, "medium");
  assert.equal(calls[0].body.output_config.format.type, "json_schema");
  assert.match(calls[0].headers.get("anthropic-beta") ?? "", /server-side-fallback-2026-07-01/);
});

const chatCompletion = (content: string) => ({
  id: "c1",
  object: "chat.completion",
  created: 1,
  model: "m",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content, refusal: null },
      finish_reason: "stop",
      logprobs: null,
    },
  ],
});

test("OpenAI and Azure: json_schema response format; Azure routes to the deployment", async () => {
  const { f, calls } = fakeFetch(() => chatCompletion('{"title":"T","score":3}'));
  setAiFetchForTests(f);
  const r = await generateJson(settings({ OPENAI_API_KEY: "k" }), "text", {
    system: "s",
    prompt: "p",
    schema: Schema,
  });
  assert.equal(r?.data.score, 3);
  assert.equal(calls[0].body.response_format.type, "json_schema");
  const az = settings({
    AZURE_OPENAI_API_KEY: "k",
    AZURE_OPENAI_ENDPOINT: "https://res.openai.azure.com",
    YT_AI_TEXT_MODEL: "azure:gpt-6-astra",
  });
  await generateJson(az, "text", { system: "s", prompt: "p", schema: Schema });
  assert.match(
    calls[1].url,
    /res\.openai\.azure\.com\/openai\/deployments\/gpt-6-astra\/chat\/completions\?api-version=/,
  );
  assert.equal(calls[1].headers.get("api-key"), "k");
});

test("Gemini: JSON mode with schema", async () => {
  const realFetch = globalThis.fetch;
  const { f, calls } = fakeFetch(() => ({
    candidates: [
      {
        content: { role: "model", parts: [{ text: '{"title":"G","score":9}' }] },
        finishReason: "STOP",
      },
    ],
  }));
  globalThis.fetch = f;
  try {
    const r = await generateJson(settings({ GEMINI_API_KEY: "k" }), "text", {
      system: "s",
      prompt: "p",
      schema: Schema,
    });
    assert.deepEqual(r?.data, { title: "G", score: 9 });
    assert.match(calls[0].url, /gemini-2\.5-pro:generateContent/);
    assert.equal(calls[0].body.generationConfig.responseMimeType, "application/json");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("no provider: generateJson returns null so tools fall back to briefs", async () => {
  assert.equal(
    await generateJson(settings({}), "text", { system: "s", prompt: "p", schema: Schema }),
    null,
  );
});

test("t-test p-values match reference values", () => {
  assert.ok(Math.abs(tTestP(2.0, 10) - 0.0734) < 0.001);
  assert.ok(Math.abs(tTestP(2.228, 10) - 0.05) < 0.001);
  assert.ok(tTestP(0, 5) > 0.99);
  const w = welch([1, 2, 3, 4, 5], [6, 7, 8, 9, 10]);
  assert.ok(Math.abs(w.p - 0.00105) < 0.0001, `p=${w.p}`);
  assert.equal(median([3, 1, 2]), 2);
});

test("A/B schedule is balanced in every block", () => {
  let seed = 1;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const s = blockSchedule(["A", "B", "C"], "2026-11-10", 12, rand);
  assert.equal(s.length, 12);
  assert.equal(s[0].day, "2026-11-10");
  assert.equal(s[11].day, "2026-11-21");
  for (let b = 0; b < 4; b++)
    assert.deepEqual(
      s
        .slice(b * 3, b * 3 + 3)
        .map((x) => x.variant)
        .sort(),
      ["A", "B", "C"],
    );
});

test("A/B analysis finds a real winner despite a downward trend, and no winner on noise", () => {
  let seed = 7;
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.1;
  const sched = blockSchedule(["A", "B"], "2026-11-10", 16, () => 0.3);
  const points = sched.map((d, i) => ({
    day: d.day,
    variant: d.variant,
    value: Math.round(1000 * Math.exp(-0.05 * i + noise()) * (d.variant === "B" ? 1.3 : 1)),
  }));
  const r = analyse(points, "views", ["A", "B"]);
  assert.equal(r.winner, "B");
  assert.ok(
    (r.variants[1].lift_vs_original ?? 0) > 20 && (r.variants[1].lift_vs_original ?? 0) < 40,
  );
  const flat = sched.map((d, i) => ({
    day: d.day,
    variant: d.variant,
    value: Math.round(1000 * Math.exp(-0.05 * i + noise())),
  }));
  assert.equal(analyse(flat, "views", ["A", "B"]).winner, null);
  assert.match(analyse(points.slice(0, 4), "views", ["A", "B"]).verdict, /Not enough/);
});

test("SEO score rewards good packaging and lists fixes", () => {
  const good = seoCheck({
    title: "How We Built a Robot in 24 Hours",
    description: `Building a robot in 24 hours at a hackathon. ${"Details. ".repeat(40)}\n0:00 Intro\n1:00 Build\n3:00 Demo\nhttps://hackyard.org #Hackathon #Robots`,
    tags: ["robot", "hackathon", "build", "engineering", "students"],
    keyword: "robot",
    durationSeconds: 600,
  });
  assert.ok(good.score >= 85, `score ${good.score}: ${good.fixes.join(" | ")}`);
  const bad = seoCheck({
    title: "WOW!!! YOU WON'T BELIEVE THIS",
    description: "",
    tags: [],
    keyword: "robot",
  });
  assert.ok(bad.score < 40);
  assert.ok(bad.fixes.length >= 5);
});

test("outlier scores compare against neighbours of the same format", () => {
  const vids: VideoStat[] = Array.from({ length: 12 }, (_, i) => ({
    id: `v${i}`,
    title: `t${i}`,
    published_at: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
    age_days: 300 - i,
    is_short: i % 2 === 1,
    privacy: "public",
    views: i === 4 ? 5000 : i % 2 ? 100 : 1000,
    likes: 0,
    comments: 0,
    views_per_day: 1,
  }));
  const s = outlierScores(vids);
  assert.equal(s.find((v) => v.id === "v4")?.outlier_score, 5);
  assert.equal(s.find((v) => v.id === "v3")?.outlier_score, 1);
});
