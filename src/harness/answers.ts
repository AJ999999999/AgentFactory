// Answering an ask. The person picks an option; its effect becomes explicit events
// (a revision, a closed goal, a superseded todo), so the log says exactly what the
// answer changed. Only the role the ask is addressed to (or the partner, who sits
// above every role) may answer it.
import type { Budget, Direction, Effect, Finding, GoalRevision, HEvent, TodoDraft } from "./types.ts";
import type { State } from "./project.ts";
import { eid, safeId } from "./store.ts";
import { criteriaHash, spawnEvents } from "./validate.ts";

export type Answer = {
  by: string; // role
  choice: string;
  note?: string;
  revision?: GoalRevision; // for pivot / narrow / fix
  budget?: Budget; // for raise
  finding?: { assumption?: string; direction: Direction; text: string; metrics?: Record<string, number>; runs?: number }; // for action and review asks
};

// A note has to say something. "..." or "-" is a template's placeholder sent as it was,
// and the agents whose work depends on the answer would build on it as if the person
// had said it (in a real run, a profile question was marked done with a note of "...").
function saysSomething(note: string | undefined): void {
  if (note?.trim() && !/[\p{L}\p{N}]/u.test(note)) throw new Error(`the note "${note.trim().slice(0, 20)}" has no words in it: say what it should say, or leave the note out`);
}

export function answerEvents(s: State, askId: string, ans: Answer, now: number): HEvent[] {
  const a = s.asks.get(askId);
  if (!a) throw new Error(`no ask ${askId}`);
  if (a.status !== "open") throw new Error(`${askId} is already ${a.status}${a.status === "answered" ? `; to fix what its note says, run correct ${askId} --note with the new text` : ""}`);
  if (ans.by !== a.to && ans.by !== "partner") throw new Error(`${askId} is for ${a.to}; ${ans.by} can't answer it`);
  const opt = a.options.find((o) => o.id === ans.choice);
  if (!opt) throw new Error(`${askId} has no option "${ans.choice}" (options: ${a.options.map((o) => o.id).join(", ")})`);
  saysSomething(ans.note);
  const by = ans.by;
  const base = eid("ans", askId);
  const out: HEvent[] = [{ id: base, at: now, by, type: "ask_answered", ask: askId, answeredBy: by, choice: ans.choice, note: ans.note, revision: ans.revision }];
  const n = (k: string) => eid(base, k);

  // People's answers can carry evidence. Its grade comes from who they are and what
  // they did, never from the answer itself: a role listed as an expert gives expert
  // evidence; anyone doing an action reports an observation (measured); anything else
  // is an opinion.
  if (ans.finding) {
    const experts = s.engagement?.experts ?? [];
    const grade = experts.includes(by) ? "expert" : a.kind === "action" ? "measured" : "opinion";
    const f: Finding = {
      id: n("f"), goal: a.goal, assumption: ans.finding.assumption, direction: ans.finding.direction, grade, source: `ask:${askId}`, author: by,
      text: ans.finding.text, metrics: ans.finding.metrics, todo: a.todo, runs: ans.finding.runs ?? 1,
    };
    out.push({ id: f.id, at: now, by, type: "finding", finding: f });
  }
  if (a.kind === "action" && a.todo && ans.choice === "done") out.push({ id: n("done"), at: now, by, type: "todo_done", todo: a.todo });

  if (opt.effect) out.push(...effectEvents(s, a.goal, opt.effect, ans, now, by, n));
  // Todos whose product was this decision are done once it's made (unless the answer
  // sent them back or dropped them).
  if (!opt.effect || !["reopen", "supersede", "accept"].includes(opt.effect.type)) {
    for (const t of s.todos.values()) if (t.status === "review" && t.ask === askId) out.push({ id: n(`done-${t.id}`), at: now, by, type: "todo_done", todo: t.id });
  }
  return out;
}

// Fixing what an answer said. The note is what the agents whose work depends on the
// answer are told, so a wrong one steers every turn after it. The choice can't change
// here: what it did (work done or dropped, a goal closed) has already happened.
export function correctionEvents(s: State, askId: string, c: { by: string; note: string }, now: number): HEvent[] {
  const a = s.asks.get(askId);
  if (!a) throw new Error(`no ask ${askId}`);
  if (a.status === "open") throw new Error(`${askId} hasn't been answered yet: answer it`);
  if (a.status !== "answered" || a.answeredBy === "harness") throw new Error(`${askId} was settled by the harness, not answered by a person, so there's no answer to correct`);
  if (c.by !== a.answeredBy && c.by !== a.to && c.by !== "partner") throw new Error(`${askId} was answered by ${a.answeredBy}; ${c.by} can't correct it`);
  const note = c.note?.trim();
  if (!note) throw new Error("say what the note should say");
  saysSomething(note);
  if (note === a.note) return [];
  return [{ id: eid("fix", askId, now), at: now, by: c.by, type: "answer_corrected", ask: askId, note }];
}

