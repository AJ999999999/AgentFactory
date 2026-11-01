// The desk's main view, the way a Claude project lists its threads: each Copilot session
// in a terminal is a thread, titled by what you first asked it, grouped by what it needs
// from you. The work itself happens in the terminal; the desk tells you which one needs
// you and takes you there.
import type { Ask, Rule } from "./hold.ts";
import type { DeskEvent } from "./log.ts";
import type { Summary } from "./session.ts";
import { deskView, type TerminalState, type TerminalView } from "./view.ts";

export type ThreadState = "needs you" | "your turn" | "working" | "closed";

export type Thread = TerminalView & {
  thread: ThreadState;
  // Your first prompt in the session, else where it runs.
  title: string;
  // What it needs from you, or for "your turn", what it said last.
  why?: string;
  // The command (or tool and file) it waits for permission to run, as the terminal shows it.
  wants?: string;
  // What it's doing now, while it works.
  now?: string;
  // The end of what it said last, from its session file.
  lastSaid?: string;
  branch?: string;
  prompts: number;
  files: string[];
  commands: number;
  failed: number;
  started: number;
  lastAt: number;
};

const GROUP: Record<TerminalState, ThreadState> = {
  "waiting on the desk": "needs you",
  "waiting for permission": "needs you",
  "asking you": "needs you",
  "waiting for your next prompt": "your turn",
  working: "working",
  closed: "closed",
};
export const GROUPS: ThreadState[] = ["needs you", "your turn", "working", "closed"];

const commandIn = (detail?: string) => {
  if (!detail) return undefined;
  try {
    const v = JSON.parse(detail) as Record<string, unknown>;
    return String(v.command ?? v.path ?? v.url ?? detail);
  } catch {
    return detail;
  }
};
// A shell command stands alone; anything else reads as the tool and what it touches.
const wantsOf = (tool?: string, detail?: string) => {
  try {
    if (detail && typeof (JSON.parse(detail) as Record<string, unknown>).command === "string") return commandIn(detail);
  } catch { /* not JSON: the detail as it is */ }
  return [tool, commandIn(detail)].filter(Boolean).join(" ") || undefined;
};
const lastLine = (t?: string) => t?.trim().split("\n").filter((l) => l.trim()).pop()?.replace(/\*\*/g, "").trim();

export function threads(
  log: DeskEvent[],
  asks: Ask[],
  rules: Rule[],
  modes: Record<string, string>,
  summaryOf: (session: string, transcript?: string) => Summary | undefined,
  opts: { now?: number; startOfDay?: number; askMode?: "desk" | "terminal"; closedToShow?: number } = {},
): Thread[] {
  const now = opts.now ?? Date.now();
  const views = deskView(log, asks, rules, modes, now, opts.startOfDay, opts.askMode);
  const first = new Map<string, number>();
  const last = new Map<string, DeskEvent>();
  const lastAsk = new Map<string, DeskEvent>();
  const transcript = new Map<string, string>();
  for (const e of log) {
    if (!first.has(e.session)) first.set(e.session, e.at);
    last.set(e.session, e);
    if (e.event === "permissionRequest") lastAsk.set(e.session, e);
    if (e.transcript && !transcript.has(e.session)) transcript.set(e.session, e.transcript);
  }
  const out = views.map((t): Thread => {
    const s = summaryOf(t.session, transcript.get(t.session));
    const thread = GROUP[t.state];
    let why: string | undefined;
    let wants: string | undefined;
    if (t.asks.length) {
      why = `wants to run ${commandIn(t.asks[0].detail) ?? t.asks[0].tool}`;
      wants = wantsOf(t.asks[0].tool, t.asks[0].detail);
    } else if (t.state === "waiting for permission") {
      const a = lastAsk.get(t.session);
      why = a ? `wants to run ${commandIn(a.detail) ?? a.tool ?? "a tool"}` : "asks for permission in its terminal";
      wants = a && wantsOf(a.tool, a.detail);
    } else if (t.state === "asking you") why = t.said ?? lastLine(s?.said) ?? "asks you something in its terminal";
    else if (t.state === "waiting for your next prompt") why = lastLine(s?.said) ?? t.said;
    return {
      ...t,
      thread,
      title: s?.title ?? `New session in ${t.cwd.split(/[\\/]/).filter(Boolean).pop() ?? t.cwd}`,
      ...(why ? { why } : {}),
      ...(wants ? { wants } : {}),
      ...(thread === "working" && s?.now ? { now: s.now } : {}),
      ...(s?.said ? { lastSaid: s.said.length > 2000 ? `…${s.said.slice(-2000)}` : s.said } : {}),
      ...(s?.branch ? { branch: s.branch } : {}),
      prompts: s?.prompts ?? 0,
      files: s?.files ?? [],
      commands: s?.commands ?? 0,
      failed: s?.failed ?? 0,
      started: first.get(t.session) ?? t.since,
      lastAt: Math.max(last.get(t.session)?.at ?? t.since, t.since),
    };
  });
  // What waits on you longest first; what's working, most recently active first.
  const rank = (t: Thread) => GROUPS.indexOf(t.thread);
  const sorted = out.sort((a, b) => rank(a) - rank(b) || (a.thread === "needs you" || a.thread === "your turn" ? a.since - b.since : b.lastAt - a.lastAt));
  const closed = sorted.filter((t) => t.thread === "closed").slice(0, opts.closedToShow ?? 8);
  return [...sorted.filter((t) => t.thread !== "closed"), ...closed];
}
