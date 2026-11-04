// After a ticket: looking back, the numbers, and noticing when the process has drifted
// (docs/jira-bugs.md).
//
// - Close: once a ticket has been quiet for the playbook's closeAfterDays, its close step
//   (a judge) reads the whole history and proposes at most a few lessons for the next ticket
//   on that service. Lessons are facts whose subject starts with "lesson.", and they reach
//   packets only once the partner keeps them: a guess made halfway never becomes knowledge.
//   A new round on the ticket drops a close that hasn't started.
// - Numbers: per playbook and service, computed from the log alone, never from a model.
// - Drift: the partner rewriting the same kind of reply again and again, or the conductor
//   sending the same step back, points at that step's brief. A judge drafts the change and
//   asks the partner; the playbook is theirs to change.
import type { State, TodoState } from "./project.ts";
import { FOLLOW_UP, playbookOf, serviceGoal, stepTodo } from "./playbook.ts";
import type { Playbook } from "./playbook.ts";
import { eid } from "./store.ts";
import type { HEvent, PlayRef } from "./types.ts";

const DAY = 86_400_000;
const H = "harness";
const LIVE = ["open", "running", "review", "blocked"];
export const CLOSE = "close";
export const LESSON = "lesson.";

type Ticket = { key: string; todos: TodoState[]; sends: TodoState[]; pb: Playbook; root: string };

// Every ticket that has a run, with its steps (all rounds) and the replies sent on it.
export function tickets(s: State): Ticket[] {
  const by = new Map<string, TodoState[]>();
  for (const t of s.todos.values()) {
    const k = t.play?.ticket ? `${t.play.ticket.source}/${t.play.ticket.id}` : undefined;
    if (!k) continue;
    by.set(k, [...(by.get(k) ?? []), t]);
  }
  const out: Ticket[] = [];
  for (const [key, todos] of by) {
    todos.sort((a, b) => a.addedAt - b.addedAt);
    const pb = playbookOf(s, todos[0].play);
    if (!pb) continue;
    const runs = new Set(todos.map((t) => t.play!.run));
    const sends = [...s.todos.values()].filter((t) => t.because && runs.has(t.because) && (t.job?.spec?.jira as { comment?: string } | undefined)?.comment);
    out.push({ key, todos, sends, pb, root: todos[0].play!.run });
  }
  return out;
}

const minutes = (t: TodoState) => (t.doneAt !== undefined ? Math.round((t.doneAt - t.addedAt) / 60_000) : undefined);

// What happened on a ticket, for its close step: each step, what it chose, what we said.
function history(s: State, k: Ticket): string {
  const lines: string[] = [];
  for (const t of k.todos) {
    if (t.play!.step === CLOSE) continue;
    const o = s.playOutcomes.get(t.id);
    const m = minutes(t);
    lines.push(`- ${t.play!.step}${o ? ` → ${o.outcome}` : ""} (${t.status}${m !== undefined ? `, ${m} min` : ""})${o?.slots.summary ? `: ${o.slots.summary}` : ""}${o?.slots.where ? ` [${o.slots.where}]` : ""}`);
    for (const c of s.conducted.filter((x) => x.todo === t.id && x.verdict === "reject")) lines.push(`  sent back by the conductor: ${c.note ?? ""}`);
  }
  for (const t of k.sends) {
    const text = String((t.job!.spec.jira as { comment: string }).comment);
    // Sent as drafted, or as the partner rewrote it (the answer's note).
    const rewritten = [...s.replies.values()].some((r) => r.run === t.because && s.asks.get(eid("ask-reply", r.todo))?.choice === "edit" && s.asks.get(eid("ask-reply", r.todo))?.note?.trim() === text);
    lines.push(`- reply sent${rewritten ? " (rewritten by the partner)" : ""}: "${text.slice(0, 300)}"`);
  }
  return lines.join("\n").slice(0, 1600);
}

export function retroRules(s: State, now: number, emit: (e: HEvent) => void): void {
  if (!s.policy.playbooks) return;
  for (const k of tickets(s)) closeRule(s, k, now, emit);
  driftRules(s, now, emit);
  promoteRule(s, now, emit);
}

// ---------- plans on probation ----------

