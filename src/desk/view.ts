// What the desk's page shows, computed from the log and the open asks: nothing here is
// kept, so the page, the hook and the report can never disagree.
import type { Ask, Rule } from "./hold.ts";
import { terminalOf } from "./hold.ts";
import type { DeskEvent } from "./log.ts";

export type TerminalState = "waiting on the desk" | "waiting for permission" | "asking you" | "waiting for your next prompt" | "working" | "closed";

export type TerminalView = {
  name: string;
  cwd: string;
  session: string;
  state: TerminalState;
  since: number;
  mode: "desk" | "terminal";
  // What it last said when it stopped, if it said anything.
  said?: string;
  asks: Ask[];
  rules: Rule[];
  // Times it stopped for you today (asks and questions; idle is you driving).
  stopsToday: number;
};

const KIND: Record<string, TerminalState> = { permission_prompt: "waiting for permission", elicitation_dialog: "asking you", agent_idle: "waiting for your next prompt" };

// Most urgent first: an ask held for the desk blocks a session the longest.
const ORDER: TerminalState[] = ["waiting on the desk", "asking you", "waiting for permission", "waiting for your next prompt", "working", "closed"];

export function deskView(log: DeskEvent[], asks: Ask[], rules: Rule[], modes: Record<string, string>, now = Date.now(), startOfDay = new Date(now).setHours(0, 0, 0, 0)): TerminalView[] {
  const byName = new Map<string, TerminalView>();
  for (const e of log) {
    if (e.event === "decision") continue;
    const name = terminalOf(e);
    let t = byName.get(name);
    // A new session in the same terminal takes over its row.
    if (!t || (e.event === "sessionStart" && e.session !== t.session) || (t.state === "closed" && e.session !== t.session)) {
      t = { name, cwd: e.cwd, session: e.session, state: "working", since: e.at, mode: modes[name] === "terminal" ? "terminal" : "desk", asks: [], rules: rules.filter((r) => r.terminal === name), stopsToday: t?.stopsToday ?? 0 };
      byName.set(name, t);
    }
    if (e.session !== t.session) continue;
    const next: TerminalState = e.event === "sessionEnd" ? "closed" : e.event === "notification" && e.kind && KIND[e.kind] ? KIND[e.kind] : e.event === "notification" ? t.state : "working";
    if (next !== t.state) {
      t.state = next;
      t.since = e.at;
      t.said = e.event === "notification" ? e.message : undefined;
    }
  }
  for (const e of log) {
    if (e.at < startOfDay) continue;
    const t = byName.get(terminalOf(e));
    if (!t) continue;
    if ((e.event === "notification" && (e.kind === "permission_prompt" || e.kind === "elicitation_dialog")) || (e.event === "decision" && e.by === "page")) t.stopsToday++;
  }
  for (const a of asks) {
    let t = byName.get(a.terminal);
    if (!t) byName.set(a.terminal, (t = { name: a.terminal, cwd: a.cwd, session: a.session, state: "working", since: a.at, mode: "desk", asks: [], rules: [], stopsToday: 0 }));
    t.asks.push(a);
    if (t.state !== "waiting on the desk") {
      t.state = "waiting on the desk";
      t.since = a.at;
    }
  }
  return [...byName.values()].sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || a.since - b.since);
}
