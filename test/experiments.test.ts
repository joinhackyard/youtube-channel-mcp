import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { Db } from "../src/db.js";
import { YtError } from "../src/errors.js";
import { Experiments } from "../src/experiments.js";
import { quotaDay } from "../src/quota.js";

/** A fake channel whose live title we can watch. */
function setup(opts: { apiError?: YtError } = {}) {
  const home = mkdtempSync(join(tmpdir(), "ytp-ab-"));
  const cfg = loadConfig({ YT_MCP_HOME: home });
  const db = new Db(join(home, "state.db"));
  const live = { title: "Original title", description: "Desc" };
  const updates: string[] = [];
  const api = {
    getVideo: async () => ({
      id: "vid",
      snippet: { title: live.title, description: live.description, categoryId: "28" },
      status: { privacyStatus: "public" },
    }),
    call: async (_c: number, label: string, fn: () => unknown) => {
      fn();
      return { id: "vid", snippet: { title: live.title }, status: { privacyStatus: "public" } };
    },
    yt: {
      videos: {
        update: (args: { requestBody: { snippet?: { title?: string; description?: string } } }) => {
          if (args.requestBody.snippet?.title) {
            live.title = args.requestBody.snippet.title;
            updates.push(live.title);
          }
        },
      },
    },
  };
  const channels = {
    byRowId: () => ({ id: "row1", channel_id: "UC1", title: "Chan", status: "ok" }),
    api: async () => {
      if (opts.apiError) throw opts.apiError;
      return api;
    },
  };
  const ex = new Experiments(db, cfg, channels as never);
  const today = quotaDay();
  const insert = (
    id: string,
    schedule: { day: string; variant: string }[],
    status = "scheduled",
  ) => {
    const now = Date.now();
    db.run(
      `insert into experiments(id, channel_row_id, video_id, status, metric, starts_on, ends_on, schedule, current_variant, live_thumb, auto_apply, created_at, updated_at)
       values (?, 'row1', 'vid', ?, 'views', ?, ?, ?, 'A', 'A', 1, ?, ?)`,
      id,
      status,
      schedule[0].day,
      schedule[schedule.length - 1].day,
      JSON.stringify(schedule),
      now,
      now,
    );
    db.run(
      "insert into experiment_variants(experiment_id, label, title, description, thumbnail_path, is_original) values (?, 'A', 'Original title', 'Desc', null, 1)",
      id,
    );
    db.run(
      "insert into experiment_variants(experiment_id, label, title, description, thumbnail_path, is_original) values (?, 'B', 'Challenger title', 'Desc', null, 0)",
      id,
    );
  };
  return { db, ex, live, updates, today, insert };
}

test("tick puts today's variant live once and records one exposure", async () => {
  const s = setup();
  s.insert("ab1", [
    { day: s.today, variant: "B" },
    { day: "2999-01-01", variant: "A" },
  ]);
  await s.ex.tick();
  await s.ex.tick();
  assert.equal(s.live.title, "Challenger title");
  assert.deepEqual(s.updates, ["Challenger title"], "applied exactly once");
  assert.equal(s.ex.get("ab1").status, "running");
  assert.equal(
    s.db.all("select * from experiment_exposures where experiment_id = 'ab1'").length,
    1,
  );
  s.db.close();
});

test("a stopped test is never rotated again", async () => {
  const s = setup();
  s.insert("ab2", [
    { day: s.today, variant: "B" },
    { day: "2999-01-01", variant: "A" },
  ]);
  await s.ex.tick();
  await s.ex.stop("ab2", "A");
  assert.equal(s.live.title, "Original title");
  assert.equal(s.ex.get("ab2").status, "stopped");
  s.db.run("delete from experiment_exposures where experiment_id = 'ab2'");
  await s.ex.tick();
  assert.equal(s.live.title, "Original title", "stop is final");
  await assert.rejects(s.ex.stop("ab2", "B"), /already stopped/);
  s.db.close();
});

test("live title is corrected even if the recorded variant was wrong", async () => {
  const s = setup();
  s.insert("ab3", [
    { day: s.today, variant: "A" },
    { day: "2999-01-01", variant: "B" },
  ]);
  s.live.title = "Challenger title"; // e.g. a half-finished earlier rotation left B's title live
  await s.ex.tick();
  assert.equal(s.live.title, "Original title");
  s.db.close();
});

test("permanent errors end the test as failed instead of retrying forever", async () => {
  const s = setup({ apiError: new YtError("not_found", "Video not found") });
  s.insert("ab4", [{ day: s.today, variant: "B" }]);
  await s.ex.tick();
  const e = s.ex.get("ab4");
  assert.equal(e.status, "failed");
  assert.match(e.error ?? "", /not found/);
  s.db.close();
});

test("only one active test per video", () => {
  const s = setup();
  s.insert("ab5", [{ day: s.today, variant: "B" }]);
  assert.throws(() => s.insert("ab6", [{ day: s.today, variant: "B" }]), /UNIQUE/);
  s.db.close();
});
