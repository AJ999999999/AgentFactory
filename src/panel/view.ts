// What the panel shows, computed from an engagement's state. Pure: the page is a
// projection of the event log like everything else, never a second copy of the state.
import type { LiveView } from "../harness/live.ts";
import { heldBy } from "../harness/harness.ts";
import type { AskState, SeatState, State, TodoState } from "../harness/project.ts";
import { beliefs, capacityFor, findAssumption, seatKey, seatPermissions } from "../harness/project.ts";
import { vendorOfModel } from "../harness/agents.ts";
import { blockers, phase } from "../harness/select.ts";
import { irreversibleEffect } from "../harness/types.ts";
import type { AskKind, BeliefStatus, Budget, GoalRevision, Granularity, TurnResult } from "../harness/types.ts";
import { isBlind } from "../harness/escalation.ts";

// Some options need more than a click: a number, the revised goal, or what you saw.
export type Needs = "budget" | "revision" | "observation";

// confirm: it can't be undone (a goal closed, work dropped), so it takes a second
// step; danger: it stops or drops something.
// irreversible: by its effect, or because the asker says so. Only ever adds caution: an
// asker can mark an option irreversible but can't make one with a final effect undoable.
export type OptionView = { id: string; label: string; needs?: Needs; hint?: string; confirm?: boolean; danger?: boolean; consequence?: string; irreversible?: boolean };

export type AskView = {
  engagement: string;
  id: string;
  goal: string;
  goalTitle: string;
  to: string;
  kind: AskKind;
  question: string;
  urgent: boolean;
  openedAt: number;
  about?: string; // the work it is about
  holds: string[]; // the work it holds up
  evidence: Array<{ grade: string; direction: string; text: string }>;
  options: OptionView[];
  recommend?: { option: string; label: string; why: string; by: string };
  blind?: true; // the recommendation is held back until you answer
  // Why this one shouldn't be answered from the card in one click. Empty: the card has
  // what the answer needs.
  lookFirst: string[];
  budget?: Budget; // now, for a raise
  revision?: GoalRevision; // the goal as it stands, to edit into a new direction
  tests?: { id: string; text: string }; // what an observation counts toward
  // The flow around the question, for deciding it: whether the goal can move at all
  // without an answer, and how the turns that led here went.
  stalls: boolean; // nothing else in its goal can run until a question is answered
  stalledWith?: number; // when it stalls: the other open questions that hold the same goal's work
  history: Array<{ at: number; result: TurnResult; reason?: string }>; // the work's last turns, newest first
};

// One agent: a seat as the partner sees it. What it's doing now, what runs it, what it
// may do, and how its turns have gone.
export type AgentNow =
  | { state: "running"; turn: string; text: string; since: number }
  | { state: "waiting"; vendor: string; until: number; kind: "limit" | "unreachable" | "setup"; reason: string }
  | { state: "asking"; why: string } // a permission it needs waits on the goal's owner
  // Nothing of its runs on this PC now. open: work in its lane not started; underway:
  // started (a job, a person's task, a review, or a turn on another PC).
  | { state: "idle"; open: number; underway: number };

export type AgentView = {
  key: string; // "<goal>/<lane>"
  template: string;
  model: string; // the library's placeholder
  // What the agents policy maps that placeholder to: the CLI, and its model ("" for
  // that CLI's default). Absent when the panel wasn't given the mapping.
  runsOn?: { cli: string; model: string };
  charter?: string;
  permissions: string[]; // what it may do now
  pending: Array<{ permission: string; decision: string; state: "asking" | "declined" }>;
  now: AgentNow;
  turns: { total: number; done: number; failed: number; stopped: number; lastAt?: number };
  recent: Array<{ at: number; result: TurnResult; granularity: Granularity; text: string; reason?: string }>; // newest first
};

export type SeatView = { lane: string; role: string; generated: boolean; probation: boolean; accepted: number; rejected: number; promoteAfter: number; agent: AgentView };

