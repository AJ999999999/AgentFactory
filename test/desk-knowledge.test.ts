// What Copilot sessions teach: a session file read into a digest, a read-only analysis
// whose findings are kept as guesses in a git repo of their own, confirmed or retracted
// on the desk, and told to the next session in that repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeJson } from "../src/desk/hold.ts";
import { confirm, contextFor, guesses, recordProposals, reject, repoNameOf, summary } from "../src/desk/knowledge.ts";
import { analysisPrompt, learn, parseItems, toLearn, type Analyst } from "../src/desk/learn.ts";
import { append, type DeskEvent } from "../src/desk/log.ts";
import { digest, readEvents, sessionFile, sessionTail } from "../src/desk/session.ts";
import { startDesk } from "../src/desk/server.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const HOOK = path.join(ROOT, "src", "desk", "hook.ts");
const tmp = (n: string) => fs.mkdtempSync(path.join(os.tmpdir(), `af-know-${n}-`));
const line = (type: string, data: Record<string, unknown>) => JSON.stringify({ type, data, id: type, timestamp: "2026-10-31T10:00:00Z" });

const SESSION = [
  line("session.start", { context: { cwd: "/w/billing", branch: "fix-rounding" } }),
  line("user.message", { content: "Round only the invoice total, not each line." }),
  line("tool.execution_start", { toolCallId: "1", toolName: "powershell", arguments: { command: "npm test" } }),
  line("tool.execution_complete", { toolCallId: "1", toolName: "powershell", success: false, error: { message: "e2e timed out" } }),
  line("tool.execution_start", { toolCallId: "2", toolName: "powershell", arguments: { command: "npm test -w api" } }),
  line("tool.execution_complete", { toolCallId: "2", toolName: "powershell", success: true }),
  line("assistant.message", { content: "Done. API tests pass." }),
  line("assistant.message", { content: "inner talk", parentToolCallId: "x" }),
  "not json",
].join("\n");

// A Copilot home with one session, and a desk home whose knowledge repo is in it.
function setup(name: string) {
  const home = tmp(name);
  const copilot = path.join(home, "copilot");
  fs.mkdirSync(path.join(copilot, "session-state", "s1"), { recursive: true });
  fs.writeFileSync(path.join(copilot, "session-state", "s1", "events.jsonl"), SESSION);
  const repo = path.join(home, "work", "billing");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  writeJson(path.join(home, "config.json"), { knowledgeDir: path.join(home, "knowledge"), learn: "off" });
  return { home, copilot, repo, dir: path.join(home, "knowledge") };
}

test("a session file is found where Copilot keeps it, and read leniently", () => {
  const { copilot } = setup("find");
  const f = sessionFile("s1", undefined, { COPILOT_HOME: copilot })!;
  assert.ok(f.endsWith(path.join("s1", "events.jsonl")));
  assert.equal(sessionFile("../etc", undefined, { COPILOT_HOME: copilot }), undefined, "a session id is never a path");
  assert.equal(readEvents(f).length, 8, "the line that isn't JSON is skipped");
  const tail = sessionTail(f);
  assert.ok(tail.some((l) => l.includes("npm test -w api")));
  assert.ok(tail.some((l) => l.includes("e2e timed out")));
});

