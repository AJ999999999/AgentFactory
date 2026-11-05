// The conductor (docs/conductor.md): a strong model reads finished work before it counts,
// and sends it back with directions when it went the wrong way.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { apply, loadPolicy, project } from "../src/harness/project.ts";
import type { HarnessPolicy, State } from "../src/harness/project.ts";
import { settle } from "../src/harness/rules.ts";
import { checkLibrary } from "../src/harness/team.ts";
import { validateTurn } from "../src/harness/validate.ts";
import type { TurnOutput } from "../src/harness/validate.ts";
import { buildPacket } from "../src/harness/packet.ts";
import { ScriptedTurnAgent, turnPrompt } from "../src/harness/agents.ts";
import type { Behavior } from "../src/harness/agents.ts";
import { Sim } from "../src/harness/sim.ts";
import { conductorReport } from "../src/harness/escalation.ts";
import { criteriaHash } from "../src/harness/validate.ts";
import type { EngagementDef, GoalDef, HEvent, TodoDraft } from "../src/harness/types.ts";

const teamPolicy = loadPolicy(path.join(import.meta.dirname, "..", "policy", "harness.json"));
const off: HarnessPolicy = { ...teamPolicy, team: undefined, conductor: undefined };
const on: HarnessPolicy = { ...off, conductor: { maxRedirects: 1 } };
const T0 = Date.parse("2026-11-04T09:00:00Z");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "af-conductor-"));
let seq = 0;

const engagement: HEvent = { id: "open", at: T0, by: "partner", type: "engagement_opened", engagement: { id: "e", title: "E", principals: { partner: "you" } } };
const goal = (): HEvent => {
  const g: GoalDef = { id: "G", title: "G", objective: "multi-currency totals", owner: "partner", scope: ["work"], assumptions: [], budget: { turns: 100 } };
  return { id: "goal-G", at: T0, by: "partner", type: "goal_opened", goal: g, criteriaHash: criteriaHash(g) };
};
const todo = (d: TodoDraft & { id: string }): HEvent => ({ id: `add-${d.id}`, at: T0, by: "partner", type: "todo_added", todo: { ...d, goal: "G" }, provenance: "seed" });
const st = (policy: HarnessPolicy, ...events: HEvent[]): State => project([engagement, goal(), ...events], policy);

// Validate a turn of a todo and fold its events in, as the harness would.
function finish(s: State, todoId: string, output: TurnOutput, files: string[] = [], checked = false): HEvent[] {
  const turn = `turn-${++seq}`;
  const v = validateTurn({ s, todo: s.todos.get(todoId)!, agent: "r1", turn, now: T0 + seq * 1000, why: "test", output, files, checkFailures: [], checked, wtDir: tmp, knownSources: [] });
  for (const e of v.events) apply(s, e);
  return v.events;
}
const conductTodo = (s: State, target: string) => [...s.todos.values()].find((t) => t.conducts === target);

test("with the conductor on, a finished todo waits in review until the conductor accepts it", () => {
  const s = st(on, todo({ id: "b", lane: "build", text: "add multi-currency totals", writeScope: ["work"] }));
  finish(s, "b", { done: true, note: "added EUR" }, ["work/money.ts"]);
  assert.equal(s.todos.get("b")!.status, "review", "work that depends on it waits");
  const c = conductTodo(s, "b")!;
  assert.equal(c.lane, "conduct");
  assert.match(c.text, /work\/money\.ts/);
  assert.match(c.text, /added EUR/, "the conductor sees the worker's note");
  finish(s, c.id, { done: true, verdict: "accept" });
  assert.equal(s.todos.get("b")!.status, "done");
  assert.equal(s.todos.get(c.id)!.status, "done");
  assert.deepEqual(s.conducted.map((x) => x.verdict), ["accept"]);
});

test("a send-back reopens the todo, and its next turn's packet carries the conductor's directions", () => {
  const s = st(on, todo({ id: "b", lane: "build", text: "add multi-currency totals", writeScope: ["work"] }));
  finish(s, "b", { done: true }, ["work/money.ts"]);
  const c = conductTodo(s, "b")!;
  finish(s, c.id, { done: true, verdict: "reject", note: "Totals ignore GBP: convert in work/report.ts too." });
  const b = s.todos.get("b")!;
  assert.equal(b.status, "open");
  assert.equal(b.redirects, 1);
  assert.match(buildPacket(s, b, "test"), /Sent back: the conductor sent it back: Totals ignore GBP: convert in work\/report\.ts too\./);
  // The next turn has read it: the line doesn't follow the todo forever.
  finish(s, "b", { done: false }, ["work/report.ts"]);
  assert.doesNotMatch(buildPacket(s, s.todos.get("b")!, "test"), /Sent back/);
});

