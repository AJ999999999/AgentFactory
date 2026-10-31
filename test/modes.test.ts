// Worker mode and session mode: one worker with the lane's skill instead of a role per
// lane, and a CLI session that carries across a todo's turns. Judges are left alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CopilotTurnAgent, turnPrompt } from "../src/harness/agents.ts";
import type { TurnAgent, TurnContext } from "../src/harness/agents.ts";
import { SessionMode, WorkerMode, roleSkill } from "../src/harness/modes.ts";
import { ClaudeCodeTurnAgent, CodexTurnAgent, PiTurnAgent } from "../src/harness/vendors.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const PROFILES = path.join(ROOT, "integrations", "copilot", "harness-agents");
const tmp = (n: string) => fs.mkdtempSync(path.join(os.tmpdir(), `af-modes-${n}-`));
// Codex turns read the provider from your own Codex config: never the real one in tests.
process.env.CODEX_HOME = tmp("codex-home");
const JUDGES = ["replan", "synthesis", "probation-review"];

function ctx(lane: string, todo = "t1", goal = "G", extra: Partial<TurnContext["seat"]> = {}): TurnContext {
  return {
    turn: `${todo}-1-x`, agent: "r1", now: 0, packet: `Your todo ${todo}`, wtDir: os.tmpdir(),
    todo: { id: todo, goal, lane, text: "t" },
    seat: { key: `${goal}/${lane}`, goal, lane, role: lane === "synthesis" ? "strategist" : "builder", agent: lane === "synthesis" ? "strategist" : "builder", template: "x@v1", model: "model-a", skills: ["orient"], permissions: [], pending: [], generated: false, effective: ["repo:read"], ...extra },
  } as never;
}

// An agent that records what it was handed.
function spy(): TurnAgent & { seen: TurnContext[] } {
  const seen: TurnContext[] = [];
  return { name: "spy", seen, run: async (c: TurnContext) => (seen.push(c), { done: true }) };
}

