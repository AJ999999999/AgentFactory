// Projection: fold the event log into current state. Pure and deterministic: the same
// events always give the same state, on any machine, after any restart. The fold
// applies events literally; consequences (supersede this, ask that) are written as
// their own events by the rules, so every state change has an audit trail.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Catalog, Library } from "../factory.ts";
import { AGENT_GRADES } from "./types.ts";
import type {
  Ask, AssumptionDef, BeliefStatus, Category, Criterion, EngagementDef, Finding, GoalDef, GoalRevision, Grade, HEvent, Op,
  SeatDef, TodoDraft, TodoKind, TurnRecord,
} from "./types.ts";

export type HarnessPolicy = {
  version: number;
  evidence: Record<Category, Grade[]>;
  minRuns: number;
  claims: { ttlMinutes: number; turnTimeoutMinutes: number };
  retries: { maxFailures: number; maxTurnsPerTodo: number };
  spin: { thinStreak: number };
  thrash: { maxPivots: number; windowDays: number };
  synthesis: { afterFindings: number };
  budget: { warnAt: number; scopeAskOver: number; defaultTurnsPerTodo: number };
  money: { autoApproveUsd: number };
  spawn: { autoCarveFraction: number };
  proposals: { maxTodosPerTurn: number; maxAsksPerTurn: number; noteChars: number };
  packet: { maxLines: number; maxChars: number };
  schedule: { jobPollMinutes: number[]; maxSleepMinutes: number; waitPollMinutes: number };
  protected: string[];
  probation?: { promoteAfter: number; rejectStreak: number };
  // When the model service refuses for capacity: wait for the reset it names, clamped to
  // [min, max]; with no reset given, defaultBackoff doubled for each hit in a row.
  // A service that can't be reached is retried sooner (unreachableBackoffMinutes, doubled
  // for each hit in a row); a CLI that can't start as configured waits setupBackoffMinutes.
  capacity?: { defaultBackoffMinutes: number; minBackoffMinutes: number; maxBackoffHours: number; unreachableBackoffMinutes?: number; setupBackoffMinutes?: number };
  // The firm library and permission catalog, loaded from the files the policy names.
  // Without them, nothing is staffed and every lane runs as the fallback agent.
  team?: { library: Library; catalog: Catalog };
};

export function loadPolicy(file: string): HarnessPolicy {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Omit<HarnessPolicy, "team"> & { team?: { library: string; catalog: string } };
  const { team, ...rest } = raw;
  if (!team) return rest;
  const read = (f: string) => JSON.parse(fs.readFileSync(path.resolve(path.dirname(file), f), "utf8"));
  return { ...rest, team: { library: read(team.library) as Library, catalog: read(team.catalog) as Catalog } };
}

export type GoalState = {
  id: string;
  def: GoalDef;
  version: number;
  status: "active" | "done" | "killed";
  criteriaHash: string;
  openedAt: number;
  revisedAt: number; // start of the current version: criteria are judged on evidence since then
  pivots: number[];
  budgetVersion: number;
  spent: { turns: number; usd: number; gpuHours: number };
  turnTimes: number[];
  resets: Map<string, number>; // assumption -> time; findings before it no longer count
  notes: Array<{ at: number; text: string; turn?: string; version: number }>;
};

export type TodoStatus = "open" | "running" | "review" | "done" | "superseded" | "blocked";

export type TodoState = TodoDraft & {
  id: string;
  goal: string;
  kind: TodoKind;
  priority: number;
  status: TodoStatus;
  goalVersion: number;
  addedAt: number;
  provenance: string;
  failures: number; // consecutive, reset by a retry
  stopped?: boolean; // the partner stopped its last turn; cleared when it's reopened
  turns: number;
  capFrom: number; // turn count when the turn cap last reset (a person said keep going)
  handle?: string;
  startedAt?: number;
  ask?: string;
  reviewTodo?: string; // a probation review in progress
  doneAt?: number;
  reason?: string;
};

export type SeatState = SeatDef & {
  key: string; // "<goal>/<lane>"
  staffedAt: number;
  ask?: string; // the owner's decision on pending permissions
  probation: boolean;
  accepted: number;
  acceptStreak: number;
  rejectStreak: number;
  rejected: number;
  promotedAt?: number;
};

