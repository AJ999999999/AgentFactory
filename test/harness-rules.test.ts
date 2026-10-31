// Harness rules as pure functions over projected state: no git, no clock, no agents.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { apply, beliefOf, loadPolicy, project, seatOf, seatPermissions } from "../src/harness/project.ts";
import { checkLibrary } from "../src/harness/team.ts";
import { CopilotTurnAgent } from "../src/harness/agents.ts";
import type { TurnContext } from "../src/harness/agents.ts";
import { readEvents, writeEventFiles } from "../src/harness/store.ts";
import type { State } from "../src/harness/project.ts";
import { settle } from "../src/harness/rules.ts";
import { blockers, nextWake, phase, rank, readyTodos } from "../src/harness/select.ts";
import { budgetProblem, validateTurn } from "../src/harness/validate.ts";
import type { TurnOutput } from "../src/harness/validate.ts";
import { answerEvents } from "../src/harness/answers.ts";
import { buildPacket } from "../src/harness/packet.ts";
import { criteriaHash } from "../src/harness/validate.ts";
import { askView } from "../src/panel/view.ts";
import type { AssumptionDef, Finding, GoalDef, HEvent, TodoDraft, TurnRecord } from "../src/harness/types.ts";

// Most tests here check one mechanism at a time, without a team (nothing is staffed);
// the team tests at the end use the full policy.
const teamPolicy = loadPolicy(path.join(import.meta.dirname, "..", "policy", "harness.json"));
const policy = { ...teamPolicy, team: undefined };
const T0 = Date.parse("2026-11-02T09:00:00Z");
const DAY = 86_400_000;
let seq = 0;
const id = (p: string) => `${p}-${++seq}`;

const A = (x: Partial<AssumptionDef> & { id: string }): AssumptionDef => ({ text: x.id, category: "desirability", risk: 3, uncertainty: 3, ...x });
const goal = (x: Partial<GoalDef> & { id: string }): HEvent => {
  const g: GoalDef = { title: x.id, objective: "o", owner: "partner", scope: ["work"], assumptions: [], budget: { turns: 100 }, ...x };
  return { id: `goal-${g.id}`, at: T0, by: "partner", type: "goal_opened", goal: g, criteriaHash: criteriaHash(g) };
};
const todo = (g: string, d: TodoDraft & { id: string }, at = T0): HEvent => ({ id: `add-${d.id}`, at, by: "partner", type: "todo_added", todo: { ...d, goal: g }, provenance: "seed" });
const finding = (f: Partial<Finding> & { goal: string; assumption: string; direction: Finding["direction"]; grade: Finding["grade"] }, at = T0 + 1): HEvent => {
  const fid = f.id ?? id("f");
  return { id: fid, at, by: "x", type: "finding", finding: { source: "s", author: "job:x", text: "t", ...f, id: fid } };
};
const turn = (t: Partial<TurnRecord> & { todo: string; goal: string }, at: number): HEvent => {
  const tid = id("t");
  return { id: `turn-${tid}`, at, by: "r1", type: "turn", turn: { id: tid, agent: "r1", result: "progress", granularity: "surface", reasons: [], files: [], ...t } };
};
const engagement: HEvent = { id: "open", at: T0, by: "partner", type: "engagement_opened", engagement: { id: "e", title: "E", principals: { partner: "you", pharmacist: "dr" } } };
const st = (...events: HEvent[]): State => project([engagement, ...events], policy);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "af-rules-"));
const validate = (s: State, todoId: string, output: TurnOutput, files: string[] = [], extra: Partial<Parameters<typeof validateTurn>[0]> = {}) =>
  validateTurn({ s, todo: s.todos.get(todoId)!, agent: "r1", turn: id("turn"), now: T0 + DAY, why: "test", output, files, checkFailures: [], checked: false, wtDir: tmp, knownSources: ["signups"], ...extra });

// ---------- beliefs ----------

test("belief comes from graded evidence only: agents' findings never settle desirability, behavior does", () => {
  const g = goal({ id: "G", assumptions: [A({ id: "D", category: "desirability" })] });
  let s = st(g, finding({ goal: "G", assumption: "D", direction: "supports", grade: "reported" }), finding({ goal: "G", assumption: "D", direction: "supports", grade: "stated" }));
  assert.equal(beliefOf(s, "G", s.goals.get("G")!.def.assumptions[0]).status, "untested", "reported and stated interest are signals");
  s = st(g, finding({ goal: "G", assumption: "D", direction: "supports", grade: "behavioral" }));
  assert.equal(beliefOf(s, "G", s.goals.get("G")!.def.assumptions[0]).status, "supported");
});

test("measured evidence needs replications; untrusted never counts; conflicts are contested; a reset forgets the past", () => {
  const g = goal({ id: "G", assumptions: [A({ id: "F", category: "feasibility" })] });
  const def = () => s.goals.get("G")!.def.assumptions[0];
  let s = st(g, finding({ goal: "G", assumption: "F", direction: "supports", grade: "measured", runs: 1 }));
  assert.equal(beliefOf(s, "G", def()).status, "untested", "one run is not enough");
  s = st(g, finding({ goal: "G", assumption: "F", direction: "supports", grade: "measured", runs: 3, untrusted: true }));
  assert.equal(beliefOf(s, "G", def()).status, "untested", "untrusted content never settles anything");
  s = st(g, finding({ goal: "G", assumption: "F", direction: "supports", grade: "measured", runs: 3 }), finding({ goal: "G", assumption: "F", direction: "refutes", grade: "expert" }));
  assert.equal(beliefOf(s, "G", def()).status, "contested");
  s = st(g, finding({ goal: "G", assumption: "F", direction: "refutes", grade: "measured", runs: 3 }, T0 + 1), { id: "reset", at: T0 + 2, by: "partner", type: "assumption_reset", goal: "G", assumption: "F", reason: "fixed" }, finding({ goal: "G", assumption: "F", direction: "supports", grade: "measured", runs: 3 }, T0 + 3));
  assert.equal(beliefOf(s, "G", def()).status, "supported", "evidence from before the fix no longer counts");
});

// ---------- gates ----------

