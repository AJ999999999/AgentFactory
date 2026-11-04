// Playbooks: work that has a known shape, such as a bug ticket, written once as steps the
// harness fills in for each case (docs/jira-bugs.md). A ticket isn't one todo: it's a
// process with a fork in the middle, and which way the fork goes is only known once
// someone has looked.
//
// - A run starts when an event rule names a playbook: its first step becomes the todo.
// - A step with outcomes is a fork. Its turn returns one outcome from a fixed list, and the
//   slots it found (the service, the error, a summary). Once the step is done (after the
//   conductor, when it reads the step), the harness adds the steps that outcome names. The
//   agent chooses the branch; it never writes the branch's todos itself.
// - A step with `reply` drafts the answer to the person who filed the ticket. The partner
//   is asked before it goes out, and the loop sends it, never a turn. A reply telling a user
//   the problem was their own doing is always asked (rule:jira_reply_user_error).
// - Steps after triage go to the goal of the service the ticket is about, from the service
//   map. Triage never opens a goal: a service with no goal is a question for the partner.
// - What turns learn about a service (where code is, what its logs look like) is a fact:
//   recorded right away, unconfirmed until the partner confirms it, replaced by a newer one
//   on the same subject, and rechecked once the playbook it was learned under changes.
import * as fs from "node:fs";
import * as path from "node:path";
import type { State, TodoState } from "./project.ts";
import { HARNESS_DIR, eid } from "./store.ts";
import type { SourceDef } from "./events.ts";
import type { AskOption, Fact, HEvent, PlayRef, ServiceDef, TodoDraft } from "./types.ts";

export type PlayStep = {
  lane: string;
  kind?: "task" | "job";
  logs?: boolean; // a job that fetches the service's logs around the ticket (logs.ts)
  after?: string[]; // steps of the same run that finish first
  text: string; // the todo, with {placeholders}
  brief: string[]; // what the turn is told to do, with {placeholders}
  // A fork: each outcome names the steps it adds, and the slots its turn must fill.
  outcomes?: Record<string, { next: string[]; needs?: string[]; means: string }>;
  reply?: boolean; // drafts the reply to the ticket's reporter
  conduct?: boolean; // the conductor reads it before its outcome is taken
  priority?: number;
  writes?: boolean; // may change the service's code (its `dir`)
  check?: string; // the check its output must pass: a world checker, or tests-fail / tests-pass (checks.ts)
  // Shipping: a step that only ships with a later one (ship false), and the earlier steps
  // whose commits go in the same pull request (shipWith).
  ship?: boolean;
  shipWith?: string[];
  needsShip?: boolean; // only added when the service's goal ships to a repository
  merged?: string[]; // steps added once its pull request is merged
};

export type Playbook = {
  id: string;
  version: number;
  title: string;
  start: string; // the first step
  steps: Record<string, PlayStep>;
  // What each kind of reply says, by the outcome that led to it.
  replies?: Record<string, string>;
  // Once per service goal: a first look at its code, logs and commands, as facts.
  onboard?: PlayStep;
};

export function loadPlaybooks(dir: string): Record<string, Playbook> {
  if (!fs.existsSync(dir)) return {};
  const out: Record<string, Playbook> = {};
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    const pb = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Playbook;
    const bad = playbookProblems(pb);
    if (bad.length) throw new Error(`playbook ${f}: ${bad.join("; ")}`);
    out[pb.id] = pb;
  }
  return out;
}

export function playbookProblems(pb: Playbook): string[] {
  const out: string[] = [];
  if (!pb.id || !Number.isInteger(pb.version)) out.push("needs an id and a whole-number version");
  if (!pb.steps?.[pb.start]) out.push(`start step ${pb.start} doesn't exist`);
  for (const [id, st] of Object.entries(pb.steps ?? {})) {
    for (const a of st.after ?? []) if (!pb.steps[a]) out.push(`${id}: after ${a}, which doesn't exist`);
    for (const [o, b] of Object.entries(st.outcomes ?? {})) for (const n of b.next) if (!pb.steps[n]) out.push(`${id}: outcome ${o} leads to ${n}, which doesn't exist`);
    if (st.logs && st.kind !== "job") out.push(`${id}: fetching logs is a job`);
    for (const x of [...(st.shipWith ?? []), ...(st.merged ?? [])]) if (!pb.steps[x]) out.push(`${id}: names step ${x}, which doesn't exist`);
  }
  return out;
}