test("the digest keeps your words, what failed and what you refused, and drops a sub-agent's talk", () => {
  const d = digest(readEvents(setup("digest").copilot + "/session-state/s1/events.jsonl"), [{ tool: "powershell", note: "never push from here" }]);
  assert.equal(d.repo, "billing");
  assert.equal(d.branch, "fix-rounding");
  assert.deepEqual([d.prompts, d.tools, d.failures], [1, 2, 1]);
  assert.match(d.text, /### You\nRound only the invoice total/);
  assert.match(d.text, /npm test\n  FAILED: e2e timed out/);
  assert.match(d.text, /you refused powershell: "never push from here"/);
  assert.doesNotMatch(d.text, /inner talk/);
});

test("a long session loses Copilot's middle, never your prompts", () => {
  const evs = [{ type: "user.message", data: { content: "FIRST ask" } }, ...Array.from({ length: 200 }, (_, i) => ({ type: "assistant.message", data: { content: `answer ${i} ${"x".repeat(300)}` } })), { type: "user.message", data: { content: "LAST ask" } }];
  const d = digest(evs, [], 8000);
  assert.ok(d.text.length < 9000);
  assert.match(d.text, /FIRST ask/);
  assert.match(d.text, /LAST ask/);
  assert.match(d.text, /…/);
});

test("the analysis's reply is read from its last JSON object with items", () => {
  assert.deepEqual(parseItems('Here you go:\n```json\n{"items":[{"a":1}]}\n```'), [{ a: 1 }]);
  assert.deepEqual(parseItems('{"note": "x"} then {"items": []}'), []);
  assert.equal(parseItems("no json here"), null);
  const p = analysisPrompt("billing", "## Known\n- x", ["test.command: use make"]);
  assert.match(p, /session\.md/);
  assert.match(p, /never propose them again:\n- test\.command: use make/);
});

test("findings are kept as guesses; secrets, bad shapes and what you marked wrong are left out", () => {
  const { dir } = setup("record");
  const { kept, dropped } = recordProposals(dir, "billing", [
    { scope: "repo", kind: "fact", subject: "test.command", value: "npm test -w api", text: "Run API tests with npm test -w api", evidence: "passed" },
    { scope: "you", kind: "preference", subject: "git.push", text: "I push myself" },
    { scope: "repo", kind: "fact", subject: "deploy.token", text: "deploy with token=abcd1234efgh" },
    { scope: "elsewhere", kind: "fact", subject: "x", text: "y" },
    { scope: "repo", kind: "intention", subject: "x", text: "y" },
  ], { session: "s1", now: 1000 });
  assert.equal(kept.length, 2);
  assert.deepEqual(dropped.map((d) => d.why), ["looks like it holds a secret", "scope is repo or you", "kind is fact, constraint or preference"]);
  const gs = guesses(dir, 2000);
  assert.deepEqual(gs.map((g) => [g.principal, g.subject, g.session]).sort(), [["repo.billing", "test.command", "s1"], ["you", "git.push", "s1"]]);

  reject(dir, "repo.billing", gs.find((g) => g.subject === "test.command")!.entry, 3000, "we use make");
  const again = recordProposals(dir, "billing", [{ scope: "repo", kind: "fact", subject: "test.command", value: "npm test -w api", text: "Run API tests with npm test -w api" }], { session: "s2", now: 4000 });
  assert.deepEqual(again.dropped.map((d) => d.why), ["you marked this wrong before"]);
});

test("a new session is told a guess as something to check, and what you confirmed as how things are", () => {
  const { home, dir, repo } = setup("context");
  assert.equal(contextFor(repo, home), undefined, "nothing known, nothing said");
  const { kept } = recordProposals(dir, "billing", [{ scope: "repo", kind: "constraint", subject: "money.rounding", text: "Round only at the invoice total." }], { session: "s1", now: Date.now() });
  const before = contextFor(path.join(repo, "src"), home)!;
  assert.match(before, /What earlier sessions learned about billing/);
  assert.match(before, /Ask me before relying on these[\s\S]*money\.rounding/);
  confirm(dir, "repo.billing", kept[0].id, Date.now(), "Round money only at the invoice total, never per line.");
  const after = contextFor(repo, home)!;
  assert.match(after, /How I work[\s\S]*never per line/);
  assert.doesNotMatch(after, /Ask me before relying on these/);
  assert.deepEqual(guesses(dir), []);
  assert.deepEqual(summary(dir, "billing").confirmed, 1);
  assert.equal(repoNameOf(path.join(repo, "src")), "billing");
});

test("the hook tells a new session what's known about its repo, and ignores the desk's own analysis runs", () => {
  const { home, dir, repo } = setup("hook");
  recordProposals(dir, "billing", [{ scope: "repo", kind: "fact", subject: "test.command", text: "npm test -w api" }], { session: "s1", now: Date.now() });
  const env = { ...process.env, AF_DESK_HOME: home };
  const r = spawnSync(process.execPath, ["--no-warnings", HOOK, "sessionStart"], { input: JSON.stringify({ sessionId: "s9", cwd: repo }), env, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(JSON.parse(r.stdout).additionalContext, /test\.command/);
  const q = spawnSync(process.execPath, ["--no-warnings", HOOK, "sessionStart"], { input: JSON.stringify({ sessionId: "s10", cwd: repo }), env: { ...env, AF_DESK_QUIET: "1" }, encoding: "utf8" });
  assert.equal(q.stdout, "");
  assert.ok(!fs.readFileSync(path.join(home, "events.jsonl"), "utf8").includes("s10"));
});

const canned = (items: unknown[]): Analyst => async (prompt, work) => {
  assert.ok(fs.readFileSync(path.join(work, "session.md"), "utf8").includes("Round only the invoice total"), "the analyst reads the digest from its folder");
  assert.match(prompt, /billing/);
  return `Here:\n${JSON.stringify({ items })}`;
};

test("learning from an ended session commits the guesses, the digest and the analysis to the knowledge repo, once", async () => {
  const { home, copilot, repo, dir } = setup("learn");
  process.env.COPILOT_HOME = copilot;
  try {
    const ev = (e: Partial<DeskEvent> & Pick<DeskEvent, "event">) => append({ at: Date.now(), session: "s1", cwd: repo, ...e } as DeskEvent, home);
    ev({ event: "sessionStart" });
    ev({ event: "decision", by: "page", choice: "deny", tool: "powershell", message: "I push myself" });
    assert.deepEqual(toLearn((await import("../src/desk/log.ts")).readLog(home), dir), [], "a session still open isn't learned from");
    ev({ event: "sessionEnd" });
    const log = (await import("../src/desk/log.ts")).readLog(home);
    assert.deepEqual(toLearn(log, dir).map((t) => t.session), ["s1"]);

    const a = (await learn("s1", { home, analyst: canned([{ scope: "repo", kind: "fact", subject: "test.command", text: "npm test -w api runs only the API tests" }]) }))!;
    assert.equal(a.ok, true);
    assert.equal(a.kept.length, 1);
    assert.ok(fs.readFileSync(path.join(dir, "sessions", "s1.md"), "utf8").includes('you refused powershell: "I push myself"'));
    const git = (args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" }).stdout;
    assert.match(git(["log", "-1", "--format=%s%n%b"]), /learn from billing session s1: 1 kept[\s\S]*Session: s1/);
    assert.equal(git(["status", "--porcelain"]), "", "everything written is committed");
    assert.deepEqual(toLearn(log, dir), [], "learned once");
    assert.equal(await learn("s1", { home, analyst: canned([]) }), null);

    const bad = (await learn("s1", { home, force: true, analyst: async () => "I couldn't decide." }))!;
    assert.equal(bad.ok, false);
    assert.match(bad.error!, /didn't reply with JSON/);
  } finally {
    delete process.env.COPILOT_HOME;
  }
});

test("the desk confirms and retracts guesses, and learns from a session on request", async () => {
  const { home, copilot, repo, dir } = setup("server");
  process.env.COPILOT_HOME = copilot;
  append({ at: Date.now(), event: "sessionStart", session: "s1", cwd: repo }, home);
  const desk = await startDesk({ home, port: 0, analyst: canned([{ scope: "you", kind: "preference", subject: "git.push", text: "I push myself" }, { scope: "repo", kind: "fact", subject: "test.command", text: "npm test -w api" }]), learnEveryMs: 60_000 });
  try {
    const base = desk.url.replace(/\/$/, "");
    const h = { "x-desk-token": desk.token, "content-type": "application/json" };
    const state = async () => (await fetch(`${base}/api/state?wait=0`, { headers: h })).json();
    assert.equal((await fetch(`${base}/api/learn`, { method: "POST", headers: h, body: JSON.stringify({ session: "s1" }) })).status, 200);
    let s;
    for (let i = 0; i < 100; i++) {
      s = await state();
      if (s.guesses.length === 2 && !s.learning.running) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(s.guesses.length, 2);
    assert.equal(s.terminals[0].tail.length > 0, true, "the terminal shows the end of its session");
    const push = s.guesses.find((g: { subject: string }) => g.subject === "git.push");
    const tc = s.guesses.find((g: { subject: string }) => g.subject === "test.command");
    assert.equal((await fetch(`${base}/api/know`, { method: "POST", headers: h, body: JSON.stringify({ principal: push.principal, entry: push.entry, verdict: "right" }) })).status, 200);
    assert.equal((await fetch(`${base}/api/know`, { method: "POST", headers: h, body: JSON.stringify({ principal: tc.principal, entry: tc.entry, verdict: "wrong", text: "it's make test" }) })).status, 200);
    s = await state();
    assert.deepEqual(s.guesses, []);
    assert.equal(s.terminals[0].knowledge.confirmed, 0);
    assert.match(contextFor(repo, home)!, /How I work \(from earlier sessions\)[\s\S]*I push myself/);
    assert.equal((await fetch(`${base}/api/know`, { method: "POST", headers: h, body: JSON.stringify({ principal: tc.principal, entry: "nope", verdict: "right" }) })).status, 400);
  } finally {
    await desk.close();
    delete process.env.COPILOT_HOME;
  }
});

test("the desk's page wears the partner's panel's styles", async () => {
  const { page } = await import("../src/desk/server.ts");
  const html = page();
  assert.ok(!html.includes("/*__PANEL_CSS__*/"));
  assert.match(html, /\.strip \{/);
  assert.match(html, /\.eng-head/);
});

test("a knowledge repo with a remote shares each change, so another desk can pull what this one learned", async () => {
  const { commit, ensureRepo } = await import("../src/desk/knowledge.ts");
  const { dir } = setup("share");
  const bare = path.join(path.dirname(dir), "team.git");
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  await ensureRepo(dir);
  spawnSync("git", ["remote", "add", "origin", bare], { cwd: dir });
  recordProposals(dir, "billing", [{ scope: "repo", kind: "fact", subject: "test.command", text: "npm test -w api" }], { session: "s1", now: 1 });
  await commit(dir, "learn something");
  const other = path.join(path.dirname(dir), "other");
  spawnSync("git", ["clone", "-q", bare, other]);
  assert.equal(guesses(other).length, 1);
});
