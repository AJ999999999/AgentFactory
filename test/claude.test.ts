// Judges on another vendor: seats whose model maps to "claude:<model>" run in Claude
// Code with only the catalog's tools, and a usage limit on one vendor holds up only the
// seats on it.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createWorkspace } from "../src/foundation/workspace.ts";
import { CapacityError, CopilotTurnAgent, TurnRouter, classifyCapacity } from "../src/harness/agents.ts";
import { ClaudeCodeTurnAgent, ClaudeStream } from "../src/harness/vendors.ts";
import { Harness } from "../src/harness/harness.ts";
import { loadPolicy } from "../src/harness/project.ts";
import { blockers } from "../src/harness/select.ts";
import type { EngagementDef } from "../src/harness/types.ts";
import { SimClock } from "../src/harness/world.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const policy = loadPolicy(path.join(ROOT, "policy", "harness.json"));
const PROFILES = path.join(ROOT, "integrations", "copilot", "harness-agents");
const tmp = (n: string) => fs.mkdtempSync(path.join(os.tmpdir(), `af-claude-${n}-`));
const MODELS = { "model-a": "", "model-b": "claude:opus", "model-c": "" };

// Trimmed from Claude Code 2.1.314's --output-format stream-json --verbose.
const line = (o: unknown) => JSON.stringify(o);
const STREAM = [
  line({ type: "system", subtype: "init", model: "claude-opus-5-5", permissionMode: "dontAsk", mcp_servers: [] }),
  line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "git push" } }] } }),
  line({ type: "system", subtype: "permission_denied", tool_name: "Bash", message: "Permission to use Bash with command git push has been denied." }),
  line({ type: "user", message: { content: [{ type: "tool_result", is_error: true, content: "Permission to use Bash with command git push has been denied." }] } }),
  line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "work/a.md" } }] } }),
  line({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", resetsAt: 1793426400, rateLimitType: "seven_day", utilization: 0.86 } }),
  line({ type: "assistant", message: { content: [{ type: "text", text: 'Looks fine.\n{"done": true, "verdict": "accept"}' }] } }),
  line({ type: "result", subtype: "success", is_error: false, result: 'Looks fine.\n{"done": true, "verdict": "accept"}', num_turns: 3, total_cost_usd: 0.0123, duration_ms: 9000 }),
].join("\n");

test("Claude Code's stream: a line per step, its denials, the plan's usage, and the reply from the result", () => {
  const lines: string[] = [];
  const s = new ClaudeStream((...l) => lines.push(...l), 0);
  for (let i = 0; i < STREAM.length; i += 61) s.feed(STREAM.slice(i, i + 61));
  s.end();
  assert.equal(s.model, "claude-opus-5-5");
  assert.equal(s.capacity(), null, "a warning is not a limit");
  assert.ok(s.reply().endsWith('{"done": true, "verdict": "accept"}'));
  assert.deepEqual(lines, [
    "model: claude-opus-5-5",
    "→ Bash: git push",
    "  ✗ denied: Bash (Permission to use Bash with command git push has been denied.)",
    "→ Read: work/a.md",
    "usage: seven_day 86% used, resets 2026-10-31T06:00:00.000Z",
    "  Looks fine.",
    '  {"done": true, "verdict": "accept"}',
    "result: success, 3 steps, $0.0123 at API prices, 9s",
  ]);
  // A refusal for the plan's limit: its own reset time, exactly.
  const t = new ClaudeStream(() => {}, 0);
  t.feed(line({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1793426400, rateLimitType: "seven_day" } }) + "\n");
  t.feed(line({ type: "result", subtype: "success", is_error: true, result: "Claude AI usage limit reached|1793426400" }) + "\n");
  t.end();
  assert.deepEqual(t.capacity(), { reason: "Claude seven_day limit reached", resetAt: 1793426400_000 });
});