export const playbookOf = (s: State, ref?: PlayRef) => (ref ? s.policy.playbooks?.[ref.playbook] : undefined);
export const stepOf = (s: State, t: Pick<TodoState, "play">): PlayStep | undefined => {
  const pb = playbookOf(s, t.play);
  if (!pb || !t.play) return undefined;
  return t.play.step === "onboard" ? pb.onboard : pb.steps[t.play.step];
};

export const serviceOf = (s: State, id?: string): ServiceDef | undefined => (id ? (s.engagement?.services ?? []).find((x) => x.id === id) : undefined);
export const serviceGoal = (s: State, id?: string) => (id ? [...s.goals.values()].find((g) => g.def.service === id && g.status === "active") : undefined);

// Where a run's log excerpt lands in the engagement's repo: a harness path, so no turn can
// write it, and every turn after can read it.
export const logsFile = (engagement: string, run: string) => `${HARNESS_DIR}/${engagement}/logs/${run}.log`;

// {ticket.id}, {service}, {slots.summary}, {build}... Unknown names become nothing.
function fill(text: string, vars: Record<string, string | undefined>): string {
  return text.replace(/\{([a-zA-Z][\w.]*)\}/g, (_, k: string) => vars[k] ?? "");
}

function vars(s: State, ref: PlayRef, outcome?: string): Record<string, string | undefined> {
  const pb = playbookOf(s, ref);
  const svc = serviceOf(s, ref.service);
  const v: Record<string, string | undefined> = {
    "ticket.id": ref.ticket?.id, "ticket.title": ref.ticket?.title, "ticket.url": ref.ticket?.url, service: ref.service, run: ref.run, outcome,
    dir: svc?.dir, build: svc?.build, test: svc?.test, sample: svc?.sample, sop: svc?.sop, "logs.where": svc?.logs?.where, "logs.notes": svc?.logs?.notes,
    logsFile: logsFile(s.engagement?.id ?? "", ref.run),
    services: (s.engagement?.services ?? []).map((x) => `${x.id}${x.names?.length ? ` (${x.names.join(", ")})` : ""}${x.jiraComponents?.length ? ` [Jira: ${x.jiraComponents.join(", ")}]` : ""}`).join("; "),
    replyGuide: outcome ? pb?.replies?.[outcome] : undefined,
  };
  for (const [k, x] of Object.entries(ref.slots ?? {})) v[`slots.${k}`] = x;
  return v;
}

// A run's first step is the run itself; each later step is "<run>-<step>", so taking a
// branch twice adds it once.
const stepId = (pb: Playbook, run: string, step: string) => (step === pb.start ? run : `${run}-${step}`);

// One step of a run, as a todo.
export function stepTodo(s: State, ref: PlayRef, step: string, outcome?: string): TodoDraft & { id: string } {
  const pb = playbookOf(s, ref)!;
  const st = step === "onboard" ? pb.onboard! : pb.steps[step];
  const id = stepId(pb, ref.run, step);
  const v = vars(s, ref, outcome);
  const svc = serviceOf(s, ref.service);
  const draft: TodoDraft & { id: string } = {
    id, lane: st.lane, kind: st.kind ?? "task", text: fill(st.text, v).slice(0, 2000), priority: st.priority ?? 2,
    play: { ...ref, step }, because: ref.run === id ? undefined : ref.run,
    ...(st.after?.length ? { after: st.after.map((a) => stepId(pb, ref.run, a)) } : {}),
    ...(st.conduct ? { conduct: true } : {}),
    ...(st.writes && svc?.dir ? { writeScope: [svc.dir] } : {}),
    ...(st.check ? { check: st.check } : {}),
  };
  if (st.logs) {
    const terms = (ref.slots?.terms ?? "").split(/[,;\n]/).map((x) => x.trim()).filter(Boolean).slice(0, 8);
    draft.job = { spec: { logs: { service: ref.service ?? "", ...(svc?.logs ?? {}), terms, from: ref.slots?.from ?? "", to: ref.slots?.to ?? "", file: v.logsFile } } };
  }
  return draft;
}