// What the view needs besides the state: the model mapping from the agents policy, and
// the turns running on this PC. Both are optional, and the view stays pure.
export type ViewContext = { models?: Record<string, string>; running?: Array<{ turn: string; todo: string; goal: string; text: string; startedAt: number }> };

// How work is moving in a goal: where it sits now, and what changed in the last day.
export type FlowView = {
  running: number; // a turn or a job under way
  ready: number; // could start at the next wake
  asking: number; // held by an open question
  held: number; // held by something else: a dependency, a limit, a pause
  person: number; // a person's task under way
  day: { added: number; done: number; failed: number };
};

export type WorkView = { id: string; text: string; lane: string; kind: string; state: "running" | "review" | "ready" | "held"; why?: string };

export type GoalView = {
  id: string;
  title: string;
  status: "active" | "done" | "killed";
  version: number;
  turns: { spent: number; budget?: number; warnAt: number };
  usd: { spent: number; budget?: number };
  beliefs: Array<{ id: string; text: string; status: BeliefStatus; category: string; loadBearing: boolean; riskiest: boolean }>;
  seats: SeatView[];
  work: WorkView[];
  workMore: number;
  flow: FlowView;
  turnLog: Array<{ at: number; todo: string; text: string; result: TurnResult; granularity: Granularity; reasons: string[] }>;
};

export type RunnerView = { id: string; at: number; quiet: boolean; next?: { at: number; why: string } };

export type EngagementView = {
  id: string;
  title: string;
  paused: { at: number; by: string; reason?: string } | null;
  capacity: Array<{ vendor: string; until: number; reason: string; kind: "limit" | "unreachable" | "setup" }>; // a model service said "not now"
  running?: LiveView[]; // turns running on this PC now, with the end of each log
  goals: GoalView[];
  asks: AskView[];
  runners: RunnerView[];
  folder?: string; // where it was opened, when the panel shows more than one folder
  error?: string;
};

const WORK_SHOWN = 6;
const TURNS_SHOWN = 48;
const STATE_ORDER = { running: 0, review: 1, ready: 2, held: 3 } as const;
const AGENT_RECENT = 12;
const DAY_MS = 86_400_000;
const HISTORY_SHOWN = 5;

// Which live work open questions hold, by todo id.
function askedWork(s: State): Set<string> {
  const out = new Set<string>();
  for (const a of s.asks.values()) if (a.status === "open") for (const t of heldBy(s, a)) out.add(t.id);
  return out;
}

const liveWork = (s: State, goal: string) => [...s.todos.values()].filter((t) => t.goal === goal && ["open", "running", "review", "blocked"].includes(t.status));

export function flowView(s: State, goal: string, now: number, asked = askedWork(s)): FlowView {
  const f: FlowView = { running: 0, ready: 0, asking: 0, held: 0, person: 0, day: { added: 0, done: 0, failed: 0 } };
  for (const t of liveWork(s, goal)) {
    const w = workView(s, t, now);
    if (w.state === "running") t.kind === "action" ? f.person++ : f.running++;
    else if (asked.has(t.id)) f.asking++;
    else if (w.state === "ready") f.ready++;
    else f.held++; // a review in progress, or held by something other than a question
  }
  for (const t of s.todos.values()) {
    if (t.goal !== goal) continue;
    if (t.addedAt > now - DAY_MS) f.day.added++;
    if (t.doneAt !== undefined && t.doneAt > now - DAY_MS) f.day.done++;
  }
  f.day.failed = s.turns.filter((t) => t.goal === goal && t.at > now - DAY_MS && (t.result === "host_failure" || t.result === "validation_failed")).length;
  return f;
}

// "Send back (answer with what to fix)" -> "Send back", with "What to fix" as the
// prompt in the note: the page asks for what the parenthesis describes. Other
// parentheses say what the option does ("Reject (the todo is dropped)") and stay.
export function splitLabel(label: string): { label: string; hint?: string } {
  const m = label.match(/^(.*?)\s*\((?:answer with|recorded with|attach) ([^)]*)\)\s*$/);
  if (!m || !m[1]) return { label };
  return { label: m[1], hint: m[2][0].toUpperCase() + m[2].slice(1) };
}