test("Claude's own ways of saying when a limit resets", () => {
  const now = new Date(2026, 9, 30, 11, 0).getTime();
  assert.equal(classifyCapacity("Claude AI usage limit reached|1793426400", now)?.resetAt, 1793426400_000);
  assert.equal(classifyCapacity("You've hit your limit · resets 5pm (America/Toronto)", now)?.resetAt, new Date(2026, 9, 30, 17, 0).getTime());
  assert.equal(classifyCapacity("Usage limit reached. Resets at 9:30 AM", now)?.resetAt, new Date(2026, 9, 31, 9, 30).getTime(), "a time already past today means tomorrow");
  // Codex on a ChatGPT plan, as it really said it on 2026-10-30.
  assert.equal(classifyCapacity("You’ve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at Nov 17th, 2026 10:18 PM.", now)?.resetAt, new Date(2026, 10, 17, 22, 18).getTime());
  assert.equal(classifyCapacity("Usage limit reached; resets on Nov 2", now)?.resetAt, new Date(2026, 10, 2, 0, 0).getTime());
});

// A fake `claude` that records how it was called, reads its prompt from stdin, and
// answers in stream-json (or hits its limit, when LIMIT is set in its folder).
function fakeClaude(dir: string): string {
  const f = path.join(dir, "claude.js");
  fs.writeFileSync(f, `const fs = require("node:fs");
const path = require("node:path");
const here = ${JSON.stringify(dir)};
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  fs.writeFileSync(path.join(here, "call.json"), JSON.stringify({ args: process.argv.slice(2), stdin: input }));
  const out = (o) => console.log(JSON.stringify(o));
  out({ type: "system", subtype: "init", model: "claude-opus-5-5" });
  if (fs.existsSync(path.join(here, "LIMIT"))) {
    out({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: Math.floor(Date.parse("2026-11-02T15:00:00Z") / 1000), rateLimitType: "five_hour" } });
    out({ type: "result", subtype: "success", is_error: true, result: "Claude AI usage limit reached" });
    process.exit(1);
  }
  out({ type: "result", subtype: "success", is_error: false, result: 'Weighed it.\\n{"done": true, "note": "keep going"}' });
});
`);
  return f;
}

function fakeCopilot(dir: string): string {
  const f = path.join(dir, "copilot.js");
  fs.writeFileSync(f, `const fs = require("node:fs");
fs.mkdirSync("work", { recursive: true });
fs.writeFileSync("work/built.md", "built");
console.log(JSON.stringify({ type: "assistant.message", data: { content: '{"done": true}' } }));
`);
  return f;
}

const def = (): EngagementDef => ({
  id: "j", title: "Judges", principals: { partner: "you" },
  goals: [{
    id: "G", title: "G", objective: "o", owner: "partner", scope: ["work"], budget: { turns: 20 },
    assumptions: [{ id: "A1", text: "people want it", category: "desirability", risk: 3, uncertainty: 3 }],
    todos: [
      { id: "weigh", lane: "synthesis", text: "Weigh the evidence on A1", because: "kickoff" },
      { id: "build", lane: "build", text: "Build it", writeScope: ["work"] },
    ],
  }],
});

async function setup() {
  const dir = tmp("h");
  const bins = tmp("bin");
  const copilot = new CopilotTurnAgent({ bin: fakeCopilot(bins), fallback: { agent: "author", model: "model-a" }, profileDirs: null, models: MODELS, timeoutMs: 30_000 });
  const claude = new ClaudeCodeTurnAgent({ bin: fakeClaude(bins), models: MODELS, fallback: { agent: "author", model: "model-a" }, profileDirs: [PROFILES], timeoutMs: 30_000 });
  const router = new TurnRouter(copilot, { claude });
  const control = await createWorkspace({ dir });
  const clock = new SimClock("2026-11-02T09:00:00Z");
  const h = new Harness({ control, engagement: "j", policy, clock, world: {}, agent: router, worktreeRoot: path.join(dir, "wt"), turnsDir: path.join(dir, "turns") });
  await h.open(def());
  return { h, clock, bins, router };
}

