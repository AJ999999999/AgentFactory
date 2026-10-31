// Readiness, ranking and wake-up time. Pure functions over the projection.
//
// A todo is ready when nothing in its way is unresolved. Gates are scoped by the
// dependency graph: an open question blocks the todos that depend on it (or the
// whole goal, when the question is about the goal itself), never "the agent". Agents
// are ephemeral here; blocking by agent identity would block nothing or everything.
import { pathsOverlap } from "../util.ts";
import type { PulseData } from "./claims.ts";
import type { AskState, State, TodoState } from "./project.ts";
import { beliefOf, findAssumption, goalChain, seatKey } from "./project.ts";

export type Runner = { id: string; capabilities: string[] };

const DAY = 86_400_000;
const MIN = 60_000;

export function ts(iso: string | undefined): number | undefined {
  return iso ? Date.parse(iso) : undefined;
}

export function activeFreezes(s: State): Array<{ todo: string; paths: string[] }> {
  return [...s.todos.values()].filter((t) => t.status === "running" && t.freeze?.length).map((t) => ({ todo: t.id, paths: t.freeze! }));
}

export function spendAskId(todo: string): string {
  return `ask-spend-${todo}`;
}

function askSatisfied(a: AskState | undefined): boolean {
  if (!a || a.status !== "answered") return false;
  const opt = a.options.find((o) => o.id === a.choice);
  // An approval answered "reject" never satisfies a dependency (the todo is superseded).
  return !(a.kind === "approval" && opt?.effect?.type !== "approve");
}

// A goal's own closure stops its work; a parent's matters only if it was killed (a
// parent closed as done, e.g. a discovery phase, leaves its workstreams running).
export function goalBlocks(s: State, goalId: string): string[] {
  const out: string[] = [];
  for (const [i, g] of goalChain(s, goalId).entries()) {
    if (i === 0 ? g.status !== "active" : g.status === "killed") out.push(`goal ${g.id} is ${g.status}`);
    for (const a of s.asks.values()) if (a.status === "open" && a.goal === g.id && a.blocksGoal) out.push(`waiting on ${a.to}: ${a.id}`);
  }
  return out;
}

// Why this todo can't run now (empty = ready). Claims are checked by the caller.
export function blockers(s: State, t: TodoState, now: number, runner?: Runner): string[] {
  const why: string[] = [];
  if (t.status !== "open") return [`status ${t.status}`];
  why.push(...goalBlocks(s, t.goal));
  const chain = goalChain(s, t.goal);
  const g = chain[0];
  if (!g) return ["unknown goal"];

  if (t.kind === "task" && t.lane !== "replan") {
    const replan = [...s.todos.values()].find((x) => x.goal === t.goal && x.lane === "replan" && ["open", "running"].includes(x.status));
    if (replan) why.push(`replan first: ${replan.id}`);
  }
  if (t.kind === "task") {
    // Seat questions (a permission, a struggling generated role) hold only that lane.
    for (const a of s.asks.values()) if (a.status === "open" && a.lane === t.lane && a.goal === t.goal) why.push(`waiting on ${a.to}: ${a.id}`);
    if (s.policy.team && !s.seats.has(seatKey(t.goal, t.lane))) why.push(`no seat for ${t.lane} yet`);
  }
  for (const dep of t.after ?? []) {
    const d = s.todos.get(dep);
    if (d) {
      if (d.status !== "done") why.push(`after ${dep} (${d.status})`);
      continue;
    }
    const a = s.asks.get(dep);
    if (!askSatisfied(a)) why.push(`after ${dep} (${a ? a.status : "missing"})`);
  }
  if (t.cost?.usd && t.cost.usd > s.policy.money.autoApproveUsd && !askSatisfied(s.asks.get(spendAskId(t.id)))) why.push(`spend $${t.cost.usd} not approved`);
  for (const id of t.assumes ?? []) {
    const a = findAssumption(s, t.goal, id);
    if (!a) {
      why.push(`assumes unknown ${id}`);
      continue;
    }
    const b = beliefOf(s, a.goal, a.def);
    if (b.status !== "supported") why.push(`assumes ${id} (${b.status})`);
  }
  const nb = ts(t.notBefore);
  if (nb !== undefined && nb > now) why.push(`not before ${t.notBefore}`);
  for (const gg of chain) {
    for (const b of gg.def.blackouts ?? []) {
      if (b.lanes.includes(t.lane) && ts(b.from)! <= now && now < ts(b.to)!) why.push(`blackout until ${b.to}: ${b.reason}`);
    }
  }
  for (const f of activeFreezes(s)) {
    if (f.todo !== t.id && (t.writeScope ?? []).some((p) => f.paths.some((q) => pathsOverlap(p, q)))) why.push(`frozen by running ${f.todo}`);
  }
  // Budgets are the goal's own: a child's budget was carved out of its parent's when
  // it was spawned, so the parent's spending can't starve it (closing the parent can).
  const b = g.def.budget;
  if (t.kind === "task") {
    if (b.turns !== undefined && g.spent.turns >= b.turns) why.push(`turn budget of ${g.id} spent`);
    if (b.turnsPerWeek !== undefined && g.turnTimes.filter((x) => x > now - 7 * DAY).length >= b.turnsPerWeek) why.push(`weekly turn rate of ${g.id} reached`);
  }
  if (t.kind === "job" && t.job?.gpuHours && b.gpuHours !== undefined && g.spent.gpuHours + t.job.gpuHours > b.gpuHours) why.push(`gpu budget of ${g.id}`);
  const cap = t.maxTurns ?? s.policy.retries.maxTurnsPerTodo;
  if (t.kind === "task" && t.turns - t.capFrom >= cap) why.push(`turn cap ${cap} reached`);
  if (runner) {
    const missing = (t.requires ?? []).filter((c) => !runner.capabilities.includes(c));
    if (missing.length) why.push(`needs ${missing.join(",")}`);
    if ((t.excludeAgents ?? []).includes(runner.id)) why.push(`excluded ${runner.id}`);
  }
  return why;
}