export const seatKey = (goal: string, lane: string) => `${goal}/${lane}`;

export type AskState = Ask & {
  status: "open" | "answered" | "auto_closed";
  openedAt: number;
  autoReason?: "criteria_met" | "precedent"; // auto_closed: why the harness settled it
  precedentAsk?: string; // auto_closed by precedent: the earlier ask whose answer was reused
  answeredAt?: number;
  answeredBy?: string;
  choice?: string;
  note?: string;
  revision?: GoalRevision;
};

export type TurnAt = TurnRecord & { at: number };

export type State = {
  engagement: Omit<EngagementDef, "goals"> | null;
  goals: Map<string, GoalState>;
  todos: Map<string, TodoState>;
  asks: Map<string, AskState>;
  findings: Map<string, Finding & { at: number }>;
  discounted: Map<string, string>;
  turns: TurnAt[];
  sources: Map<string, { fingerprint: string; at: number }>; // "<goal>/<monitor>"
  seats: Map<string, SeatState>; // "<goal>/<lane>"
  paused: { at: number; by: string; reason?: string } | null;
  capacity: Map<string, CapacityState>; // by vendor: who said "not now", until when, for which seats
  eventIds: Set<string>;
  lastAt: number;
  policy: HarnessPolicy;
  evidence: Record<Category, Grade[]>; // policy defaults, overridden per engagement
};

export function project(events: HEvent[], policy: HarnessPolicy): State {
  const s: State = {
    engagement: null,
    goals: new Map(),
    todos: new Map(),
    asks: new Map(),
    findings: new Map(),
    discounted: new Map(),
    turns: [],
    sources: new Map(),
    seats: new Map(),
    paused: null,
    capacity: new Map(),
    eventIds: new Set(),
    lastAt: 0,
    policy,
    evidence: { ...policy.evidence },
  };
  for (const e of events) apply(s, e);
  return s;
}