test("work that assumes something waits for it; when it's refuted, the owner decides before the work goes", () => {
  const g = goal({ id: "G", assumptions: [A({ id: "D", loadBearing: true }), A({ id: "N" })] });
  const build = todo("G", { id: "build", lane: "build", text: "b", assumes: ["D"] });
  const brand = todo("G", { id: "brand", lane: "build", text: "b", assumes: ["N"] });
  let s = st(g, build);
  assert.deepEqual(blockers(s, s.todos.get("build")!, T0), ["assumes D (untested)"]);
  const refuted = [g, build, brand, finding({ goal: "G", assumption: "D", direction: "refutes", grade: "behavioral" }), finding({ goal: "G", assumption: "N", direction: "refutes", grade: "behavioral" })];
  s = st(...refuted);
  const out = settle(s, T0 + DAY);
  assert.ok(out.some((e) => e.type === "todo_superseded" && e.todo === "brand"), "not load-bearing: dropped at once");
  assert.ok(!out.some((e) => e.type === "todo_superseded" && e.todo === "build"), "load-bearing: waits for the owner");
  const ask = out.find((e) => e.type === "ask_opened" && e.ask.origin === "rule:load_bearing_refuted");
  assert.ok(ask && ask.type === "ask_opened" && ask.ask.blocksGoal);
  // "fix and test again": the work survives and waits for the retest
  const fixed = st(...refuted);
  settle(fixed, T0 + DAY);
  for (const e of answerEvents(fixed, ask.ask.id, { by: "partner", choice: "fix" }, T0 + DAY + 1)) apply(fixed, e);
  settle(fixed, T0 + DAY + 2);
  assert.equal(fixed.todos.get("build")!.status, "open");
  assert.deepEqual(blockers(fixed, fixed.todos.get("build")!, T0 + DAY + 2), ["assumes D (untested)"]);
  // "continue without it": the dependent work goes
  for (const e of answerEvents(s, ask.ask.id, { by: "partner", choice: "continue" }, T0 + DAY + 1)) apply(s, e);
  assert.ok(settle(s, T0 + DAY + 2).some((e) => e.type === "todo_superseded" && e.todo === "build"));
});

test("a question blocks only the work that depends on it, unless it's about the whole goal", () => {
  const s = st(
    goal({ id: "G" }), goal({ id: "H" }),
    todo("G", { id: "dep", lane: "x", text: "x", after: ["ask-1"] }), todo("G", { id: "free", lane: "x", text: "x" }), todo("H", { id: "other", lane: "x", text: "x" }),
    { id: "ask-1", at: T0, by: "r1", type: "ask_opened", ask: { id: "ask-1", goal: "G", to: "partner", kind: "decision", question: "q", options: [{ id: "a", label: "a" }, { id: "b", label: "b" }], origin: "turn:x" } },
  );
  const ready = readyTodos(s, T0, undefined, new Set(), ["task"]).map((t) => t.id).sort();
  assert.deepEqual(ready, ["free", "other"]);
  apply(s, { id: "ask-2", at: T0, by: "h", type: "ask_opened", ask: { id: "ask-2", goal: "G", to: "partner", kind: "decision", question: "q", options: [], origin: "rule:x", blocksGoal: true } });
  assert.deepEqual(readyTodos(s, T0, undefined, new Set(), ["task"]).map((t) => t.id), ["other"], "a goal-level question stops that goal only");
});

test("a running experiment freezes its surface: no todo may change it, and a turn that does is discarded", () => {
  const s = st(
    goal({ id: "G", scope: ["site"] }),
    todo("G", { id: "wait", kind: "wait", lane: "m", text: "w", freeze: ["site/landing"], wait: { source: "signups", minDays: 14 } }),
    todo("G", { id: "tweak", lane: "build", text: "improve copy", writeScope: ["site/landing"] }),
    todo("G", { id: "blog", lane: "build", text: "blog", writeScope: ["site/blog"] }),
    { id: "start", at: T0, by: "r1", type: "todo_started", todo: "wait", handle: "w" },
  );
  assert.ok(blockers(s, s.todos.get("tweak")!, T0).some((b) => b.startsWith("frozen by running wait")));
  assert.deepEqual(blockers(s, s.todos.get("blog")!, T0), []);
  const v = validate(s, "blog", { done: true }, ["site/blog/post.md", "site/landing/index.html"]);
  assert.equal(v.result, "validation_failed");
  assert.ok(v.reasons.some((r) => r.includes("outside the todo's scope")));
});

test("blackouts and notBefore hold work and set the wake time", () => {
  const s = st(goal({ id: "G", blackouts: [{ from: "2026-12-15T00:00:00Z", to: "2027-01-05T00:00:00Z", lanes: ["deploy"], reason: "holiday freeze" }] }), todo("G", { id: "cut", lane: "deploy", text: "cut over" }));
  const now = Date.parse("2026-12-20T00:00:00Z");
  assert.ok(blockers(s, s.todos.get("cut")!, now)[0].startsWith("blackout until"));
  const h = nextWake(s, now, { readyNow: false, pulse: { monitors: {}, polls: {} }, claimExpiries: [] });
  assert.equal(h.timer, Date.parse("2027-01-05T00:00:00Z"));
});

// ---------- money, criteria, budget ----------

test("money is approved before it's spent, and only asked for when it's the last thing in the way", () => {
  const g = goal({ id: "G", assumptions: [A({ id: "D" })], budget: { turns: 10, usd: 500 } });
  let s = st(g, todo("G", { id: "ads", kind: "wait", lane: "m", text: "ads", cost: { usd: 200 }, assumes: ["D"], wait: { source: "signups" } }));
  assert.equal(settle(s, T0).filter((e) => e.type === "ask_opened").length, 0, "no approval for work that may never happen");
  s = st(g, todo("G", { id: "ads", kind: "wait", lane: "m", text: "ads", cost: { usd: 200 }, wait: { source: "signups" } }));
  const out = settle(s, T0);
  const ask = out.find((e) => e.type === "ask_opened");
  assert.ok(ask && ask.type === "ask_opened" && ask.ask.kind === "approval" && ask.ask.question.includes("$500"));
  assert.ok(blockers(s, s.todos.get("ads")!, T0).some((b) => b.startsWith("spend $200")));
  for (const e of answerEvents(s, ask.ask.id, { by: "partner", choice: "approve" }, T0 + 1)) apply(s, e);
  assert.deepEqual(blockers(s, s.todos.get("ads")!, T0 + 2), []);
});

