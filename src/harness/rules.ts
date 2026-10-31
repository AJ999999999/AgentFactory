// Rules: what the harness must do on its own, derived from state. Each rule emits
// events with ids derived from their cause, so running the rules twice, or on two
// runners at once, writes each consequence exactly once. settle() applies rules until
// nothing new comes out (a superseded todo can orphan the todos after it).
import { sha256 } from "../util.ts";
import type { Ask, AskOption, HEvent, TodoDraft } from "./types.ts";
import type { GoalState, State, TodoState } from "./project.ts";
import { apply, beliefOf, beliefs, criterionMet, findAssumption, metricsOf, openAsks, seatKey, thinStreak } from "./project.ts";
import { blockers, spendAskId } from "./select.ts";
import { eid } from "./store.ts";
import { staffSeat } from "./team.ts";

const DAY = 86_400_000;
const LIVE = ["open", "running", "review", "blocked"];

type Emit = (e: HEvent) => void;

export function settle(s: State, now: number): HEvent[] {
  const all: HEvent[] = [];
  for (let round = 0; round < 12; round++) {
    const batch: HEvent[] = [];
    const seen = new Set<string>();
    const emit: Emit = (e) => {
      if (s.eventIds.has(e.id) || seen.has(e.id)) return;
      seen.add(e.id);
      batch.push(e);
    };
    rules(s, now, emit);
    if (!batch.length) break;
    for (const e of batch) apply(s, e);
    all.push(...batch);
  }
  return all;
}

const H = "harness";

function ask(now: number, a: Ask): HEvent {
  return { id: a.id, at: now, by: H, type: "ask_opened", ask: a };
}

function todo(now: number, goal: string, draft: TodoDraft & { id: string }, provenance: string): HEvent {
  return { id: `add-${draft.id}`, at: now, by: H, type: "todo_added", todo: { ...draft, goal }, provenance };
}

function supersede(now: number, t: TodoState, reason: string): HEvent {
  return { id: eid("sup", t.id), at: now, by: H, type: "todo_superseded", todo: t.id, reason };
}

function worldTestsInFlight(s: State, goalId: string, assumption: string): boolean {
  return [...s.todos.values()].some((t) => t.goal === goalId && (t.kind === "job" || t.kind === "wait") && (t.status === "open" || t.status === "running") &&
    ((t.job?.informs ?? t.wait?.informs ?? []).some((i) => i.assumption === assumption)));
}

export function refutedAskId(g: GoalState, assumption: string): string {
  return eid("ask-refuted", g.id, `v${g.version}`, assumption, g.resets.get(assumption) ?? 0);
}

const directionOptions = (extra: AskOption[] = []): AskOption[] => [
  { id: "pivot", label: "Change direction (answer with the revised goal)", effect: { type: "revise", pivot: true } },
  { id: "kill", label: "Stop this goal", effect: { type: "close", status: "killed" } },
  ...extra,
  { id: "continue", label: "Continue as planned (recorded with your reason)", effect: { type: "ack" } },
];