export function apply(s: State, e: HEvent): void {
  if (s.eventIds.has(e.id)) return;
  s.eventIds.add(e.id);
  s.lastAt = Math.max(s.lastAt, e.at);
  switch (e.type) {
    case "engagement_opened":
      s.engagement = e.engagement;
      s.evidence = { ...s.policy.evidence, ...(e.engagement.evidence ?? {}) } as Record<Category, Grade[]>;
      break;
    case "goal_opened":
      if (!s.goals.has(e.goal.id)) {
        s.goals.set(e.goal.id, {
          id: e.goal.id, def: e.goal, version: 1, status: "active", criteriaHash: e.criteriaHash, openedAt: e.at, revisedAt: e.at,
          pivots: [], budgetVersion: 1, spent: { turns: 0, usd: 0, gpuHours: 0 }, turnTimes: [], resets: new Map(), notes: [],
        });
      }
      break;
    case "goal_revised": {
      const g = s.goals.get(e.goal);
      if (!g || e.version <= g.version) break;
      const r = e.revision;
      g.def = {
        ...g.def,
        ...(r.objective !== undefined ? { objective: r.objective } : {}),
        ...(r.title !== undefined ? { title: r.title } : {}),
        ...(r.assumptions !== undefined ? { assumptions: r.assumptions } : {}),
        ...(r.success !== undefined ? { success: r.success } : {}),
        ...(r.kill !== undefined ? { kill: r.kill } : {}),
        ...(r.budget !== undefined ? { budget: r.budget } : {}),
      };
      if (r.budget) g.budgetVersion++;
      g.version = e.version;
      g.revisedAt = e.at;
      g.criteriaHash = e.criteriaHash;
      if (e.pivot) g.pivots.push(e.at);
      break;
    }
    case "goal_closed": {
      const g = s.goals.get(e.goal);
      if (g && g.status === "active") g.status = e.status;
      break;
    }
    case "todo_added": {
      if (s.todos.has(e.todo.id)) break;
      const g = s.goals.get(e.todo.goal);
      s.todos.set(e.todo.id, {
        ...e.todo, kind: e.todo.kind ?? "task", priority: e.todo.priority ?? 2, status: "open", goalVersion: g?.version ?? 1,
        addedAt: e.at, provenance: e.provenance, failures: 0, turns: 0, capFrom: 0,
      });
      break;
    }
    case "todo_started": {
      const t = s.todos.get(e.todo);
      if (t && t.status === "open") Object.assign(t, { status: "running", handle: e.handle, ask: e.ask ?? t.ask, startedAt: e.at });
      break;
    }
    case "todo_done": {
      const t = s.todos.get(e.todo);
      if (t && !["done", "superseded"].includes(t.status)) Object.assign(t, { status: "done", doneAt: e.at });
      break;
    }
    case "todo_review": {
      const t = s.todos.get(e.todo);
      if (t && !["done", "superseded"].includes(t.status)) Object.assign(t, { status: "review", ask: e.ask, reviewTodo: e.reviewTodo });
      break;
    }
    case "todo_reopened": {
      const t = s.todos.get(e.todo);
      if (t && t.status !== "superseded") Object.assign(t, { status: "open", stopped: false, reason: e.reason, failures: e.resetFailures ? 0 : t.failures, capFrom: e.resetFailures ? t.turns : t.capFrom, handle: undefined, startedAt: undefined, reviewTodo: undefined });
      break;
    }
    case "todo_superseded": {
      const t = s.todos.get(e.todo);
      if (t && t.status !== "done") Object.assign(t, { status: "superseded", reason: e.reason });
      break;
    }
    case "todo_blocked": {
      const t = s.todos.get(e.todo);
      if (t && !["done", "superseded"].includes(t.status)) Object.assign(t, { status: "blocked", reason: e.reason, ask: e.ask });
      break;
    }
    case "ask_opened":
      if (!s.asks.has(e.ask.id)) s.asks.set(e.ask.id, { ...e.ask, status: "open", openedAt: e.at });
      break;
    case "ask_answered": {
      const a = s.asks.get(e.ask);
      if (a && a.status === "open") Object.assign(a, { status: "answered", answeredAt: e.at, answeredBy: e.answeredBy, choice: e.choice, note: e.note, revision: e.revision });
      break;
    }
    case "ask_auto_closed": {
      const a = s.asks.get(e.ask);
      if (a && a.status === "open") Object.assign(a, { status: "auto_closed", answeredAt: e.at, answeredBy: "harness", autoReason: e.reason, ...(e.precedentAsk ? { precedentAsk: e.precedentAsk } : {}), ...(e.choice ? { choice: e.choice } : {}), ...(e.note ? { note: e.note } : {}) });
      break;
    }
    case "finding":
      if (!s.findings.has(e.finding.id)) s.findings.set(e.finding.id, { ...e.finding, at: e.at });
      break;
    case "finding_discounted":
      s.discounted.set(e.finding, e.reason);
      break;
    case "assumption_reset": {
      const g = s.goals.get(e.goal);
      if (g) g.resets.set(e.assumption, e.at);
      break;
    }
    case "budget_set": {
      const g = s.goals.get(e.goal);
      if (g) {
        g.def = { ...g.def, budget: e.budget };
        g.budgetVersion++;
      }
      break;
    }
    case "turn": {
      s.turns.push({ ...e.turn, at: e.at });
      // A turn the model actually ran ends the streak of refusals.
      if (["completed", "progress", "blocked", "validation_failed", "stopped"].includes(e.turn.result)) {
        const m = e.turn.seat ? s.seats.get(e.turn.seat)?.model : undefined;
        for (const c of s.capacity.values()) if (covers(c, m)) c.streak = 0;
      }
      const g = s.goals.get(e.turn.goal);
      if (g) {
        g.spent.turns++;
        g.turnTimes.push(e.at);
      }
      const t = s.todos.get(e.turn.todo);
      if (t) {
        t.turns++;
        if (e.turn.result === "host_failure" || e.turn.result === "validation_failed") t.failures++;
        else if (e.turn.result !== "claim_lost" && e.turn.result !== "stopped") t.failures = 0;
        t.stopped = e.turn.result === "stopped";
      }
      break;
    }
    case "job_finished": {
      const t = s.todos.get(e.todo);
      const g = t && s.goals.get(t.goal);
      if (g && e.gpuHours) g.spent.gpuHours += e.gpuHours;
      // A failed run (infrastructure, not a negative result) goes back in the queue.
      if (t && e.status === "failed" && t.status === "running") Object.assign(t, { status: "open", failures: t.failures + 1, handle: undefined, startedAt: undefined });
      break;
    }
    case "spend": {
      const g = s.goals.get(e.goal);
      if (g) g.spent.usd += e.usd;
      break;
    }
    case "source_changed":
      s.sources.set(`${e.goal}/${e.monitor}`, { fingerprint: e.fingerprint, at: e.at });
      break;
    case "note": {
      const g = s.goals.get(e.goal);
      if (g) g.notes.push({ at: e.at, text: e.text, turn: e.turn, version: g.version });
      break;
    }
    case "seat_staffed": {
      const key = seatKey(e.seat.goal, e.seat.lane);
      if (!s.seats.has(key)) s.seats.set(key, { ...e.seat, key, staffedAt: e.at, ask: e.ask, probation: e.seat.generated, accepted: 0, acceptStreak: 0, rejectStreak: 0, rejected: 0 });
      break;
    }
    case "capacity":
      // Never move the wait earlier: two runners hitting the same limit keep the later reset.
      const vendor = e.vendor ?? "model";
      const was = s.capacity.get(vendor);
      s.capacity.set(vendor, { vendor, until: Math.max(e.until, was?.until ?? 0), reason: e.reason, streak: Math.max(e.streak, was && was.kind === (e.kind ?? "limit") ? was.streak : 0), kind: e.kind ?? "limit", ...(e.models ? { models: e.models } : {}) });
      break;
    case "paused":
      s.paused = e.paused ? { at: e.at, by: e.by, reason: e.reason } : null;
      break;
    case "review_verdict": {
      const seat = s.seats.get(e.seat);
      if (!seat) break;
      if (e.verdict === "accept") {
        seat.accepted++;
        seat.acceptStreak++;
        seat.rejectStreak = 0;
        // Off probation after enough independent acceptances in a row.
        if (seat.probation && seat.acceptStreak >= (s.policy.probation?.promoteAfter ?? 3)) Object.assign(seat, { probation: false, promotedAt: e.at });
      } else {
        seat.rejected++;
        seat.rejectStreak++;
        seat.acceptStreak = 0;
      }
      break;
    }
  }
}