test("kill criteria trip on world evidence with enough sample, judged within the current version", () => {
  const kill = [{ id: "K1", metric: "conversion", op: "<" as const, value: 0.02, minSample: { metric: "visitors", value: 2000 } }];
  const g = goal({ id: "G", kill });
  const m = (metrics: Record<string, number>, grade: Finding["grade"] = "behavioral", at = T0 + 1): HEvent => ({ id: id("m"), at, by: "x", type: "finding", finding: { id: id("mf"), goal: "G", direction: "neutral", grade, source: "metric:x", author: "metric:x", text: "", metrics } });
  const kills = (out: HEvent[]) => out.filter((e) => e.type === "ask_opened" && e.ask.origin === "rule:kill_criterion").length;
  assert.equal(kills(settle(st(g, m({ conversion: 0.01, visitors: 800 })), T0)), 0, "not enough visitors yet");
  assert.equal(kills(settle(st(g, m({ conversion: 0.01, visitors: 2100 }, "opinion")), T0)), 0, "an agent's numbers never trip a criterion");
  const out = settle(st(g, m({ conversion: 0.011, visitors: 2100 })), T0);
  assert.ok(out.some((e) => e.type === "ask_opened" && e.ask.origin === "rule:kill_criterion" && e.ask.blocksGoal));
  const revised: HEvent = { id: "rev", at: T0 + 10, by: "partner", type: "goal_revised", goal: "G", version: 2, revision: { objective: "new" }, pivot: true, reason: "p", criteriaHash: "x" };
  assert.equal(settle(st(g, m({ conversion: 0.011, visitors: 2100 }), revised), T0 + 20).filter((e) => e.type === "ask_opened" && e.ask.origin === "rule:kill_criterion").length, 0, "the old version's data doesn't judge the new version");
});

test("an agent's scope estimate far over budget asks before anything is built", () => {
  const s = st(goal({ id: "G", budget: { turns: 2000 } }), { id: "est", at: T0 + 1, by: "r1", type: "finding", finding: { id: "est", goal: "G", direction: "neutral", grade: "opinion", source: "", author: "r1", text: "outside view", metrics: { estimated_turns: 60000 } } });
  const ask = settle(s, T0 + 2).find((e) => e.type === "ask_opened" && e.ask.origin === "rule:scope_vs_budget");
  assert.ok(ask && ask.type === "ask_opened" && ask.ask.blocksGoal);
});

test("budget: warn on forecast, stop at zero, and a raise reopens work", () => {
  const g = goal({ id: "G", budget: { turns: 5 } });
  const evs: HEvent[] = [g, todo("G", { id: "a", lane: "x", text: "a" }), todo("G", { id: "b", lane: "x", text: "b" })];
  for (let i = 0; i < 4; i++) evs.push(turn({ todo: "a", goal: "G", granularity: "substantive" }, T0 + i));
  let out = settle(st(...evs), T0 + 10);
  assert.ok(out.some((e) => e.type === "ask_opened" && e.ask.origin === "rule:budget_forecast"));
  evs.push(turn({ todo: "a", goal: "G", granularity: "substantive" }, T0 + 5));
  const s = st(...evs);
  out = settle(s, T0 + 10);
  const ask = out.find((e) => e.type === "ask_opened" && e.ask.origin === "rule:budget_exhausted");
  assert.ok(ask && ask.type === "ask_opened");
  assert.ok(blockers(s, s.todos.get("b")!, T0 + 10).includes("turn budget of G spent"));
  for (const e of answerEvents(s, ask.ask.id, { by: "partner", choice: "raise", budget: { turns: 20 } }, T0 + 11)) apply(s, e);
  assert.deepEqual(blockers(s, s.todos.get("b")!, T0 + 12), []);
});

// ---------- spin, thrash, contradictions ----------

test("spin: three thin turns force a replan that holds other work; a thin replan escalates", () => {
  const evs: HEvent[] = [goal({ id: "G" }), todo("G", { id: "a", lane: "x", text: "a" }), todo("G", { id: "b", lane: "x", text: "b" })];
  for (let i = 0; i < 3; i++) evs.push(turn({ todo: "a", goal: "G", granularity: i === 1 ? "none" : "surface" }, T0 + i));
  evs.push(turn({ todo: "a", goal: "G", result: "host_failure", granularity: "none" }, T0 + 4));
  const s = st(...evs);
  const out = settle(s, T0 + 10);
  const replan = out.find((e) => e.type === "todo_added" && e.todo.lane === "replan");
  assert.ok(replan && replan.type === "todo_added" && replan.todo.priority === 0);
  assert.ok(blockers(s, s.todos.get("b")!, T0 + 10)[0].startsWith("replan first"));
  apply(s, turn({ todo: replan.todo.id, goal: "G", result: "completed", granularity: "surface" }, T0 + 11));
  apply(s, { id: "rd", at: T0 + 11, by: "r1", type: "todo_done", todo: replan.todo.id });
  const out2 = settle(s, T0 + 12);
  assert.ok(out2.some((e) => e.type === "ask_opened" && e.ask.origin === "rule:spin" && e.ask.blocksGoal));
});

test("a refutation is progress, not spin", () => {
  const evs: HEvent[] = [goal({ id: "G" }), todo("G", { id: "a", lane: "x", text: "a" })];
  evs.push(turn({ todo: "a", goal: "G", granularity: "surface" }, T0 + 1), turn({ todo: "a", goal: "G", granularity: "surface" }, T0 + 2), turn({ todo: "a", goal: "G", granularity: "milestone" }, T0 + 3), turn({ todo: "a", goal: "G", granularity: "surface" }, T0 + 4));
  assert.equal(settle(st(...evs), T0 + 10).filter((e) => e.type === "todo_added").length, 0);
});

test("thrash: too many pivots in the window asks to hold a direction", () => {
  const evs: HEvent[] = [goal({ id: "G" }), todo("G", { id: "a", lane: "x", text: "a" })];
  for (let v = 2; v <= 4; v++) evs.push({ id: `rev${v}`, at: T0 + v * DAY, by: "partner", type: "goal_revised", goal: "G", version: v, revision: {}, pivot: true, reason: "r", criteriaHash: "x" });
  assert.ok(settle(st(...evs), T0 + 5 * DAY).some((e) => e.type === "ask_opened" && e.ask.origin === "rule:thrash"));
});

