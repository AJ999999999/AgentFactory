// Turn validation: what an agent hands back is a proposal. The harness decides what
// counts, independently of the agent's own claims:
//
// - files only inside the todo's write scope, never protected or frozen paths
// - red-line and todo checkers must pass, or the whole turn is discarded
// - agents can write opinion and reported findings only; strong evidence comes from
//   the world (jobs, metric sources, people)
// - every proposed todo needs a reason to exist (an assumption it tests, or the
//   finding, question or todo that motivated it): no busywork
// - replan may supersede, synthesis may discount (never its own findings)
// - spawned goals must fit inside the parent's scope and budget, and the contracts
//   they build against must already exist
//
// Granularity is computed from what was accepted, not from what the agent says it did.
import * as fs from "node:fs";
import * as path from "node:path";
import { matchGlob, pathsOverlap, pathWithin, sha256 } from "../util.ts";
import { AGENT_GRADES, GRADES } from "./types.ts";
import type { AskOption, Direction, Effect, Finding, GoalDef, Grade, HEvent, TodoDraft, TurnRecord, TurnResult, Granularity, Verdict } from "./types.ts";
import type { AskState, Belief, SeatState, State, TodoState } from "./project.ts";
import { beliefOf, findAssumption, goalChain } from "./project.ts";
import { activeFreezes } from "./select.ts";
import { eid, safeId } from "./store.ts";
import { REVIEW_LANE } from "./team.ts";

export type FindingDraft = { assumption?: string; direction: Direction; grade: Grade; source: string; text: string; metrics?: Record<string, number> };
export type AskDraft = { question: string; options: AskOption[]; to?: string };

export type TurnOutput = {
  done?: boolean;
  blocker?: string;
  findings?: FindingDraft[];
  todos?: TodoDraft[];
  asks?: AskDraft[];
  spawn?: GoalDef[];
  supersede?: Array<{ todo: string; reason: string }>;
  discount?: Array<{ finding: string; reason: string }>;
  note?: string;
  verdict?: Verdict; // probation reviews only
};

export type Validated = { result: TurnResult; granularity: Granularity; events: HEvent[]; reasons: string[] };

const AGENT_EFFECTS: Effect["type"][] = ["approve", "ack", "decide", "supersede", "revise", "reopen"];