test("every role profile's front matter is YAML Copilot can read", () => {
  // Copilot refuses a profile whose front matter doesn't parse, and every turn of that
  // role then fails: an unquoted value with ": " in it was enough (af-data-engineer).
  for (const f of fs.readdirSync(PROFILES).filter((x) => x.endsWith(".agent.md"))) {
    const m = fs.readFileSync(path.join(PROFILES, f), "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    assert.ok(m, `${f}: no front matter`);
    for (const line of m![1].split(/\r?\n/).filter((l) => l.trim())) {
      const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
      assert.ok(kv, `${f}: not a key: value line: ${line}`);
      const v = kv![2];
      const quoted = /^".*"$/.test(v) || /^'.*'$/.test(v);
      assert.ok(quoted || !/: |#/.test(v), `${f}: ${kv![1]} needs quotes: ${v}`);
    }
    assert.match(m![1], /^name: af-[a-z-]+$/m, `${f}: name`);
  }
});

test("a role's skill is its profile without the rules every turn shares", () => {
  const s = roleSkill([PROFILES], "builder")!;
  assert.match(s, /^You build one bounded piece at a time\./);
  assert.ok(!s.includes("Every turn"), "the shared rules are the worker's own");
  assert.equal(roleSkill([PROFILES], "no-such-role"), undefined);
});

test("worker mode: seats that do the work run as the worker with their lane's skill; judges keep their roles", async () => {
  const inner = spy();
  const w = new WorkerMode(inner, { judgeLanes: JUDGES, skill: (r) => roleSkill([PROFILES], r) });
  await w.run(ctx("build"));
  const c = inner.seen[0];
  assert.equal(c.seat!.agent, "worker");
  assert.equal(c.seat!.role, "builder", "the role stays for the record");
  assert.deepEqual(c.seat!.effective, ["repo:read"], "the grant is still the lane's");
  assert.equal(c.skill!.name, "builder");
  assert.match(c.skill!.text, /You build one bounded piece/);
  const p = turnPrompt(c);
  assert.match(p, /You are this engagement's worker\. This todo is build work: use the builder skill\./);
  assert.ok(!p.includes("Your role:"));

  await w.run(ctx("synthesis"));
  assert.equal(inner.seen[1].seat!.agent, "strategist");
  assert.equal(inner.seen[1].skill, undefined);

  await w.run(ctx("murals", "t2", "G", { role: "gen-murals", agent: "author", generated: true, charter: "Paints murals." }));
  assert.deepEqual([inner.seen[2].seat!.agent, inner.seen[2].seat!.generated, inner.seen[2].skill], ["worker", false, { name: "murals", text: "Paints murals." }]);
});

test("session mode: one session per todo, resumed on its next turn and after a restart; judges start fresh", async () => {
  const dir = tmp("s");
  const inner = spy();
  const s = new SessionMode(inner, { scope: "todo", dir, salt: "eng-1", judgeLanes: JUDGES });
  await s.run(ctx("build", "t1"));
  await s.run(ctx("build", "t1"));
  await s.run(ctx("build", "t2"));
  await s.run(ctx("synthesis", "t3"));
  const [a, b, c, d] = inner.seen;
  assert.match(a.session!.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual([a.session!.turn, a.session!.resumed, b.session!.turn, b.session!.resumed], [1, false, 2, true]);
  assert.equal(a.session!.id, b.session!.id);
  assert.notEqual(c.session!.id, a.session!.id, "another todo, another session");
  assert.equal(d.session, undefined, "a judge looks with fresh eyes");
  assert.match(turnPrompt(b), /This continues your session on this todo \(turn 2\)/);
  assert.ok(!turnPrompt(a).includes("This continues"));

  // The loop starts a new process for each wake: the bookkeeping is on disk.
  const again = spy();
  await new SessionMode(again, { scope: "todo", dir, salt: "eng-1", judgeLanes: JUDGES }).run(ctx("build", "t1"));
  assert.deepEqual([again.seen[0].session!.id, again.seen[0].session!.turn, again.seen[0].session!.resumed], [a.session!.id, 3, true]);
  // Another engagement (or eval run) never shares a session id.
  assert.notEqual(new SessionMode(spy(), { scope: "todo", dir: tmp("o"), salt: "eng-2", judgeLanes: [] }).sessionId("G/t1"), a.session!.id);

  // Goal scope: every todo of the goal shares the worker's session.
  const g = spy();
  const gs = new SessionMode(g, { scope: "goal", dir: tmp("g"), salt: "eng-1", judgeLanes: JUDGES });
  await gs.run(ctx("research", "t1"));
  await gs.run(ctx("build", "t2"));
  assert.equal(g.seen[0].session!.id, g.seen[1].session!.id);
  assert.match(turnPrompt(g.seen[1]), /continues your session on this goal/);
});

function fake(dir: string, name: string, out: string): string {
  const f = path.join(dir, `${name}.js`);
  fs.writeFileSync(f, `const fs = require("node:fs");
let input = "";
const done = () => { fs.writeFileSync(${JSON.stringify(path.join(dir, `${name}.json`))}, JSON.stringify({ args: process.argv.slice(2), input })); ${out} };
process.stdin.on("data", (c) => (input += c)); process.stdin.on("end", done); process.stdin.on("error", done);
setTimeout(done, 3000);
`);
  return f;
}
const said = (dir: string, name: string) => JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), "utf8")) as { args: string[]; input: string };
const after = (a: string[], f: string) => a[a.indexOf(f) + 1];

test("the CLIs: Copilot and pi resume by session id as the worker; Claude Code starts fresh and says so", async () => {
  const dir = tmp("cli");
  const sessions = tmp("book");
  const models = { "model-a": "", "model-b": "claude:opus", "model-c": "pi:x/y" };
  const common = { fallback: { agent: "author", model: "model-a" }, timeoutMs: 30_000 };
  const copilotOut = `console.log(JSON.stringify({ type: "assistant.message", data: { content: '{"done": true}' } })); process.exit(0);`;
  const copilot = new CopilotTurnAgent({ ...common, bin: fake(dir, "copilot", copilotOut), profileDirs: [PROFILES], models });
  const agent = new WorkerMode(new SessionMode(copilot, { scope: "todo", dir: sessions, salt: "e", judgeLanes: JUDGES }), { judgeLanes: JUDGES, skill: (r) => roleSkill([PROFILES], r) });
  await agent.run(ctx("build"));
  await agent.run(ctx("build"));
  const c = said(dir, "copilot");
  assert.equal(after(c.args, "--agent"), "af-worker");
  assert.match(after(c.args, "--session-id"), /^[0-9a-f-]{36}$/);
  const prompt = after(c.args, "-p");
  assert.match(prompt, /use the builder skill/);
  assert.match(prompt, /This continues your session on this todo \(turn 2\)/);

  const piOut = `console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: '{"done": true}' }] } })); process.exit(0);`;
  const pi = new PiTurnAgent({ ...common, bin: fake(dir, "pi", piOut), models, profileDirs: [PROFILES] });
  await pi.run({ ...ctx("build"), seat: { ...ctx("build").seat!, model: "model-c" }, session: { id: "abc", scope: "todo", turn: 2, resumed: true, dir: sessions } } as never);
  const p = said(dir, "pi");
  assert.deepEqual([after(p.args, "--session-dir"), after(p.args, "--session-id")], [path.join(sessions, "pi"), "abc"]);
  assert.ok(!p.args.includes("--no-session"));

  const claudeOut = `console.log(JSON.stringify({ type: "result", subtype: "success", result: '{"done": true}' })); process.exit(0);`;
  const claude = new ClaudeCodeTurnAgent({ ...common, bin: fake(dir, "claude", claudeOut), models, profileDirs: [PROFILES] });
  const log: string[] = [];
  await claude.run({ ...ctx("build"), seat: { ...ctx("build").seat!, model: "model-b" }, log: (...l: string[]) => log.push(...l), session: { id: "abc", scope: "todo", turn: 2, resumed: true, dir: sessions } } as never);
  assert.ok(log.some((l) => l.includes("claude can't carry a session across worktrees")));
  assert.ok(!said(dir, "claude").input.includes("This continues your session"), "its prompt doesn't claim a session it hasn't got");
});

test("Codex: the first turn of a session is kept and its thread noted; later turns resume that thread in the new worktree", async () => {
  const dir = tmp("codex");
  const sessions = tmp("cbook");
  const out = `console.log(JSON.stringify({ type: "thread.started", thread_id: "th-123" })); console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: '{"done": true}' } })); process.exit(0);`;
  const models = { "model-a": "codex:" };
  const codex = new CodexTurnAgent({ fallback: { agent: "author", model: "model-a" }, timeoutMs: 30_000, bin: fake(dir, "codex", out), models, profileDirs: [PROFILES] });
  const agent = new WorkerMode(new SessionMode(codex, { scope: "todo", dir: sessions, salt: "e", judgeLanes: JUDGES }), { judgeLanes: JUDGES, skill: (r) => roleSkill([PROFILES], r) });
  const writer = { ...ctx("build"), seat: { ...ctx("build").seat!, effective: ["repo:read", "repo:write:lease"] } } as never;
  await agent.run(writer);
  let c = said(dir, "codex");
  assert.deepEqual([c.args[0], c.args[1]], ["exec", "--json"]);
  assert.ok(!c.args.includes("--ephemeral"), "a session's first turn is kept, to be resumed");
  assert.equal(after(c.args, "--sandbox"), "workspace-write");
  assert.ok(c.input.startsWith("Your role's standing instructions:"));
  assert.deepEqual(Object.values(JSON.parse(fs.readFileSync(path.join(sessions, "codex-threads.json"), "utf8"))), ["th-123"]);

  await agent.run(writer);
  c = said(dir, "codex");
  assert.deepEqual(c.args.slice(0, 2), ["exec", "resume"]);
  assert.equal(c.args.at(-2), "th-123");
  assert.ok(c.args.includes('sandbox_mode="workspace-write"') && !c.args.includes("--sandbox") && !c.args.includes("--cd"));
  assert.match(c.input, /This continues your session on this todo \(turn 2\)/);
  assert.ok(!c.input.startsWith("Your role's standing instructions:"), "a resumed session already has them");

  // A session whose first turn never got a thread from Codex starts again, and says so honestly.
  const log: string[] = [];
  await codex.run({ ...writer as object, log: (...l: string[]) => log.push(...l), session: { id: "never-started", scope: "todo", turn: 2, resumed: true, dir: sessions } } as never);
  c = said(dir, "codex");
  assert.equal(c.args[1], "--json");
  assert.ok(!c.input.includes("This continues your session"));
  assert.ok(log.some((l) => l.includes("turn 2, new")));
});
