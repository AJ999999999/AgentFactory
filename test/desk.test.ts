// The desk: a hook that records your own Copilot CLI sessions without changing them,
// and a report of how often each repo's session stopped to wait for you.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { hooksConfig, install, uninstall } from "../src/desk/install.ts";
import { readLog, toEvent, type DeskEvent } from "../src/desk/log.ts";
import { renderReport, report, waits } from "../src/desk/report.ts";

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
  assert.deepEqual(Object.keys(cfg.hooks).sort(), ["agentStop", "notification", "permissionRequest", "sessionEnd", "sessionStart", "userPromptSubmitted"]);
  for (const entries of Object.values(cfg.hooks) as Array<Array<{ powershell: string; bash: string; timeoutSec: number }>>) {
    assert.ok(entries[0].powershell.includes(HOOK) && entries[0].bash.includes(HOOK));
    assert.ok(entries[0].timeoutSec <= 5);
  }
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
  assert.deepEqual({ ...billing }, { repo: "billing", sessions: 1, permissions: 2, questions: 0, idle: 1, asked: 3, medianWaitMs: 10_000, tools: [["shell", 2]] });
  assert.equal(rows.find((r) => r.repo === "web")!.questions, 1);
  assert.match(renderReport(rows), /3 times a session stopped for you; 3 permission checks/);
  assert.match(renderReport([]), /Nothing recorded yet/);
});
