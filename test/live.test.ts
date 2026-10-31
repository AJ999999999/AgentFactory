// Watching and stopping turns as they run: Copilot's JSON stream read into a log, the
// panel's view of running turns, and a stop that kills the agent and leaves the work
// waiting on the partner.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createWorkspace } from "../src/foundation/workspace.ts";
import { CapacityError, CopilotStream, CopilotTurnAgent } from "../src/harness/agents.ts";
import { Harness } from "../src/harness/harness.ts";
import { LiveTurns } from "../src/harness/live.ts";
import { loadPolicy } from "../src/harness/project.ts";
import type { EngagementDef } from "../src/harness/types.ts";
import { SystemClock } from "../src/harness/world.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const policy = loadPolicy(path.join(ROOT, "policy", "harness.json"));
const tmp = (n: string) => fs.mkdtempSync(path.join(os.tmpdir(), `af-live-${n}-`));

const ev = (type: string, data: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => JSON.stringify({ type, data, id: "0b5e-429a-11ef", ...extra });

// The shape Copilot CLI 1.0.105 prints with --output-format json (trimmed).
const STREAM = [
  ev("session.mcp_servers_loaded", { servers: [{ name: "github-mcp-server", serverMetadata: { instructions: "Mind GitHub's rate limits and quota when listing issues." } }] }),
  ev("session.auto_mode_resolved", { chosenModel: "gpt-6-luna", availableModels: ["gpt-6-luna"] }),
  ev("assistant.reasoning_delta", { deltaContent: "thinking" }),
  ev("assistant.message", { content: "", toolRequests: [{ name: "apply_patch" }] }),
  ev("tool.execution_start", { toolName: "apply_patch", toolTitle: "Applying patch", arguments: "*** Begin Patch\n*** Add File: work/a.md\n+hi\n*** End Patch\n" }),
  ev("tool.execution_complete", { toolName: "apply_patch", success: true }),
  ev("tool.execution_start", { toolName: "powershell", toolTitle: "Running command", arguments: { command: "npm test" } }),
  ev("tool.execution_complete", { toolName: "powershell", success: true, shellExecution: { exitCode: 1 } }),
  ev("tool.execution_start", { toolName: "powershell", toolTitle: "Running command", arguments: { command: "git push" } }),
  ev("tool.execution_complete", { toolName: "powershell", success: false, error: { message: "Permission denied: shell(git push)" } }),
  ev("assistant.message", { content: 'Wrote it. Tests fail on {braces} for now.\n{"done": false, "note": "tests red"}' }),
  JSON.stringify({ type: "result", exitCode: 0, usage: { premiumRequests: 1, sessionDurationMs: 14319 } }),
].join("\n");

test("Copilot's JSON stream: a line per step for the log, the reply from its messages, the model it picked", () => {
  const lines: string[] = [];
  const s = new CopilotStream((...l) => lines.push(...l));
  // Arrives in pieces that split lines.
  for (let i = 0; i < STREAM.length; i += 97) s.feed(STREAM.slice(i, i + 97));
  s.end();
  assert.equal(s.model, "gpt-6-luna");
  assert.equal(s.errors(), "", "MCP instructions that mention rate limits are not errors");
  assert.ok(s.reply().endsWith('{"done": false, "note": "tests red"}'));
  assert.deepEqual(lines, [
    "model: gpt-6-luna (picked by Copilot from gpt-6-luna)",
    "→ Applying patch: work/a.md",
    "→ Running command: npm test",
    "  exit 1",
    "→ Running command: git push",
    "  ✗ powershell: Permission denied: shell(git push)",
    "  Wrote it. Tests fail on {braces} for now.",
    '  {"done": false, "note": "tests red"}',
    "result: exit 0, 1 premium request, 14s",
  ]);
  // An older CLI that prints text: passed through as it is.
  const plain: string[] = [];
  const t = new CopilotStream((...l) => plain.push(...l));
  t.feed("Did the thing.\n{\"done\": true}\n");
  t.end();
  assert.equal(t.events, 0);
  assert.deepEqual(plain, ["Did the thing.", '{"done": true}']);
});

function fake(dir: string, body: string): string {
  const f = path.join(dir, "copilot.js");
  fs.writeFileSync(f, `const fs = require("node:fs");\nconst ev = (type, data = {}) => console.log(JSON.stringify({ type, data }));\n${body}\n`);
  return f;
}

const def = (todos: EngagementDef["goals"][number]["todos"]): EngagementDef => ({
  id: "w", title: "Watch", principals: { partner: "you" },
  goals: [{ id: "G", title: "G", objective: "o", owner: "partner", scope: ["work"], assumptions: [], budget: { turns: 20 }, todos }],
});

async function harness(agent: CopilotTurnAgent, d: EngagementDef) {
  const dir = tmp("h");
  const control = await createWorkspace({ dir });
  const turns = path.join(dir, "turns");
  const h = new Harness({ control, engagement: d.id, policy, clock: new SystemClock(), world: {}, agent, worktreeRoot: path.join(dir, "wt"), turnsDir: turns });
  await h.open(d);
  return { h, turns, dir };
}

test("a capacity error inside the JSON stream is recognised; the same words in MCP instructions are not", async () => {
  const dir = tmp("cap");
  const bin = fake(dir, `ev("session.mcp_servers_loaded", { servers: [{ serverMetadata: { instructions: "Respect the API rate limit." } }] });
ev("session.error", { message: "You have exceeded your premium request allowance. It resets in 3 hours." });
process.exit(1);`);
  const agent = new CopilotTurnAgent({ bin, fallback: { agent: "author", model: "model-a" }, profileDirs: null, timeoutMs: 30_000 });
  const ctx = { turn: "t", agent: "r", now: 1_000, packet: "p", todo: { id: "t", lane: "build", text: "t" }, wtDir: dir } as never;
  await assert.rejects(agent.run(ctx), (e: unknown) => e instanceof CapacityError && e.resetAt === 1_000 + 3 * 3_600_000);
  const plain = fake(dir, `ev("session.mcp_servers_loaded", { servers: [{ serverMetadata: { instructions: "Respect the API rate limit." } }] });
console.error("Error: something broke");
process.exit(1);`);
  const agent2 = new CopilotTurnAgent({ bin: plain, fallback: { agent: "author", model: "model-a" }, profileDirs: null, timeoutMs: 30_000 });
  await assert.rejects(agent2.run(ctx), (e: unknown) => !(e instanceof CapacityError) && /something broke/.test((e as Error).message));
});

test("a running turn shows in the turns folder with its log; stopping it kills the agent, keeps nothing, and asks the partner", async () => {
  const work = tmp("stop");
  const pidFile = path.join(work, "pid.txt");
  const bin = fake(work, `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
fs.mkdirSync("work", { recursive: true });
fs.writeFileSync("work/half.md", "half done");
ev("session.auto_mode_resolved", { chosenModel: "m1", availableModels: ["m1"] });
let i = 0;
setInterval(() => ev("tool.execution_start", { toolTitle: "Running command", arguments: { command: "step " + ++i } }), 100);
setTimeout(() => { console.log(JSON.stringify({ type: "assistant.message", data: { content: '{"done": true}' } })); process.exit(0); }, 60_000);`);
  const agent = new CopilotTurnAgent({ bin, fallback: { agent: "author", model: "model-a" }, profileDirs: null, timeoutMs: 120_000 });
  const { h, turns } = await harness(agent, def([{ id: "t", lane: "build", text: "Write the half", writeScope: ["work"] }]));
  const live = new LiveTurns(turns);
  const started = Date.now();
  const ticking = h.tick({ id: "r1", capabilities: [] });

  // Wait for the turn to be running and its log to show steps.
  let running = live.list(Date.now());
  for (let i = 0; i < 200 && !(running.length && running[0].tail.some((l) => l.includes("step 3"))); i++) {
    await new Promise((r) => setTimeout(r, 100));
    running = live.list(Date.now());
  }
  assert.equal(running.length, 1, "the turn is listed while it runs");
  const r0 = running[0];
  assert.deepEqual([r0.todo, r0.text, r0.runner, r0.stopping], ["t", "Write the half", "r1", false]);
  assert.ok(r0.tail.some((l) => l.includes("model: m1")), r0.tail.join("\n"));
  assert.ok(!r0.tail.some((l) => l.includes("Your todo") || l.includes("--- prompt ---")), "the panel's tail leaves the prompt out");
  assert.ok(live.tail(r0.turn, 500).some((l) => l.includes("Your todo")), "the log keeps it");
  assert.equal(live.requestStop("no-such-turn", "partner", Date.now()), false);
  assert.equal(live.requestStop(r0.turn, "partner", Date.now()), true);
  assert.equal(live.list(Date.now())[0].stopping, true);

  const r = await ticking;
  assert.equal(r.turns[0].result, "stopped");
  assert.ok(Date.now() - started < 30_000, "it stopped well before the agent would have finished");
  assert.equal(live.list(Date.now()).length, 0, "nothing is listed as running any more");
  const log = fs.readFileSync(path.join(turns, `${r0.turn}.log`), "utf8");
  assert.match(log, /stop requested by the partner/);
  assert.match(log, /--- stopped: stopped by the partner/);
  // The agent's process is gone.
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  let gone = false;
  for (let i = 0; i < 50 && !gone; i++) {
    try {
      process.kill(pid, 0);
      await new Promise((res) => setTimeout(res, 100));
    } catch {
      gone = true;
    }
  }
  assert.ok(gone, "the agent was killed");

  let s = await h.state();
  assert.deepEqual(s.turns.map((t) => t.result), ["stopped"]);
  assert.equal(s.todos.get("t")!.failures, 0, "a stop is not a failure");
  assert.equal(s.goals.get("G")!.spent.turns, 1, "the turn it used is counted");
  assert.throws(() => h.control.run(["show", "origin/main:work/half.md"]), "its changes were thrown away");

  // The next wake doesn't start it again: it asks.
  await h.tick({ id: "r1", capabilities: [] });
  s = await h.state();
  const ask = [...s.asks.values()].find((a) => a.origin === "rule:stopped")!;
  assert.ok(ask && ask.status === "open");
  assert.equal(s.todos.get("t")!.status, "blocked");
  await h.answer(ask.id, { by: "partner", choice: "retry" });
  s = await h.state();
  assert.equal(s.todos.get("t")!.status, "open");
  assert.equal(s.todos.get("t")!.stopped, false);
});

test("a turn's log is kept after it ends; a dead runner's leftover marker isn't shown as running", async () => {
  const work = tmp("log");
  const bin = fake(work, `fs.mkdirSync("work", { recursive: true });
fs.writeFileSync("work/a.md", "a");
ev("tool.execution_start", { toolTitle: "Applying patch", arguments: "*** Add File: work/a.md" });
ev("assistant.message", { content: '{"done": true}' });
console.log(JSON.stringify({ type: "result", exitCode: 0, usage: { premiumRequests: 1 } }));`);
  const agent = new CopilotTurnAgent({ bin, fallback: { agent: "author", model: "model-a" }, profileDirs: null, timeoutMs: 30_000 });
  const { h, turns } = await harness(agent, def([{ id: "t", lane: "build", text: "t", writeScope: ["work"] }]));
  const r = await h.tick({ id: "r1", capabilities: [] });
  assert.equal(r.turns[0].result, "completed");
  const logs = fs.readdirSync(turns);
  assert.equal(logs.length, 1, `only the log is left: ${logs}`);
  const log = fs.readFileSync(path.join(turns, logs[0]), "utf8");
  for (const want of ["--- prompt ---", "Your todo t", "→ Applying patch: work/a.md", "result: exit 0, 1 premium request", "--- completed"]) assert.ok(log.includes(want), want);

  // A marker left by a runner that died mid-turn.
  const live = new LiveTurns(turns);
  fs.writeFileSync(path.join(turns, "x-1-abc.json"), JSON.stringify({ turn: "x-1-abc", todo: "x", goal: "G", text: "x", runner: "r9", pid: 999_999_999, startedAt: Date.now(), until: Date.now() + 60_000 }));
  assert.equal(live.list(Date.now()).length, 0);
});
