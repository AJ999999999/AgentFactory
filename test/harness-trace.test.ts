// One record to look back through: from anything in the log, back to why it happened and
// forward to what it led to.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { apply, loadPolicy, project } from "../src/harness/project.ts";
import { answerEvents } from "../src/harness/answers.ts";
import { settle } from "../src/harness/rules.ts";
import { receiveEvent } from "../src/harness/events.ts";
import { buildGraph, resolve, traceText } from "../src/harness/trace.ts";
import { criteriaHash } from "../src/harness/validate.ts";
import type { GoalDef, HEvent } from "../src/harness/types.ts";

const policy = { ...loadPolicy(path.join(import.meta.dirname, "..", "policy", "harness.json")), team: undefined };
const T0 = Date.parse("2026-11-04T09:00:00Z");

// A Jira bug becomes work, its turns fail three times, you answer "retry, from now on",
// the next turn finds a measurement.
function story(): HEvent[] {
  const log: HEvent[] = [];
  const g: GoalDef = { id: "G", title: "Keep payments working", objective: "o", owner: "partner", scope: ["work"], assumptions: [{ id: "A", text: "Rounding per line is the cause", category: "feasibility", risk: 3, uncertainty: 3 }], budget: { turns: 50 }, perpetual: true };
  const s = project([], policy);
  const push = (...es: HEvent[]) => { for (const e of es) { apply(s, e); log.push(e); } log.push(...settle(s, log.at(-1)!.at)); };
  push(
    { id: "open", at: T0, by: "partner", type: "engagement_opened", engagement: { id: "e", title: "E", principals: { partner: "you" }, events: { sources: [{ id: "jira-pay", kind: "jira", url: "https://jira.example.com", jql: "project = PAY", tokenEnv: "T" }], rules: [{ id: "pay-bugs", match: { source: "jira-pay" }, goal: "G", lane: "fix" }] } } },
    { id: "goal-G", at: T0, by: "partner", type: "goal_opened", goal: g, criteriaHash: criteriaHash(g) },
  );
  push(...receiveEvent(s, { source: "jira-pay", id: "PAY-7", type: "bug", updated: "2026-11-04T08:00:00.000+0000", title: "Totals off by a cent", url: "https://jira.example.com/browse/PAY-7" }, T0 + 1));
  const todo = [...s.todos.values()][0].id;
  for (let i = 1; i <= 3; i++) push({ id: `turn-t${i}`, at: T0 + i * 1000, by: "r1", type: "turn", turn: { id: `t${i}`, todo, goal: "G", agent: "r1", result: "validation_failed", granularity: "none", reasons: ["tests fail"], files: [] } });
  const ask = [...s.asks.values()].find((a) => a.origin === "rule:failures")!;
  push(...answerEvents(s, ask.id, { by: "partner", choice: "retry", standing: true, note: "flaky" }, T0 + 5000));
  push({ id: "turn-t4", at: T0 + 6000, by: "r1", type: "turn", turn: { id: "t4", todo, goal: "G", agent: "r1", result: "completed", granularity: "substantive", reasons: [], files: ["work/fix.ts"] } });
  push({ id: "f1", at: T0 + 6001, by: "r1", type: "finding", finding: { id: "f1", goal: "G", assumption: "A", direction: "supports", grade: "reported", source: "repo:work/fix.ts", author: "r1", text: "per-line rounding reproduced", turn: "t4", todo } });
  return log;
}

test("from a finding back to the Jira ticket: the turn that found it, its work, and the event that work came from", () => {
  const g = buildGraph(story(), { turnsDir: "/x/turns" });
  const text = traceText(g, "f1");
  assert.match(text, /^reported evidence for A: per-line rounding reproduced/);
  assert.match(text, /← found in: turn by r1: completed, wrote work\/fix\.ts/);
  assert.ok(text.includes(path.join("/x/turns", "t4.log")), "points at the turn's log, in this system's own path form");
  assert.match(text, /← on: task in fix: bug PAY-7: Totals off by a cent/);
  assert.match(text, /← came from: jira-pay: bug PAY-7 "Totals off by a cent", routed by pay-bugs .*https:\/\/jira\.example\.com\/browse\/PAY-7/);
});

test("from a question forward: your answer and what it changed; and back to the work it was about and the ticket behind it", () => {
  const log = story();
  const g = buildGraph(log);
  const ask = log.find((e) => e.type === "ask_opened")!.id;
  const text = traceText(g, ask);
  assert.match(text, /question for partner: .*failed 3 times.*\(the failures rule\)/);
  assert.match(text, /why:\n {2}← about: goal "Keep payments working" opened/);
  assert.match(text, /→ answers: partner answered .*: retry \(from now on\), "flaky"/);
  assert.match(text, /→ the answer to: todo .* reopened/, "the effect is tied to the answer that caused it");
  assert.match(text, /← came from: jira-pay: bug PAY-7/);
});

test("an id is found whatever kind it is, and an unknown one says so", () => {
  const g = buildGraph(story());
  assert.equal(resolve(g, "G"), "goal:G");
  assert.equal(resolve(g, "t2"), "turn:t2");
  assert.equal(resolve(g, "todo:nope"), undefined);
  assert.equal(traceText(g, "nope"), "nothing in the log is called nope");
});

test("a workstream traces back to the answer that approved its spawn, though its events come from the spawn", () => {
  const child: GoalDef = { id: "renderer", title: "Renderer", objective: "o", owner: "partner", scope: ["r"], assumptions: [], budget: { turns: 10 }, parent: "G" };
  const parent: GoalDef = { id: "G", title: "Engine", objective: "o", owner: "partner", scope: ["r"], assumptions: [], budget: { turns: 100 } };
  const log: HEvent[] = [
    { id: "goal-G", at: T0, by: "partner", type: "goal_opened", goal: parent, criteriaHash: criteriaHash(parent) },
    { id: "ask-spawn", at: T0 + 1, by: "r1", type: "ask_opened", ask: { id: "ask-spawn", goal: "G", to: "partner", kind: "decision", origin: "todo:teams", question: "Spawn renderer?", options: [{ id: "approve", label: "Spawn them", effect: { type: "spawn", goals: [child] } }, { id: "reject", label: "Don't", effect: { type: "ack" } }] } },
    { id: "ans-ask-spawn", at: T0 + 2, by: "partner", type: "ask_answered", ask: "ask-spawn", answeredBy: "partner", choice: "approve" },
    { id: "goal-renderer", at: T0 + 2, by: "partner", type: "goal_opened", goal: child, criteriaHash: criteriaHash(child), carvedFrom: "G" },
  ];
  const text = traceText(buildGraph(log), "renderer");
  assert.match(text, /← a workstream of: goal "Engine" opened/);
  assert.match(text, /← approved in the answer to: question for partner: Spawn renderer\?/);
});