export function optionNeeds(a: AskState, o: AskState["options"][number]): Needs | undefined {
  const e = o.effect;
  if (e?.type === "budget") return "budget";
  // A new direction, or a revision with nothing given yet ("narrow the scope", "plan
  // the next stage"), needs the revised goal. "Fix and retest" needs only a note.
  if (e?.type === "revise" && (e.pivot || (!e.revision && !e.resetAssumptions?.length))) return "revision";
  if (a.kind === "action" && o.id === "done") return "observation";
  return undefined;
}

export function askView(s: State, engagement: string, a: AskState, now = s.lastAt, asked = askedWork(s)): AskView {
  const g = s.goals.get(a.goal);
  const t = a.todo ? s.todos.get(a.todo) : undefined;
  const tests = t?.tests ? findAssumption(s, a.goal, t.tests) : null;
  const evidence = (a.evidence ?? []).map((id) => s.findings.get(id)).filter((f) => !!f).map((f) => ({ grade: f.grade, direction: f.direction, text: f.text }));
  // A blind question keeps its recommendation hidden until it is answered (see isBlind).
  const blind = a.status === "open" && isBlind(s.policy, a);
  const rec = a.recommend && !blind ? a.options.find((o) => o.id === a.recommend!.option) : undefined;
  const final = (o: AskState["options"][number]) => irreversibleEffect(o.effect) || o.irreversible === true;
  const lookFirst = [
    ...(rec && final(rec) ? ["what it recommends can't be undone"] : []),
    ...(evidence.some((f) => f.direction === "supports") && evidence.some((f) => f.direction === "refutes") ? ["the evidence points both ways"] : []),
  ];
  const options = a.options.map((o) => ({
    id: o.id,
    // Changing the approach without a new goal: say what changes, for the agents.
    ...(o.effect?.type === "revise" && !optionNeeds(a, o) ? { hint: "What changes" } : {}),
    ...splitLabel(o.label),
    ...(optionNeeds(a, o) ? { needs: optionNeeds(a, o) } : {}),
    ...(o.consequence ? { consequence: o.consequence } : {}),
    ...(final(o) ? { irreversible: true } : {}),
    // Can't be undone, or the card itself says to look first: a second step, not one click.
    ...(final(o) || lookFirst.length ? { confirm: true } : {}),
    ...((o.effect?.type === "close" && o.effect.status === "killed") || o.effect?.type === "supersede" ? { danger: true } : {}),
  }));
  return {
    engagement,
    id: a.id,
    goal: a.goal,
    goalTitle: g?.def.title ?? a.goal,
    to: a.to,
    kind: a.kind,
    question: a.question,
    urgent: !!a.urgent,
    openedAt: a.openedAt,
    ...(t && t.text !== a.question ? { about: t.text } : {}),
    holds: heldBy(s, a).filter((x) => x.id !== a.todo).map((x) => x.text),
    evidence,
    options,
    ...(rec ? { recommend: { option: rec.id, label: splitLabel(rec.label).label, why: a.recommend!.why, by: a.recommend!.by } } : {}),
    lookFirst,
    ...(blind ? { blind: true } : {}),
    ...(g && options.some((o) => o.needs === "budget") ? { budget: g.def.budget } : {}),
    ...(g && options.some((o) => o.needs === "revision") ? { revision: { objective: g.def.objective, assumptions: g.def.assumptions, success: g.def.success, kill: g.def.kill, todos: [] } } : {}),
    ...(tests ? { tests: { id: tests.def.id, text: tests.def.text } } : {}),
    stalls: stalls(s, a, now, asked),
    ...(stalls(s, a, now, asked) ? { stalledWith: [...s.asks.values()].filter((x) => x.id !== a.id && x.status === "open" && x.goal === a.goal && heldBy(s, x).length).length } : {}),
    history: history(s, a),
  };
}

