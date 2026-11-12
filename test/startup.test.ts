import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Reproduce the broken npx dependency without changing the installed SDK.
const brokenGemini = `data:text/javascript,${encodeURIComponent(`
  import { registerHooks } from "node:module";
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "@google/genai") throw new SyntaxError("Unexpected end of input");
      return nextResolve(specifier, context);
    },
  });
`)}`;

test("CLI help and connect start even when the Gemini SDK cannot load", () => {
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    YT_MCP_HOME: mkdtempSync(join(tmpdir(), "ytp-startup-")),
    YT_MCP_VAULT: "file",
  };
  const run = (command: string) =>
    spawnSync(process.execPath, ["--import", brokenGemini, cli, command], {
      env,
      encoding: "utf8",
      timeout: 15_000,
    });
  const help = run("--help");
  assert.ifError(help.error);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Connect or reconnect a YouTube channel/);

  const connect = run("connect");
  assert.ifError(connect.error);
  assert.equal(connect.status, 1, connect.stderr);
  assert.match(connect.stderr, /Google OAuth client/);
  assert.doesNotMatch(connect.stderr, /SyntaxError/);
});

test("Gemini SDK load failures are reported when Gemini is used", () => {
  const providers = new URL("../src/ai/providers.js", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      brokenGemini,
      "--input-type=module",
      "--eval",
      `const { listModels } = await import(${JSON.stringify(providers)});
       try {
         await listModels({ providers: { gemini: { apiKey: "test" } }, models: {}, effort: "high" }, "gemini");
         process.exitCode = 1;
       } catch (error) {
         if (!error.message.includes("Google Gemini request failed: Unexpected end of input")) throw error;
       }`,
    ],
    { encoding: "utf8", timeout: 15_000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});
