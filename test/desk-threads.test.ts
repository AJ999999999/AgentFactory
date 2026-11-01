// The desk as a Claude project's thread list: each Copilot session in a terminal is a
// thread, titled by what you first asked it, grouped by what it needs from you, with
// what it's doing now and what it changed. The work stays in the terminals.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeJson } from "../src/desk/hold.ts";
import { append, type DeskEvent } from "../src/desk/log.ts";
import { deskTools } from "../src/desk/mcp.ts";
import { startDesk } from "../src/desk/server.ts";
import { summarize, titleOf, type Summary } from "../src/desk/session.ts";
import { threads } from "../src/desk/threads.ts";

const tmp = (n: string) => fs.mkdtempSync(path.join(os.tmpdir(), `af-threads-${n}-`));
const at = (m: number) => 1_800_000_000_000 + m * 60_000;
const ev = (type: string, data: Record<string, unknown>) => ({ type, data });

test("a thread is titled by the first sentence of your first prompt, in any language", () => {
  assert.equal(titleOf("Invoices round each line, so totals are off by a cent. Round only the total."), "Invoices round each line, so totals are off by a cent.");
  assert.equal(titleOf("把发票的舍入改成只在总额上做。然后跑测试"), "把发票的舍入改成只在总额上做。");
  assert.equal(titleOf("Fix the v1.2 parser. Then test"), "Fix the v1.2 parser.");
  assert.ok(titleOf("word ".repeat(40)).endsWith("…"));
  assert.ok(titleOf("word ".repeat(40)).length <= 81);
});

test("a session's file says what it's for, what it's doing now, and what it changed", () => {
  const s = summarize([
    ev("session.start", { context: { cwd: "/w/api", branch: "refunds" } }),
    ev("user.message", { content: "Add a refunds endpoint. Follow payments." }),
    ev("tool.execution_start", { toolCallId: "1", toolName: "apply_patch", arguments: "*** Begin Patch\n*** Add File: src/refunds.ts\n*** Update File: src/index.ts\n*** End Patch" }),
    ev("tool.execution_complete", { toolCallId: "1", toolName: "apply_patch", success: true }),
    ev("tool.execution_start", { toolCallId: "2", toolName: "edit", arguments: { path: "src/refunds.ts" } }),
    ev("tool.execution_complete", { toolCallId: "2", success: true }),
    ev("tool.execution_start", { toolCallId: "3", toolName: "powershell", arguments: { command: "npm test" } }),
    ev("tool.execution_complete", { toolCallId: "3", success: false, shellExecution: { exitCode: 1 } }),
    ev("user.message", { content: "Use the finance schema." }),
    ev("assistant.message", { content: "Switching to finance." }),
    ev("assistant.message", { content: "sub-agent talk", parentToolCallId: "x" }),
    ev("tool.execution_start", { toolCallId: "4", toolName: "report_intent", arguments: { intent: "Writing tests" } }),
    ev("tool.execution_start", { toolCallId: "5", toolName: "powershell", arguments: { command: "npm test -w api" } }),
  ]);
  assert.deepEqual(s, {
    prompts: 2,
    title: "Add a refunds endpoint.",
    branch: "refunds",
    said: "Switching to finance.",
    now: "Writing tests (running powershell: npm test -w api)",
    files: ["src/index.ts", "src/refunds.ts"],
    commands: 2,
    failed: 1,
  });
});