test("a judge's seat runs in Claude Code: read-only tools from the catalog, its role's profile, nothing of yours loaded", async () => {
  const { h, bins, router } = await setup();
  const s = await h.state();
  const weigh = s.todos.get("weigh")!;
  assert.equal(router.vendor({ todo: weigh, seat: { ...s.seats.get("G/synthesis")!, effective: [] } } as never), "claude");
  assert.equal(router.vendor({ todo: s.todos.get("build")!, seat: { ...s.seats.get("G/build")!, effective: [] } } as never), "copilot");

  const r = await h.tick({ id: "r1", capabilities: [] }, { slots: 2 });
  assert.deepEqual(r.turns.map((t) => [t.todo, t.result]).sort(), [["build", "completed"], ["weigh", "completed"]]);
  const call = JSON.parse(fs.readFileSync(path.join(bins, "call.json"), "utf8")) as { args: string[]; stdin: string };
  const a = call.args;
  const after = (flag: string) => a[a.indexOf(flag) + 1];
  assert.equal(after("--model"), "opus");
  assert.equal(after("--permission-mode"), "dontAsk", "anything not granted is refused, never asked about");
  assert.equal(after("--setting-sources"), "", "your settings files (which could allow more) aren't read");
  assert.ok(a.includes("--strict-mcp-config") && a.includes("--no-session-persistence"));
  const allowed = a.slice(a.indexOf("--allowedTools") + 1, a.indexOf("--disallowedTools"));
  const denied = a.slice(a.indexOf("--disallowedTools") + 1);
  assert.ok(!allowed.includes("Edit") && !allowed.includes("Write"), `a strategist can't write: ${allowed}`);
  assert.ok(denied.includes("Edit") && denied.includes("Bash(git push *)"));
  assert.match(after("--append-system-prompt"), /Every turn:/, "the role's profile, without its front matter");
  assert.ok(call.stdin.includes("Your todo weigh"), "the prompt comes on stdin");
  assert.ok(!a.some((x) => x.includes("Your todo")), "and not on the command line");
});

test("Claude's usage limit holds up only the seats on Claude; Copilot's builders keep working", async () => {
  const { h, clock, bins } = await setup();
  fs.writeFileSync(path.join(bins, "LIMIT"), "");
  const r = await h.tick({ id: "r1", capabilities: [] }, { slots: 2 });
  assert.deepEqual(r.turns.map((t) => [t.todo, t.result]).sort(), [["build", "completed"], ["weigh", "capacity"]]);
  let s = await h.state();
  const c = s.capacity.get("claude")!;
  assert.deepEqual([c.until, c.models], [Date.parse("2026-11-02T15:00:00Z"), ["model-b"]]);
  assert.equal(s.capacity.has("copilot"), false);
  assert.ok(blockers(s, s.todos.get("weigh")!, clock.now()).some((b) => b.startsWith("claude usage limit")));
  assert.equal(s.todos.get("weigh")!.failures, 0);
  assert.equal(r.hint.at <= c.until, true);
  // After the reset the judge runs.
  fs.rmSync(path.join(bins, "LIMIT"));
  clock.set(c.until + 1);
  const r2 = await h.tick({ id: "r1", capabilities: [] });
  assert.deepEqual(r2.turns.map((t) => [t.todo, t.result]), [["weigh", "completed"]]);
  s = await h.state();
  assert.equal(s.capacity.get("claude")!.streak, 0);
});

test("a seat routed to Claude with Claude Code not set up fails plainly, as a failure of the setup", async () => {
  const bins = tmp("nobin");
  const copilot = new CopilotTurnAgent({ bin: fakeCopilot(bins), fallback: { agent: "author", model: "model-a" }, profileDirs: null, models: MODELS, timeoutMs: 30_000 });
  const router = new TurnRouter(copilot);
  const ctx = { turn: "t", agent: "r", now: 0, packet: "p", todo: { id: "t", lane: "synthesis", text: "t" }, seat: { model: "model-b", role: "strategist", agent: "strategist", skills: [], effective: [] }, wtDir: bins } as never;
  await assert.rejects(router.run(ctx), (e: unknown) => !(e instanceof CapacityError) && /claude isn.t set up here/.test((e as Error).message));
});
