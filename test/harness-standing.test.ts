// Standing answers ("from now on"): the next question of the same shape is settled with
// the person's earlier choice, as the harness's own act, and never where the call must
// stay theirs.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { apply, loadPolicy, project, type State } from "../src/harness/project.ts";
import { answerEvents } from "../src/harness/answers.ts";
import { settle } from "../src/harness/rules.ts";
import { standingFor } from "../src/harness/standing.ts";
import { escalationReport } from "../src/harness/escalation.ts";
import { criteriaHash } from "../src/harness/validate.ts";
import type { Ask, GoalDef, HEvent } from "../src/harness/types.ts";

const policy = { ...loadPolicy(path.join(import.meta.dirname, "..", "policy", "harness.json")), team: undefined };
const T0 = Date.parse("2026-11-02T09:00:00Z");
const DAY = 86_400_000;

const engagement: HEvent = { id: "open", at: T0, by: "partner", type: "engagement_opened", engagement: { id: "e", title: "E", principals: { partner: "you" } } };
const goal = (id: string): HEvent => {
  const g: GoalDef = { id, title: id, objective: "o", owner: "partner", scope: ["work"], assumptions: [], budget: { turns: 100 } };
  return { id: `goal-${id}`, at: T0, by: "partner", type: "goal_opened", goal: g, criteriaHash: criteriaHash(g) };
};
const todo = (g: string, id: string, lane: string): HEvent => ({ id: `add-${id}`, at: T0, by: "partner", type: "todo_added", todo: { id, goal: g, lane, kind: "task", text: id }, provenance: "seed" });
// The question the failures rule asks, about one todo.
const failAsk = (g: string, id: string, t: string, at: number, origin = "rule:failures"): HEvent => {
  const ask: Ask = {
    id, goal: g, to: "partner", kind: "decision", todo: t, origin, question: `"${t}" failed 3 times in a row. Retry, or drop it?`,
    options: [{ id: "retry", label: "Retry", effect: { type: "retry", todo: t } }, { id: "drop", label: "Drop it", effect: { type: "supersede", todos: [t] } }],
  };
  return { id, at, by: "harness", type: "ask_opened", ask };
};
const run = (s: State, events: HEvent[], now: number) => {
  for (const e of events) apply(s, e);
  const follow = settle(s, now);
  return [...events, ...follow];
};

test("an answer given 'from now on' settles the next question of its shape in that goal, as the harness's act pointing at the answer", () => {
  const s = project([engagement, goal("G"), todo("G", "t1", "build"), todo("G", "t2", "build"), failAsk("G", "ask-1", "t1", T0 + 1)], policy);
  run(s, answerEvents(s, "ask-1", { by: "partner", choice: "retry", standing: true }, T0 + 2), T0 + 2);
  assert.equal(s.standing.size, 1);

  const log = run(s, [failAsk("G", "ask-2", "t2", T0 + DAY)], T0 + DAY);
  const a2 = s.asks.get("ask-2")!;
  assert.equal(a2.status, "auto_closed", "settled without reaching you");
  assert.equal(a2.autoReason, "standing");
  assert.equal(a2.precedentAsk, "ask-1", "points at the answer it repeats");
  assert.equal(a2.choice, "retry");
  assert.ok(log.some((e) => e.type === "todo_reopened" && e.todo === "t2" && e.by === "harness"), "the choice's effect applied, as the harness's act");
  assert.ok(s.autonomous.some((x) => x.type === "ask_auto_closed" && x.goal === "G"), "the daily spot check can draw it");
  assert.ok(!log.some((e) => e.type === "ask_answered" && e.ask === "ask-2"), "never recorded as a fresh answer from you");

  // Settling twice writes once.
  assert.deepEqual(settle(s, T0 + DAY + 1), []);
});

