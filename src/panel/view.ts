// What the panel shows, computed from an engagement's state. Pure: the page is a
// projection of the event log like everything else, never a second copy of the state.
import { heldBy } from "../harness/harness.ts";
import type { AskState, State, TodoState } from "../harness/project.ts";
import { beliefs, findAssumption } from "../harness/project.ts";
import { blockers, phase } from "../harness/select.ts";
import type { AskKind, BeliefStatus, Budget, GoalRevision, Granularity, TurnResult } from "../harness/types.ts";

// Some options need more than a click: a number, the revised goal, or what you saw.
export type Needs = "budget" | "revision" | "observation";

// confirm: it can't be undone (a goal closed, work dropped), so it takes a second
// step; danger: it stops or drops something.
export type OptionView = { id: string; label: string; needs?: Needs; hint?: string; confirm?: boolean; danger?: boolean };

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
  budget?: Budget; // now, for a raise
  revision?: GoalRevision; // the goal as it stands, to edit into a new direction
  tests?: { id: string; text: string }; // what an observation counts toward
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
  seats: Array<{ lane: string; role: string; generated: boolean; probation: boolean; accepted: number; rejected: number; promoteAfter: number }>;
  work: WorkView[];
  workMore: number;
  turnLog: Array<{ at: number; todo: string; text: string; result: TurnResult; granularity: Granularity; reasons: string[] }>;
};

export type RunnerView = { id: string; at: number; quiet: boolean; next?: { at: number; why: string } };

export type EngagementView = {
  id: string;
  title: string;
  paused: { at: number; by: string; reason?: string } | null;
  goals: GoalView[];
  asks: AskView[];
  runners: RunnerView[];
  folder?: string; // where it was opened, when the panel shows more than one folder
  error?: string;
};

const WORK_SHOWN = 6;
const TURNS_SHOWN = 48;
const STATE_ORDER = { running: 0, review: 1, ready: 2, held: 3 } as const;

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

export function askView(s: State, engagement: string, a: AskState): AskView {
  const g = s.goals.get(a.goal);
  const t = a.todo ? s.todos.get(a.todo) : undefined;
  const tests = t?.tests ? findAssumption(s, a.goal, t.tests) : null;
  const options = a.options.map((o) => ({
    id: o.id,
    // Changing the approach without a new goal: say what changes, for the agents.
    ...(o.effect?.type === "revise" && !optionNeeds(a, o) ? { hint: "What changes" } : {}),
    ...splitLabel(o.label),
    ...(optionNeeds(a, o) ? { needs: optionNeeds(a, o) } : {}),
    ...(o.effect && ["close", "supersede", "decide"].includes(o.effect.type) ? { confirm: true } : {}),
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
    evidence: (a.evidence ?? []).map((id) => s.findings.get(id)).filter((f) => !!f).map((f) => ({ grade: f.grade, direction: f.direction, text: f.text })),
    options,
    ...(g && options.some((o) => o.needs === "budget") ? { budget: g.def.budget } : {}),
    ...(g && options.some((o) => o.needs === "revision") ? { revision: { objective: g.def.objective, assumptions: g.def.assumptions, success: g.def.success, kill: g.def.kill, todos: [] } } : {}),
    ...(tests ? { tests: { id: tests.def.id, text: tests.def.text } } : {}),
  };
}

function workView(s: State, t: TodoState, now: number): WorkView {
  const base = { id: t.id, text: t.text, lane: t.lane, kind: t.kind };
  if (t.status === "running") return { ...base, state: "running", ...(t.kind === "action" ? { why: "waiting on a person" } : {}) };
  if (t.status === "review") return { ...base, state: "review", ...(t.ask ? { why: `waiting on ${s.asks.get(t.ask)?.to ?? "review"}` } : t.reviewTodo ? { why: "independent review" } : {}) };
  if (t.status === "blocked") return { ...base, state: "held", why: t.reason ?? "blocked" };
  const why = blockers(s, t, now);
  return why.length ? { ...base, state: "held", why: why[0] } : { ...base, state: "ready" };
}

export function goalView(s: State, goalId: string, now: number): GoalView {
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
    seats: [...s.seats.values()].filter((x) => x.goal === goalId).map((x) => ({ lane: x.lane, role: x.role, generated: x.generated, probation: x.probation, accepted: x.accepted, rejected: x.rejected, promoteAfter: s.policy.probation?.promoteAfter ?? 3 })),
    work: work.slice(0, WORK_SHOWN),
    workMore: Math.max(0, work.length - WORK_SHOWN),
    turnLog: s.turns.filter((t) => t.goal === goalId).slice(-TURNS_SHOWN).map((t) => ({ at: t.at, todo: t.todo, text: s.todos.get(t.todo)?.text ?? t.todo, result: t.result, granularity: t.granularity, reasons: t.reasons.slice(0, 3).map((r) => r.slice(0, 240)) })),
  };
}

export function engagementView(s: State, id: string, now: number, runners: RunnerView[]): EngagementView {
  // Goals in the order they were opened; closed ones after the active ones.
  const goals = [...s.goals.values()].sort((a, b) => Number(a.status !== "active") - Number(b.status !== "active") || a.openedAt - b.openedAt);
  const asks = [...s.asks.values()].filter((a) => a.status === "open").map((a) => askView(s, id, a));
  return { id, title: s.engagement?.title ?? id, paused: s.paused, goals: goals.map((g) => goalView(s, g.id, now)), asks, runners };
}