// Each drafted plan's kind, with how its runs went, in order: finished, and clean (the
// conductor sent nothing back, the partner rewrote or held no reply, dropped no work).
export function planRuns(s: State): Map<string, { pb: Playbook; goal: string; runs: Array<{ root: string; finished: boolean; clean: boolean }> }> {
  const out = new Map<string, { pb: Playbook; goal: string; runs: Array<{ root: string; finished: boolean; clean: boolean }> }>();
  for (const k of tickets(s)) {
    const plan = s.plans.get(k.root);
    if (!plan) continue;
    const ids = new Set(k.todos.map((t) => t.id));
    const sentBack = s.conducted.some((c) => ids.has(c.todo) && c.verdict === "reject");
    const rewritten = k.todos.some((t) => ["edit", "hold"].includes(s.asks.get(eid("ask-reply", t.id))?.choice ?? ""));
    const dropped = k.todos.some((t) => t.status === "superseded" && /^dropped by /.test(t.reason ?? ""));
    const finished = !isBusy(s, k) && k.todos.some((t) => t.status === "done" && t.play!.run === k.root && t.play!.step !== k.pb.start);
    const row = out.get(plan.kind) ?? { pb: k.pb, goal: k.todos[k.todos.length - 1].goal, runs: [] };
    row.runs.push({ root: k.root, finished, clean: !sentBack && !rewritten && !dropped });
    out.set(plan.kind, row);
  }
  return out;
}

function promoteRule(s: State, now: number, emit: (e: HEvent) => void): void {
  for (const [kind, r] of planRuns(s)) {
    const done = r.runs.filter((x) => x.finished);
    let streak = 0;
    for (const x of [...done].reverse()) {
      if (!x.clean) break;
      streak++;
    }
    const need = r.pb.promoteAfter ?? 3;
    if (streak < need) continue;
    // Asked again after each further run of that many clean ones, if not made a playbook yet.
    const id = eid("ask-promote", r.pb.id, kind, Math.floor(done.filter((x) => x.clean).length / need));
    if (s.asks.has(id)) continue;
    emit({ id, at: now, by: H, type: "ask_opened", ask: {
      id, goal: r.goal, to: s.goals.get(r.goal)?.def.owner ?? "partner", kind: "decision", origin: "rule:play_promote",
      question: `${kind} tickets have gone well ${streak} times in a row on drafted plans, with nothing sent back, rewritten or dropped. Make it a playbook of its own? \`npm run harness -- playbooks draft ${kind}\` prints a starting file: save it as policy/playbooks/${kind}.json, and add an event rule that names it.`,
      options: [{ id: "make", label: "I'll make it a playbook", effect: { type: "ack" } }, { id: "wait", label: "Keep drafting plans for now", effect: { type: "ack" } }],
    } });
  }
}

// A starting playbook for a kind, from its latest plan: the drafting playbook's own first
// step, routed to the plan's steps, with the ticket's id made a placeholder. Its wording is
// still one ticket's: generalise it before you save it.
export function draftPlaybook(s: State, kind: string): Playbook | undefined {
  const latest = [...s.plans.entries()].filter(([, p]) => p.kind === kind).sort((a, b) => b[1].at - a[1].at)[0];
  if (!latest) return undefined;
  const [run, plan] = latest;
  const from = tickets(s).find((k) => k.root === run);
  if (!from) return undefined;
  const ticket = from.todos[0].play!.ticket?.id ?? "";
  const general = (x: string) => (ticket ? x.split(ticket).join("{ticket.id}") : x);
  const start = from.pb.steps[from.pb.start];
  const outcomes = Object.fromEntries(Object.entries(start.outcomes ?? {}).filter(([o]) => o !== "planned"));
  const steps: Playbook["steps"] = {
    triage: { ...start, plans: undefined, conduct: undefined, text: "Triage {ticket.id}: {ticket.title}", brief: [`Read the ticket and say whether it's a ${kind} ticket you can route.`, "The services we support: {services}."],
      outcomes: { route: { next: plan.steps.map((x) => x.id), needs: ["summary"], means: "it's this kind of ticket: \"summary\" says what's asked, in a sentence." }, ...outcomes } },
  };
  for (const x of plan.steps) steps[x.id] = { lane: x.lane, text: general(x.text), brief: [general(x.text)], ...(x.after ? { after: x.after } : {}), ...(x.reply ? { reply: true } : {}), ...(x.writes ? { writes: true } : {}) };
  for (const n of Object.values(outcomes).flatMap((o) => o.next)) if (!steps[n] && from.pb.steps[n]) steps[n] = from.pb.steps[n];
  return { id: kind, version: 1, title: kind.replace(/-/g, " "), start: "triage", steps, ...(from.pb.replies ? { replies: from.pb.replies } : {}), ...(from.pb.close ? { close: from.pb.close, closeAfterDays: from.pb.closeAfterDays } : {}), ...(from.pb.followUp ? { followUp: from.pb.followUp, maxFollowUps: from.pb.maxFollowUps } : {}) };
}