export function validateTurn(input: {
  s: State;
  todo: TodoState;
  agent: string;
  turn: string;
  now: number;
  why: string;
  output: TurnOutput;
  files: string[];
  checkFailures: string[]; // red lines + the todo's own checker
  checked: boolean; // a checker covered this todo's output and passed
  wtDir: string;
  knownSources: string[];
  seat?: SeatState; // who did the turn; absent when the policy has no team
}): Validated {
  const { s, todo: t, agent, turn, now, output: o, files, seat } = input;
  // Who did it: the seat when there's a team, else the runner. "Your own evidence" means
  // evidence from the same seat, not from the same machine.
  const actor = seat?.key ?? agent;
  const actorOf = (turnId?: string) => {
    const x = turnId ? s.turns.find((y) => y.id === turnId) : undefined;
    return x ? (x.seat ?? x.agent) : undefined;
  };
  const p = s.policy;
  const g = s.goals.get(t.goal)!;
  const chain = goalChain(s, t.goal);
  const reasons: string[] = [];
  const hard: string[] = [];
  const events: HEvent[] = [];
  const at = now;
  const by = agent;

  // ---- files ----
  const scope = t.writeScope ?? [];
  for (const f of files) {
    if (p.protected.some((g) => matchGlob(g, f))) hard.push(`wrote protected path ${f}`);
    else if (!scope.some((sc) => pathWithin(f, sc))) hard.push(`wrote ${f} outside the todo's scope (${scope.join(", ") || "none"})`);
    const fr = activeFreezes(s).find((z) => z.todo !== t.id && z.paths.some((q) => pathsOverlap(f, q)));
    if (fr) hard.push(`changed ${f}, frozen while ${fr.todo} runs`);
  }
  hard.push(...input.checkFailures);
  if (hard.length) return failed(input, hard);

  const accepted = { findings: [] as Finding[], todos: 0, testing: 0, asks: 0, supersede: 0, discount: 0, spawn: 0 };

  // ---- findings ----
  for (const [i, d] of (o.findings ?? []).entries()) {
    if (!GRADES.includes(d.grade)) { reasons.push(`finding ${i}: unknown grade ${d.grade}`); continue; }
    if (!AGENT_GRADES.includes(d.grade)) { reasons.push(`finding ${i}: agents can't record ${d.grade} evidence; it comes from jobs, metric sources or people`); continue; }
    if (!["supports", "refutes", "neutral"].includes(d.direction)) { reasons.push(`finding ${i}: bad direction`); continue; }
    if (d.grade === "reported" && !d.source) { reasons.push(`finding ${i}: reported evidence needs a source`); continue; }
    let owner = t.goal;
    if (d.assumption) {
      const a = findAssumption(s, t.goal, d.assumption);
      if (!a) { reasons.push(`finding ${i}: unknown assumption ${d.assumption}`); continue; }
      owner = a.goal;
    }
    if (d.source?.startsWith("repo:") && !fs.existsSync(path.join(input.wtDir, d.source.slice(5)))) { reasons.push(`finding ${i}: cited ${d.source}, which doesn't exist`); continue; }
    const f: Finding = {
      id: eid(turn, "f", i), goal: owner, assumption: d.assumption, direction: d.direction, grade: d.grade, source: d.source ?? "", author: actor,
      text: String(d.text ?? "").slice(0, 500), metrics: d.metrics, untrusted: /^https?:|^client:|^web:/.test(d.source ?? "") || undefined, todo: t.id, turn,
    };
    accepted.findings.push(f);
    events.push({ id: f.id, at, by, type: "finding", finding: f });
  }

  // ---- todos ----
  const known = (id: string) => s.todos.has(id) || s.asks.has(id) || s.findings.has(id) || accepted.findings.some((f) => f.id === id);
  const goalScope = g.def.scope;
  const newIds = new Set<string>();
  for (const [i, d] of (o.todos ?? []).entries()) {
    if (i >= p.proposals.maxTodosPerTurn) { reasons.push(`todo ${i}: over the ${p.proposals.maxTodosPerTurn}-per-turn limit`); continue; }
    const id = d.id ?? eid(t.id, "p", t.turns + 1, i);
    const r = checkTodo(s, t.goal, d, id, goalScope, known, newIds, input.knownSources);
    if (r) { reasons.push(`todo ${i}: ${r}`); continue; }
    newIds.add(id);
    const draft = sanitize(s, { ...d, id });
    events.push({ id: `add-${id}`, at, by, type: "todo_added", todo: { ...draft, goal: t.goal }, provenance: `turn:${turn}` });
    accepted.todos++;
    if (d.tests || d.kind === "job" || d.kind === "wait" || d.kind === "action") accepted.testing++;
  }

  // ---- asks ----
  const autoClosed = new Set<string>(); // asks the harness settled itself in this turn
  const principals = s.engagement?.principals ?? {};
  for (const [i, d] of (o.asks ?? []).entries()) {
    if (i >= p.proposals.maxAsksPerTurn) { reasons.push(`ask ${i}: over the per-turn limit`); continue; }
    const to = d.to ?? g.def.owner;
    if (!(to in principals)) { reasons.push(`ask ${i}: ${to} is not a principal of this engagement`); continue; }
    if (!d.question || (d.options ?? []).length < 2) { reasons.push(`ask ${i}: needs a question and at least two options`); continue; }
    const bad = d.options.find((op) => op.effect && !AGENT_EFFECTS.includes(op.effect.type));
    if (bad) { reasons.push(`ask ${i}: agents can't propose a "${bad.effect!.type}" option`); continue; }
    const id = eid("ask", t.goal, sha256(d.question).slice(0, 12));
    // The same question, with the same options, already answered in this engagement: its
    // answer stands, unless choosing it changes something (then the person decides again).
    const prior = precedent(s, d.question, d.options);
    if (prior) {
      const again = s.asks.has(id) ? eid(id, "again", turn) : id;
      events.push({ id: again, at, by, type: "ask_opened", ask: { id: again, goal: t.goal, to, kind: "decision", question: d.question.slice(0, 600), options: d.options, origin: `turn:${turn}`, todo: t.id } });
      events.push({ id: eid(again, "auto"), at, by: "harness", type: "ask_auto_closed", ask: again, reason: "precedent", precedentAsk: prior.id, choice: prior.choice, ...(prior.note ? { note: prior.note } : {}) });
      events.push({ id: eid(again, "auto", "note"), at, by: "harness", type: "note", goal: t.goal, turn, text: `Asked before (${prior.id}), and ${prior.answeredBy} chose "${prior.choice}"${prior.note ? `: ${prior.note}` : ""}. That answer stands for "${d.question.slice(0, 120)}".`.slice(0, p.proposals.noteChars) });
      autoClosed.add(again);
      reasons.push(`ask ${i}: answered before (${prior.id}): ${prior.choice}`);
      continue;
    }
    if (s.asks.has(id)) { reasons.push(`ask ${i}: already asked (${id})`); continue; }
    events.push({ id, at, by, type: "ask_opened", ask: { id, goal: t.goal, to, kind: "decision", question: d.question.slice(0, 600), options: d.options, origin: `turn:${turn}`, todo: t.id } });
    accepted.asks++;
  }

  // ---- supersede (replan only) ----
  for (const [i, d] of (o.supersede ?? []).entries()) {
    const x = s.todos.get(d.todo);
    if (t.lane !== "replan") { reasons.push(`supersede ${i}: only a replan may supersede work`); continue; }
    if (!x || x.goal !== t.goal || x.status !== "open" || x.id === t.id) { reasons.push(`supersede ${i}: ${d.todo} is not open work in this goal`); continue; }
    if (!d.reason) { reasons.push(`supersede ${i}: needs a reason`); continue; }
    events.push({ id: eid("sup", x.id), at, by, type: "todo_superseded", todo: x.id, reason: `replan ${turn}: ${d.reason}` });
    accepted.supersede++;
  }

  // ---- discount (synthesis only, never your own findings) ----
  for (const [i, d] of (o.discount ?? []).entries()) {
    const f = s.findings.get(d.finding);
    if (t.lane !== "synthesis") { reasons.push(`discount ${i}: only synthesis may discount findings`); continue; }
    if (!f || !chain.some((c) => c.id === f.goal)) { reasons.push(`discount ${i}: no finding ${d.finding} in this goal`); continue; }
    if (f.author === actor || actorOf(f.turn) === actor) { reasons.push(`discount ${i}: can't discount evidence you produced`); continue; }
    if (!d.reason) { reasons.push(`discount ${i}: needs a reason`); continue; }
    events.push({ id: eid("disc", f.id), at, by, type: "finding_discounted", finding: f.id, reason: d.reason });
    accepted.discount++;
  }

  // ---- spawn ----
  if (o.spawn?.length) {
    const r = checkSpawn(s, t, o.spawn, input.wtDir);
    if (typeof r === "string") reasons.push(`spawn: ${r}`);
    else {
      events.push(...r.events.map((e) => ({ ...e, at, by }) as HEvent));
      accepted.spawn += o.spawn.length;
    }
  }

  // ---- note ----
  if (o.note) events.push({ id: eid(turn, "note"), at, by, type: "note", goal: t.goal, text: String(o.note).slice(0, p.proposals.noteChars), turn });

  // ---- outcome ----
  let result: TurnResult = "progress";
  let done = !!o.done;
  if (o.blocker) {
    const id = eid("ask-blocked", t.id, t.turns + 1);
    events.push({
      id, at, by, type: "ask_opened",
      ask: {
        id, goal: t.goal, to: g.def.owner, kind: "decision", todo: t.id, origin: `turn:${turn}`, question: `Blocked on "${t.text}": ${String(o.blocker).slice(0, 400)}`,
        options: [{ id: "unblock", label: "Unblocked (answer with guidance)", effect: { type: "reopen", todo: t.id } }, { id: "drop", label: "Drop it", effect: { type: "supersede", todos: [t.id] } }],
      },
    });
    if (input.checked) {
      // The todo's own checker passed on this output: the work is done by the measure set
      // before it started, so the doubt goes on record and nobody is asked. In the eval a
      // turn fixed a bug completely and then asked whether it could close the todo.
      events.push({ id: eid(id, "auto"), at, by: "harness", type: "ask_auto_closed", ask: id, reason: "criteria_met", note: `${t.check} passed on ${files.join(", ") || "the output"}` });
      autoClosed.add(id);
      reasons.push(`blocker set aside: ${t.check} passed (${String(o.blocker).slice(0, 120)})`);
      done = true;
    } else {
      events.push({ id: eid("block", t.id, t.turns + 1), at, by, type: "todo_blocked", todo: t.id, reason: String(o.blocker).slice(0, 200), ask: id });
      result = "blocked";
    }
  }
  if (result === "blocked") {
    // held above
  } else if (done && t.reviews) {
    // A probation review is finished only with a verdict on the work it reviews.
    if (o.verdict !== "accept" && o.verdict !== "reject") reasons.push(`a probation review needs a verdict: "accept" or "reject"`);
    else {
      const target = s.todos.get(t.reviews);
      if (target && target.status === "review" && target.reviewTodo === t.id) {
        const why = String(o.note ?? "").slice(0, 200);
        events.push({ id: eid("verdict", t.id), at, by, type: "review_verdict", todo: target.id, review: t.id, seat: `${target.goal}/${target.lane}`, verdict: o.verdict, note: why || undefined });
        if (o.verdict === "accept") events.push({ id: eid("done", target.id, "review", t.id), at, by, type: "todo_done", todo: target.id, turn });
        else events.push({ id: eid("reopen", target.id, "review", t.id), at, by, type: "todo_reopened", todo: target.id, reason: `review ${t.id}: ${why || "rejected"}` });
      }
      events.push({ id: eid("done", t.id, t.turns + 1), at, by, type: "todo_done", todo: t.id, turn });
      result = "completed";
    }
  } else if (done) {
    const firstAsk = events.find((e) => e.type === "ask_opened" && e.ask.origin === `turn:${turn}` && !autoClosed.has(e.ask.id));
    if (firstAsk && firstAsk.type === "ask_opened" && !t.review) {
      // The todo's product is a decision: it's done when the person answers.
      events.push({ id: eid("review", t.id, t.turns + 1), at, by, type: "todo_review", todo: t.id, ask: firstAsk.ask.id });
    } else if (t.review) {
      const id = eid("ask-review", t.id, t.turns + 1);
      events.push({
        id, at, by, type: "ask_opened",
        ask: {
          id, goal: t.goal, to: t.review, kind: "review", todo: t.id, origin: `turn:${turn}`, question: `Review "${t.text}" (${files.join(", ") || "no files"}).`,
          options: [{ id: "approve", label: "Approve", effect: { type: "accept", todo: t.id } }, { id: "reject", label: "Send back (answer with what to fix)", effect: { type: "reopen", todo: t.id } }],
        },
      });
      events.push({ id: eid("review", t.id, t.turns + 1), at, by, type: "todo_review", todo: t.id, ask: id });
    } else if (seat?.probation && !input.checked) {
      // A generated role on probation: an independent reviewer (another lane, another
      // model) checks the work before it counts. A passing checker or a named person's
      // review (above) already vouches for it, so those skip this.
      const rid = eid("prv", t.id, t.turns + 1);
      events.push({
        id: `add-${rid}`, at, by: "harness", type: "todo_added", provenance: "rule:probation",
        todo: {
          id: rid, goal: t.goal, lane: REVIEW_LANE, kind: "task", priority: Math.max(1, t.priority), reviews: t.id, because: t.id, maxTurns: 2,
          text: `Independent review: the ${seat.role} role is on probation. Does ${files.join(", ") || "its output"} do "${t.text}"? Reply with a verdict, "accept" or "reject", and say why.`,
        },
      });
      events.push({ id: eid("review", t.id, t.turns + 1), at, by, type: "todo_review", todo: t.id, reviewTodo: rid });
    } else {
      events.push({ id: eid("done", t.id, t.turns + 1), at, by, type: "todo_done", todo: t.id, turn });
    }
    result = "completed";
  }
  if (o.verdict && !t.reviews) reasons.push("verdict ignored: only a probation review gives one");

  // ---- granularity ----
  const flips = beliefFlips(s, accepted.findings);
  const adequate = accepted.findings.some((f) => isAdequate(s, f));
  const effectiveReplan = t.lane === "replan" && (accepted.supersede > 0 || accepted.testing > 0 || accepted.asks > 0);
  // A synthesis that only writes a note hasn't changed anything anyone can check.
  const effectiveSynthesis = t.lane === "synthesis" && (accepted.discount > 0 || accepted.testing > 0 || accepted.asks > 0);
  const informedOwnTest = !!t.tests && accepted.findings.some((f) => f.assumption === t.tests);
  // Finishing work someone planned (a person, a rule, a monitor) is progress. Finishing
  // work an agent invented for itself counts only if a checker vouches for it.
  const planned = !t.provenance.startsWith("turn:");
  const sourced = accepted.findings.some((f) => f.grade === "reported");
  let granularity: Granularity = "none";
  if (flips.length) granularity = "milestone";
  else if (adequate || accepted.testing || accepted.spawn || effectiveReplan || effectiveSynthesis || (result === "completed" && (input.checked || informedOwnTest || planned)) || sourced) granularity = "substantive";
  else if (events.length || files.length) granularity = "surface";
  if (flips.length) reasons.push(`belief changed: ${flips.join(", ")}`);

  const rec: TurnRecord = { id: turn, todo: t.id, goal: t.goal, agent, result, granularity, reasons, files, why: input.why, seat: seat?.key };
  events.unshift({ id: `turn-${turn}`, at, by, type: "turn", turn: rec });
  return { result, granularity, events, reasons };
}

