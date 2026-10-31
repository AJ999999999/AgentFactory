// The desk: what your own Copilot CLI sessions ask of you, across every terminal.
//
// Copilot CLI runs a hook on each event of an interactive session. The desk's hook
// appends one line per event to a log in your home folder and answers nothing, so the
// session goes on exactly as without it. The log stays on this PC: it can hold your
// company's commands and paths, which must never reach this repo.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// AF_DESK_HOME points somewhere else, for tests and for a second setup on one PC.
export function deskHome(): string {
  return process.env.AF_DESK_HOME || path.join(os.homedir(), ".af", "desk");
}

export function logFile(home = deskHome()): string {
  return path.join(home, "events.jsonl");
}

// The events the desk listens to. Copilot names them in camelCase in a hooks file.
export const EVENTS = ["sessionStart", "sessionEnd", "userPromptSubmitted", "permissionRequest", "notification", "agentStop"] as const;
export type DeskEventName = (typeof EVENTS)[number];

export type DeskEvent = {
  at: number;
  event: DeskEventName;
  session: string;
  cwd: string;
  // The terminal's name, when it was started with the desk's launcher.
  terminal?: string;
  tool?: string;
  // What the tool would do, cut short: enough to see what kind of ask it was.
  detail?: string;
  kind?: string;
  message?: string;
  reason?: string;
};

const CUT = 300;
const cut = (s: unknown): string | undefined => {
  if (s === undefined || s === null || s === "") return undefined;
  const t = typeof s === "string" ? s : JSON.stringify(s);
  return t.length > CUT ? `${t.slice(0, CUT)}…` : t;
};
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

// Copilot sends camelCase fields under camelCase event names and snake_case under the
// VS Code-style names. Read either, so a change of style upstream doesn't blind the log.
export function toEvent(event: DeskEventName, raw: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env, now = Date.now()): DeskEvent {
  const ts = raw.timestamp;
  const at = typeof ts === "number" ? ts : typeof ts === "string" && !Number.isNaN(Date.parse(ts)) ? Date.parse(ts) : now;
  const out: DeskEvent = {
    at,
    event,
    session: str(raw.sessionId) ?? str(raw.session_id) ?? "unknown",
    cwd: str(raw.cwd) ?? process.cwd(),
  };
  const terminal = str(env.AF_DESK_TERMINAL);
  if (terminal) out.terminal = terminal;
  const tool = str(raw.toolName) ?? str(raw.tool_name);
  if (tool) out.tool = tool;
  const detail = cut(raw.toolInput ?? raw.toolArgs ?? raw.tool_input);
  if (detail) out.detail = detail;
  const kind = str(raw.notification_type) ?? str(raw.notificationType);
  if (kind) out.kind = kind;
  const message = cut(raw.message ?? raw.title);
  if (message) out.message = message;
  const reason = str(raw.reason) ?? str(raw.stopReason) ?? str(raw.source);
  if (reason) out.reason = reason;
  return out;
}

// One appended line per event: appends of a short line don't interleave, so several
// terminals can write at once without a lock.
export function append(e: DeskEvent, home = deskHome()): void {
  fs.mkdirSync(home, { recursive: true });
  fs.appendFileSync(logFile(home), JSON.stringify(e) + "\n");
}

export function readLog(home = deskHome()): DeskEvent[] {
  let text = "";
  try {
    text = fs.readFileSync(logFile(home), "utf8");
  } catch {
    return [];
  }
  const out: DeskEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as DeskEvent);
    } catch {
      /* a line cut short by a crash */
    }
  }
  return out.sort((a, b) => a.at - b.at);
}