// Work under way on a ticket: a step, a reply on its way, or a question about one.
function isBusy(s: State, k: Ticket): boolean {
  const work = k.todos.filter((t) => t.play!.step !== CLOSE);
  return work.some((t) => LIVE.includes(t.status)) || k.sends.some((t) => LIVE.includes(t.status)) ||
    [...s.asks.values()].some((a) => a.status === "open" && a.todo && work.some((t) => t.id === a.todo));
}

function closeRule(s: State, k: Ticket, now: number, emit: (e: HEvent) => void): void {
  if (!k.pb.close) return;
  const work = k.todos.filter((t) => t.play!.step !== CLOSE);
  const closes = k.todos.filter((t) => t.play!.step === CLOSE);
  const busy = isBusy(s, k);
  if (busy) {
    // A new round: its close comes after it.
    for (const c of closes) if (c.status === "open" && !c.turns) emit({ id: eid("sup", c.id), at: now, by: H, type: "todo_superseded", todo: c.id, reason: "the ticket has a new round" });
    return;
  }
  if (!work.some((t) => t.status === "done")) return;
  if (closes.some((c) => c.status !== "superseded")) return;
  // Not in the same moment as the last step: the rules of that pass may still add the steps
  // that follow it (a fork's branch), and a close made then would be dropped at once.
  const last = Math.max(...work.map((t) => t.doneAt ?? t.addedAt), ...k.sends.map((t) => t.doneAt ?? t.addedAt));
  if (last >= now) return;
  // Numbered, so a close dropped for a new round never stands in the way of the next.
  const run = `${k.root}-close-${closes.length + 1}`;
  const first = work.find((t) => t.play!.service)?.play!;
  const ref: PlayRef = { ...k.todos[0].play!, run, step: CLOSE, service: first?.service, slots: { ...(first?.slots ?? {}) } };
  const d = stepTodo(s, ref, CLOSE);
  const goal = serviceGoal(s, ref.service)?.id ?? k.todos[k.todos.length - 1].goal;
  emit({ id: `add-${d.id}`, at: now, by: H, type: "todo_added", provenance: "play:close", todo: {
    ...d, goal, because: k.root,
    notBefore: new Date(last + (k.pb.closeAfterDays ?? 3) * DAY).toISOString(),
    text: `${d.text}\n\nWhat happened:\n${history(s, k)}`.slice(0, 2000),
  } });
}

// A close's proposed lessons go to the partner; kept ones count as confirmed facts.
export function lessonRules(s: State, now: number, emit: (e: HEvent) => void): void {
  for (const t of s.todos.values()) {
    if (t.play?.step !== CLOSE || t.status !== "done" || !t.play.service) continue;
    const turns = new Set(s.turns.filter((x) => x.todo === t.id).map((x) => x.id));
    const lessons = [...(s.facts.get(t.play.service)?.values() ?? [])].filter((f) => f.subject.startsWith(LESSON) && f.turn && turns.has(f.turn) && !f.confirmed);
    if (!lessons.length) continue;
    const askId = eid("ask-lessons", t.id);
    const a = s.asks.get(askId);
    if (!a) {
      emit({ id: askId, at: now, by: H, type: "ask_opened", ask: {
        id: askId, goal: t.goal, to: s.goals.get(t.goal)?.def.owner ?? "partner", kind: "decision", todo: t.id, lane: t.lane, origin: "rule:play_lessons",
        question: `Looking back at ${t.play.ticket?.id ?? t.play.run}, keep these for the next ${t.play.service} ticket?\n${lessons.map((f) => `- ${f.subject.slice(LESSON.length)}: ${f.text}`).join("\n")}`.slice(0, 2000),
        options: [{ id: "keep", label: "Keep them", effect: { type: "ack" }, consequence: "later packets for this service include them as confirmed" }, { id: "drop", label: "Don't keep them", effect: { type: "ack" } }],
      } });
      continue;
    }
    if ((a.status !== "answered" && a.status !== "auto_closed") || a.choice !== "keep") continue;
    for (const f of lessons) emit({ id: eid("lesson-ok", f.id), at: now, by: a.answeredBy ?? H, type: "fact_confirmed", service: f.service, subject: f.subject, fact: f.id });
  }
}

