// The eval: its checks are sound (every case's start fails them, its solution passes),
// and its runner runs a case through the real harness, grades the merged result and
// counts what it cost, here with a fake Copilot that writes the fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildSeed, grade, loadCases } from "../src/eval/cases.ts";
import { report, runCase } from "../src/eval/run.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const tmp = (n: string) => fs.mkdtempSync(path.join(os.tmpdir(), `af-eval-${n}-`));

test("every case's checks fail on its start and pass on its reference solution", () => {
  const cases = loadCases();
  assert.equal(cases.length, 10);
  for (const c of cases) {
    const start = tmp(`${c.id}-s`);
    const sol = tmp(`${c.id}-x`);
    buildSeed(c, start);
    buildSeed(c, sol, true);
    const a = grade(c, start);
    const b = grade(c, sol);
    assert.ok(a.score < 1, `${c.id}: the start already passes`);
    assert.equal(b.score, 1, `${c.id}: the solution misses ${b.checks.filter((x) => !x.ok).map((x) => `${x.name}: ${x.error}`).join("; ")}`);
  }
});

test("code under test that calls process.exit can't end the grader", () => {
  const [c] = loadCases(["safe-rules"]);
  const start = tmp("exit");
  buildSeed(c, start); // its rules.js runs rules through Function(), process.exit(1) included
  const g = grade(c, start);
  assert.ok(g.total > 5, "every check ran");
  assert.equal(g.checks.find((x) => x.name === "refuses: process.exit(1)")!.ok, false);
});

// A fake Copilot that writes the correct money.js into its worktree and reports done.
function fakeCopilot(dir: string): string {
  const fixed = path.join(ROOT, "eval", "project", "src", "money.js");
  const f = path.join(dir, "copilot.js");
  fs.writeFileSync(f, `const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(dir, "calls.jsonl"))}, JSON.stringify({ agent: args[args.indexOf("--agent") + 1], session: args.includes("--session-id") ? args[args.indexOf("--session-id") + 1] : null }) + "\\n");
fs.copyFileSync(${JSON.stringify(fixed)}, "src/money.js");
const ev = (o) => console.log(JSON.stringify(o));
ev({ type: "assistant.message", data: { content: '{"done": true, "note": "rounding fixed"}' } });
ev({ type: "result", exitCode: 0, usage: { premiumRequests: 1 } });
`);
  return f;
}

test("a case runs through the harness: the fix is merged and graded, its turns and premium requests counted", async () => {
  const [c] = loadCases(["fix-rounding"]);
  const bins = tmp("bins");
  const out = tmp("out");
  const lines: string[] = [];
  for (const arm of ["A", "C"]) {
    const r = await runCase(c, arm, 1, { out, runId: "t", maxTicks: 5, log: (s) => lines.push(s), bins: { copilot: fakeCopilot(bins) } });
    assert.equal(r.score, 1, r.failed.join("; "));
    assert.deepEqual([r.turns, r.outcomes.completed, r.todosDone, r.premiumRequests, r.stoppedBy], [1, 1, 1, 1, "done"]);
    assert.ok(fs.existsSync(path.join(r.dir, "final", "src", "money.js")));
  }
  const calls = fs.readFileSync(path.join(bins, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(calls[0].session, null, "arm A: a fresh session");
  assert.match(calls[1].session, /^[0-9a-f-]{36}$/, "arm C: a session for the todo");
  const md = report("t", [], ["A", "C"]);
  assert.match(md, /\| A \| 0 \|/);
  assert.ok(spawnSync(process.execPath, ["--no-warnings", path.join(ROOT, "src", "eval", "run.ts"), "--list"], { encoding: "utf8" }).stdout.includes("multi-currency"));
});