export function voi(s: State, t: TodoState): number {
  const ids = [t.tests, ...(t.job?.informs ?? []).map((i) => i.assumption), ...(t.wait?.informs ?? []).map((i) => i.assumption)].filter(Boolean) as string[];
  let best = 0;
  for (const id of ids) {
    const a = findAssumption(s, t.goal, id);
    if (!a) continue;
    const st = beliefOf(s, a.goal, a.def).status;
    if (st === "supported" || st === "refuted") continue;
    best = Math.max(best, a.def.risk * a.def.uncertainty * (a.def.loadBearing ? 1.5 : 1));
  }
  return best;
}

function windowSpend(s: State, goalId: string, now: number): number {
  return s.goals.get(goalId)!.turnTimes.filter((x) => x > now - 7 * DAY).length;
}

export type Pick = { todo: TodoState; why: string; candidates: number };

// Urgent (P0) work first, across goals. Otherwise: the goal furthest below its
// compute share, then priority, then value of information (risk x uncertainty of the
// assumption the todo tests), then age.
export function rank(s: State, ready: TodoState[], now: number): Pick | null {
  if (!ready.length) return null;
  const share = (g: string) => s.goals.get(g)?.def.share ?? 1;
  const deficit = (g: string) => windowSpend(s, g, now) / share(g);
  const sorted = [...ready].sort((a, b) => {
    const p0 = Number(b.priority === 0) - Number(a.priority === 0);
    if (p0) return p0;
    const d = deficit(a.goal) - deficit(b.goal);
    if (d) return d;
    if (a.priority !== b.priority) return a.priority - b.priority;
    const v = voi(s, b) - voi(s, a);
    if (v) return v;
    return a.addedAt - b.addedAt || a.id.localeCompare(b.id);
  });
  const t = sorted[0];
  const parts = [`P${t.priority}`];
  const v = voi(s, t);
  if (v) parts.push(`tests ${t.tests ?? (t.job ?? t.wait)?.informs?.[0]?.assumption} (risk x uncertainty ${v})`);
  if (new Set(ready.map((r) => r.goal)).size > 1) parts.push(`goal ${t.goal} furthest below its share`);
  parts.push(`${ready.length} ready`);
  return { todo: t, why: parts.join(" · "), candidates: ready.length };
}

export function readyTodos(s: State, now: number, runner: Runner | undefined, claimed: Set<string>, kinds: string[]): TodoState[] {
  return [...s.todos.values()].filter((t) => kinds.includes(t.kind) && !claimed.has(t.id) && blockers(s, t, now, runner).length === 0);
}

// The phase is the category of the riskiest unsettled load-bearing assumption.
export function phase(s: State, goalId: string): { category: string; assumption: string; score: number } | null {
  const g = s.goals.get(goalId);
  if (!g) return null;
  let best: { category: string; assumption: string; score: number } | null = null;
  for (const a of g.def.assumptions) {
    const st = beliefOf(s, goalId, a).status;
    if (st === "supported" || st === "refuted") continue;
    const score = a.risk * a.uncertainty * (a.loadBearing ? 1.5 : 1);
    if (!best || score > best.score) best = { category: a.category, assumption: a.id, score };
  }
  return best;
}