// ---------- drift ----------

function driftRules(s: State, now: number, emit: (e: HEvent) => void): void {
  // Replies the partner rewrote, by service and kind.
  const replies = new Map<string, Array<{ draft: string; sent?: string; edited: boolean; goal: string; pb: Playbook; step: string }>>();
  for (const r of s.replies.values()) {
    const t = s.todos.get(r.todo);
    const a = s.asks.get(eid("ask-reply", r.todo));
    const pb = t ? playbookOf(s, t.play) : undefined;
    if (!t?.play || !pb || !a || a.status !== "answered" || !["send", "edit"].includes(a.choice ?? "")) continue;
    const k = `${pb.id}|${t.play.service ?? ""}|${r.outcome}`;
    replies.set(k, [...(replies.get(k) ?? []), { draft: r.text, sent: a.note, edited: a.choice === "edit", goal: t.goal, pb, step: t.play.step }]);
  }
  for (const [k, xs] of replies) {
    const recent = xs.slice(-5);
    const edits = recent.filter((x) => x.edited);
    if (edits.length < 3) continue;
    const [pbId, service, outcome] = k.split("|");
    const pb = edits[0].pb;
    const id = eid("drift-reply", pbId, service, outcome, Math.floor(xs.filter((x) => x.edited).length / 3));
    const brief = (pb.steps[edits[0].step]?.brief ?? []).join(" / ");
    driftTodo(s, emit, now, id, edits[edits.length - 1].goal, pb, edits[0].step,
      `You rewrote ${edits.length} of the last ${recent.length} ${outcome.replace(/_/g, " ")} replies${service ? ` for ${service}` : ""}.`,
      [`The ${edits[0].step} step's brief now: "${brief.slice(0, 500)}"`, `Its reply guide for ${outcome}: "${pb.replies?.[outcome] ?? ""}"`, ...edits.slice(-3).map((x, i) => `Draft ${i + 1}: "${x.draft.slice(0, 200)}" → sent as: "${(x.sent ?? "").slice(0, 200)}"`)]);
  }
  // Steps the conductor sends back, by playbook and step.
  const reads = new Map<string, Array<{ reject: boolean; note?: string; goal: string; pb: Playbook }>>();
  for (const c of s.conducted) {
    const t = s.todos.get(c.todo);
    const pb = t ? playbookOf(s, t.play) : undefined;
    if (!t?.play || !pb) continue;
    const k = `${pb.id}|${t.play.step}`;
    reads.set(k, [...(reads.get(k) ?? []), { reject: c.verdict === "reject", note: c.note, goal: t.goal, pb }]);
  }
  for (const [k, xs] of reads) {
    const recent = xs.slice(-5);
    const back = recent.filter((x) => x.reject);
    if (back.length < 3) continue;
    const [pbId, step] = k.split("|");
    const pb = back[0].pb;
    const id = eid("drift-conduct", pbId, step, Math.floor(xs.filter((x) => x.reject).length / 3));
    driftTodo(s, emit, now, id, back[back.length - 1].goal, pb, step,
      `The conductor sent the ${step} step back ${back.length} times in its last ${recent.length} reads.`,
      [`The ${step} step's brief now: "${(pb.steps[step]?.brief ?? []).join(" / ").slice(0, 500)}"`, ...back.slice(-3).map((x, i) => `Sent back ${i + 1}: "${(x.note ?? "").slice(0, 200)}"`)]);
  }
}

