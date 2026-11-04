// One record to look back through. Every event in the log, and every thing it's about (a
// goal, a todo, a question, a finding, a turn), gets the same envelope: what it is, who
// wrote it, when, its evidence grade if it's evidence, where its full record lives when
// that's a file (a turn's log), and what it came from. `trace` walks those links: back
// from anything to why it happened, and forward to what it led to.
//
// Computed from the log, like all state (project.ts); nothing here is stored. A turn's log
// is pointed at, not copied.
import * as path from "node:path";
import type { HEvent } from "./types.ts";

export type NodeKind = "goal" | "todo" | "ask" | "finding" | "turn" | "event";
export type RecordNode = {
  key: string; // "<kind>:<id>"
  kind: NodeKind;
  id: string;
  at: number;
  by: string;
  what: string; // one line
  grade?: string;
  where?: string; // the full record, when it's a file
};
export type Link = { from: string; to: string; how: string }; // `from` happened because of `to`

export type Graph = { nodes: Map<string, RecordNode>; back: Map<string, Link[]>; forward: Map<string, Link[]> };

const line = (s: string, n = 140) => {
  const one = s.split("\n")[0].trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

// A long question keeps its start and its end, where rules put what they ask.
const ends = (s: string, n = 160) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 60)} … ${one.slice(-56)}` : one;
};

// The answer an event was an effect of: answerEvents and standingEvents derive their ids
// from "ans-<ask>" and "standing-<ask>" (a todo it added has "add-" in front).
function answerOf(eventId: string, asks: Set<string>): string | undefined {
  const m = /^(?:add-)?(?:ans|standing)-(.+)$/.exec(eventId);
  if (!m) return undefined;
  // The ask id is a prefix of the rest; the longest known one wins.
  let best: string | undefined;
  for (const a of asks) if ((m[1] === a || m[1].startsWith(`${a}-`)) && (!best || a.length > best.length)) best = a;
  return best;
}

export function buildGraph(events: HEvent[], opts: { turnsDir?: string } = {}): Graph {
  const nodes = new Map<string, RecordNode>();
  const back = new Map<string, Link[]>();
  const forward = new Map<string, Link[]>();
  const node = (n: RecordNode) => { if (!nodes.has(n.key)) nodes.set(n.key, n); return n.key; };
  const link = (from: string, to: string, how: string) => {
    if (from === to) return;
    const l = { from, to, how };
    if ((back.get(from) ?? []).some((x) => x.to === to && x.how === how)) return;
    back.set(from, [...(back.get(from) ?? []), l]);
    forward.set(to, [...(forward.get(to) ?? []), l]);
  };
  const asks = new Set(events.filter((e) => e.type === "ask_opened").map((e) => (e as Extract<HEvent, { type: "ask_opened" }>).ask.id));
  const has = (key: string) => nodes.has(key);
  // A workstream's goal comes from the answer that approved its spawn; its events' ids come
  // from the spawn, so the link is found from the question's options and the answer's choice.
  const spawnedBy = new Map<string, { ask: string; option: string }>();
  const chose = new Map<string, string>();
  const ev = (e: HEvent, what: string) => node({ key: `event:${e.id}`, kind: "event", id: e.id, at: e.at, by: e.by, what });
  // The answer this event is an effect of, if any.
  const fromAnswer = (e: HEvent, key: string) => {
    const a = answerOf(e.id, asks);
    if (a) link(key, `ask:${a}`, "the answer to");
  };
  // A todo's or question's stated cause, whatever kind of record it names.
  const cause = (from: string, ref: string | undefined, how: string) => {
    if (!ref) return;
    for (const k of [`finding:${ref}`, `ask:${ref}`, `todo:${ref}`, `turn:${ref}`, `event:${ref}`]) if (has(k)) return link(from, k, how);
  };

  for (const e of events) {
    switch (e.type) {
      case "goal_opened":
        node({ key: `goal:${e.goal.id}`, kind: "goal", id: e.goal.id, at: e.at, by: e.by, what: `goal "${line(e.goal.title)}" opened` });
        if (e.goal.parent) link(`goal:${e.goal.id}`, `goal:${e.goal.parent}`, "a workstream of");
        {
          const by = spawnedBy.get(e.goal.id);
          if (by && chose.get(by.ask) === by.option) link(`goal:${e.goal.id}`, `ask:${by.ask}`, "approved in the answer to");
        }
        fromAnswer(e, `goal:${e.goal.id}`);
        break;
      case "goal_revised":
      case "goal_closed": {
        const k = ev(e, e.type === "goal_revised" ? `goal ${e.goal} moved to v${e.version}${e.pivot ? " (a new direction)" : ""}: ${line(e.reason)}` : `goal ${e.goal} closed, ${e.status}: ${line(e.reason)}`);
        link(k, `goal:${e.goal}`, "about");
        fromAnswer(e, k);
        break;
      }
      case "todo_added": {
        const k = node({ key: `todo:${e.todo.id}`, kind: "todo", id: e.todo.id, at: e.at, by: e.by, what: `${e.todo.kind ?? "task"} in ${e.todo.lane}: ${line(e.todo.text)}` });
        link(k, `goal:${e.todo.goal}`, "work in");
        fromAnswer(e, k);
        if (e.provenance.startsWith("event:")) link(k, `event:${e.provenance.slice(6)}`, "came from");
        else if (e.provenance.startsWith("monitor:")) {
          const src = [...nodes.values()].reverse().find((n) => n.kind === "event" && n.what.startsWith(`monitor ${e.provenance.slice(8)} `));
          if (src) link(k, src.key, "came from");
        }
        cause(k, e.todo.because, "because of");
        for (const after of e.todo.after ?? []) cause(k, after, "waits for");
        if (e.todo.tests) link(k, `goal:${e.todo.goal}`, `tests ${e.todo.tests} of`);
        break;
      }
      case "todo_done":
      case "todo_reopened":
      case "todo_superseded":
      case "todo_blocked": {
        const what = e.type === "todo_done" ? "done" : e.type === "todo_reopened" ? `reopened: ${line(e.reason)}` : e.type === "todo_superseded" ? `dropped: ${line(e.reason)}` : `blocked: ${line(e.reason)}`;
        const k = ev(e, `todo ${e.todo} ${what}`);
        link(k, `todo:${e.todo}`, "about");
        fromAnswer(e, k);
        if (e.type === "todo_done" && e.turn) link(k, `turn:${e.turn}`, "by");
        if (e.type === "todo_blocked" && e.ask) link(k, `ask:${e.ask}`, "on");
        break;
      }
      case "ask_opened": {
        const a = e.ask;
        const k = node({ key: `ask:${a.id}`, kind: "ask", id: a.id, at: e.at, by: e.by, what: `question for ${a.to}: ${ends(a.question)}` });
        link(k, `goal:${a.goal}`, "about");
        if (a.todo) link(k, `todo:${a.todo}`, "about the work");
        const [kind, ...rest] = a.origin.split(":");
        const ref = rest.join(":");
        if (kind === "turn") link(k, `turn:${ref}`, "asked in");
        else if (kind === "todo") cause(k, ref, "asked by");
        else if (kind === "audit") cause(k, ref, "a spot check of");
        else if (kind === "monitor") {
          const src = [...nodes.values()].reverse().find((n) => n.kind === "event" && n.what.startsWith(`monitor ${ref} `));
          if (src) link(k, src.key, "asked because");
        } else if (kind === "rule") nodes.get(k)!.what += ` (the ${ref.replace(/_/g, " ")} rule)`;
        for (const f of a.evidence ?? []) cause(k, f, "on the evidence");
        for (const o of a.options) if (o.effect?.type === "spawn") for (const sg of o.effect.goals) spawnedBy.set(sg.id, { ask: a.id, option: o.id });
        break;
      }
      case "ask_answered": {
        chose.set(e.ask, e.choice);
        const k = ev(e, e.answeredBy === "harness" ? `question ${e.ask} closed: ${e.choice}${e.note ? `, ${line(e.note, 80)}` : ""}` : `${e.answeredBy} answered ${e.ask}: ${e.choice}${e.standing ? " (from now on)" : ""}${e.note ? `, "${line(e.note, 80)}"` : ""}`);
        link(k, `ask:${e.ask}`, "answers");
        break;
      }
      case "ask_auto_closed": {
        const k = ev(e, `question ${e.ask} settled by the harness (${e.reason})${e.choice ? `: ${e.choice}` : ""}`);
        link(k, `ask:${e.ask}`, "settles");
        if (e.precedentAsk) link(k, `ask:${e.precedentAsk}`, e.reason === "standing" ? "your standing answer to" : "the earlier answer to");
        break;
      }
      case "event_received": {
        const o = e.event;
        node({ key: `event:${e.id}`, kind: "event", id: e.id, at: e.at, by: o.source, what: `${o.source}: ${o.type} ${o.id} "${line(o.title, 100)}"${e.rule ? `, routed by ${e.rule}` : ", matched no rule"}`, ...(o.url ? { where: o.url } : {}) });
        break;
      }
      case "source_changed":
        ev(e, `monitor ${e.monitor} saw a change: ${line(e.summary)}`);
        break;
      case "finding": {
        const f = e.finding;
        const k = node({ key: `finding:${f.id}`, kind: "finding", id: f.id, at: e.at, by: f.author, grade: f.grade, what: `${f.grade} evidence ${f.direction === "supports" ? "for" : f.direction === "refutes" ? "against" : "on"} ${f.assumption ?? "the goal"}: ${line(f.text)}` });
        link(k, `goal:${f.goal}`, "on");
        if (f.turn) link(k, `turn:${f.turn}`, "found in");
        else if (f.todo) link(k, `todo:${f.todo}`, "found by");
        if (f.source.startsWith("ask:")) link(k, `ask:${f.source.slice(4)}`, "reported in the answer to");
        if (f.event) link(k, `event:${f.event}`, "recorded from");
        fromAnswer(e, k);
        break;
      }
      case "finding_discounted":
        link(ev(e, `finding ${e.finding} discounted: ${line(e.reason)}`), `finding:${e.finding}`, "about");
        break;
      case "turn": {
        const t = e.turn;
        const k = node({ key: `turn:${t.id}`, kind: "turn", id: t.id, at: e.at, by: t.agent, what: `turn by ${t.agent}: ${t.result}${t.reasons.length ? ` (${line(t.reasons.join("; "), 100)})` : ""}${t.files.length ? `, wrote ${t.files.slice(0, 3).join(", ")}${t.files.length > 3 ? ` and ${t.files.length - 3} more` : ""}` : ""}`, ...(opts.turnsDir ? { where: path.join(opts.turnsDir, `${t.id}.log`) } : {}) });
        link(k, `todo:${t.todo}`, "on");
        break;
      }
      case "job_finished":
        link(ev(e, `job for ${e.todo} ${e.status}${Object.keys(e.metrics).length ? `: ${Object.entries(e.metrics).map(([m, v]) => `${m}=${v}`).join(", ")}` : ""}`), `todo:${e.todo}`, "ran");
        break;
      case "assumption_reset":
      case "budget_set": {
        const k = ev(e, e.type === "assumption_reset" ? `assumption ${e.assumption} in ${e.goal} reset: ${line(e.reason)}` : `budget of ${e.goal} set: ${Object.entries(e.budget).map(([m, v]) => `${m} ${v}`).join(", ")}`);
        link(k, `goal:${e.goal}`, "about");
        fromAnswer(e, k);
        break;
      }
      default:
        break;
    }
  }
  return { nodes, back, forward };
}

// Finds what an id names: "todo:x" as given, or a bare id tried as each kind.
export function resolve(g: Graph, id: string): string | undefined {
  if (g.nodes.has(id)) return id;
  for (const k of ["ask", "todo", "finding", "turn", "goal", "event"]) if (g.nodes.has(`${k}:${id}`)) return `${k}:${id}`;
  return undefined;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
const show = (n: RecordNode) => `${n.what}  [${n.kind} ${n.id}, ${n.by}, ${day(n.at)}${n.where ? `, ${n.where}` : ""}]`;

// Why it happened (back) and what it led to (forward), each as an indented tree, each
// record shown once.
export function traceText(g: Graph, id: string, depth = 4): string {
  const start = resolve(g, id);
  if (!start) return `nothing in the log is called ${id}`;
  const out = [show(g.nodes.get(start)!)];
  const walk = (dir: "back" | "forward", title: string) => {
    const seen = new Set([start]);
    const lines: string[] = [];
    const go = (key: string, level: number) => {
      if (level > depth) return;
      const links = [...((dir === "back" ? g.back : g.forward).get(key) ?? [])].sort((a, b) => (g.nodes.get(dir === "back" ? a.to : a.from)?.at ?? 0) - (g.nodes.get(dir === "back" ? b.to : b.from)?.at ?? 0));
      for (const l of links) {
        const next = dir === "back" ? l.to : l.from;
        const n = g.nodes.get(next);
        if (!n || seen.has(next)) continue;
        seen.add(next);
        lines.push(`${"  ".repeat(level)}${dir === "back" ? "←" : "→"} ${dir === "back" ? l.how : l.how.replace(/^about$/, "then")}: ${show(n)}`);
        go(next, level + 1);
      }
    };
    go(start, 1);
    if (lines.length) out.push(title, ...lines);
  };
  walk("back", "why:");
  walk("forward", "then:");
  return out.join("\n");
}

// The same walk as data, for the panel: each step's link and record, and what came before it.
export type TraceItem = { how: string; node: RecordNode; children: TraceItem[] };
export function traceTree(g: Graph, id: string, depth = 4): { node: RecordNode; why: TraceItem[]; then: TraceItem[] } | undefined {
  const start = resolve(g, id);
  if (!start) return undefined;
  const walk = (dir: "back" | "forward"): TraceItem[] => {
    const seen = new Set([start]);
    const go = (key: string, level: number): TraceItem[] => {
      if (level > depth) return [];
      const out: TraceItem[] = [];
      for (const l of (dir === "back" ? g.back : g.forward).get(key) ?? []) {
        const next = dir === "back" ? l.to : l.from;
        const n = g.nodes.get(next);
        if (!n || seen.has(next)) continue;
        seen.add(next);
        out.push({ how: dir === "back" ? l.how : l.how.replace(/^about$/, "then"), node: n, children: go(next, level + 1) });
      }
      return out.sort((a, b) => a.node.at - b.node.at);
    };
    return go(start, 1);
  };
  return { node: g.nodes.get(start)!, why: walk("back"), then: walk("forward") };
}