// What a step's turn is told, after the packet: its brief, and what it must hand back.
export function playPrompt(s: State, t: TodoState): string[] {
  const st = stepOf(s, t);
  if (!st || !t.play) return [];
  const pb = playbookOf(s, t.play)!;
  const v = vars(s, t.play, t.play.slots?.outcome);
  const out = [
    `This is step "${t.play.step}" of the ${pb.title} playbook (v${pb.version})${t.play.ticket ? ` for ${t.play.ticket.id}` : ""}${t.play.service ? `, service ${t.play.service}` : ""}.`,
    // Twice: a reply guide brought in by {replyGuide} has placeholders of its own.
    ...st.brief.map((b) => fill(fill(b, v), v)),
  ];
  if (st.outcomes) {
    out.push(`When you're done, choose where it goes next. Add "outcome" to the JSON, one of:`);
    for (const [o, b] of Object.entries(st.outcomes)) out.push(`- "${o}": ${b.means}${b.needs?.length ? ` Needs "slots": ${b.needs.map((n) => `"${n}"`).join(", ")}.` : ""}`);
    out.push(`and "slots": {"name": "short text"} with what you found. The harness adds the next steps; don't propose them as todos.`);
  }
  if (st.reply) out.push(`Add "reply": {"text": "..."}: the reply to the person who filed the ticket, in plain words. It goes to the partner first; nothing is sent by you.`);
  if (t.play.service) out.push(`What you learn about ${t.play.service} that the next ticket would need (where code is, what the logs look like, how to run it) goes in "facts": [{"subject": "area.thing", "text": "...", "source": "repo:<path>"}].`);
  return out;
}

// What's known about a service, for the packet: confirmed facts first, then unconfirmed
// ones, marked; facts learned under an older playbook are marked to recheck.
export function factLines(s: State, service: string, max = 4): string[] {
  const facts = [...(s.facts.get(service)?.values() ?? [])];
  const current = (f: Fact) => !f.playbook || (s.policy.playbooks?.[f.playbook.id]?.version ?? f.playbook.version) <= f.playbook.version;
  const label = (f: Fact & { confirmed?: boolean }) => (f.confirmed ? "confirmed" : !current(f) ? "learned under an older playbook: recheck" : "unconfirmed");
  return facts
    .sort((a, b) => Number(!!b.confirmed) - Number(!!a.confirmed) || Number(current(b)) - Number(current(a)) || b.at - a.at)
    .slice(0, max)
    .map((f) => `Known about ${service} (${label(f)}): ${f.subject}: ${f.text.slice(0, 200)}`);
}

// ---------- the harness's rules for runs ----------

const H = "harness";

