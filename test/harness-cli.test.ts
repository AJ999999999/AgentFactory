// The harness's command line, run the way the scheduled task runs it: a fresh process
// in the folder the engagement was opened in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { EngagementDef } from "../src/harness/types.ts";

const CLI = path.join(import.meta.dirname, "..", "src", "harness", "cli.ts");

const def: EngagementDef = {
  id: "cli-open",
  title: "Opened from the command line",
  principals: { partner: "you" },
  goals: [{ id: "g", title: "Game", objective: "A game", owner: "partner", scope: ["game"], budget: { turns: 5 }, assumptions: [], todos: [{ id: "core", lane: "build", text: "Build the core loop" }] }],
};

test("an engagement opens with its own world module from a folder outside this repo, and later wakes load it again", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-cli-open-"));
  const spec = path.join(dir, "spec");
  fs.mkdirSync(spec);
  // An absolute path, as `open` saves it: on Windows that's "C:\...", which import()
  // reads as a URL with the scheme "c:" unless it's turned into a file:// URL first.
  const world = path.join(spec, "world.mjs");
  fs.writeFileSync(world, `export const world = { checkers: { fine: () => [] } };\n`);
  fs.writeFileSync(path.join(spec, "engagement.json"), JSON.stringify(def));
  const run = (...a: string[]) => execFileSync(process.execPath, ["--no-warnings", CLI, ...a], {
    cwd: dir, encoding: "utf8", stdio: "pipe",
    env: { ...process.env, AF_PANEL_FOLDERS: path.join(dir, "panel-folders.json") },
  });
  try {
    assert.match(run("open", path.join(spec, "engagement.json"), "--world", world), /opened cli-open: 1 goal/);
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, ".af", "harness", "cli-open", "config.json"), "utf8")) as { world?: string };
    assert.equal(cfg.world, world, "saved, so the scheduled loop loads the same checks");
    assert.match(run("status"), /## g v1/, "a later process loads the saved world");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
