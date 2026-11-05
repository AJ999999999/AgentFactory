// `open` checks the setup before any turn is spent on it (docs/real-runs.md): in the second
// private engagement most of the operator's interventions were setup problems.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Git } from "../src/git.ts";
import { checksAtStart, ignoredHarnessFiles, missingTestCommands, vagueTodoText } from "../src/harness/opencheck.ts";
import type { EngagementDef } from "../src/harness/types.ts";

const CLI = path.join(import.meta.dirname, "..", "src", "harness", "cli.ts");
const tmp = (n: string) => fs.mkdtempSync(path.join(os.tmpdir(), `af-opencheck-${n}-`));

const def = (todos: EngagementDef["goals"][number]["todos"], redLines?: string[]): EngagementDef => ({
  id: "oc", title: "Open checks", principals: { partner: "you" }, ...(redLines ? { redLines } : {}),
  goals: [{ id: "g", title: "App", objective: "An app", owner: "partner", scope: ["app"], budget: { turns: 5 }, assumptions: [], todos }],
});

test("a .gitignore that would hide the event log is caught, and the lines the message suggests un-hide it", async () => {
  const dir = tmp("ignore");
  execFileSync("git", ["init", "-q", dir]);
  // What the seeded Python app had.
  fs.writeFileSync(path.join(dir, ".gitignore"), ".agents/\n*.json\n");
  const g = new Git(dir);
  assert.deepEqual(await ignoredHarnessFiles(g, "oc"), [".agents/harness/oc/events/000000000000000-probe.json", ".agents/harness/probe.json", "policy/probe.json"]);
  fs.appendFileSync(path.join(dir, ".gitignore"), "!.agents/\n!.agents/**\n!policy/\n!policy/**\n");
  assert.deepEqual(await ignoredHarnessFiles(g, "oc"), []);
});

test("a repo with no npm script the seats may test with is named, and one with a test script passes", () => {
  const dir = tmp("npm");
  const cmds = ["npm test", "npm run build"];
  assert.deepEqual(missingTestCommands(dir, cmds), ["npm test", "npm run build"]);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "python -m pytest" } }));
  assert.deepEqual(missingTestCommands(dir, cmds), []);
  assert.deepEqual(missingTestCommands(dir, ["pytest"]), [], "a grant that isn't npm scripts isn't checked here");
});

test("todo text that points at other work without naming it is flagged", () => {
  const out = vagueTodoText(def([
    { id: "plan", lane: "plan", text: "Plan how to do the build steps below" },
    { id: "a", lane: "build", text: "As above, but for the API" },
    { id: "b", lane: "build", text: "Build the scoring rules in app/rules.py" },
  ]));
  assert.equal(out.length, 2);
  assert.match(out[0], /^g\/plan: "the build steps below" points at other work without naming it/);
  assert.match(out[1], /^g\/a: "As above"/);
});

test("checks are run on the starting commit: a failing red line, a failing todo check and a missing checker are each named", async () => {
  const dir = tmp("checks");
  const out = await checksAtStart(dir, def([
    { id: "core", lane: "build", text: "Build the core", writeScope: ["app"], check: "tests" },
    { id: "docs", lane: "docs", text: "Write the docs", check: "nope" },
  ], ["no-secrets"]), {
    checkers: {
      "no-secrets": () => ["app/.env holds a token"],
      tests: (d: string) => (fs.existsSync(path.join(d, "cache")) ? [] : ["cache/ is missing"]),
    },
  });
  assert.equal(out.length, 3);
  assert.match(out[0], /^red line no-secrets fails before any work, so every turn would be thrown away: app\/\.env holds a token/);
  assert.match(out[2], /^g\/docs: no checker "nope"/);
  assert.match(out[1], /^tests fails before any work \(cache\/ is missing\)\. Fine if it checks what g\/core will make; if it runs the project's tests, fix the setup first/);
  fs.mkdirSync(path.join(dir, "cache"));
  assert.equal((await checksAtStart(dir, def([{ id: "core", lane: "build", text: "t", check: "tests" }]), { checkers: { tests: (d: string) => (fs.existsSync(path.join(d, "cache")) ? [] : ["x"]) } })).length, 0);
});

test("open stops on a seed whose .gitignore hides the event log, and warns about the rest without stopping", () => {
  const dir = tmp("cli");
  const env = { ...process.env, AF_PANEL_FOLDERS: path.join(dir, "panel-folders.json") };
  const seed = path.join(dir, "seed");
  fs.mkdirSync(seed);
  fs.writeFileSync(path.join(seed, ".gitignore"), ".agents/\n*.json\n");
  fs.writeFileSync(path.join(dir, "engagement.json"), JSON.stringify(def([{ id: "core", lane: "build", text: "Build the steps below", writeScope: ["app"] }])));
  const bad = spawnSync(process.execPath, ["--no-warnings", CLI, "open", "engagement.json", "--seed", seed], { cwd: dir, env, encoding: "utf8" });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /\.gitignore hides the harness's own files/);
  assert.ok(!fs.existsSync(path.join(dir, ".af", "harness", "oc", "control", ".agents")), "nothing written");
  // Fixed: it opens, with the warnings shown.
  fs.appendFileSync(path.join(seed, ".gitignore"), "!.agents/\n!.agents/**\n!policy/\n!policy/**\n");
  const ok = spawnSync(process.execPath, ["--no-warnings", CLI, "open", "engagement.json", "--seed", seed], { cwd: dir, env, encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /opened oc: 1 goal/);
  assert.match(ok.stderr, /warning: Seats can test only with `npm test` or `npm run build`/);
  assert.match(ok.stderr, /warning: g\/core: "the steps below"/);
  fs.rmSync(dir, { recursive: true, force: true });
});
