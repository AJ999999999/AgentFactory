// What goes wrong in long runs: runners die, two machines wake at once, a turn
// outlives its claim, the whole thing restarts from a fresh clone, an agent does
// nothing useful, nobody answers. Real git, simulated clock.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cloneControl } from "../src/git.ts";
import { createWorkspace } from "../src/foundation/workspace.ts";
import { CopilotTurnAgent, ScriptedTurnAgent, parseTurnOutput } from "../src/harness/agents.ts";
import type { Behavior, TurnAgent } from "../src/harness/agents.ts";
import { Harness } from "../src/harness/harness.ts";
import { loadPolicy } from "../src/harness/project.ts";
import { Sim } from "../src/harness/sim.ts";
import { SimClock, SimJobs } from "../src/harness/world.ts";
import type { EngagementDef, TodoDraft } from "../src/harness/types.ts";

const policy = loadPolicy(path.join(import.meta.dirname, "..", "policy", "harness.json"));
const START = "2026-11-02T09:00:00Z";
const MIN = 60_000;
const tmp = (n: string) => fs.mkdtempSync(path.join(os.tmpdir(), `af-stress-${n}-`));

function def(todos: TodoDraft[], extra: Partial<EngagementDef["goals"][number]> = {}): EngagementDef {
  return {
    id: "s", title: "Stress", principals: { partner: "you" },
    goals: [{ id: "G", title: "G", objective: "o", owner: "partner", scope: ["work"], assumptions: [], budget: { turns: 50 }, todos, ...extra }],
  };
}

async function machines(n: number, d: EngagementDef, agent: TurnAgent, world = {}) {
  const dir = tmp("m");
  const first = await createWorkspace({ dir });
  const origin = path.join(dir, "origin.git");
  const clock = new SimClock(START);
  const out: Harness[] = [];
  for (let i = 0; i < n; i++) {
    const control = i === 0 ? first : cloneControl(origin, path.join(dir, `control-${i}`));
    out.push(new Harness({ control, engagement: d.id, policy, clock, world, agent, worktreeRoot: path.join(dir, `wt-${i}`) }));
  }
  await out[0].open(d);
  return { hs: out, clock, origin, dir };
}

const done = (name: string, f?: (c: Parameters<Behavior["run"]>[0]) => void): Behavior => ({ name, when: () => true, run: (c) => { f?.(c); return { done: true }; } });

test("a runner that dies mid-turn: its claim expires, the next tick records the failure and redoes the work", async () => {
  const agent = new ScriptedTurnAgent([done("ok")]);
  const { hs, clock } = await machines(1, def([{ id: "t", lane: "build", text: "t" }]), agent);
  const h = hs[0];
  // A runner claims the todo and dies without writing anything back.
  await h.claims.tryClaim("t", "dead", "t-1-dead", clock.now() + policy.claims.ttlMinutes * MIN);
  let r = await h.tick({ id: "r1", capabilities: [] });
  assert.equal(r.turns.length, 0, "a claimed todo isn't touched");
  assert.equal(r.hint.at, clock.now() + policy.claims.ttlMinutes * MIN + 1, "wake when the claim expires");
  clock.set(r.hint.at);
  r = await h.tick({ id: "r1", capabilities: [] });
  const s = await h.state();
  assert.deepEqual(s.turns.map((t) => [t.agent, t.result]), [["dead", "host_failure"], ["r1", "completed"]]);
  assert.equal(s.todos.get("t")!.status, "done");
});

test("repeated failures stop retrying and ask; a retry from the owner starts the count again", async () => {
  let calls = 0;
  const agent: TurnAgent = { name: "flaky", run: async () => { calls++; throw new Error("model timeout"); } };
  const { hs, clock } = await machines(1, def([{ id: "t", lane: "build", text: "t" }]), agent);
  const h = hs[0];
  for (let i = 0; i < 5; i++) {
    await h.tick({ id: "r1", capabilities: [] });
    clock.advance(5);
  }
  let s = await h.state();
  assert.equal(calls, 3, "three failures, then it stopped");
  assert.equal(s.todos.get("t")!.status, "blocked");
  const ask = [...s.asks.values()].find((a) => a.origin === "rule:failures")!;
  await h.answer(ask.id, { by: "partner", choice: "retry" });
  await h.tick({ id: "r1", capabilities: [] });
  s = await h.state();
  assert.equal(calls, 4);
  assert.equal(s.todos.get("t")!.failures, 1);
});

