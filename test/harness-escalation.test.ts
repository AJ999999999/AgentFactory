// Escalation quality over the harness log: which questions changed anything, blind
// recommendations, and the daily spot check of decisions the harness made alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { escalationReport, isBlind, worthAsking } from "../src/harness/escalation.ts";
import { buildPacket } from "../src/harness/packet.ts";
import { loadPolicy, project } from "../src/harness/project.ts";
import { settle } from "../src/harness/rules.ts";
import { criteriaHash } from "../src/harness/validate.ts";
import type { Ask, GoalDef, HEvent } from "../src/harness/types.ts";
import { askView } from "../src/panel/view.ts";

const policy = { ...loadPolicy(path.join(import.meta.dirname, "..", "policy", "harness.json")), team: undefined };
const T0 = Date.parse("2026-11-02T09:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const engagement: HEvent = { id: "open", at: T0, by: "partner", type: "engagement_opened", engagement: { id: "e", title: "E", principals: { partner: "you" } } };
const goal = (id: string): HEvent => {
  const g: GoalDef = { id, title: id, objective: "o", owner: "partner", scope: ["work"], assumptions: [], budget: { turns: 100 } };
  return { id: `goal-${id}`, at: T0, by: "partner", type: "goal_opened", goal: g, criteriaHash: criteriaHash(g) };
};
const ask = (a: Partial<Ask> & { id: string; origin: string }, at = T0): HEvent => ({
  id: a.id, at, by: "harness", type: "ask_opened",
  ask: {
    goal: "G", to: "partner", kind: "decision", question: "q",
    options: [{ id: "continue", label: "Continue", effect: { type: "ack" } }, { id: "stop", label: "Stop", effect: { type: "close", status: "killed" } }],
    ...a,
  },
});
const answer = (askId: string, choice: string, at = T0 + 2 * HOUR, by = "partner"): HEvent => ({ id: `ans-${askId}`, at, by, type: "ask_answered", ask: askId, answeredBy: by, choice });

test("a question answered with 'continue' changed nothing; 'stop' changed course; rates are per origin", () => {
  const r = escalationReport([
    ask({ id: "a1", origin: "rule:turn_cap" }), answer("a1", "continue"),
    ask({ id: "a2", origin: "rule:turn_cap" }), answer("a2", "continue", T0 + 4 * HOUR),
    ask({ id: "a3", origin: "rule:turn_cap" }), answer("a3", "stop", T0 + 6 * HOUR),
    ask({ id: "a4", origin: "rule:turn_cap" }),
    ask({ id: "m1", origin: "monitor:prices" }), answer("m1", "continue"),
  ], policy);
  const cap = r.byOrigin.find((o) => o.origin === "rule:turn_cap")!;
  assert.deepEqual([cap.opened, cap.answered, cap.open, cap.keptCourse, cap.changedCourse], [4, 3, 1, 2, 1]);
  assert.equal(cap.keptRate, 2 / 3);
  assert.equal(cap.medianHoursToAnswer, 4);
  assert.equal(r.byOrigin.find((o) => o.origin === "monitor")!.keptRate, 1);
});

test("must-ask questions, the harness's own 'moot' closes and auto-closed asks stay out of the rates", () => {
  const r = escalationReport([
    ask({ id: "money", origin: "rule:money", kind: "approval" }), answer("money", "continue"),
    ask({ id: "act", origin: "todo:t1", kind: "action" }),
    ask({ id: "moot", origin: "rule:spin" }), answer("moot", "moot", T0 + HOUR, "harness"),
    ask({ id: "auto", origin: "turn:t9" }), { id: "ac", at: T0 + 1, by: "harness", type: "ask_auto_closed", ask: "auto", reason: "precedent" } as unknown as HEvent,
  ], policy);
  assert.deepEqual(r.byOrigin, []);
  assert.deepEqual(r.floor, { opened: 2, answered: 1 });
  assert.equal(r.autoClosed, 2);
});

test("worth asking only when the partner changes course more than 1/k of the time, and only with enough answers", () => {
  const base = { origin: "x", opened: 0, open: 0, keptRate: null, withRecommendation: 0, followedShown: { n: 0, followed: 0 }, followedBlind: { n: 0, followed: 0 }, medianHoursToAnswer: null };
  assert.equal(worthAsking({ ...base, answered: 10, keptCourse: 10, changedCourse: 0 }, 10), "too_few_answers");
  assert.equal(worthAsking({ ...base, answered: 30, keptCourse: 29, changedCourse: 1 }, 10), "consider_relaxing");
  assert.equal(worthAsking({ ...base, answered: 30, keptCourse: 26, changedCourse: 4 }, 10), "keep");
});

test("about a fifth of agents' recommendations are hidden, always the same ones, never on must-ask or urgent questions", () => {
  const rec = { option: "continue", why: "w", by: "agent" };
  const asks = Array.from({ length: 2000 }, (_, i): Ask => ({ id: `ask-${i}`, goal: "G", to: "partner", kind: "decision", question: "q", options: [], origin: "turn:x", recommend: rec }));
  const share = asks.filter((a) => isBlind(policy, a)).length / asks.length;
  assert.ok(share > 0.17 && share < 0.23, `blind share ${share}`);
  assert.equal(isBlind(policy, asks[5]), isBlind(policy, asks[5]));
  const blindOne = asks.find((a) => isBlind(policy, a))!;
  assert.equal(isBlind(policy, { ...blindOne, urgent: true }), false);
  assert.equal(isBlind(policy, { ...blindOne, origin: "rule:money" }), false);
  assert.equal(isBlind(policy, { ...blindOne, recommend: undefined }), false);
  assert.equal(isBlind({ ...policy, escalation: undefined }, blindOne), false, "off unless the policy turns it on");
});

test("the panel holds back a blind question's recommendation, and the report splits followed-shown from followed-blind", () => {
  const rec = { option: "continue", why: "safe", by: "agent" };
  const ids = Array.from({ length: 40 }, (_, i) => `q-${i}`);
  const mk = (id: string) => ({ id, goal: "G", to: "partner", kind: "decision" as const, question: "q", options: [], origin: "turn:x", recommend: rec });
  const blindId = ids.find((i) => isBlind(policy, mk(i)))!;
  const shownId = ids.find((i) => !isBlind(policy, mk(i)))!;
  const s = project([engagement, goal("G"), ask({ id: blindId, origin: "turn:x", recommend: rec }), ask({ id: shownId, origin: "turn:x", recommend: rec })], policy);
  const vb = askView(s, "e", s.asks.get(blindId)!);
  assert.equal(vb.recommend, undefined);
  assert.equal(vb.blind, true);
  assert.equal(askView(s, "e", s.asks.get(shownId)!).recommend?.option, "continue");

  const r = escalationReport([ask({ id: blindId, origin: "turn:x", recommend: rec }), answer(blindId, "stop"), ask({ id: shownId, origin: "turn:x", recommend: rec }), answer(shownId, "continue")], policy);
  const t = r.byOrigin.find((o) => o.origin === "turn")!;
  assert.deepEqual([t.followedShown, t.followedBlind], [{ n: 1, followed: 1 }, { n: 1, followed: 0 }]);
});

test("once a day, one decision the harness made alone goes back to the owner as a spot check that holds no work", () => {
  const events: HEvent[] = [
    engagement, goal("G"),
    { id: "add-t1", at: T0, by: "partner", type: "todo_added", todo: { id: "t1", goal: "G", text: "write the intro", lane: "build", scope: ["work"] } as never, provenance: "seed" },
    { id: "add-t2", at: T0, by: "partner", type: "todo_added", todo: { id: "t2", goal: "G", text: "write the outro", lane: "build", scope: ["work"] } as never, provenance: "seed" },
    { id: "sup-t1", at: T0 + HOUR, by: "harness", type: "todo_superseded", todo: "t1", reason: "replaced by a later plan" },
    { id: "sup-t2", at: T0 + HOUR, by: "partner", type: "todo_superseded", todo: "t2", reason: "partner dropped it" },
  ];
  const s = project(events, policy);
  assert.deepEqual(s.autonomous.map((d) => d.event), ["sup-t1"], "only the harness's own decisions");
  const out = settle(s, T0 + 2 * HOUR);
  const audits = out.filter((e): e is Extract<HEvent, { type: "ask_opened" }> => e.type === "ask_opened" && e.ask.origin.startsWith("audit:"));
  assert.equal(audits.length, 1);
  const a = audits[0].ask;
  assert.equal(a.origin, "audit:sup-t1");
  assert.deepEqual(a.audit, { event: "sup-t1", probability: 1 });
  assert.match(a.question, /dropped "write the intro"/);
  assert.equal(a.to, "partner");
  assert.ok(!a.blocksGoal && !a.todo && !a.lane, "holds no work");
  assert.deepEqual(a.options.map((o) => o.id), ["same", "would_differ", "wanted_to_be_asked"]);

  // Same day: nothing more. The next day: nothing left that hasn't been checked.
  assert.equal(settle(s, T0 + 3 * HOUR).filter((e) => e.type === "ask_opened").length, 0);
  assert.equal(settle(s, T0 + 2 * DAY).filter((e) => e.type === "ask_opened" && e.ask.origin.startsWith("audit:")).length, 0);
});

test("spot-check answers give a miss rate weighted by each pick's chance, and agents never see the spot check", () => {
  const r = escalationReport([
    ask({ id: "au1", origin: "audit:e1", audit: { event: "e1", probability: 0.5 } }), answer("au1", "same"),
    ask({ id: "au2", origin: "audit:e2", audit: { event: "e2", probability: 0.25 } }), answer("au2", "would_differ"),
    ask({ id: "au3", origin: "audit:e3", audit: { event: "e3", probability: 1 } }),
  ], policy);
  assert.equal(r.audits.asked, 3);
  assert.equal(r.audits.answered, 2);
  assert.equal(r.audits.verdicts.would_differ, 1);
  assert.equal(r.audits.missRate, 4 / 6, "weights 1/p: 2 for 'same', 4 for 'would differ'");
  assert.equal(r.byOrigin.length, 0);

  const s = project([
    engagement, goal("G"),
    { id: "add-t1", at: T0, by: "partner", type: "todo_added", todo: { id: "t1", goal: "G", text: "do it", lane: "build", scope: ["work"] } as never, provenance: "seed" },
    ask({ id: "au9", origin: "audit:x", audit: { event: "x", probability: 1 } }),
  ], policy);
  assert.doesNotMatch(buildPacket(s, s.todos.get("t1")!, "status"), /au9|Spot check/);
});