test("after maxRedirects send-backs, the todo's next finish counts without the conductor", () => {
  const s = st(on, todo({ id: "b", lane: "build", text: "t", writeScope: ["work"] }));
  finish(s, "b", { done: true }, ["work/a.ts"]);
  finish(s, conductTodo(s, "b")!.id, { done: true, verdict: "reject", note: "Change work/a.ts to handle zero." });
  finish(s, "b", { done: true }, ["work/a.ts"]);
  assert.equal(s.todos.get("b")!.status, "done");
  assert.equal([...s.todos.values()].filter((t) => t.conducts === "b").length, 1, "no second read");
});

test("a send-back without directions isn't a verdict: the work keeps waiting", () => {
  const s = st(on, todo({ id: "b", lane: "build", text: "t", writeScope: ["work"] }));
  finish(s, "b", { done: true }, ["work/a.ts"]);
  const c = conductTodo(s, "b")!;
  const ev = finish(s, c.id, { done: true, verdict: "reject" });
  const rec = (ev.find((e) => e.type === "turn") as Extract<HEvent, { type: "turn" }>).turn;
  assert.ok(rec.reasons.some((r) => /directions/.test(r)));
  assert.equal(s.todos.get("b")!.status, "review");
  assert.equal(s.todos.get(c.id)!.status, "open");
});

test("without the policy, judge lanes, and with skipChecked a passing checker: no conductor", () => {
  let s = st(off, todo({ id: "b", lane: "build", text: "t", writeScope: ["work"] }));
  finish(s, "b", { done: true }, ["work/a.ts"]);
  assert.equal(s.todos.get("b")!.status, "done", "off by default");

  s = st({ ...on, team: teamPolicy.team }, todo({ id: "r", lane: "replan", text: "replan" }));
  finish(s, "r", { done: true });
  assert.equal(s.todos.get("r")!.status, "done", "judges aren't judged by the conductor");

  s = st({ ...on, conductor: { skipChecked: true } }, todo({ id: "b", lane: "build", text: "t", writeScope: ["work"], check: "unit" }));
  finish(s, "b", { done: true }, ["work/a.ts"], true);
  assert.equal(s.todos.get("b")!.status, "done");

  s = st({ ...on, conductor: { lanes: ["research"] } }, todo({ id: "b", lane: "build", text: "t", writeScope: ["work"] }));
  finish(s, "b", { done: true }, ["work/a.ts"]);
  assert.equal(s.todos.get("b")!.status, "done", "only the lanes it's given");
});

test("a dropped conductor todo lets its work count, unlike a dropped probation review", () => {
  const s = st(on, todo({ id: "b", lane: "build", text: "t", writeScope: ["work"] }));
  finish(s, "b", { done: true }, ["work/a.ts"]);
  const c = conductTodo(s, "b")!;
  apply(s, { id: "drop-c", at: T0 + 50_000, by: "partner", type: "todo_superseded", todo: c.id, reason: "dropped by partner" });
  for (const e of settle(s, T0 + 60_000)) apply(s, e);
  assert.equal(s.todos.get("b")!.status, "done");
});

test("the conductor's verdicts never move a seat's probation record", () => {
  const s = st({ ...on, team: teamPolicy.team }, todo({ id: "b", lane: "build", text: "t", writeScope: ["work"] }));
  for (const e of settle(s, T0 + 1)) apply(s, e);
  finish(s, "b", { done: true }, ["work/a.ts"]);
  finish(s, conductTodo(s, "b")!.id, { done: true, verdict: "reject", note: "Handle zero in work/a.ts." });
  const seat = s.seats.get("G/build")!;
  assert.equal(seat.rejected, 0);
  assert.equal(seat.rejectStreak, 0);
});

test("checkLibrary refuses a conductor on the same model as the work it reads", () => {
  const lib = structuredClone(teamPolicy.team!.library);
  assert.deepEqual(checkLibrary(lib, teamPolicy.team!.catalog), []);
  lib.roles.conductor.model = lib.roles.builder.model;
  assert.ok(checkLibrary(lib, teamPolicy.team!.catalog).some((v) => v.startsWith("judge lane conduct")));
});