test("contradicting evidence gets an independent synthesis; a weak contrary signal gets a proper test, not a pivot", () => {
  const g = goal({ id: "G", assumptions: [A({ id: "F", category: "feasibility", loadBearing: true })] });
  const s = st(g, finding({ goal: "G", assumption: "F", direction: "supports", grade: "measured", runs: 3 }), finding({ goal: "G", assumption: "F", direction: "refutes", grade: "measured", runs: 3 }));
  const out = settle(s, T0 + 10);
  assert.ok(out.some((e) => e.type === "todo_added" && e.todo.lane === "synthesis" && e.todo.priority === 0));
  assert.ok(!out.some((e) => e.type === "ask_opened" && e.ask.origin === "rule:load_bearing_refuted"), "no direction question while the evidence is contested");
  const s2 = st(g, finding({ goal: "G", assumption: "F", direction: "supports", grade: "measured", runs: 3 }), finding({ goal: "G", assumption: "F", direction: "refutes", grade: "reported", author: "r1" }, T0 + 2));
  const out2 = settle(s2, T0 + 10);
  assert.ok(out2.some((e) => e.type === "todo_added" && e.todo.lane === "replicate" && e.todo.tests === "F"));
  assert.ok(!out2.some((e) => e.type === "ask_opened" && e.ask.origin === "rule:load_bearing_refuted"));
});

// ---------- validation ----------

test("validation: agents can't mint strong evidence, invent busywork, or propose closing goals", () => {
  const s = st(goal({ id: "G", assumptions: [A({ id: "D" })], scope: ["work"] }), todo("G", { id: "r", lane: "research", text: "r", tests: "D" }));
  const v = validate(s, "r", {
    findings: [
      { assumption: "D", direction: "supports", grade: "expert", source: "me", text: "trust me" },
      { assumption: "D", direction: "supports", grade: "reported", source: "https://example.com/survey", text: "a survey" },
    ],
    todos: [{ lane: "polish", text: "Tidy up the docs" }, { lane: "test", text: "Pre-order test", tests: "D", kind: "wait", wait: { source: "signups", informs: [{ assumption: "D", metric: "preorders", threshold: { metric: "preorders", op: ">=", value: 20 } }] } }],
    asks: [{ question: "Shall we close?", options: [{ id: "y", label: "y", effect: { type: "close", status: "done" } }, { id: "n", label: "n" }] }],
  });
  assert.equal(v.result, "progress");
  assert.ok(v.reasons.some((r) => r.includes("can't record expert")));
  assert.ok(v.reasons.some((r) => r.includes("no reason to exist")));
  assert.ok(v.reasons.some((r) => r.includes("can't propose a \"close\"")));
  const f = v.events.find((e) => e.type === "finding");
  assert.ok(f && f.type === "finding" && f.finding.untrusted, "web content is marked untrusted");
  assert.equal(v.events.filter((e) => e.type === "todo_added").length, 1);
  assert.equal(v.granularity, "substantive", "a sourced finding and a proposed test are real progress");
});