function effectEvents(s: State, goalId: string, e: Effect, ans: Answer, now: number, by: string, n: (k: string) => string): HEvent[] {
  const g = s.goals.get(goalId)!;
  switch (e.type) {
    case "approve":
    case "ack":
      return [];
    case "close":
      return [{ id: n("close"), at: now, by, type: "goal_closed", goal: goalId, status: e.status, reason: ans.note ?? `answered ${ans.choice}` }];
    case "budget": {
      const budget = ans.budget;
      if (!budget) throw new Error("this option needs a budget (--budget)");
      return [{ id: n("budget"), at: now, by, type: "budget_set", goal: goalId, budget: { ...g.def.budget, ...budget } }];
    }
    case "reset":
      return e.assumptions.map((x) => ({ id: n(`reset-${x}`), at: now, by, type: "assumption_reset", goal: goalId, assumption: x, reason: ans.note ?? "retest" }) as HEvent);
    case "decide": {
      const out: HEvent[] = [];
      for (const t of s.todos.values()) {
        if (t.goal === goalId && t.forOption && e.rejected.includes(t.forOption) && t.status === "open") out.push({ id: eid("sup", t.id), at: now, by, type: "todo_superseded", todo: t.id, reason: `option ${t.forOption} rejected` });
      }
      return out;
    }
    case "supersede":
      return e.todos.filter((id) => s.todos.has(id)).map((id) => ({ id: eid("sup", id), at: now, by, type: "todo_superseded", todo: id, reason: ans.note ?? `answered ${ans.choice}` }) as HEvent);
    case "retry":
      return [{ id: n("retry"), at: now, by, type: "todo_reopened", todo: e.todo, reason: ans.note ?? "retry", resetFailures: true }];
    case "reopen":
      return [{ id: n("reopen"), at: now, by, type: "todo_reopened", todo: e.todo, reason: ans.note ?? "reopened", resetFailures: true }];
    case "accept":
      return [{ id: n("accept"), at: now, by, type: "todo_done", todo: e.todo }];
    case "spawn":
      return spawnEvents(s, goalId, e.goals).map((x) => ({ ...x, at: now, by }) as HEvent);
    case "revise": {
      const rev: GoalRevision = { ...(e.revision ?? {}), ...(ans.revision ?? {}) };
      if (e.pivot && !Object.keys(rev).length) throw new Error("a pivot needs the revised goal (--revision file.json)");
      const version = g.version + 1;
      const next = { assumptions: rev.assumptions ?? g.def.assumptions, kill: rev.kill ?? g.def.kill, success: rev.success ?? g.def.success };
      const out: HEvent[] = [{ id: n("rev"), at: now, by, type: "goal_revised", goal: goalId, version, revision: rev, pivot: e.pivot, reason: ans.note ?? ans.choice, criteriaHash: criteriaHash(next) }];
      for (const x of e.resetAssumptions ?? []) out.push({ id: n(`reset-${x}`), at: now, by, type: "assumption_reset", goal: goalId, assumption: x, reason: ans.note ?? "approach changed" });
      if (e.pivot) {
        // A new direction: work planned for the old one goes, unless explicitly carried.
        const carry = new Set(rev.carry ?? []);
        for (const t of s.todos.values()) {
          if (t.goal !== goalId || carry.has(t.id) || t.carry || !["open", "blocked"].includes(t.status)) continue;
          out.push({ id: eid("sup", t.id), at: now, by, type: "todo_superseded", todo: t.id, reason: `goal pivoted to v${version}` });
        }
      }
      for (const [i, d] of (rev.todos ?? []).entries()) {
        const id = d.id ?? eid(goalId, `v${version}`, i);
        if (!safeId(id)) throw new Error(`bad todo id ${id}`);
        out.push({ id: `add-${id}`, at: now, by, type: "todo_added", todo: { ...(d as TodoDraft), id, goal: goalId }, provenance: `answer:${ans.choice}` });
      }
      return out;
    }
  }
}