function rules(s: State, now: number, emitOut: Emit): void {
  const p = s.policy;
  // Goals that got a new question in this pass (so "idle" isn't asked on top of it).
  const asked = new Set<string>();
  const emit: Emit = (e) => {
    if (e.type === "ask_opened") asked.add(e.ask.goal);
    emitOut(e);
  };
  for (const g of s.goals.values()) {
    const live = [...s.todos.values()].filter((t) => t.goal === g.id && LIVE.includes(t.status));

    // A closed goal leaves no work behind, and its open questions become moot. A killed
    // goal takes its workstreams with it.
    if (g.status !== "active") {
      for (const t of live) emit(supersede(now, t, `goal ${g.status}`));
      if (g.status === "killed") {
        for (const c of s.goals.values()) if (c.def.parent === g.id && c.status === "active") emit({ id: eid("close", c.id, "parent"), at: now, by: H, type: "goal_closed", goal: c.id, status: "killed", reason: `parent ${g.id} was killed` });
      }
      for (const a of openAsks(s, g.id)) emit({ id: eid("moot", a.id), at: now, by: H, type: "ask_answered", ask: a.id, answeredBy: H, choice: "moot", note: `goal ${g.status}` });
      continue;
    }
    const bs = beliefs(s, g.id);
    const owner = g.def.owner;
    const v = `v${g.version}`;

    // Questions about a direction the goal has already left are moot.
    for (const a of openAsks(s, g.id)) {
      if (a.goalVersion !== undefined && a.goalVersion < g.version) emit({ id: eid("moot", a.id), at: now, by: H, type: "ask_answered", ask: a.id, answeredBy: H, choice: "moot", note: `goal moved to v${g.version}` });
    }

    // Staffing: the first open task in a lane gets that lane a seat.
    for (const lane of new Set(live.filter((x) => x.status === "open" && x.kind === "task").map((x) => x.lane))) {
      if (!s.seats.has(seatKey(g.id, lane))) for (const e of staffSeat(s, g, lane, now)) emit(e);
    }
    // A role on probation whose work keeps failing independent review: the owner looks.
    // Only that lane waits.
    for (const seat of s.seats.values()) {
      const streak = p.probation?.rejectStreak ?? 2;
      if (seat.goal !== g.id || !seat.probation || seat.rejectStreak < streak) continue;
      const lane = live.filter((x) => x.lane === seat.lane && x.status === "open");
      emit(ask(now, {
        id: eid("ask-probation", g.id, seat.lane, seat.rejected), goal: g.id, to: owner, kind: "decision", lane: seat.lane, origin: "rule:probation",
        question: `The ${seat.role} role generated for ${seat.lane} work failed independent review ${seat.rejectStreak} times in a row. Keep it trying, or drop the open ${seat.lane} work?`,
        options: [
          { id: "keep", label: "Keep trying", effect: { type: "ack" } },
          { id: "drop", label: `Drop the open ${seat.lane} work`, effect: { type: "supersede", todos: lane.map((x) => x.id) } },
        ],
      }));
    }
    // Work waiting on a probation review that was dropped goes with it: dropping the
    // review must never let unreviewed work through.
    for (const t of live.filter((x) => x.status === "review" && x.reviewTodo)) {
      const r = s.todos.get(t.reviewTodo!);
      if (r?.status === "superseded") emit(supersede(now, t, `its review was dropped (${r.reason})`));
    }

    for (const t of live.filter((x) => x.status === "open")) {
      // Work after something that will never happen is dead.
      for (const dep of t.after ?? []) {
        const d = s.todos.get(dep);
        if (d?.status === "superseded") emit(supersede(now, t, `depends on ${dep}, which was superseded`));
      }
      // Work that only makes sense if an assumption holds dies when it's refuted. For a
      // load-bearing assumption the owner decides first (pivot, fix and retest, stop):
      // until they answer, the work just waits.
      for (const id of t.assumes ?? []) {
        const found = findAssumption(s, g.id, id);
        if (!found) {
          emit(supersede(now, t, `assumption ${id} is no longer part of the goal`));
          continue;
        }
        const b = beliefOf(s, found.goal, found.def);
        if (b.status !== "refuted") continue;
        const owner = s.goals.get(found.goal)!;
        const decided = !found.def.loadBearing || s.asks.get(refutedAskId(owner, found.def.id))?.status === "answered";
        if (decided) emit(supersede(now, t, `assumed ${id}, which was refuted`));
      }
      // Research on an assumption the goal dropped is moot.
      if (t.tests && !findAssumption(s, g.id, t.tests)) emit(supersede(now, t, `assumption ${t.tests} is no longer part of the goal`));
      // Don't keep researching a settled question. Exempt: replications, synthesis, and
      // work created because something new happened (a monitor fired, a new finding),
      // whose whole point is to re-examine what we believe.
      if (t.tests && t.lane !== "replicate" && t.lane !== "synthesis" && !t.because) {
        const b = bs.find((x) => x.def.id === t.tests);
        if (b && (b.status === "supported" || b.status === "refuted")) emit(supersede(now, t, `${t.tests} already ${b.status}`));
      }
      // Money is authorized before it's spent, and asked for only when it's the last
      // thing in the way: no approvals for work that may never happen.
      const inWay = t.cost?.usd && t.cost.usd > p.money.autoApproveUsd ? blockers(s, t, now) : [];
      if (inWay.length === 1 && inWay[0].startsWith("spend $")) {
        const left = g.def.budget.usd !== undefined ? g.def.budget.usd - g.spent.usd : undefined;
        emit(ask(now, {
          id: spendAskId(t.id), goal: g.id, to: owner, kind: "approval", todo: t.id, origin: "rule:money",
          question: `Approve $${t.cost!.usd} for "${t.text}"?${left !== undefined ? ` ($${left} of the goal's $${g.def.budget.usd} left)` : ""}`,
          options: [
            { id: "approve", label: "Approve", effect: { type: "approve" } },
            { id: "reject", label: "Reject (the todo is dropped)", effect: { type: "supersede", todos: [t.id] } },
          ],
        }));
      }
      // A todo that keeps taking turns without finishing is a loop, however much
      // "progress" each turn claims. Stop and ask.
      const cap = t.maxTurns ?? p.retries.maxTurnsPerTodo;
      if (t.kind === "task" && t.turns - t.capFrom >= cap) {
        const id = eid("ask-cap", t.id, t.turns);
        emit(ask(now, {
          id, goal: g.id, to: owner, kind: "decision", todo: t.id, origin: "rule:turn_cap",
          question: `"${t.text}" has taken ${t.turns - t.capFrom} turns without finishing. Keep going, or drop it?`,
          options: [
            { id: "continue", label: "Keep going (another round of turns)", effect: { type: "retry", todo: t.id } },
            { id: "drop", label: "Drop it", effect: { type: "supersede", todos: [t.id] } },
          ],
        }));
        emit({ id: eid("block-cap", t.id, t.turns), at: now, by: H, type: "todo_blocked", todo: t.id, reason: `${cap} turns without finishing`, ask: id });
        continue;
      }
      // The partner stopped a turn on it: don't just start it again. Ask what they want.
      if (t.stopped) {
        const id = eid("ask-stopped", t.id, t.turns);
        emit(ask(now, {
          id, goal: g.id, to: owner, kind: "decision", todo: t.id, origin: "rule:stopped",
          question: `You stopped a turn on "${t.text}". Try it again, or drop it?`,
          options: [
            { id: "retry", label: "Try again", effect: { type: "retry", todo: t.id } },
            { id: "drop", label: "Drop it", effect: { type: "supersede", todos: [t.id] } },
          ],
        }));
        emit({ id: eid("block-stopped", t.id, t.turns), at: now, by: H, type: "todo_blocked", todo: t.id, reason: "stopped by the partner", ask: id });
        continue;
      }
      // Repeated failure stops retrying and asks.
      if (t.failures >= p.retries.maxFailures) {
        const id = eid("ask-fail", t.id, t.turns);
        emit(ask(now, {
          id, goal: g.id, to: owner, kind: "decision", todo: t.id, origin: "rule:failures",
          question: `"${t.text}" failed ${t.failures} times in a row. Retry, or drop it?`,
          options: [
            { id: "retry", label: "Retry", effect: { type: "retry", todo: t.id } },
            { id: "drop", label: "Drop it", effect: { type: "supersede", todos: [t.id] } },
          ],
        }));
        emit({ id: eid("block", t.id, t.turns), at: now, by: H, type: "todo_blocked", todo: t.id, reason: `failed ${t.failures} times`, ask: id });
      }
    }

    // A person's work becomes a question to that person once it's unblocked.
    for (const t of live.filter((x) => x.kind === "action" && x.status === "open")) {
      if (blockers(s, t, now).length) continue;
      const id = eid("ask-action", t.id);
      emit(ask(now, {
        id, goal: g.id, to: t.assignee ?? owner, kind: "action", todo: t.id, origin: `todo:${t.id}`, question: t.text,
        options: [{ id: "done", label: "Done (attach what you observed)" }, { id: "cannot", label: "Can't do it", effect: { type: "supersede", todos: [t.id] } }],
      }));
      emit({ id: eid("start", t.id), at: now, by: H, type: "todo_started", todo: t.id, ask: id });
    }

    // The goal's direction depends on a load-bearing assumption that turned out false.
    // Don't call it while another test of the same assumption is still running: the
    // next result may contradict this one.
    for (const b of bs) {
      if (!b.def.loadBearing || b.status !== "refuted") continue;
      if (worldTestsInFlight(s, g.id, b.def.id)) continue;
      emit(ask(now, {
        id: refutedAskId(g, b.def.id), goal: g.id, to: owner, kind: "decision", blocksGoal: true, origin: "rule:load_bearing_refuted", goalVersion: g.version,
        question: `"${b.def.text}" (${b.def.id}) was refuted. ${g.def.title} depends on it.`, evidence: b.adequate.map((f) => f.id),
        options: directionOptions([{ id: "fix", label: "Change the approach and test it again", effect: { type: "revise", pivot: false, resetAssumptions: [b.def.id] } }]),
      }));
    }

    // Pre-registered kill criteria, judged on world evidence only.
    for (const c of g.def.kill ?? []) {
      if (!criterionMet(s, g.id, c)) continue;
      const m = c.metric ? metricsOf(s, g.id, { since: g.revisedAt }).get(c.metric) : undefined;
      emit(ask(now, {
        id: eid("ask-kill", g.id, v, c.id), goal: g.id, to: owner, kind: "decision", blocksGoal: true, origin: "rule:kill_criterion", goalVersion: g.version,
        question: `Kill criterion ${c.id} tripped: ${c.metric ?? c.assumption} ${c.op ?? "is"} ${c.value ?? c.status}${m ? ` (now ${m.value})` : ""}.`,
        evidence: m ? [m.finding] : [], options: directionOptions(),
      }));
    }

    // Success: ask the owner to close (never closes itself).
    if (!g.def.perpetual && g.def.success?.length && g.def.success.every((c) => criterionMet(s, g.id, c))) {
      emit(ask(now, {
        id: eid("ask-success", g.id, v), goal: g.id, to: owner, kind: "decision", origin: "rule:success", goalVersion: g.version,
        question: `Every success criterion of ${g.def.title} is met. Close it?`,
        options: [{ id: "close", label: "Close as done", effect: { type: "close", status: "done" } }, { id: "continue", label: "Keep going", effect: { type: "ack" } }],
      }));
    }

    budgetRules(s, g, now, emit);
    spinRules(s, g, live, now, emit);

    // Direction changed too often: the goal is thrashing.
    const recent = g.pivots.filter((at) => at > now - p.thrash.windowDays * DAY);
    if (recent.length > p.thrash.maxPivots) {
      emit(ask(now, {
        id: eid("ask-thrash", g.id, g.pivots.length), goal: g.id, to: owner, kind: "decision", blocksGoal: true, origin: "rule:thrash", goalVersion: g.version,
        question: `${g.def.title} changed direction ${recent.length} times in ${p.thrash.windowDays} days. Hold the current direction, or stop?`,
        options: [{ id: "hold", label: "Hold this direction", effect: { type: "ack" } }, { id: "kill", label: "Stop", effect: { type: "close", status: "killed" } }],
      }));
    }

    // Contradicting adequate evidence: an independent synthesis, then the owner.
    for (const b of bs.filter((x) => x.status === "contested")) {
      const n = b.adequate.length;
      const open = live.some((t) => t.lane === "synthesis" && t.tests === b.def.id);
      const done = [...s.todos.values()].some((t) => t.id === eid("synth", g.id, b.def.id, n) && t.status === "done");
      if (!open && !done) {
        emit(todo(now, g.id, {
          id: eid("synth", g.id, b.def.id, n), lane: "synthesis", priority: 0, tests: b.def.id,
          text: `Evidence on ${b.def.id} contradicts itself (${b.adequate.map((f) => `${f.id}: ${f.direction}`).join(", ")}). Find out why: discount a finding with a reason, or propose a replication.`,
        }, "rule:contested"));
      } else if (done) {
        emit(ask(now, {
          id: eid("ask-contested", g.id, b.def.id, n), goal: g.id, to: owner, kind: "decision", origin: "rule:contested", evidence: b.adequate.map((f) => f.id),
          question: `Evidence on "${b.def.text}" still conflicts after synthesis. How should we treat it?`,
          options: [{ id: "retest", label: "Discard it and test again", effect: { type: "reset", assumptions: [b.def.id] } }, { id: "continue", label: "Leave it contested", effect: { type: "ack" } }],
        }));
      }
    }

    // A weak signal against a load-bearing assumption: test it properly instead of
    // flipping direction on it.
    for (const b of bs.filter((x) => x.def.loadBearing && (x.status === "supported" || x.status === "untested"))) {
      const against = b.signals.filter((f) => f.direction === "refutes");
      if (!against.length || live.some((t) => t.tests === b.def.id)) continue;
      const f = against[against.length - 1];
      emit(todo(now, g.id, {
        id: eid("retest", g.id, b.def.id, f.id), lane: "replicate", priority: 1, tests: b.def.id, because: f.id,
        text: `${f.grade} evidence (${f.id}) suggests "${b.def.text}" is false. Design a test that can settle it (a job or a wait); don't change direction on this alone.`,
      }, "rule:weak_signal"));
    }

    // Coordinate findings across lanes on a cadence.
    const lastSynth = Math.max(0, ...s.turns.filter((t) => t.goal === g.id && t.result === "completed" && s.todos.get(t.todo)?.lane === "synthesis").map((t) => t.at));
    const fresh = [...s.findings.values()].filter((f) => f.goal === g.id && f.at > lastSynth);
    if (fresh.length >= p.synthesis.afterFindings && !live.some((t) => t.lane === "synthesis")) {
      emit(todo(now, g.id, {
        id: eid("digest", g.id, sha256(fresh.map((f) => f.id).join()).slice(0, 10)), lane: "synthesis", priority: 1,
        text: `Coordinate ${fresh.length} findings since the last synthesis: what changed in what we believe, and what to test next.`,
      }, "rule:synthesis_cadence"));
    }

    // Nothing left to do, nothing asked, not closed: a goal that would idle forever.
    const monitored = (g.def.monitors ?? []).some((m) => !m.expiresAt || Date.parse(m.expiresAt) > now);
    const succeeded = !!g.def.success?.length && g.def.success.every((c) => criterionMet(s, g.id, c));
    if (!g.def.perpetual && !live.length && !openAsks(s, g.id).length && !asked.has(g.id) && !monitored && !succeeded) {
      const done = [...s.todos.values()].filter((t) => t.goal === g.id && t.status === "done").length;
      emit(ask(now, {
        id: eid("ask-idle", g.id, v, done), goal: g.id, to: owner, kind: "decision", origin: "rule:idle", goalVersion: g.version,
        question: `${g.def.title} has no open work left (${done} todos done). Close it, or add the next piece of work?`,
        options: [
          { id: "close", label: "Close as done", effect: { type: "close", status: "done" } },
          { id: "next", label: "Plan the next stage (answer with the revised goal)", effect: { type: "revise", pivot: false } },
          { id: "kill", label: "Stop it", effect: { type: "close", status: "killed" } },
        ],
      }));
    }
  }
}

function budgetRules(s: State, g: GoalState, now: number, emit: Emit): void {
  const p = s.policy;
  const b = g.def.budget;
  const owner = g.def.owner;
  const raise: AskOption = { id: "raise", label: "Raise the budget (answer with the new budget)", effect: { type: "budget", budget: {} } };
  // An agent's estimate can't trip a verdict, but it can raise a question early.
  const est = metricsOf(s, g.id, { agents: true, since: g.revisedAt }).get("estimated_turns");
  if (est && b.turns !== undefined && est.value > b.turns * p.budget.scopeAskOver) {
    emit(ask(now, {
      id: eid("ask-scope", g.id, `v${g.version}`, est.finding), goal: g.id, to: owner, kind: "decision", blocksGoal: true, origin: "rule:scope_vs_budget", goalVersion: g.version, evidence: [est.finding],
      question: `${g.def.title} is estimated at ${est.value} turns against a budget of ${b.turns}. Narrow the scope, raise the budget, or stop?`,
      options: [{ id: "narrow", label: "Narrow the scope (answer with the revised goal)", effect: { type: "revise", pivot: false } }, raise, { id: "kill", label: "Stop", effect: { type: "close", status: "killed" } }],
    }));
  }
  if (b.turns === undefined) return;
  const bv = `b${g.budgetVersion}`;
  if (g.spent.turns >= b.turns) {
    emit(ask(now, {
      id: eid("ask-budget-out", g.id, bv), goal: g.id, to: owner, kind: "decision", origin: "rule:budget_exhausted",
      question: `${g.def.title} has used its ${b.turns} turns. Agent work on it is paused.`,
      options: [raise, { id: "close", label: "Close it", effect: { type: "close", status: "done" } }, { id: "kill", label: "Stop it", effect: { type: "close", status: "killed" } }],
    }));
  } else if (g.spent.turns >= b.turns * p.budget.warnAt) {
    const open = [...s.todos.values()].filter((t) => t.goal === g.id && t.kind === "task" && t.status === "open").length;
    const forecast = g.spent.turns + open * p.budget.defaultTurnsPerTodo;
    if (forecast > b.turns) {
      emit(ask(now, {
        id: eid("ask-budget-warn", g.id, bv), goal: g.id, to: owner, kind: "decision", origin: "rule:budget_forecast",
        question: `${g.def.title} has used ${g.spent.turns} of ${b.turns} turns; the ${open} open todos need about ${forecast - g.spent.turns} more.`,
        options: [raise, { id: "continue", label: "Continue until it runs out", effect: { type: "ack" } }],
      }));
    }
  }
}

function spinRules(s: State, g: GoalState, live: TodoState[], now: number, emit: Emit): void {
  const streak = thinStreak(s, g.id);
  if (streak.length < s.policy.spin.thinStreak) return;
  const last = streak[0];
  // The replan itself came back thin: more turns won't help, the owner has to look.
  if (s.todos.get(last.todo)?.lane === "replan") {
    emit(ask(now, {
      id: eid("ask-stuck", g.id, last.id), goal: g.id, to: g.def.owner, kind: "decision", blocksGoal: true, origin: "rule:spin", goalVersion: g.version,
      question: `${g.def.title} is stuck: ${streak.length} turns without new evidence or validated output, and a replan didn't change that.`,
      options: directionOptions(),
    }));
    return;
  }
  if (live.some((t) => t.lane === "replan")) return;
  emit(todo(now, g.id, {
    id: eid("replan", g.id, last.id), lane: "replan", priority: 0,
    text: `The last ${streak.length} turns produced no evidence and no validated output (${streak.map((t) => t.todo).join(", ")}). Change the plan: supersede work that isn't moving the riskiest assumption, add a test for it, or ask the owner.`,
  }, "rule:spin"));
}