// The goal can't move without an answer: it's active, not paused, this question holds
// some of its work, and none of its work can run or is running. A person's task under
// way doesn't count as moving: it waits on someone too.
function stalls(s: State, a: AskState, now: number, asked: Set<string>): boolean {
  const g = s.goals.get(a.goal);
  if (!g || g.status !== "active" || s.paused || !heldBy(s, a).length) return false;
  return !liveWork(s, a.goal).some((t) => !asked.has(t.id) && (t.status === "running" ? t.kind !== "action" : workView(s, t, now).state === "ready"));
}

// The turns behind the question: on its own work, or else on the lane it holds.
function history(s: State, a: AskState): AskView["history"] {
  const lane = a.lane ? seatKey(a.goal, a.lane) : undefined;
  const mine = s.turns.filter((t) => (a.todo ? t.todo === a.todo : lane !== undefined && (t.seat ?? seatKey(t.goal, s.todos.get(t.todo)?.lane ?? "")) === lane));
  return mine.slice(-HISTORY_SHOWN).reverse().map((t) => ({ at: t.at, result: t.result, ...(t.reasons[0] ? { reason: t.reasons[0].slice(0, 240) } : {}) }));
}

function workView(s: State, t: TodoState, now: number): WorkView {
  const base = { id: t.id, text: t.text, lane: t.lane, kind: t.kind };
  if (t.status === "running") return { ...base, state: "running", ...(t.kind === "action" ? { why: "waiting on a person" } : {}) };
  if (t.status === "review") return { ...base, state: "review", ...(t.ask ? { why: `waiting on ${s.asks.get(t.ask)?.to ?? "review"}` } : t.reviewTodo ? { why: "independent review" } : {}) };
  if (t.status === "blocked") return { ...base, state: "held", why: t.reason ?? "blocked" };
  const why = blockers(s, t, now);
  return why.length ? { ...base, state: "held", why: why[0] } : { ...base, state: "ready" };
}

// "claude:opus" -> Claude Code on opus; "" -> Copilot's default; "gpt-5" -> Copilot on gpt-5.
export function runsOn(mapped: string): { cli: string; model: string } {
  const cli = vendorOfModel(mapped);
  return { cli, model: cli === "copilot" ? mapped : mapped.slice(cli.length + 1) };
}

export function agentView(s: State, seat: SeatState, now: number, ctx: ViewContext = {}): AgentView {
  const inLane = (t: { goal: string; lane: string }) => t.goal === seat.goal && t.lane === seat.lane;
  // Older turn records don't name their seat: the todo's lane says whose turn it was.
  const mine = s.turns.filter((t) => (t.seat ?? (s.todos.get(t.todo) ? seatKey(t.goal, s.todos.get(t.todo)!.lane) : "")) === seat.key);
  const ask = seat.ask ? s.asks.get(seat.ask) : undefined;
  const granted = ask?.status === "answered" && ask.choice === "grant";
  const pending = granted ? [] : seat.pending.map((p) => ({ ...p, state: (ask?.status === "open" ? "asking" : "declined") as "asking" | "declined" }));
  const live = (ctx.running ?? []).find((r) => { const t = s.todos.get(r.todo); return !!t && inLane(t); });
  const cap = capacityFor(s, seat.model, now);
  const lane = [...s.todos.values()].filter((t) => inLane(t) && t.status === "open");
  let state: AgentNow;
  if (live) state = { state: "running", turn: live.turn, text: live.text, since: live.startedAt };
  // The owner's decision holds the whole lane, so it comes before a usage limit.
  else if (ask?.status === "open") state = { state: "asking", why: ask.question };
  else if (cap && lane.length) state = { state: "waiting", vendor: cap.vendor, until: cap.until, kind: cap.kind, reason: cap.reason };
  else state = { state: "idle", open: lane.length, underway: [...s.todos.values()].filter((t) => inLane(t) && (t.status === "running" || t.status === "review")).length };
  const mapped = ctx.models?.[seat.model];
  return {
    key: seat.key,
    template: seat.template,
    model: seat.model,
    ...(mapped !== undefined ? { runsOn: runsOn(mapped) } : {}),
    ...(seat.charter ? { charter: seat.charter } : {}),
    permissions: seatPermissions(s, seat),
    pending,
    now: state,
    turns: {
      total: mine.length,
      done: mine.filter((t) => t.result === "completed").length,
      failed: mine.filter((t) => t.result === "host_failure" || t.result === "validation_failed").length,
      stopped: mine.filter((t) => t.result === "stopped").length,
      ...(mine.length ? { lastAt: mine[mine.length - 1].at } : {}),
    },
    recent: mine.slice(-AGENT_RECENT).reverse().map((t) => ({ at: t.at, result: t.result, granularity: t.granularity, text: s.todos.get(t.todo)?.text ?? t.todo, ...(t.reasons[0] ? { reason: t.reasons[0].slice(0, 240) } : {}) })),
  };
}

