// A long session read as a story: one step per prompt you gave, in a few words, joined to
// the step it follows from, with a handful of bullets for what Copilot did and said.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startDesk } from "../src/desk/server.ts";
import { askOf, commandHead, gistOf, story } from "../src/desk/session.ts";

const ev = (type: string, data: Record<string, unknown>, timestamp?: string) => ({ type, data, ...(timestamp ? { timestamp } : {}) });
const line = (type: string, data: Record<string, unknown>) => JSON.stringify({ type, data }) + "\n";

test("each prompt reads as a few words: an instruction, a yes, a choice, a stop, a picked-up session", () => {
  assert.deepEqual(askOf("now let's really try hard on ui/ux.  the entire desk need to adopt more progress loading."), { kind: "ask", ask: "Try hard on ui/ux" });
  assert.deepEqual(askOf("Can you please fix the flaky login test and then push it"), { kind: "ask", ask: "Fix the flaky login test and then…" });
  assert.deepEqual(askOf("fetch origin claude/x , and check out"), { kind: "ask", ask: "Fetch origin claude/x" });
  assert.deepEqual(askOf("Yes"), { kind: "reply", ask: "Said yes" });
  assert.deepEqual(askOf("好"), { kind: "reply", ask: "Said yes" });
  assert.deepEqual(askOf("好，先提交，然后修第 1 条"), { kind: "ask", ask: "先提交" }, "a Chinese instruction that starts with 好 is not a yes");
  assert.deepEqual(askOf("b"), { kind: "reply", ask: "Chose b" });
  assert.deepEqual(askOf("continue"), { kind: "reply", ask: "Continue" });
  assert.deepEqual(askOf("Push to GitHub"), { kind: "ask", ask: "Push to GitHub" });
  assert.deepEqual(askOf("[Request interrupted by user]"), { kind: "stop", ask: "Stopped it" });
  assert.equal(askOf("This session is being continued from a previous conversation that ran out of context.").kind, "resume");
});

test("a command is named by its program and what it does, not its whole line", () => {
  assert.equal(commandHead("cd C:\\w\\api && npm test -- --watch"), "npm test");
  assert.equal(commandHead('$env:X = "1"; git -c a=b commit -m "x"'), "git commit");
  assert.equal(commandHead("node C:\\tmp\\scratch\\shots.mjs http://x"), "node shots.mjs");
  assert.equal(commandHead("python <<'EOF'\nprint(1)\nEOF"), "python");
  assert.equal(commandHead("Get-ChildItem src | Select Name"), "Get-ChildItem");
  assert.equal(commandHead("if (Test-Path x) { rm x }"), "a script");
});

test("what Copilot said reads as its first sentence and its list items, without markdown", () => {
  assert.deepEqual(gistOf("**Done.** Tests pass.\n\n```\nnpm test\n```\n- Fixed `round()`\n- Added [docs](https://x.y)\n- Third\n"), ["Done.", "Fixed round()", "Added docs", "Third"]);
  assert.deepEqual(gistOf("## Plan\nOnly one line here", 0), ["Only one line here"]);
});

test("a step follows the step before, an earlier step it shares words with, or starts a new topic", () => {
  const s = story([
    ev("user.message", { content: "Add a refunds endpoint to the billing service with tests" }),
    ev("tool.execution_start", { toolCallId: "1", toolName: "edit", arguments: { path: "src/refunds.ts" } }),
    ev("tool.execution_complete", { toolCallId: "1", success: true }),
    ev("user.message", { content: "yes" }),
    ev("user.message", { content: "Write the release notes for the mobile app version two launch" }),
    ev("user.message", { content: "Make the refunds endpoint reject amounts above the original billing charge" }),
    ev("user.message", { content: "continue with that and also update the release notes after it" }),
  ]);
  const steps = s.steps();
  assert.deepEqual(steps.map((x) => [x.ask, x.parent]), [
    ["Add a refunds endpoint to the billing…", -1],
    ["Said yes", 0],
    ["Write the release notes for the mobile…", -1],
    ["Make the refunds endpoint reject amounts above…", 0],
    ["Continue with that and also update the…", 3],
  ]);
  assert.deepEqual(steps.map((x) => x.tone), ["ok", "talk", "talk", "talk", "talk"]);
  // Only what changed since a version comes back, and starting a step changes the one before.
  const v = s.v;
  s.feed(ev("tool.execution_start", { toolCallId: "2", toolName: "powershell", arguments: { command: "npm test" } }));
  assert.deepEqual(s.steps(v).map((x) => [x.i, x.tone]), [[4, "run"]]);
});