test("a standing answer stays inside its goal and its lane", () => {
  const s = project([engagement, goal("G"), goal("H"), todo("G", "t1", "build"), todo("G", "r1", "research"), todo("H", "h1", "build"), failAsk("G", "ask-1", "t1", T0 + 1)], policy);
  run(s, answerEvents(s, "ask-1", { by: "partner", choice: "retry", standing: true }, T0 + 2), T0 + 2);
  run(s, [failAsk("G", "ask-r", "r1", T0 + 3), failAsk("H", "ask-h", "h1", T0 + 3)], T0 + 3);
  assert.equal(s.asks.get("ask-r")!.status, "open", "another lane is another kind of question");
  assert.equal(s.asks.get("ask-h")!.status, "open", "another goal is another decision");
});

test("must-ask questions, options that can't be undone, and agents' own questions can't be answered 'from now on'", () => {
  const s = project([engagement, goal("G"), todo("G", "t1", "build"), failAsk("G", "ask-1", "t1", T0 + 1), failAsk("G", "ask-cap", "t1", T0 + 1, "rule:turn_cap"), failAsk("G", "ask-agent", "t1", T0 + 1, "turn:x")], policy);
  assert.throws(() => answerEvents(s, "ask-1", { by: "partner", choice: "drop", standing: true }, T0 + 2), /can't be undone/);
  assert.throws(() => answerEvents(s, "ask-cap", { by: "partner", choice: "retry", standing: true }, T0 + 2), /must-ask/, "the turn cap is the brake on a standing retry");
  assert.throws(() => answerEvents(s, "ask-agent", { by: "partner", choice: "retry", standing: true }, T0 + 2), /only the harness's own questions/);
  assert.doesNotThrow(() => answerEvents(s, "ask-1", { by: "partner", choice: "retry" }, T0 + 2), "without 'from now on' you can answer anything");
});

test("a standing answer ends with the goal's direction, after its days, or when you take it back", () => {
  const base = [engagement, goal("G"), todo("G", "t1", "build"), todo("G", "t2", "build"), failAsk("G", "ask-1", "t1", T0 + 1)];
  const fresh = () => {
    const s = project(base, policy);
    run(s, answerEvents(s, "ask-1", { by: "partner", choice: "retry", standing: true }, T0 + 2), T0 + 2);
    apply(s, failAsk("G", "ask-2", "t2", T0 + 3));
    return s;
  };
  let s = fresh();
  assert.ok(standingFor(s, s.asks.get("ask-2")!, T0 + 3), "covers it while it holds");
  assert.equal(standingFor(s, s.asks.get("ask-2")!, T0 + 31 * DAY), undefined, "30 days by default");
  s.goals.get("G")!.version++;
  assert.equal(standingFor(s, s.asks.get("ask-2")!, T0 + 3), undefined, "a new direction for the goal ends it");
  s = fresh();
  apply(s, { id: "unstand", at: T0 + 3, by: "partner", type: "standing_revoked", goal: "G", shape: "rule:failures|build" });
  assert.equal(standingFor(s, s.asks.get("ask-2")!, T0 + 3), undefined);
});

test("questions a standing answer settled aren't counted as yours in the escalation numbers", () => {
  const s = project([engagement, goal("G"), todo("G", "t1", "build"), todo("G", "t2", "build"), failAsk("G", "ask-1", "t1", T0 + 1)], policy);
  const log: HEvent[] = [engagement, goal("G"), todo("G", "t1", "build"), todo("G", "t2", "build"), failAsk("G", "ask-1", "t1", T0 + 1)];
  log.push(...run(s, answerEvents(s, "ask-1", { by: "partner", choice: "retry", standing: true }, T0 + 2), T0 + 2));
  log.push(...run(s, [failAsk("G", "ask-2", "t2", T0 + DAY)], T0 + DAY));
  const r = escalationReport(log, policy);
  const failures = r.byOrigin.find((o) => o.origin === "rule:failures");
  assert.equal(failures?.opened, 1, "only the question you answered yourself");
  assert.equal(r.autoClosed, 1, "the one the standing answer settled is counted as the harness's");
});