function failed(input: { s: State; todo: TodoState; agent: string; turn: string; now: number; why: string; files: string[]; seat?: SeatState }, hard: string[]): Validated {
  const rec: TurnRecord = { id: input.turn, todo: input.todo.id, goal: input.todo.goal, agent: input.agent, result: "validation_failed", granularity: "none", reasons: hard, files: input.files, why: input.why, seat: input.seat?.key };
  return { result: "validation_failed", granularity: "none", reasons: hard, events: [{ id: `turn-${input.turn}`, at: input.now, by: input.agent, type: "turn", turn: rec }] };
}

function isAdequate(s: State, f: Finding): boolean {
  if (!f.assumption || f.direction === "neutral" || f.untrusted) return false;
  const a = findAssumption(s, f.goal, f.assumption);
  return !!a && (s.evidence[a.def.category] ?? []).includes(f.grade) && (f.grade !== "measured" || (f.runs ?? 1) >= s.policy.minRuns);
}

// Would these findings change any belief? Recomputed with the findings added.
export function beliefFlips(s: State, add: Finding[]): string[] {
  const out: string[] = [];
  const touched = new Set(add.filter((f) => f.assumption).map((f) => `${f.goal}::${f.assumption}`));
  for (const key of touched) {
    const [goal, id] = key.split("::");
    const a = findAssumption(s, goal, id);
    if (!a) continue;
    const before: Belief = beliefOf(s, a.goal, a.def);
    const added = add.filter((f) => f.goal === a.goal && f.assumption === id);
    for (const f of added) s.findings.set(f.id, { ...f, at: s.lastAt + 1 });
    const after = beliefOf(s, a.goal, a.def);
    for (const f of added) s.findings.delete(f.id);
    const settled = (x: string) => x === "supported" || x === "refuted" || x === "contested";
    if (before.status !== after.status && settled(after.status)) out.push(`${id} ${before.status} -> ${after.status}`);
  }
  return out;
}