function driftTodo(s: State, emit: (e: HEvent) => void, now: number, id: string, goal: string, pb: Playbook, step: string, what: string, evidence: string[]): void {
  if (s.todos.has(id)) return;
  emit({ id: `add-${id}`, at: now, by: H, type: "todo_added", provenance: "rule:play_drift", todo: {
    id, goal, lane: "retro", kind: "task", priority: 2, because: `playbook:${pb.id}`,
    text: [
      `The ${pb.title} playbook (v${pb.version}) may have drifted from how the work is really done. ${what}`,
      ...evidence,
      `Work out what the step should say instead, from this evidence alone. Then ask the partner, with one ask: quote the current wording, give the new wording, and offer "I'll change the playbook" and "Leave it as it is". The playbook is policy: you can't change it, and neither can the harness.`,
    ].join("\n").slice(0, 2000),
  } });
}

// ---------- the numbers ----------

export type PlaybookStats = {
  playbook: string;
  service: string;
  tickets: number;
  outcomes: Record<string, number>; // each ticket's last outcome
  followUps: number;
  steps: Array<{ step: string; done: number; medianMinutes: number | null; conducted: number; sentBack: number }>;
  replies: { sent: number; rewritten: number; held: number };
  closed: number;
  lessons: { proposed: number; kept: number };
};

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const v = [...xs].sort((a, b) => a - b);
  return v.length % 2 ? v[(v.length - 1) / 2] : Math.round((v[v.length / 2 - 1] + v[v.length / 2]) / 2);
};

// Pure: from the log, per playbook and service.
export function playbookStats(s: State): PlaybookStats[] {
  const rows = new Map<string, PlaybookStats & { mins: Map<string, number[]> }>();
  const row = (pb: string, service: string) => {
    const k = `${pb}|${service}`;
    let r = rows.get(k);
    if (!r) rows.set(k, (r = { playbook: pb, service, tickets: 0, outcomes: {}, followUps: 0, steps: [], replies: { sent: 0, rewritten: 0, held: 0 }, closed: 0, lessons: { proposed: 0, kept: 0 }, mins: new Map() }));
    return r;
  };
  for (const k of tickets(s)) {
    const service = k.todos.find((t) => t.play!.service)?.play!.service ?? "(none)";
    const r = row(k.pb.id, service);
    r.tickets++;
    // The last outcome that says what the ticket was, not where it went next.
    const last = k.todos.map((t) => s.playOutcomes.get(t.id)).filter((o) => o && !["route", "look"].includes(o.outcome)).sort((a, b) => a!.at - b!.at).pop();
    if (last) r.outcomes[last.outcome] = (r.outcomes[last.outcome] ?? 0) + 1;
    r.followUps += k.todos.filter((t) => t.play!.step === FOLLOW_UP).length;
    r.closed += k.todos.filter((t) => t.play!.step === CLOSE && t.status === "done").length;
    for (const t of k.todos) {
      const m = minutes(t);
      if (t.status === "done" && m !== undefined) r.mins.set(t.play!.step, [...(r.mins.get(t.play!.step) ?? []), m]);
      else if (!r.mins.has(t.play!.step)) r.mins.set(t.play!.step, []);
      const a = s.asks.get(eid("ask-reply", t.id));
      if (a?.status === "answered") {
        if (a.choice === "edit") r.replies.rewritten++;
        if (a.choice === "hold") r.replies.held++;
      }
    }
    r.replies.sent += k.sends.filter((t) => t.status === "done").length;
  }
  for (const r of rows.values()) {
    const ticketsHere = tickets(s).filter((k) => k.pb.id === r.playbook && (k.todos.find((t) => t.play!.service)?.play!.service ?? "(none)") === r.service);
    const ids = new Set(ticketsHere.flatMap((k) => k.todos.map((t) => t.id)));
    for (const [step, mins] of r.mins) {
      const reads = s.conducted.filter((c) => ids.has(c.todo) && s.todos.get(c.todo)?.play?.step === step);
      r.steps.push({ step, done: mins.length, medianMinutes: median(mins), conducted: reads.length, sentBack: reads.filter((c) => c.verdict === "reject").length });
    }
    const facts = [...(s.facts.get(r.service)?.values() ?? [])].filter((f) => f.subject.startsWith(LESSON));
    r.lessons = { proposed: facts.length, kept: facts.filter((f) => f.confirmed).length };
  }
  return [...rows.values()].map(({ mins: _m, ...r }) => r).sort((a, b) => b.tickets - a.tickets);
}
