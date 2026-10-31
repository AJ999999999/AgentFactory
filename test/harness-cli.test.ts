// The harness's command line, run the way the scheduled task runs it: a fresh process
// in the folder the engagement was opened in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
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

test("the loop keeps the harness's events in its log and leaves stderr for crashes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-cli-loop-"));
  // Nothing an agent could pick up: the loop wakes, asks the partner, and sleeps.
  const quiet: EngagementDef = { ...def, id: "cli-loop", goals: [{ ...def.goals[0], todos: [{ id: "look", kind: "action", lane: "playtest", assignee: "partner", text: "Try it" }] }] };
  fs.writeFileSync(path.join(dir, "engagement.json"), JSON.stringify(quiet));
  const env = { ...process.env, AF_PANEL_FOLDERS: path.join(dir, "panel-folders.json"), COPILOT_HOME: path.join(dir, "copilot-home"), CODEX_HOME: path.join(dir, "codex-home") };
  execFileSync(process.execPath, ["--no-warnings", CLI, "open", "engagement.json"], { cwd: dir, env, stdio: "pipe" });
  const log = path.join(dir, "loop.log");
  const loop = spawn(process.execPath, ["--no-warnings", CLI, "loop", "--runner", "r1", "--log", log], { cwd: dir, env, windowsHide: true });
  let stderr = "";
  loop.stderr.on("data", (c) => (stderr += c));
  try {
    const until = Date.now() + 60_000;
    while (!(fs.existsSync(log) && /tick \{"runner":"r1"/.test(fs.readFileSync(log, "utf8"))) && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
    assert.match(fs.readFileSync(log, "utf8"), /^\S+ tick \{"runner":"r1"/m, "the wake is in the log, with its time");
    assert.equal(stderr, "", "nothing on stderr: the scheduled task keeps it for crashes");
  } finally {
    loop.kill();
    await new Promise((r) => loop.once("exit", r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