test("an opened step says in a few bullets what it did, what failed and what Copilot said", () => {
  const s = story([
    ev("user.message", { content: "Fix the rounding in invoices" }, "2026-11-02T10:00:00Z"),
    ev("tool.execution_start", { toolCallId: "1", toolName: "view", arguments: { path: "src/invoice.ts" } }),
    ev("tool.execution_complete", { toolCallId: "1", success: true }),
    ev("tool.execution_start", { toolCallId: "2", toolName: "apply_patch", arguments: "*** Begin Patch\n*** Update File: src/invoice.ts\n*** Add File: test/invoice.test.ts\n*** End Patch" }),
    ev("tool.execution_complete", { toolCallId: "2", success: true }),
    ev("tool.execution_start", { toolCallId: "3", toolName: "powershell", arguments: { command: "npm test" } }),
    ev("tool.execution_complete", { toolCallId: "3", success: false, shellExecution: { exitCode: 1 }, result: { content: "✔ rounds a line (1ms)\n✖ rounds the total\n  AssertionError: 10.01 !== 10" } }),
    ev("tool.execution_start", { toolCallId: "4", toolName: "powershell", arguments: { command: "npm test" } }),
    ev("tool.execution_complete", { toolCallId: "4", success: true }),
    ev("assistant.message", { content: "Rounding now happens once, on the total.\n\n- `invoice.ts` rounds at the end\n- a test covers a 3-line invoice" }, "2026-11-02T10:04:00Z"),
  ]);
  const d = s.detail(0)!;
  assert.equal(d.tone, "warn", "a failure it recovered from");
  assert.equal(d.ms, 4 * 60_000);
  assert.deepEqual(d.did, ["Edited 2 files: invoice.test.ts, invoice.ts", "Ran 2 commands: npm test ×2", "Read 1 file"]);
  assert.deepEqual(d.errors, ["npm test: ✖ rounds the total"]);
  assert.deepEqual(d.said, ["Rounding now happens once, on the total.", "invoice.ts rounds at the end", "a test covers a 3-line invoice"]);
  assert.equal(d.prompt, "Fix the rounding in invoices");
  assert.equal(s.detail(5), undefined);
});

test("the desk serves a session's story as it grows, and one step's bullets when you open it", { timeout: 30_000 }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "af-story-"));
  const f = path.join(home, "session.jsonl");
  fs.writeFileSync(f, line("user.message", { content: "Fix the rounding." }));
  fs.writeFileSync(path.join(home, "events.jsonl"), JSON.stringify({ at: Date.now(), event: "sessionStart", session: "s1", cwd: home, terminal: "billing", transcript: f }) + "\n");
  const desk = await startDesk({ home, port: 0, learnEveryMs: 3_600_000 });
  t.after(() => desk.close());
  const get = async (p: string) => (await fetch(new URL(p, desk.url), { headers: { "x-desk-token": desk.token } })).json();

  const open = await get("/api/story?id=s1&since=0");
  assert.deepEqual(open.steps.map((x: { ask: string }) => x.ask), ["Fix the rounding"]);
  const started = Date.now();
  const waiting = get(`/api/story?id=s1&since=${open.v}&epoch=${open.epoch}&wait=20000`);
  setTimeout(() => fs.appendFileSync(f, line("user.message", { content: "now push it" })), 300);
  const next = await waiting;
  assert.deepEqual(next.steps.map((x: { i: number; ask: string; parent: number }) => [x.i, x.ask, x.parent]), [[0, "Fix the rounding", -1], [1, "Push it", 0]]);
  assert.ok(Date.now() - started < 3000);
  assert.equal((await get("/api/story/step?id=s1&i=1")).prompt, "now push it");
  assert.equal((await get("/api/story/step?id=s1&i=7")).error, "no such step");
});