// What an agent may not decide for its own proposals: surviving a pivot (carry), a
// turn cap above the policy's, urgent priority. Reviewers and assignees must be people
// who can answer.
function sanitize(s: State, d: TodoDraft & { id: string }): TodoDraft & { id: string } {
  const { carry: _carry, ...rest } = d;
  const cap = s.policy.retries.maxTurnsPerTodo;
  return { ...rest, priority: Math.max(1, d.priority ?? 2), maxTurns: d.maxTurns !== undefined ? Math.min(d.maxTurns, cap) : undefined };
}

function checkTodo(s: State, goal: string, d: TodoDraft, id: string, goalScope: string[], known: (id: string) => boolean, newIds: Set<string>, sources: string[]): string | null {
  if (!safeId(id)) return `bad id ${id}`;
  if (s.todos.has(id) || newIds.has(id)) return `${id} already exists`;
  if (!d.lane || !d.text) return "needs a lane and a text";
  const kind = d.kind ?? "task";
  if (!["task", "job", "wait", "action"].includes(kind)) return `unknown kind ${kind}`;
  const grounded = (d.tests && findAssumption(s, goal, d.tests)) || (d.because && known(d.because)) || (d.after ?? []).some((x) => s.todos.has(x)) ||
    (d.job?.informs ?? d.wait?.informs ?? []).length > 0;
  if (!grounded) return "no reason to exist: name the assumption it tests, or the finding, question or todo behind it";
  if (d.tests && !findAssumption(s, goal, d.tests)) return `tests unknown assumption ${d.tests}`;
  for (const a of d.assumes ?? []) if (!findAssumption(s, goal, a)) return `assumes unknown assumption ${a}`;
  for (const a of d.after ?? []) if (!s.todos.has(a) && !s.asks.has(a)) return `after unknown ${a}`;
  for (const w of [...(d.writeScope ?? []), ...(d.freeze ?? [])]) if (!goalScope.some((sc) => pathWithin(w, sc))) return `scope ${w} is outside the goal's scope`;
  for (const inf of [...(d.job?.informs ?? []), ...(d.wait?.informs ?? [])]) {
    const a = findAssumption(s, goal, inf.assumption);
    if (!a) return `informs unknown assumption ${inf.assumption}`;
    // A pre-registered threshold binds every test of that metric; a test on another
    // metric (a survey instead of pre-orders) states its own pass line up front.
    const pre = a.def.threshold?.metric === inf.metric ? a.def.threshold : undefined;
    if (pre && inf.threshold && JSON.stringify(pre) !== JSON.stringify(inf.threshold)) return `${inf.assumption} has a pre-registered threshold; a test can't change it`;
    if (!pre && !inf.threshold) return `${inf.assumption} has no pre-registered threshold for ${inf.metric}: state the pass line before the data exists`;
  }
  if (kind === "wait" && (!d.wait || !sources.includes(d.wait.source))) return `wait needs a known metric source (${sources.join(", ") || "none configured"})`;
  if (kind === "job" && !d.job) return "job needs a spec";
  const principals = s.engagement?.principals ?? {};
  if (kind === "action" && !(d.assignee && d.assignee in principals)) return "action needs an assignee who is a principal";
  if (d.review && !(d.review in principals)) return `reviewer ${d.review} is not a principal`;
  return null;
}