export function goalView(s: State, goalId: string, now: number, ctx: ViewContext = {}): GoalView {
  const g = s.goals.get(goalId)!;
  const ph = phase(s, goalId);
  const live = [...s.todos.values()].filter((t) => t.goal === goalId && ["open", "running", "review", "blocked"].includes(t.status));
  const work = live.map((t) => workView(s, t, now)).sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]);
  return {
    id: g.id,
    title: g.def.title,
    status: g.status,
    version: g.version,
    turns: { spent: g.spent.turns, ...(g.def.budget.turns !== undefined ? { budget: g.def.budget.turns } : {}), warnAt: s.policy.budget.warnAt },
    usd: { spent: g.spent.usd, ...(g.def.budget.usd !== undefined ? { budget: g.def.budget.usd } : {}) },
    beliefs: beliefs(s, goalId).map((b) => ({ id: b.def.id, text: b.def.text, status: b.status, category: b.def.category, loadBearing: !!b.def.loadBearing, riskiest: ph?.assumption === b.def.id })),
    seats: [...s.seats.values()].filter((x) => x.goal === goalId).map((x) => ({ lane: x.lane, role: x.role, generated: x.generated, probation: x.probation, accepted: x.accepted, rejected: x.rejected, promoteAfter: s.policy.probation?.promoteAfter ?? 3, agent: agentView(s, x, now, ctx) })),
    work: work.slice(0, WORK_SHOWN),
    flow: flowView(s, goalId, now),
    workMore: Math.max(0, work.length - WORK_SHOWN),
    turnLog: s.turns.filter((t) => t.goal === goalId).slice(-TURNS_SHOWN).map((t) => ({ at: t.at, todo: t.todo, text: s.todos.get(t.todo)?.text ?? t.todo, result: t.result, granularity: t.granularity, reasons: t.reasons.slice(0, 3).map((r) => r.slice(0, 240)) })),
  };
}

export function engagementView(s: State, id: string, now: number, runners: RunnerView[], ctx: ViewContext = {}): EngagementView {
  // Goals in the order they were opened; closed ones after the active ones.
  const goals = [...s.goals.values()].sort((a, b) => Number(a.status !== "active") - Number(b.status !== "active") || a.openedAt - b.openedAt);
  const asked = askedWork(s);
  const asks = [...s.asks.values()].filter((a) => a.status === "open").map((a) => askView(s, id, a, now, asked));
  return { id, title: s.engagement?.title ?? id, paused: s.paused, capacity: [...s.capacity.values()].filter((c) => c.until > now).map((c) => ({ vendor: c.vendor, until: c.until, reason: c.reason, kind: c.kind })), goals: goals.map((g) => goalView(s, g.id, now, ctx)), asks, runners };
}