test("two machines wake at the same moment: each todo is done once and each job is launched once", async () => {
  const seen: string[] = [];
  const agent = new ScriptedTurnAgent([done("ok", (c) => seen.push(c.todo.id))]);
  const jobs = new SimJobs(() => ({ minutes: 30, metrics: { x: 1 } }));
  const todos: TodoDraft[] = [
    ...["a", "b", "c", "d"].map((id) => ({ id, lane: "build", text: id })),
    { id: "j", kind: "job", lane: "job", text: "j", job: { spec: {} } },
    { id: "m", kind: "wait", lane: "m", text: "paid test", cost: { usd: 50 }, wait: { source: "none" } },
  ];
  const { hs } = await machines(2, def(todos), agent, { jobs });
  const [a, b] = hs;
  for (let round = 0; round < 3; round++) await Promise.all([a.tick({ id: "A", capabilities: [] }, { slots: 2 }), b.tick({ id: "B", capabilities: [] }, { slots: 2 })]);
  const s = await a.state();
  assert.deepEqual([...seen].sort(), ["a", "b", "c", "d"], "every todo exactly once");
  assert.equal(s.turns.length, 4);
  assert.deepEqual(jobs.started, ["j"], "the job was launched once");
  assert.equal([...s.asks.values()].filter((x) => x.origin === "rule:money").length, 1, "both machines noticed the same thing; it was asked once");
});

test("a turn that outlives its claim is thrown away; whoever took over keeps their work", async () => {
  let clock!: SimClock;
  let other!: Harness;
  const agent: TurnAgent = {
    name: "slow",
    run: async (c) => {
      if (c.agent === "A") {
        clock.advance(policy.claims.ttlMinutes + 5);
        await other.tick({ id: "B", capabilities: [] });
        return { done: true, note: "A's late answer" };
      }
      return { done: true, note: "B's answer" };
    },
  };
  const m = await machines(2, def([{ id: "t", lane: "build", text: "t" }]), agent);
  clock = m.clock;
  other = m.hs[1];
  await m.hs[0].tick({ id: "A", capabilities: [] });
  const s = await m.hs[0].state();
  // A's turn is recorded once (B's reap and A's late writeback name the same turn), and only B's work counts.
  assert.deepEqual(s.turns.map((t) => [t.agent, t.result]).sort(), [["A", "claim_lost"], ["B", "completed"]]);
  assert.deepEqual(s.goals.get("G")!.notes.map((n) => n.text), ["B's answer"]);
});

test("a scheduler that starts a fresh process every few minutes: an unchanged engagement costs one ls-remote", async () => {
  const agent = new ScriptedTurnAgent([done("ok")]);
  const { hs, clock, dir } = await machines(1, def([{ id: "a", lane: "build", text: "a", notBefore: "2026-11-03T09:00:00Z" }]), agent);
  const r1 = await hs[0].tick({ id: "laptop", capabilities: [] });
  assert.ok(!r1.quiet);
  // A new process: same repo, nothing in memory but what was saved to disk.
  const saved = JSON.parse(JSON.stringify(hs[0].memory("laptop")));
  const fresh = new Harness({ control: hs[0].control, engagement: "s", policy, clock, world: {}, agent, worktreeRoot: path.join(dir, "wt-fresh") });
  fresh.remember("laptop", saved);
  const calls: string[][] = [];
  const run = fresh.control.runAsync.bind(fresh.control);
  fresh.control.runAsync = (args: string[]) => { calls.push(args); return run(args); };
  clock.advance(10);
  const r2 = await fresh.tick({ id: "laptop", capabilities: [] });
  assert.ok(r2.quiet, "nothing changed and no timer is due");
  assert.deepEqual(calls.map((c) => c[0]), ["ls-remote"]);
  clock.set(Date.parse("2026-11-03T09:00:00Z"));
  const r3 = await fresh.tick({ id: "laptop", capabilities: [] });
  assert.equal(r3.turns[0]?.todo, "a", "and it wakes for real when the timer is due");
});