test("threads are grouped by what they need from you: longest waiting first, then the busiest", () => {
  const log: DeskEvent[] = [
    { at: at(1), event: "sessionStart", session: "a", cwd: "/w/api", terminal: "api" },
    { at: at(2), event: "sessionStart", session: "b", cwd: "/w/web", terminal: "web" },
    { at: at(3), event: "notification", session: "b", cwd: "/w/web", terminal: "web", kind: "agent_idle", message: "Done." },
    { at: at(4), event: "sessionStart", session: "c", cwd: "/w/etl", terminal: "etl" },
    { at: at(5), event: "permissionRequest", session: "c", cwd: "/w/etl", terminal: "etl", tool: "powershell", detail: '{"command":"npm run migrate"}' },
    { at: at(6), event: "notification", session: "c", cwd: "/w/etl", terminal: "etl", kind: "permission_prompt" },
    { at: at(7), event: "sessionStart", session: "d", cwd: "/w/docs", terminal: "docs" },
    { at: at(8), event: "sessionEnd", session: "d", cwd: "/w/docs", terminal: "docs" },
    { at: at(9), event: "sessionStart", session: "e", cwd: "/w/ops", terminal: "ops" },
    { at: at(10), event: "notification", session: "e", cwd: "/w/ops", terminal: "ops", kind: "elicitation_dialog", message: "Which region?" },
    { at: at(11), event: "userPromptSubmitted", session: "a", cwd: "/w/api", terminal: "api" },
  ];
  const sums: Record<string, Summary> = {
    a: { title: "Add a refunds endpoint.", now: "Writing tests", prompts: 2, files: ["src/refunds.ts"], commands: 3, failed: 0 },
    b: { title: "Validate the email field.", said: "Done.\nWant tests too?", prompts: 1, files: [], commands: 0, failed: 0 },
  };
  const ts = threads(log, [], [], {}, (s) => sums[s], { now: at(20), startOfDay: 0 });
  assert.deepEqual(ts.map((t) => [t.name, t.thread]), [["etl", "needs you"], ["ops", "needs you"], ["web", "your turn"], ["api", "working"], ["docs", "closed"]]);
  const [etl, ops, web, api, docs] = ts;
  assert.equal(etl.why, "wants to run npm run migrate");
  assert.equal(etl.wants, "npm run migrate", "a shell command, as its terminal shows it");
  assert.equal(ops.why, "Which region?");
  assert.equal(web.title, "Validate the email field.");
  assert.equal(web.why, "Want tests too?", "your turn: the last thing it said");
  assert.equal(api.now, "Writing tests");
  assert.equal(api.lastAt, at(11));
  assert.equal(docs.title, "New session in docs", "a session you never prompted");
  assert.equal(etl.mode, "terminal", "asks are answered in the terminal unless you choose the desk");
});

test("you start a thread from the desk: a terminal opens in that folder, under a name no open thread has", async (t) => {
  const home = tmp("start");
  const work = path.join(home, "work", "billing");
  fs.mkdirSync(work, { recursive: true });
  append({ at: Date.now(), event: "sessionStart", session: "s1", cwd: "/w/web", terminal: "web" }, home);
  const opened: Array<[string, string]> = [];
  const desk = await startDesk({ home, port: 0, launch: async (folder, name) => (opened.push([folder, name]), true) });
  t.after(() => desk.close());
  const post = (body: object) => fetch(new URL("/api/start", desk.url), { method: "POST", headers: { "x-desk-token": desk.token, "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post({ folder: work })).status, 200);
  assert.deepEqual(opened, [[work, "billing"]], "named for the folder");
  assert.match((await (await post({ folder: work, name: "web" })).json()).error, /web is already open/);
  assert.match((await (await post({ folder: path.join(home, "nope") })).json()).error, /no folder/);
  assert.match((await (await post({ folder: work, name: "a b" })).json()).error, /a name is letters/);
  const state = await (await fetch(new URL("/api/state?wait=0", desk.url), { headers: { "x-desk-token": desk.token } })).json();
  assert.deepEqual(state.threads.map((x: { name: string; thread: string }) => [x.name, x.thread]), [["web", "working"]]);
  assert.equal(state.askMode, "terminal");
});

test("a session's list_terminals says what each other thread was asked to do", () => {
  const home = tmp("titles");
  const copilot = path.join(home, "copilot");
  process.env.COPILOT_HOME = copilot;
  try {
    fs.mkdirSync(path.join(copilot, "session-state", "s2"), { recursive: true });
    fs.writeFileSync(path.join(copilot, "session-state", "s2", "events.jsonl"), JSON.stringify({ type: "user.message", data: { content: "Rename totalCents to total_cents. Then fix callers." } }) + "\n");
    append({ at: Date.now(), event: "sessionStart", session: "s1", cwd: "/w/billing", terminal: "billing" }, home);
    append({ at: Date.now(), event: "sessionStart", session: "s2", cwd: "/w/web", terminal: "web" }, home);
    writeJson(path.join(home, "config.json"), {});
    const list = deskTools("billing", home).find((x) => x.name === "list_terminals")!.call({}) as { text: string };
    assert.match(list.text, /- web: \/w\/web; working on: Rename totalCents to total_cents\.; working/);
  } finally {
    delete process.env.COPILOT_HOME;
  }
});