function checkSpawn(s: State, t: TodoState, children: GoalDef[], wtDir: string): { events: Array<Omit<HEvent, "at" | "by">> } | string {
  const parent = s.goals.get(t.goal)!;
  const siblings = [...s.goals.values()].filter((g) => g.def.parent === parent.id && g.status === "active");
  const remaining = (parent.def.budget.turns ?? Infinity) - parent.spent.turns;
  let carve = 0;
  const scopes: string[] = siblings.flatMap((g) => g.def.scope);
  for (const c of children) {
    if (!safeId(c.id) || s.goals.has(c.id)) return `bad or duplicate goal id ${c.id}`;
    if (!c.scope?.length || !c.scope.every((sc) => parent.def.scope.some((ps) => pathWithin(sc, ps)))) return `${c.id}'s scope must sit inside ${parent.id}'s`;
    if (c.scope.some((sc) => scopes.some((o) => pathsOverlap(sc, o)))) return `${c.id}'s scope overlaps another workstream; split the paths or define a contract between them`;
    scopes.push(...c.scope);
    if (!c.interfaces?.length) return `${c.id} names no interfaces: decide the contracts a workstream builds against before spawning it`;
    const missing = c.interfaces.filter((f) => !fs.existsSync(path.join(wtDir, f)));
    if (missing.length) return `${c.id}'s interfaces don't exist yet: ${missing.join(", ")}`;
    if (c.budget?.turns === undefined) return `${c.id} needs a turn budget`;
    carve += c.budget.turns;
  }
  if (carve > remaining) return `children need ${carve} turns; ${parent.id} has ${remaining} left`;
  // Workstreams an agent proposes don't get to be perpetual, watch the world, or claim
  // a bigger share of compute; their seed work goes through the same limits as any
  // proposal. Owners must be people who can answer.
  const principals = s.engagement?.principals ?? {};
  for (const c of children) if (c.owner && !(c.owner in principals)) return `${c.id}'s owner ${c.owner} is not a principal`;
  const goals: GoalDef[] = children.map(({ perpetual: _p, monitors: _m, share: _s, blackouts: _b, ...c }) => ({
    ...c, parent: parent.id, owner: c.owner ?? parent.def.owner,
    todos: (c.todos ?? []).map((d, i) => {
      const id = d.id ?? eid(c.id, "seed", i);
      return { ...sanitize(s, { ...d, id }), writeScope: (d.writeScope ?? []).filter((w) => c.scope.some((sc) => pathWithin(w, sc))) };
    }),
  }));
  if (carve > remaining * s.policy.spawn.autoCarveFraction) {
    const id = eid("ask-spawn", parent.id, goals.map((g) => g.id).join("_"));
    return {
      events: [{
        id, type: "ask_opened",
        ask: {
          id, goal: parent.id, to: parent.def.owner, kind: "decision", origin: `todo:${t.id}`, todo: t.id,
          question: `Spawn ${goals.length} workstreams (${goals.map((g) => g.id).join(", ")}) with ${carve} of ${parent.id}'s ${remaining} remaining turns?`,
          options: [{ id: "approve", label: "Spawn them", effect: { type: "spawn", goals } }, { id: "reject", label: "Don't", effect: { type: "ack" } }],
        },
      } as Omit<HEvent, "at" | "by">],
    };
  }
  return { events: spawnEvents(s, parent.id, goals) };
}