test("restart anywhere: a fresh clone projects exactly the same state and carries on", async () => {
  const agent = new ScriptedTurnAgent([done("ok")]);
  const d = def([{ id: "a", lane: "build", text: "a" }, { id: "b", lane: "build", text: "b", after: ["a"] }, { id: "c", lane: "build", text: "c", after: ["b"] }]);
  const { hs, clock, origin, dir } = await machines(1, d, agent);
  await hs[0].tick({ id: "r1", capabilities: [] });
  const before = await hs[0].state();
  const fresh = new Harness({ control: cloneControl(origin, path.join(dir, "fresh")), engagement: "s", policy, clock, world: {}, agent, worktreeRoot: path.join(dir, "wt-fresh") });
  const after = await fresh.state();
  const view = (st: typeof before) => JSON.stringify({ todos: [...st.todos.values()].map((t) => [t.id, t.status, t.turns]), turns: st.turns.map((t) => [t.todo, t.result]), goals: [...st.goals.values()].map((g) => [g.id, g.version, g.spent]) });
  assert.equal(view(after), view(before));
  await fresh.tick({ id: "r2", capabilities: [] });
  assert.equal((await fresh.state()).todos.get("b")!.status, "done", "picked up where the old runner left off");
});

test("an agent that produces nothing: replan, then the goal stops and asks the owner; no more turns are spent", async () => {
  const agent = new ScriptedTurnAgent([{ name: "nothing", when: () => true, run: () => ({ note: "thinking about it" }) }]);
  const sim = await Sim.create({ dir: tmp("idle"), def: def([{ id: "a", lane: "build", text: "a" }, { id: "b", lane: "build", text: "b" }]), policy, start: START, world: {}, agent, runners: [{ runner: { id: "r1", capabilities: [] } }], people: [] });
  await sim.run({ until: "2026-12-31T00:00:00Z" });
  const s = await sim.harness.state();
  const stuck = [...s.asks.values()].find((a) => a.origin === "rule:spin")!;
  assert.ok(stuck && stuck.blocksGoal && stuck.status === "open");
  assert.equal(s.turns.length, 4, "three thin turns, one thin replan, then nothing until someone looks");
  assert.equal(sim.log.at(-1)!.detail, "only people can move things now");
});

test("Copilot CLI runner: a real process in the worktree, its edits validated, its JSON parsed", async () => {
  const dir = tmp("copilot");
  // A .js entry runs through node on every platform (on Windows, npm's .cmd shim is
  // resolved to its entry the same way; see test/windows.test.ts).
  const fake = path.join(dir, "copilot.js");
  fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.mkdirSync("work", { recursive: true });
fs.writeFileSync("work/out.md", "written by the fake CLI\\n");
fs.writeFileSync("work/args.json", JSON.stringify(args));
console.log("I did the thing. Note the braces {like these} in prose.");
console.log(JSON.stringify({ done: true, note: "used {braces} in a string", findings: [{ direction: "neutral", grade: "opinion", source: "", text: "ok" }] }));
`);
  fs.chmodSync(fake, 0o755);
  const agent = new CopilotTurnAgent({ bin: fake, fallback: { agent: "author", model: "model-a" }, lanes: { review: { agent: "reviewer", model: "model-b" } }, timeoutMs: 30_000 });
  const { hs } = await machines(1, def([{ id: "t", lane: "x", text: "t", writeScope: ["work"] }]), agent);
  const r = await hs[0].tick({ id: "r1", capabilities: [] });
  assert.equal(r.turns[0].result, "completed");
  const args = JSON.parse(hs[0].control.run(["show", "origin/main:work/args.json"]));
  for (const flag of ["--agent", "author", "--model", "model-a", "--no-ask-user", "shell(git push)"]) assert.ok(args.includes(flag), flag);
  assert.ok(args[args.indexOf("-p") + 1].includes("Your todo t"), "the prompt carries the handoff packet");
  assert.deepEqual(parseTurnOutput('text {"a": "}"} more {"done": true, "note": "{x}"}'), { done: true, note: "{x}" });
});