test("the conductor's prompt asks for a verdict, and for directions when it sends work back", () => {
  const s = st(on, todo({ id: "b", lane: "build", text: "t", writeScope: ["work"] }));
  finish(s, "b", { done: true }, ["work/a.ts"]);
  const c = conductTodo(s, "b")!;
  const prompt = turnPrompt({ turn: "x", agent: "r1", now: T0, packet: buildPacket(s, c, "test"), todo: c, goal: s.goals.get("G")!.def, beliefs: [], findings: [], wtDir: tmp, state: s } as Parameters<typeof turnPrompt>[0]);
  assert.match(prompt, /You are the conductor: include "verdict"/);
});

test("conductorReport counts the finished todos read and sent back, by lane, with the latest reasons", () => {
  const v = (todo: string, lane: string, verdict: "accept" | "reject", at: number, note?: string): HEvent => ({ id: `v-${at}`, at, by: "r1", type: "conduct_verdict", todo, conduct: `c-${todo}`, lane, verdict, ...(note ? { note } : {}) });
  const r = conductorReport([v("a", "build", "reject", 1, "missing GBP"), v("b", "build", "accept", 2), v("c", "research", "accept", 3), v("d", "build", "reject", 4, "wrong file")]);
  assert.equal(r.read, 4);
  assert.equal(r.sentBack, 2);
  assert.deepEqual(r.byLane, [{ lane: "build", read: 3, sentBack: 2 }, { lane: "research", read: 1, sentBack: 0 }]);
  assert.deepEqual(r.recent.map((x) => x.note), ["wrong file", "missing GBP"]);
});

// ---------- through real git and real ticks ----------

test("end to end: the conductor reads the merged work in its checkout, sends it back, and the retry hears why", async () => {
  const write = (dir: string, rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  const prompts: string[] = [];
  const conductorSaw: string[] = [];
  const behaviors: Behavior[] = [
    {
      name: "conductor", when: (c) => c.todo.lane === "conduct",
      run: (c) => {
        const code = fs.readFileSync(path.join(c.wtDir, "app", "money.ts"), "utf8");
        conductorSaw.push(code);
        return code.includes("GBP") ? { done: true, verdict: "accept" } : { done: true, verdict: "reject", note: "Totals ignore GBP: add it to app/money.ts." };
      },
    },
    {
      name: "builder", when: (c) => c.todo.id === "money",
      run: (c) => {
        prompts.push(c.packet);
        write(c.wtDir, "app/money.ts", prompts.length === 1 ? "export const CURRENCIES = ['EUR'];\n" : "export const CURRENCIES = ['EUR', 'GBP'];\n");
        return { done: true };
      },
    },
    { name: "after", when: (c) => c.todo.id === "report", run: () => ({ done: true }) },
  ];
  const agent = new ScriptedTurnAgent(behaviors);
  const def: EngagementDef = {
    id: "cnd", title: "Conductor", principals: { partner: "you" },
    goals: [{
      id: "G", title: "Money", objective: "Totals in EUR and GBP", owner: "partner", scope: ["app"], assumptions: [], budget: { turns: 20 },
      todos: [
        { id: "money", lane: "build", text: "Support EUR and GBP in app/money.ts", writeScope: ["app"] },
        { id: "report", lane: "build", text: "Show totals by currency", writeScope: ["app"], after: ["money"] },
      ],
    }],
  };
  const sim = await Sim.create({
    dir: fs.mkdtempSync(path.join(os.tmpdir(), "af-cnd-")), def, policy: { ...teamPolicy, conductor: { maxRedirects: 1 } }, start: "2026-11-04T09:00:00Z",
    agent, runners: [{ runner: { id: "r1", capabilities: ["shell"] } }], people: [], world: {},
  });
  await sim.run({ until: "2026-11-06T00:00:00Z" });
  const s = await sim.harness.state();
  const order = agent.calls.map((c) => c.lane === "conduct" ? "conduct" : c.todo);
  // One send-back by default: the retry's finish counts without a second read.
  assert.deepEqual(order, ["money", "conduct", "money", "report", "conduct"], "the dependent todo waits while the conductor reads");
  assert.ok(conductorSaw[0].includes("EUR") && !conductorSaw[0].includes("GBP"), "it read the merged work");
  assert.match(prompts[1], /Sent back: the conductor sent it back: Totals ignore GBP/);
  assert.equal(s.todos.get("money")!.status, "done");
  assert.equal(s.todos.get("report")!.status, "done");
  assert.deepEqual(s.conducted.map((x) => `${x.todo}:${x.verdict}`), ["money:reject", "report:accept"]);
});