// `at` is when to wake. `timer` is the next real event (may be later than `at`, which
// is capped so new answers get noticed); `idle` means no event is scheduled at all and
// only people can move things.
export type Hint = { action: "run_now" | "sleep" | "stop"; at: number; why: string; timer?: number; idle?: boolean };

// When a running job or wait should next be polled. Job polls back off; a wait isn't
// polled before its minimum window has passed (judging a market test on day 2 of 14
// is how tests get stopped early on noise).
export function nextPollAt(s: State, t: TodoState, pulse: PulseData, now: number): number {
  const p = pulse.polls[t.id];
  if (t.kind === "wait") {
    const earliest = (t.startedAt ?? now) + (t.wait?.minDays ?? 0) * DAY;
    return Math.max(p ? p.at + s.policy.schedule.waitPollMinutes * MIN : now, earliest);
  }
  const steps = s.policy.schedule.jobPollMinutes;
  if (!p) return (t.startedAt ?? now) + steps[0] * MIN;
  const backoff = p.at + steps[Math.min(p.n, steps.length - 1)] * MIN;
  return p.eta !== undefined && p.eta > p.at ? Math.max(p.eta, p.at + steps[0] * MIN) : backoff;
}

// When should a runner wake next? The earliest timer among: due monitors, job and wait
// polls, notBefore dates, blackout ends, budget windows reopening, and claim expiries.
// Capped so answers to open questions get noticed. Nothing pending at all: stop.
export function nextWake(s: State, now: number, opts: { readyNow: boolean; pulse: PulseData; claimExpiries: number[] }): Hint {
  if (opts.readyNow) return { action: "run_now", at: now, why: "ready work" };
  const active = [...s.goals.values()].filter((g) => g.status === "active");
  if (!active.length) return { action: "stop", at: now, why: "every goal is closed" };
  const timers: Array<{ at: number; why: string }> = [];
  for (const g of active) {
    for (const m of g.def.monitors ?? []) {
      const exp = ts(m.expiresAt);
      if (exp !== undefined && exp <= now) continue;
      const last = opts.pulse.monitors[`${g.id}/${m.id}`]?.checkedAt;
      timers.push({ at: last === undefined ? now : last + m.cadenceMinutes * MIN, why: `monitor ${m.id}` });
    }
  }
  for (const t of s.todos.values()) {
    if (t.status === "running" && (t.kind === "job" || t.kind === "wait")) timers.push({ at: nextPollAt(s, t, opts.pulse, now), why: `poll ${t.id}` });
    if (t.status !== "open") continue;
    const nb = ts(t.notBefore);
    if (nb !== undefined && nb > now) timers.push({ at: nb, why: `${t.id} not before ${t.notBefore}` });
    for (const g of goalChain(s, t.goal)) {
      for (const b of g.def.blackouts ?? []) {
        const from = ts(b.from)!, to = ts(b.to)!;
        if (b.lanes.includes(t.lane) && from <= now && now < to) timers.push({ at: to, why: `blackout ends for ${t.id}` });
      }
    }
    const own = s.goals.get(t.goal);
    if (own && t.kind === "task" && own.def.budget.turnsPerWeek !== undefined) {
      const recent = own.turnTimes.filter((x) => x > now - 7 * DAY).sort((a, b) => a - b);
      if (recent.length >= own.def.budget.turnsPerWeek) timers.push({ at: recent[0] + 7 * DAY + 1, why: `weekly budget reopens for ${own.id}` });
    }
  }
  for (const at of opts.claimExpiries) timers.push({ at: at + 1, why: "claim expires" });
  const cap = { at: now + s.policy.schedule.maxSleepMinutes * MIN, why: "recheck for answers" };
  const future = timers.filter((t) => t.at > now);
  const due = timers.filter((t) => t.at <= now);
  if (due.length) return { action: "run_now", at: now, why: due[0].why, timer: now };
  const next = future.sort((a, b) => a.at - b.at)[0];
  if (!next) return { action: "sleep", at: cap.at, why: cap.why, idle: true };
  return next.at < cap.at ? { action: "sleep", at: next.at, why: next.why, timer: next.at } : { action: "sleep", at: cap.at, why: cap.why, timer: next.at };
}