export function spawnEvents(s: State, parentId: string, goals: GoalDef[]): Array<Omit<HEvent, "at" | "by">> {
  const parent = s.goals.get(parentId)!;
  const carve = goals.reduce((n, g) => n + (g.budget.turns ?? 0), 0);
  const out: Array<Omit<HEvent, "at" | "by">> = [];
  for (const g of goals) {
    out.push({ id: eid("goal", g.id), type: "goal_opened", goal: { ...g, parent: parentId }, criteriaHash: criteriaHash(g), carvedFrom: parentId } as Omit<HEvent, "at" | "by">);
    for (const [i, d] of (g.todos ?? []).entries()) {
      const id = d.id ?? eid(g.id, "seed", i);
      out.push({ id: `add-${id}`, type: "todo_added", todo: { ...d, id, goal: g.id }, provenance: `spawn:${parentId}` } as Omit<HEvent, "at" | "by">);
    }
  }
  if (parent.def.budget.turns !== undefined) {
    out.push({ id: eid("carve", parentId, goals.map((g) => g.id).join("_")), type: "budget_set", goal: parentId, budget: { ...parent.def.budget, turns: parent.def.budget.turns - carve } } as Omit<HEvent, "at" | "by">);
  }
  return out;
}

export function criteriaHash(g: Pick<GoalDef, "assumptions" | "kill" | "success">): string {
  return sha256(JSON.stringify({ a: g.assumptions.map((a) => [a.id, a.threshold ?? null]), k: g.kill ?? [], s: g.success ?? [] })).slice(0, 16);
}

// An earlier answer to the same question with the same options, if reusing it changes
// nothing by itself: no effect, or only an approval or acknowledgement. Answers the harness
// gave itself (moot, auto-closed) are never precedent; only a person's are.
const SAFE_PRECEDENT = new Set(["approve", "ack"]);
const norm = (q: string) => q.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export function precedent(s: State, question: string, options: AskOption[]): AskState | undefined {
  const q = norm(question);
  const ids = options.map((o) => o.id).sort().join("|");
  let best: AskState | undefined;
  for (const a of s.asks.values()) {
    if (a.status !== "answered" || !a.choice || a.choice === "moot" || a.answeredBy === "harness") continue;
    if (norm(a.question) !== q || a.options.map((o) => o.id).sort().join("|") !== ids) continue;
    const opt = a.options.find((o) => o.id === a.choice);
    if (!opt || (opt.effect && !SAFE_PRECEDENT.has(opt.effect.type))) continue;
    if (!best || (a.answeredAt ?? 0) > (best.answeredAt ?? 0)) best = a;
  }
  return best;
}