export function playRules(s: State, now: number, emit: (e: HEvent) => void): void {
  if (!s.policy.playbooks) return;
  const add = (goal: string, d: TodoDraft & { id: string }, provenance: string) => {
    if (s.todos.has(d.id)) return;
    emit({ id: `add-${d.id}`, at: now, by: H, type: "todo_added", todo: { ...d, goal }, provenance });
  };

  // A fork whose step is done: take the branch its outcome names.
  for (const t of s.todos.values()) {
    if (t.status !== "done" || !t.play) continue;
    const st = stepOf(s, t);
    const o = s.playOutcomes.get(t.id);
    if (!st?.outcomes || !o) continue;
    const branch = st.outcomes[o.outcome];
    if (!branch) continue;
    const slots = { ...(t.play.slots ?? {}), ...o.slots };
    let service = t.play.service ?? slots.service;
    let goal = serviceGoal(s, service);
    if (service && !goal && branch.needs?.includes("service")) {
      // A service with no goal, or one triage couldn't name: the partner says which.
      const askId = eid("ask-service", t.play.run);
      const a = s.asks.get(askId);
      if (!a) {
        const known = (s.engagement?.services ?? []).filter((x) => serviceGoal(s, x.id));
        const options: AskOption[] = [...known.map((x) => ({ id: x.id, label: x.id, effect: { type: "ack" as const } })), { id: "none", label: "Not one of ours: leave it", effect: { type: "ack" } }];
        emit({ id: askId, at: now, by: H, type: "ask_opened", ask: {
          id: askId, goal: t.goal, to: s.goals.get(t.goal)?.def.owner ?? "partner", kind: "decision", todo: t.id, origin: "rule:play_service",
          question: `Which service is ${t.play.ticket?.id ?? t.play.run} about? Triage named "${service}", which has no goal. (${t.play.ticket?.title ?? ""})`.slice(0, 600),
          options,
        } });
        continue;
      }
      if (a.status === "open" || a.choice === "none" || a.choice === "moot") continue;
      service = a.choice!;
      goal = serviceGoal(s, service);
      if (!goal) continue;
    }
    const ref: PlayRef = { ...t.play, service, slots: { ...slots, outcome: o.outcome } };
    const pb = playbookOf(s, t.play)!;
    for (const step of branch.next) {
      // A fix only makes sense where it can ship; without a repository it stops at the reply.
      if (pb.steps[step]?.needsShip && !goal?.def.ship) {
        emit({ id: eid("play-noship", t.play.run, step), at: now, by: H, type: "note", goal: goal?.id ?? t.goal, text: `${t.play.ticket?.id ?? t.play.run}: ${step} isn't started, since ${service ?? "this service"} has no repository to ship to (ship in its goal).` });
        continue;
      }
      add(goal?.id ?? t.goal, stepTodo(s, ref, step, o.outcome), `play:${t.id}`);
    }
    // The ticket moves on in Jira when it's routed to a service, if the source says how.
    const src = sourceOf(s, t.play.ticket?.source);
    if (goal && src?.statuses?.routed && t.play.ticket && t.play.step === playbookOf(s, t.play)!.start) {
      add(goal.id, jiraJob(`${t.play.run}-jira-routed`, src, t.play.ticket.id, { transition: src.statuses.routed }, `Move ${t.play.ticket.id} to "${src.statuses.routed}"`, t.play), "play:jira");
    }
  }

  // A step's pull request merged (ship.ts watched it): the steps that follow a merge, such as
  // telling the reporter it's fixed.
  for (const w of s.todos.values()) {
    if (w.status !== "done" || !w.job?.spec?.watch) continue;
    const shipJob = w.because ? s.todos.get(w.because) : undefined;
    const t = shipJob?.job?.spec?.ship ? s.todos.get(shipJob.job.spec.ship as string) : undefined;
    const st = t ? stepOf(s, t) : undefined;
    if (!t?.play || !st?.merged?.length) continue;
    const ref: PlayRef = { ...t.play, slots: { ...(t.play.slots ?? {}), outcome: "fixed" } };
    for (const step of st.merged) add(t.goal, stepTodo(s, ref, step, "fixed"), `play:${w.id}`);
  }

  // A drafted reply: ask the partner, then send it once they say so.
  for (const r of s.replies.values()) {
    const t = s.todos.get(r.todo);
    if (!t) continue;
    const askId = eid("ask-reply", r.todo);
    const a = s.asks.get(askId);
    if (!a) {
      const userError = r.outcome === "user_error";
      const st = sourceOf(s, r.ticket.source)?.statuses;
      const moveTo = r.outcome === "fixed" ? st?.resolved ?? st?.replied : st?.replied;
      emit({ id: askId, at: now, by: H, type: "ask_opened", ask: {
        id: askId, goal: t.goal, to: s.goals.get(t.goal)?.def.owner ?? "partner", kind: "approval", todo: r.todo, lane: t.lane,
        // Telling a user it was their own doing, when it was our bug, is the costliest
        // mistake on this path: that kind is always the partner's (standing.ts).
        origin: userError ? "rule:jira_reply_user_error" : "rule:jira_reply",
        question: `Send this reply on ${r.ticket.id} (${r.outcome.replace(/_/g, " ")})?\n\n${r.text}`.slice(0, 2400),
        options: [
          // Only a user_error reply is marked as final: that keeps it out of "from now on"
          // twice over. Other kinds (a duplicate's link) may go out by a standing answer.
          { id: "send", label: "Send it", effect: { type: "approve" }, consequence: `posts it as a comment on ${r.ticket.id}${moveTo ? ` and moves it to "${moveTo}"` : ""}; it can't be unsent`, ...(userError ? { irreversible: true } : {}) },
          { id: "edit", label: "Send my text instead (answer with it in the note)", effect: { type: "approve" }, ...(userError ? { irreversible: true } : {}) },
          { id: "hold", label: "Don't send", effect: { type: "ack" } },
        ],
      } });
      continue;
    }
    if (!(a.status === "answered" || a.status === "auto_closed") || (a.choice !== "send" && a.choice !== "edit")) continue;
    const text = a.choice === "edit" ? (a.note ?? "").trim() : r.text;
    if (!text) continue;
    const src = sourceOf(s, r.ticket.source);
    if (!src) continue;
    // A reply saying it's fixed closes the ticket's loop; any other waits on the reporter.
    const status = r.outcome === "fixed" ? src.statuses?.resolved ?? src.statuses?.replied : src.statuses?.replied;
    add(t.goal, jiraJob(`${r.todo}-send`, src, r.ticket.id, { comment: text, ...(status ? { transition: status } : {}) }, `Send the reply on ${r.ticket.id}`, t.play), "play:jira");
  }

  // Each service goal gets one first look, so its first ticket starts from what's known.
  const onboarders = Object.values(s.policy.playbooks).filter((p) => p.onboard);
  if (onboarders.length) {
    for (const g of s.goals.values()) {
      if (g.status !== "active" || !g.def.service || !serviceOf(s, g.def.service)) continue;
      const pb = onboarders[0];
      const run = eid("onboard", g.def.service);
      if (s.todos.has(run) || s.facts.get(g.def.service)?.size) continue;
      add(g.id, stepTodo(s, { playbook: pb.id, version: pb.version, run, step: "onboard", service: g.def.service }, "onboard"), "play:onboard");
    }
  }
}

type Source = SourceDef;
const sourceOf = (s: State, id?: string): Source | undefined => (s.engagement?.events?.sources ?? []).find((x) => x.id === id);

// Writing to Jira is a job the loop runs with its own token (jira.ts). The spec carries
// what it needs to do it (never the token itself), so a restarted loop can go on.
function jiraJob(id: string, src: Source, ticket: string, what: { comment?: string; transition?: string }, text: string, play?: PlayRef): TodoDraft & { id: string } {
  return {
    id, kind: "job", lane: "jira", priority: 1, text, ...(play ? { because: play.run } : {}),
    job: { spec: { jira: { source: src.id, url: src.url, tokenEnv: src.tokenEnv, ...(src.cloud ? { cloud: src.cloud } : {}), ticket, ...what } } },
  };
}

// For the event rule: the first step of a new run.
export function startRun(s: State, playbook: string, run: string, ticket: PlayRef["ticket"]): (TodoDraft & { id: string }) | undefined {
  const pb = s.policy.playbooks?.[playbook];
  if (!pb) return undefined;
  return stepTodo(s, { playbook, version: pb.version, run, step: pb.start, ticket }, pb.start);
}