// What a seat may do right now: what the catalog granted, plus pending permissions
// once the owner granted them.
export function seatPermissions(s: State, seat: SeatState): string[] {
  const a = seat.ask ? s.asks.get(seat.ask) : undefined;
  const granted = a?.status === "answered" && a.choice === "grant";
  return granted ? [...seat.permissions, ...seat.pending.map((p) => p.permission)] : [...seat.permissions];
}

export type CapacityState = { vendor: string; until: number; reason: string; streak: number; models?: string[]; kind: "limit" | "unreachable" | "setup" };

// Does a vendor's limit hold up a seat on this model? Unknown either way: yes.
function covers(c: CapacityState, model: string | undefined): boolean {
  return !c.models || !model || c.models.includes(model);
}

// The usage limit, if any, that a model turn for this seat waits on now.
export function capacityFor(s: State, model: string | undefined, now: number): CapacityState | undefined {
  return [...s.capacity.values()].find((c) => c.until > now && covers(c, model));
}

export function seatOf(s: State, t: { goal: string; lane: string }): SeatState | undefined {
  return s.seats.get(seatKey(t.goal, t.lane));
}

// ---------- derived views ----------

export function goalChain(s: State, goalId: string): GoalState[] {
  const out: GoalState[] = [];
  let g = s.goals.get(goalId);
  while (g) {
    out.push(g);
    g = g.def.parent ? s.goals.get(g.def.parent) : undefined;
  }
  return out;
}

export function isAgentFinding(f: Finding): boolean {
  return AGENT_GRADES.includes(f.grade);
}

export type Belief = { goal: string; def: AssumptionDef; status: BeliefStatus; adequate: Finding[]; signals: Finding[] };