test("a question can be answered from its card: the asker's recommendation and consequences travel with it, and the card says when to look first", () => {
  const g = goal({ id: "G", assumptions: [A({ id: "D" })], scope: ["work"] });
  const base = [g, todo("G", { id: "r", lane: "research", text: "r", tests: "D" })];
  const ask = (output: TurnOutput, ...more: HEvent[]) => {
    const v = validate(st(...base, ...more), "r", output);
    const opened = v.events.find((e) => e.type === "ask_opened")!;
    const s = st(...base, ...more, ...v.events);
    return { v, view: askView(s, "e", s.asks.get(opened.type === "ask_opened" ? opened.ask.id : "")!) };
  };
  const easy = ask({ asks: [{
    question: "Which onboarding first?",
    options: [{ id: "short", label: "Short form", consequence: "ships Friday" }, { id: "long", label: "Long form", consequence: "two more weeks", huge: "x".repeat(10_000) } as never],
    recommend: { option: "short", why: "cheaper to learn from" },
  }] });
  assert.deepEqual(easy.view.recommend, { option: "short", label: "Short form", why: "cheaper to learn from", by: "r1" });
  assert.deepEqual(easy.view.options.map((o) => [o.id, o.consequence, o.confirm ?? false]), [["short", "ships Friday", false], ["long", "two more weeks", false]]);
  assert.deepEqual(easy.view.lookFirst, [], "nothing in it argues against answering from the card");
  assert.ok(!JSON.stringify(easy.v.events).includes("xxxx"), "only the fields the page knows are kept");

  const final = ask({ asks: [{ question: "Drop the long form?", options: [{ id: "drop", label: "Drop it", irreversible: true }, { id: "keep", label: "Keep it" }], recommend: { option: "drop", why: "nobody uses it" } }] });
  assert.deepEqual(final.view.lookFirst, ["what it recommends can't be undone"]);
  assert.ok(final.view.options.every((o) => o.confirm), "no one-click answers on a card that says to look first");
  assert.equal(final.view.options[0].irreversible, true);

  const f1 = finding({ goal: "G", assumption: "D", direction: "supports", grade: "measured", id: "f-yes" });
  const f2 = finding({ goal: "G", assumption: "D", direction: "refutes", grade: "reported", id: "f-no" }, T0 + 2);
  const opened: HEvent = { id: "ask-split", at: T0 + 3, by: "harness", type: "ask_opened", ask: { id: "ask-split", goal: "G", to: "partner", kind: "decision", question: "Keep D?", origin: "rule:x", evidence: ["f-yes", "f-no"], options: [{ id: "y", label: "Yes" }, { id: "n", label: "No" }] } };
  const split = st(...base, f1, f2, opened);
  assert.deepEqual(askView(split, "e", split.asks.get("ask-split")!).lookFirst, ["the evidence points both ways"]);

  const bad = ask({ asks: [{ question: "Pick one?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], recommend: { option: "c", why: "c is best" } }] });
  assert.equal(bad.view.recommend, undefined);
  assert.ok(bad.v.reasons.some((r) => r.includes("recommendation names no option")));
});

test("validation: a test can't move a pre-registered threshold, and an unregistered one must be stated up front", () => {
  const s = st(goal({ id: "G", assumptions: [A({ id: "D", threshold: { metric: "preorders", op: ">=", value: 50 } }), A({ id: "E" })] }), todo("G", { id: "r", lane: "x", text: "r", tests: "D" }));
  const w = (assumption: string, threshold?: { metric: string; op: ">="; value: number }) => ({ lane: "m", text: "t", kind: "wait" as const, tests: assumption, wait: { source: "signups", informs: [{ assumption, metric: "preorders", threshold }] } });
  const v = validate(s, "r", { todos: [w("D", { metric: "preorders", op: ">=", value: 5 }), w("E")] });
  assert.ok(v.reasons.some((r) => r.includes("pre-registered threshold; a test can't change it")));
  assert.ok(v.reasons.some((r) => r.includes("state the pass line before the data exists")));
});

test("validation: only a replan supersedes, only synthesis discounts, and never its own evidence", () => {
  const s = st(
    goal({ id: "G", assumptions: [A({ id: "F", category: "feasibility" })] }),
    todo("G", { id: "x", lane: "build", text: "x" }), todo("G", { id: "y", lane: "build", text: "y" }), todo("G", { id: "syn", lane: "synthesis", text: "s" }), todo("G", { id: "rp", lane: "replan", text: "r" }),
    finding({ id: "mine", goal: "G", assumption: "F", direction: "supports", grade: "reported", author: "r1" }),
    finding({ id: "theirs", goal: "G", assumption: "F", direction: "supports", grade: "measured", runs: 3, author: "job:b" }),
  );
  assert.ok(validate(s, "x", { supersede: [{ todo: "y", reason: "r" }] }).reasons.some((r) => r.includes("only a replan")));
  const rp = validate(s, "rp", { supersede: [{ todo: "y", reason: "not moving F" }] });
  assert.ok(rp.events.some((e) => e.type === "todo_superseded"));
  assert.equal(rp.granularity, "substantive");
  const syn = validate(s, "syn", { discount: [{ finding: "mine", reason: "x" }, { finding: "theirs", reason: "debug build" }] });
  assert.ok(syn.reasons.some((r) => r.includes("can't discount evidence you produced")));
  assert.equal(syn.events.filter((e) => e.type === "finding_discounted").length, 1);
});

test("validation: spawning needs disjoint scopes inside the parent, existing contracts, and approval above a quarter of the budget", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-spawn-"));
  fs.mkdirSync(path.join(dir, "contracts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "contracts", "render.md"), "api");
  const s = st(goal({ id: "P", scope: ["engine"], budget: { turns: 100 } }), todo("P", { id: "plan", lane: "plan", text: "split" }));
  const child = (cid: string, scope: string, turns: number, interfaces = ["contracts/render.md"]): GoalDef => ({ id: cid, title: cid, objective: "o", owner: "partner", scope: [scope], assumptions: [], budget: { turns }, interfaces });
  const ex = { wtDir: dir };
  assert.ok(validate(s, "plan", { spawn: [child("a", "engine/a", 10), child("b", "engine/a/x", 10)] }, [], ex).reasons.some((r) => r.includes("overlaps")));
  assert.ok(validate(s, "plan", { spawn: [child("a", "other", 10)] }, [], ex).reasons.some((r) => r.includes("inside P's")));
  assert.ok(validate(s, "plan", { spawn: [child("a", "engine/a", 10, ["contracts/physics.md"])] }, [], ex).reasons.some((r) => r.includes("don't exist yet")));
  const small = validate(s, "plan", { spawn: [child("a", "engine/a", 10), child("b", "engine/b", 10)] }, [], ex);
  assert.equal(small.events.filter((e) => e.type === "goal_opened").length, 2);
  assert.ok(small.events.some((e) => e.type === "budget_set" && e.budget.turns === 80), "carved out of the parent");
  const big = validate(s, "plan", { spawn: [child("a", "engine/a", 40)] }, [], ex);
  assert.ok(big.events.some((e) => e.type === "ask_opened" && e.ask.question.includes("Spawn 1")));
  assert.ok(!big.events.some((e) => e.type === "goal_opened"));
});

test("validation: spawning moves budget and never creates it, so a tree of workstreams can't outspend its root", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-carve-"));
  fs.mkdirSync(path.join(dir, "contracts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "contracts", "api.md"), "api");
  const ex = { wtDir: dir };
  const child = (cid: string, scope: string, budget: GoalDef["budget"]): GoalDef => ({ id: cid, title: cid, objective: "o", owner: "partner", scope: [scope], assumptions: [], budget, interfaces: ["contracts/api.md"] });

  // Work that never ends has a weekly rate; its workstreams take a slice of that rate.
  const perpetual = st(goal({ id: "P", scope: ["lib"], budget: { turnsPerWeek: 20 }, perpetual: true }), todo("P", { id: "plan", lane: "plan", text: "split" }));
  const ok = validate(perpetual, "plan", { spawn: [child("a", "lib/a", { turnsPerWeek: 2 }), child("b", "lib/b", { turnsPerWeek: 2 })] }, [], ex);
  assert.equal(ok.events.filter((e) => e.type === "goal_opened").length, 2);
  assert.ok(ok.events.some((e) => e.type === "budget_set" && e.goal === "P" && e.budget.turnsPerWeek === 16), "carved out of the parent's rate");
  // Before, a goal with no stock of turns counted as having infinitely many: this went through unasked.
  const greedy = validate(perpetual, "plan", { spawn: [child("a", "lib/a", { turnsPerWeek: 15 })] }, [], ex);
  assert.ok(greedy.events.some((e) => e.type === "ask_opened" && e.ask.question.includes("turns a week")));
  assert.ok(validate(perpetual, "plan", { spawn: [child("a", "lib/a", { turnsPerWeek: 21 })] }, [], ex).reasons.some((r) => r.includes("has 20 left")));
  assert.ok(validate(perpetual, "plan", { spawn: [child("a", "lib/a", { turns: 500 })] }, [], ex).reasons.some((r) => r.includes("turnsPerWeek, carved from P's")), "a stock can't be minted from a rate");

  // A workstream holds at least one turn, so the budget alone bounds how many and how deep.
  const stock = st(goal({ id: "S", scope: ["eng"], budget: { turns: 100 } }), todo("S", { id: "plan", lane: "plan", text: "split" }));
  assert.ok(validate(stock, "plan", { spawn: [child("z", "eng/z", { turns: 0 })] }, [], ex).reasons.some((r) => r.includes("at least 1")));

  // A goal with no turn budget at all has nothing to carve from.
  const none = st(goal({ id: "N", scope: ["x"], budget: {} }), todo("N", { id: "plan", lane: "plan", text: "split" }));
  assert.ok(validate(none, "plan", { spawn: [child("a", "x/a", { turns: 1 })] }, [], ex).reasons.some((r) => r.includes("no turn budget to carve from")));
  assert.match(budgetProblem("N", {})!, /no turn budget/);
  assert.match(budgetProblem("N", { turns: Infinity })!, /finite/);
  assert.equal(budgetProblem("N", { turnsPerWeek: 5 }), null);
});

// ---------- answers, ranking, packet ----------

test("answers: only the addressee (or the partner) answers; a pivot drops old work except what's carried", () => {
  const g = goal({ id: "G", assumptions: [A({ id: "D", loadBearing: true })] });
  const s = st(g, todo("G", { id: "keep", lane: "x", text: "k" }), todo("G", { id: "old", lane: "x", text: "o" }),
    { id: "ask-r", at: T0, by: "h", type: "ask_opened", ask: { id: "ask-r", goal: "G", to: "pharmacist", kind: "review", question: "q", options: [{ id: "approve", label: "a" }, { id: "x", label: "x" }], origin: "x" } },
    { id: "ask-p", at: T0, by: "h", type: "ask_opened", ask: { id: "ask-p", goal: "G", to: "partner", kind: "decision", question: "q", options: [{ id: "pivot", label: "p", effect: { type: "revise", pivot: true } }], origin: "x" } });
  assert.throws(() => answerEvents(s, "ask-r", { by: "client", choice: "approve" }, T0), /can't answer/);
  assert.throws(() => answerEvents(s, "ask-p", { by: "partner", choice: "pivot" }, T0), /needs the revised goal/);
  const evs = answerEvents(s, "ask-p", { by: "partner", choice: "pivot", revision: { objective: "classroom packs", carry: ["keep"], todos: [{ lane: "m", text: "teacher test" }] } }, T0 + 1);
  for (const e of evs) apply(s, e);
  assert.equal(s.goals.get("G")!.version, 2);
  assert.equal(s.todos.get("old")!.status, "superseded");
  assert.equal(s.todos.get("keep")!.status, "open");
  assert.equal([...s.todos.values()].filter((t) => t.provenance === "answer:pivot").length, 1);
});

test("ranking: urgent first, then the goal furthest below its share, then value of information; phase is derived", () => {
  const s = st(
    goal({ id: "G", share: 1, assumptions: [A({ id: "lo", risk: 2, uncertainty: 2, category: "feasibility" }), A({ id: "hi", risk: 5, uncertainty: 4, loadBearing: true, category: "desirability" })] }),
    goal({ id: "H", share: 1 }),
    todo("G", { id: "cad", lane: "x", text: "x", tests: "lo", priority: 2 }),
    todo("G", { id: "market", lane: "x", text: "x", tests: "hi", priority: 2 }),
    todo("H", { id: "h1", lane: "x", text: "x", priority: 3 }),
  );
  for (let i = 0; i < 3; i++) apply(s, turn({ todo: "cad", goal: "G", granularity: "substantive" }, T0 + i));
  let pick = rank(s, readyTodos(s, T0 + 10, undefined, new Set(), ["task"]), T0 + 10)!;
  assert.equal(pick.todo.id, "h1", "H has used none of its share");
  apply(s, turn({ todo: "h1", goal: "H", granularity: "substantive" }, T0 + 11));
  for (let i = 0; i < 3; i++) apply(s, turn({ todo: "h1", goal: "H", granularity: "substantive" }, T0 + 12 + i));
  pick = rank(s, readyTodos(s, T0 + 20, undefined, new Set(), ["task"]), T0 + 20)!;
  assert.equal(pick.todo.id, "market", "highest risk x uncertainty first");
  assert.equal(phase(s, "G")!.category, "desirability");
  apply(s, todo("H", { id: "cve", lane: "fix", text: "patch the CVE", priority: 0 }));
  assert.equal(rank(s, readyTodos(s, T0 + 21, undefined, new Set(), ["task"]), T0 + 21)!.todo.id, "cve");
});

test("the handoff packet stays within its budget however long the engagement runs", () => {
  const evs: HEvent[] = [goal({ id: "G", objective: "x".repeat(2000), assumptions: [A({ id: "D", text: "y".repeat(500) })] }), todo("G", { id: "t", lane: "x", text: "z".repeat(3000), tests: "D" })];
  for (let i = 0; i < 200; i++) evs.push({ id: `n${i}`, at: T0 + i, by: "r1", type: "note", goal: "G", text: "note ".repeat(60) }, finding({ goal: "G", assumption: "D", direction: "neutral", grade: "reported", text: "w".repeat(400) }, T0 + i));
  const s = st(...evs);
  const p = buildPacket(s, s.todos.get("t")!, "why");
  assert.ok(p.split("\n").length <= policy.packet.maxLines);
  assert.ok(p.length <= policy.packet.maxChars);
  assert.ok(p.includes("Your todo t"));
});

test("validation: an agent can't make its own work survive a pivot, outlast the turn cap, or name a reviewer nobody is", () => {
  const s = st(goal({ id: "G", assumptions: [A({ id: "D" })] }), todo("G", { id: "r", lane: "x", text: "r", tests: "D" }));
  const v = validate(s, "r", { todos: [
    { lane: "x", text: "mine forever", tests: "D", carry: true, maxTurns: 500, priority: 0 },
    { lane: "x", text: "reviewed by a ghost", tests: "D", review: "ghost" },
  ] });
  const added = v.events.filter((e) => e.type === "todo_added");
  assert.equal(added.length, 1);
  const t = added[0].type === "todo_added" ? added[0].todo : null;
  assert.ok(t && t.carry === undefined && t.maxTurns === policy.retries.maxTurnsPerTodo && t.priority === 1);
  assert.ok(v.reasons.some((r) => r.includes("reviewer ghost is not a principal")));
});

// ---------- the team ----------

const tst = (...events: HEvent[]): State => project([engagement, ...events], teamPolicy);

test("the team follows the work: library roles by lane, a generated role with the least access, a gated permission holds only its lane", () => {
  const g = goal({ id: "G" });
  const s = tst(g, todo("G", { id: "r", lane: "research", text: "r" }), todo("G", { id: "c", lane: "cad", text: "design the printable kit" }), todo("G", { id: "d", lane: "data", text: "split the tickets" }), todo("G", { id: "j", kind: "job", lane: "bench", text: "j", job: { spec: {} } }));
  assert.ok(blockers(s, s.todos.get("r")!, T0).includes("no seat for research yet"), "nothing runs unstaffed");
  const out = settle(s, T0);
  assert.deepEqual(out.filter((e) => e.type === "seat_staffed").map((e) => (e as Extract<HEvent, { type: "seat_staffed" }>).seat.lane).sort(), ["cad", "data", "research"], "lanes with open tasks get seats; a job needs none");
  const research = s.seats.get("G/research")!;
  assert.equal(research.template, "researcher@v1");
  assert.ok(research.permissions.includes("web:read") && !research.probation);
  const cad = s.seats.get("G/cad")!;
  assert.ok(cad.generated && cad.probation);
  assert.deepEqual(cad.permissions, ["repo:read", "repo:write:lease"]);
  assert.match(cad.charter!, /design the printable kit/);
  const data = s.seats.get("G/data")!;
  assert.deepEqual(data.pending, [{ permission: "data:private:read", decision: "data_access" }]);
  assert.ok(!seatPermissions(s, data).includes("data:private:read"), "not before the owner decides");
  assert.deepEqual(blockers(s, s.todos.get("d")!, T0), [`waiting on partner: ${data.ask}`]);
  assert.deepEqual(blockers(s, s.todos.get("r")!, T0), [], "other lanes don't wait");
  for (const e of answerEvents(s, data.ask!, { by: "partner", choice: "grant" }, T0 + 1)) apply(s, e);
  assert.ok(seatPermissions(s, data).includes("data:private:read"));
  assert.deepEqual(blockers(s, s.todos.get("d")!, T0 + 1), []);
  // Template drift never widens access: whatever a role lists, the catalog decides.
  const lib = structuredClone(teamPolicy.team!.library);
  lib.roles.builder.permissions.push("broker:trade", "secrets:read", "made:up");
  const s2 = project([engagement, g, todo("G", { id: "b", lane: "build", text: "b" })], { ...teamPolicy, team: { library: lib, catalog: teamPolicy.team!.catalog } });
  settle(s2, T0);
  assert.deepEqual(s2.seats.get("G/build")!.permissions, ["repo:read", "repo:write:lease", "shell:test", "mcp:context:author"]);
  // Each workstream gets its own team.
  const child = goal({ id: "C", parent: "G", scope: ["work/c"] });
  apply(s, child);
  apply(s, todo("C", { id: "cr", lane: "research", text: "cr" }));
  settle(s, T0 + 2);
  assert.ok(s.seats.has("C/research") && s.seats.get("C/research") !== s.seats.get("G/research"));
});

test("probation: a generated role's work goes to an independent reviewer, unless a checker or a named person vouches for it", () => {
  const s = tst(goal({ id: "G" }), todo("G", { id: "c1", lane: "cad", text: "c1", writeScope: ["work"] }), todo("G", { id: "c2", lane: "cad", text: "c2", writeScope: ["work"] }), todo("G", { id: "p", lane: "cad", text: "p", review: "pharmacist", writeScope: ["work"] }));
  settle(s, T0);
  const seat = s.seats.get("G/cad")!;
  let v = validate(s, "c1", { done: true }, ["work/a"], { seat, checked: true });
  assert.ok(v.events.some((e) => e.type === "todo_done" && e.todo === "c1"), "a passing checker vouches");
  v = validate(s, "p", { done: true }, ["work/p"], { seat });
  assert.ok(v.events.some((e) => e.type === "ask_opened" && e.ask.to === "pharmacist") && !v.events.some((e) => e.type === "todo_added"), "a named reviewer vouches");
  v = validate(s, "c2", { done: true }, ["work/b"], { seat });
  for (const e of v.events) apply(s, e);
  const rev = [...s.todos.values()].find((t) => t.reviews === "c2")!;
  assert.equal(rev.lane, "probation-review");
  assert.equal(s.todos.get("c2")!.status, "review");
  settle(s, T0 + 2);
  const reviewer = s.seats.get("G/probation-review")!;
  assert.equal(reviewer.template, "blind-reviewer@v1");
  assert.notEqual(reviewer.model, seat.model, "reviewed on another model");
  assert.ok(!reviewer.permissions.some((p) => p.startsWith("repo:write")), "a reviewer can't edit what it reviews");
  let r = validate(s, rev.id, { done: true }, [], { seat: reviewer });
  assert.ok(r.reasons.some((x) => x.includes("needs a verdict")) && r.result !== "completed");
  r = validate(s, rev.id, { done: true, verdict: "reject", note: "the overhangs need supports" }, [], { seat: reviewer });
  for (const e of r.events) apply(s, e);
  assert.equal(s.todos.get("c2")!.status, "open");
  assert.match(s.todos.get("c2")!.reason!, /overhangs need supports/);
  assert.equal(s.seats.get("G/cad")!.rejectStreak, 1);
  assert.ok(validate(s, "c1", { verdict: "accept" }, [], { seat }).reasons.some((x) => x.includes("verdict ignored")), "only a review gives a verdict");
});

test("probation ends after three acceptances in a row; two rejections in a row ask the owner and hold only that lane; dropping a review drops the work", () => {
  const s = tst(goal({ id: "G" }), todo("G", { id: "c", lane: "cad", text: "c" }), todo("G", { id: "r", lane: "research", text: "r" }));
  settle(s, T0);
  const verdict = (v: "accept" | "reject", n: number) => apply(s, { id: `v${n}`, at: T0 + n, by: "r1", type: "review_verdict", todo: "c", review: `rv${n}`, seat: "G/cad", verdict: v });
  verdict("reject", 1);
  verdict("reject", 2);
  const ask = settle(s, T0 + 3).find((e) => e.type === "ask_opened" && e.ask.origin === "rule:probation");
  assert.ok(ask && ask.type === "ask_opened" && ask.ask.lane === "cad" && !ask.ask.blocksGoal);
  assert.ok(blockers(s, s.todos.get("c")!, T0 + 3).some((x) => x.includes(ask.id)));
  assert.deepEqual(blockers(s, s.todos.get("r")!, T0 + 3), []);
  for (const e of answerEvents(s, ask.id, { by: "partner", choice: "keep" }, T0 + 4)) apply(s, e);
  verdict("accept", 5);
  verdict("accept", 6);
  assert.ok(s.seats.get("G/cad")!.probation);
  verdict("accept", 7);
  assert.ok(!s.seats.get("G/cad")!.probation, "promoted");
  // Work in review whose review was dropped never slips through.
  const s2 = tst(goal({ id: "G" }), todo("G", { id: "w", lane: "cad", text: "w" }), todo("G", { id: "rv", lane: "probation-review", text: "rv", reviews: "w" }));
  apply(s2, { id: "rev", at: T0 + 1, by: "r1", type: "todo_review", todo: "w", reviewTodo: "rv" });
  apply(s2, { id: "sup-rv", at: T0 + 2, by: "r1", type: "todo_superseded", todo: "rv", reason: "replan" });
  settle(s2, T0 + 3);
  assert.equal(s2.todos.get("w")!.status, "superseded");
});

test("the library's judges run on another model than the work they judge", () => {
  const { library, catalog } = teamPolicy.team!;
  assert.deepEqual(checkLibrary(library, catalog), []);
  const same = structuredClone(library);
  same.roles.strategist.model = "model-a";
  assert.ok(checkLibrary(same, catalog).some((v) => v.startsWith("judge lane replan")));
  const rev = structuredClone(library);
  rev.roles["blind-reviewer"].model = rev.generated!.model;
  assert.ok(checkLibrary(rev, catalog).some((v) => v.startsWith("judge lane probation-review")));
  const typo = structuredClone(library);
  typo.lanes!.cad = "cad-designer";
  assert.ok(checkLibrary(typo, catalog).some((v) => v.includes("unknown role cad-designer")));
});

test("Copilot CLI turns run as their seat: the role's agent and model, tools from its permissions, a generated role's charter", () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "policy", "harness-agents.json"), "utf8"));
  const s = tst(goal({ id: "G" }), todo("G", { id: "r", lane: "research", text: "r" }), todo("G", { id: "y", lane: "synthesis", text: "y" }), todo("G", { id: "c", lane: "cad", text: "design the printable kit" }), todo("G", { id: "pr", lane: "probation-review", text: "review c", reviews: "c" }));
  settle(s, T0);
  // Profiles installed for the researcher and the generated-role fallback, not the strategist.
  const profiles = fs.mkdtempSync(path.join(os.tmpdir(), "af-profiles-"));
  for (const n of ["af-researcher", "af-author", "af-blind-reviewer"]) fs.writeFileSync(path.join(profiles, `${n}.agent.md`), `---\nname: ${n}\n---\n`);
  const agent = new CopilotTurnAgent({ fallback: cfg.fallback, agents: cfg.agents, profilePrefix: cfg.profilePrefix, profileDirs: [profiles], models: { "model-a": "plan-a" }, tools: { tools: cfg.tools, always: cfg.always }, timeoutMs: 1000 });
  const ctx = (id: string): TurnContext => {
    const t = s.todos.get(id)!;
    const seat = seatOf(s, t)!;
    return { turn: "x", agent: "r1", now: T0, packet: "PACKET", todo: t, goal: s.goals.get("G")!.def, beliefs: [], findings: [], wtDir: tmp, state: s, seat: { ...seat, effective: seatPermissions(s, seat) } };
  };
  const pairs = (f: string[]) => f.map((x, i) => (x.startsWith("--") ? `${x} ${f[i + 1]}` : "")).filter(Boolean);
  const r = agent.launch(ctx("r"));
  assert.deepEqual([r.agent, r.model], ["af-researcher", "plan-a"], "placeholders map to your plan's models");
  assert.ok(pairs(r.flags).includes("--allow-tool web_fetch") && pairs(r.flags).includes("--allow-tool write"));
  const y = agent.launch(ctx("y"));
  assert.deepEqual([y.agent, y.model], [undefined, undefined], "no profile installed: no --agent; an unmapped placeholder: no --model; rather than a failed turn");
  assert.ok(pairs(y.flags).includes("--deny-tool write"), "a judge can't write");
  assert.ok(pairs(y.flags).includes("--deny-tool shell(git push)"));
  const c = agent.launch(ctx("c"));
  assert.equal(c.agent, "af-author", "a generated role runs as the fallback profile...");
  const prompt = agent.prompt(ctx("c"));
  assert.match(prompt, /design the printable kit/, "...with its charter in the prompt");
  assert.match(prompt, /on probation/);
  assert.match(agent.prompt(ctx("pr")), /"verdict": "accept" or "reject"/);
});

test("evidence you produced means your seat's, not your machine's: synthesis can discount the researcher's finding from the same laptop", () => {
  const s = tst(
    goal({ id: "G", assumptions: [A({ id: "F", category: "feasibility" })] }), todo("G", { id: "syn", lane: "synthesis", text: "s" }), todo("G", { id: "r", lane: "research", text: "r" }),
    finding({ id: "theirs", goal: "G", assumption: "F", direction: "supports", grade: "reported", author: "G/research" }),
    finding({ id: "mine", goal: "G", assumption: "F", direction: "refutes", grade: "reported", author: "G/synthesis" }),
  );
  settle(s, T0);
  const v = validate(s, "syn", { discount: [{ finding: "theirs", reason: "the blog cites itself" }, { finding: "mine", reason: "x" }] }, [], { seat: s.seats.get("G/synthesis") });
  assert.deepEqual(v.events.filter((e) => e.type === "finding_discounted").map((e) => (e as { finding: string }).finding), ["theirs"]);
  assert.ok(v.reasons.some((x) => x.includes("can't discount evidence you produced")));
});

test("event time respects cause and effect: a writer never stamps an event before what it has read", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-hlc-"));
  const note = (id: string, at: number): HEvent => ({ id, at, by: "r", type: "note", goal: "G", text: id });
  writeEventFiles(dir, "e", [note("turn-sent-to-review", 1000)]);
  // Same millisecond, and a runner whose clock is behind: both land after what they read.
  writeEventFiles(dir, "e", [note("a-review-verdict", 1000), note("b-skewed-clock", 400)]);
  writeEventFiles(dir, "e", [note("later", 5000)]);
  const evs = readEvents(dir, "e");
  assert.deepEqual(evs.map((e) => e.id), ["turn-sent-to-review", "a-review-verdict", "b-skewed-clock", "later"]);
  assert.deepEqual(evs.map((e) => e.at), [1000, 1001, 1001, 5000], "nudged only as far as needed");
});

test("what people said reaches the agents whose work depends on it, through earlier work too", () => {
  const s = st(
    goal({ id: "G" }),
    todo("G", { id: "profile", kind: "action", lane: "intake", text: "Tell us about him", assignee: "pharmacist" }),
    todo("G", { id: "core", lane: "build", text: "core", after: ["profile"] }),
    todo("G", { id: "levels", lane: "levels", text: "levels", after: ["core"] }),
    todo("G", { id: "other", lane: "build", text: "unrelated" }),
  );
  settle(s, T0);
  const ask = [...s.asks.values()].find((a) => a.todo === "profile")!;
  for (const e of answerEvents(s, ask.id, { by: "pharmacist", choice: "done", note: "Loves trains. Loud crash sounds upset him. Plays on a laptop with the space bar." }, T0 + 1)) apply(s, e);
  for (const id of ["core", "levels"]) assert.match(buildPacket(s, s.todos.get(id)!, "test"), /From pharmacist .*Loves trains/, id);
  assert.doesNotMatch(buildPacket(s, s.todos.get("other")!, "test"), /Loves trains/, "work that doesn't depend on it doesn't get it");
});
