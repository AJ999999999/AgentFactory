// What the log says about your attention: how often each repo's session stopped to wait
// for you, for what, and how long it waited. This is the number a control panel has to
// bring down, so it is measured before anything is built on top of it.
import * as path from "node:path";
import type { DeskEvent } from "./log.ts";

export type Wait = { at: number; repo: string; terminal?: string; session: string; why: "permission" | "question" | "idle"; tool?: string; detail?: string; waitedMs?: number };

export type RepoReport = { repo: string; sessions: number; permissions: number; questions: number; idle: number; asked: number; medianWaitMs?: number; tools: Array<[string, number]> };

const WHY: Record<string, Wait["why"]> = { permission_prompt: "permission", elicitation_dialog: "question", agent_idle: "idle" };

// A session waits on you when Copilot shows a prompt (a notification). It stops waiting
// at the session's next event: your prompt, the next tool, or its end.
export function waits(log: DeskEvent[]): Wait[] {
  const out: Wait[] = [];
  const lastAsk = new Map<string, DeskEvent>();
  const open = new Map<string, Wait>();
  for (const e of log) {
    const pending = open.get(e.session);
    if (pending && e.event !== "notification") {
      pending.waitedMs = e.at - pending.at;
      open.delete(e.session);
    }
    if (e.event === "permissionRequest") lastAsk.set(e.session, e);
    if (e.event !== "notification" || !e.kind || !WHY[e.kind]) continue;
    const why = WHY[e.kind];
    const ask = why === "permission" ? lastAsk.get(e.session) : undefined;
    const w: Wait = { at: e.at, repo: path.basename(e.cwd) || e.cwd, session: e.session, why, ...(e.terminal ? { terminal: e.terminal } : {}), ...(ask?.tool ? { tool: ask.tool } : {}), ...((ask?.detail ?? e.message) ? { detail: ask?.detail ?? e.message } : {}) };
    out.push(w);
    open.set(e.session, w);
  }
  return out;
}

const median = (xs: number[]): number | undefined => {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
};

export function report(log: DeskEvent[], since = 0): RepoReport[] {
  const recent = log.filter((e) => e.at >= since);
  const ws = waits(recent);
  const repos = new Map<string, RepoReport & { ids: Set<string>; waited: number[]; toolCount: Map<string, number> }>();
  const get = (repo: string) => {
    let r = repos.get(repo);
    if (!r) repos.set(repo, (r = { repo, sessions: 0, permissions: 0, questions: 0, idle: 0, asked: 0, tools: [], ids: new Set(), waited: [], toolCount: new Map() }));
    return r;
  };
  for (const e of recent) {
    const r = get(path.basename(e.cwd) || e.cwd);
    r.ids.add(e.session);
    if (e.event === "permissionRequest") r.asked++;
  }
  for (const w of ws) {
    const r = get(w.repo);
    if (w.why === "permission") r.permissions++;
    else if (w.why === "question") r.questions++;
    else r.idle++;
    // Idle waits for your next instruction: that's you driving, not an interruption.
    if (w.why !== "idle" && w.waitedMs !== undefined) r.waited.push(w.waitedMs);
    if (w.tool) r.toolCount.set(w.tool, (r.toolCount.get(w.tool) ?? 0) + 1);
  }
  return [...repos.values()]
    .map(({ ids, waited, toolCount, ...r }) => ({ ...r, sessions: ids.size, medianWaitMs: median(waited), tools: [...toolCount].sort((a, b) => b[1] - a[1]).slice(0, 5) }))
    .sort((a, b) => b.permissions + b.questions - (a.permissions + a.questions));
}

const secs = (ms?: number) => (ms === undefined ? "-" : ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`);

export function renderReport(rows: RepoReport[]): string {
  if (!rows.length) return "Nothing recorded yet. Start a Copilot CLI session and work as usual.";
  const lines = ["repo                      sessions  asked you  questions  idle  median wait  most asked"];
  for (const r of rows) {
    lines.push(`${r.repo.padEnd(26).slice(0, 26)}${String(r.sessions).padStart(8)}${String(r.permissions).padStart(11)}${String(r.questions).padStart(11)}${String(r.idle).padStart(6)}${secs(r.medianWaitMs).padStart(13)}  ${r.tools.map(([t, n]) => `${t}×${n}`).join(", ")}`);
  }
  const total = rows.reduce((n, r) => n + r.permissions + r.questions, 0);
  const auto = rows.reduce((n, r) => n + r.asked, 0);
  lines.push("", `${total} times a session stopped for you; ${auto} permission checks ran in all (most were let through by your rules without asking).`);
  return lines.join("\n");
}