// Belief is a pure function of the evidence. Agents add findings; they never set a
// status. Only findings of a grade the category accepts count ("adequate"); measured
// findings also need enough runs. The rest are signals: they can trigger a proper test
// but can't move the belief. Conflicting adequate findings make it "contested".
export function beliefOf(s: State, goalId: string, def: AssumptionDef): Belief {
  const g = s.goals.get(goalId)!;
  const accepted = s.evidence[def.category] ?? [];
  const since = g.resets.get(def.id) ?? -Infinity;
  const mine = [...s.findings.values()].filter((f) => f.goal === goalId && f.assumption === def.id && f.at > since && !s.discounted.has(f.id));
  const adequate = mine.filter((f) => f.direction !== "neutral" && accepted.includes(f.grade) && !f.untrusted && (f.grade !== "measured" || (f.runs ?? 1) >= s.policy.minRuns));
  const signals = mine.filter((f) => !adequate.includes(f));
  const sup = adequate.some((f) => f.direction === "supports");
  const ref = adequate.some((f) => f.direction === "refutes");
  let status: BeliefStatus = sup && ref ? "contested" : sup ? "supported" : ref ? "refuted" : "untested";
  if (status === "untested" && testsInFlight(s, goalId, def.id)) status = "testing";
  return { goal: goalId, def, status, adequate, signals };
}

export function beliefs(s: State, goalId: string): Belief[] {
  const g = s.goals.get(goalId);
  return g ? g.def.assumptions.map((a) => beliefOf(s, goalId, a)) : [];
}

export function findAssumption(s: State, goalId: string, id: string): { goal: string; def: AssumptionDef } | null {
  // An assumption can belong to the goal or to any ancestor (child goals inherit them).
  for (const g of goalChain(s, goalId)) {
    const def = g.def.assumptions.find((a) => a.id === id);
    if (def) return { goal: g.id, def };
  }
  return null;
}

function testsInFlight(s: State, goalId: string, assumption: string): boolean {
  for (const t of s.todos.values()) {
    if (t.goal !== goalId || !["open", "running", "review"].includes(t.status)) continue;
    if (t.tests === assumption) return true;
    if ((t.job?.informs ?? t.wait?.informs ?? []).some((i) => i.assumption === assumption)) return true;
  }
  return false;
}

// Latest value of each metric from world-sourced findings (jobs, metric sources,
// people). Agents' numbers are kept apart: they can raise a question, never trip a
// criterion.
export function metricsOf(s: State, goalId: string, opts: { agents?: boolean; since?: number } = {}): Map<string, { value: number; at: number; finding: string }> {
  const out = new Map<string, { value: number; at: number; finding: string }>();
  const since = opts.since ?? -Infinity;
  const fs = [...s.findings.values()]
    .filter((f) => f.goal === goalId && f.metrics && f.at >= since && !s.discounted.has(f.id) && isAgentFinding(f) === !!opts.agents)
    .sort((a, b) => a.at - b.at);
  for (const f of fs) for (const [k, v] of Object.entries(f.metrics!)) out.set(k, { value: v, at: f.at, finding: f.id });
  return out;
}

export function compare(a: number, op: Op, b: number): boolean {
  switch (op) {
    case "<": return a < b;
    case "<=": return a <= b;
    case ">": return a > b;
    case ">=": return a >= b;
  }
}

export function criterionMet(s: State, goalId: string, c: Criterion): boolean {
  if (c.assumption) {
    const a = findAssumption(s, goalId, c.assumption);
    return !!a && beliefOf(s, a.goal, a.def).status === (c.status ?? "supported");
  }
  if (!c.metric || !c.op || c.value === undefined) return false;
  // Each version of a goal is judged on what was observed during that version.
  const m = metricsOf(s, goalId, { since: s.goals.get(goalId)?.revisedAt });
  const v = m.get(c.metric);
  if (!v) return false;
  if (c.minSample) {
    const n = m.get(c.minSample.metric);
    if (!n || n.value < c.minSample.value) return false;
  }
  return compare(v.value, c.op, c.value);
}

export function openAsks(s: State, goalId?: string): AskState[] {
  return [...s.asks.values()].filter((a) => a.status === "open" && (!goalId || a.goal === goalId));
}

// Turns in the goal since the last substantive one, ignoring failures.
export function thinStreak(s: State, goalId: string): TurnAt[] {
  const streak: TurnAt[] = [];
  for (let i = s.turns.length - 1; i >= 0; i--) {
    const t = s.turns[i];
    if (t.goal !== goalId) continue;
    if (t.result === "host_failure" || t.result === "validation_failed" || t.result === "claim_lost" || t.result === "stopped") continue;
    if (t.granularity === "substantive" || t.granularity === "milestone") break;
    streak.push(t);
  }
  return streak;
}
