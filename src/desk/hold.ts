// Holding a permission request for the desk's page, for a terminal you chose to answer
// there. Copilot runs its `permissionRequest` hook before it would ask you in the
// terminal; whatever the hook prints is the answer. So the hook writes the ask where the
// page can see it and waits for your answer.
//
// While it waits, the terminal shows no prompt: an ask is answered on the page or in the
// terminal, never both. Your work happens in the terminal, so asks go there unless you
// set a terminal (or `asks` in the config) to "desk"; and the hook only holds while the
// desk runs, and lets go (Copilot then asks in the terminal) when you click "answer in
// the terminal", the desk stops, or the wait runs out. Standing answers you gave on the
// desk apply either way.
import * as fs from "node:fs";
import * as path from "node:path";
import { deskHome, type DeskEvent } from "./log.ts";
import { isDeskCommand } from "./reach.ts";

export type DeskConfig = {
  // Tools Copilot is let to decide on its own: reads, which your rules nearly always allow.
  passThrough: string[];
  // How long an ask waits on the page before the terminal gets it.
  holdSec: number;
  // Where permission asks are answered, for terminals you haven't set either way.
  asks: "terminal" | "desk";
};

export const DEFAULTS: DeskConfig = {
  passThrough: ["view", "read", "glob", "grep", "rg", "ls", "list_directory", "report_intent", "think", "fetch_copilot_cli_documentation"],
  holdSec: 1200,
  asks: "terminal",
};

// Copilot kills a hook after its timeoutSec; this leaves the hold room to end first.
export const HOOK_TIMEOUT_SEC = 3600;

// `always` is what "allow from now on" would cover, when anything safely can: a whole
// tool, or for a command the program and its first word (`npm run`). `pid` is the hook
// waiting on it, so an ask whose hook died can be dropped.
export type Ask = { id: string; at: number; session: string; cwd: string; terminal: string; tool: string; detail?: string; always?: { prefix?: string }; pid?: number };
export type Choice = "allow" | "deny" | "terminal" | "always";
export type Answer = { choice: Choice; note?: string; at: number };
// "Allow this tool in this terminal from now on", given on the page.
export type Rule = { terminal: string; tool: string; prefix?: string; at: number };

export const dirs = (home = deskHome()) => ({ asks: path.join(home, "asks"), answers: path.join(home, "answers") });

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

// Write whole or not at all: the other side polls and must never read half a file.
export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

export const configFile = (home = deskHome()) => path.join(home, "config.json");
export const rulesFile = (home = deskHome()) => path.join(home, "rules.json");
export const modesFile = (home = deskHome()) => path.join(home, "modes.json");
export const pageFile = (home = deskHome()) => path.join(home, "page.json");

export function loadConfig(home = deskHome()): DeskConfig {
  return { ...DEFAULTS, ...readJson<Partial<DeskConfig>>(configFile(home), {}) };
}

// A terminal's name: the launcher's, else the repo folder's.
export function terminalOf(e: Pick<DeskEvent, "terminal" | "cwd">): string {
  return e.terminal || path.basename(e.cwd) || e.cwd;
}

// The desk beats every few seconds while it runs. No fresh beat, no hold: with the desk
// stopped, the terminal must ask as if it weren't there.
export const PAGE_FRESH_MS = 15_000;
export function deskOpen(home = deskHome(), now = Date.now()): boolean {
  const p = readJson<{ at?: number }>(pageFile(home), {});
  return typeof p.at === "number" && now - p.at < PAGE_FRESH_MS;
}

// A standing answer for a command covers that program and first word only, and never a
// line that chains, pipes, redirects or substitutes: `npm run build; rm -rf ~` must ask.
const CHAINS = /[;&|`<>\n\r]|\$\(/;
export function commandPrefix(command: string): string | undefined {
  const c = command.trim();
  if (!c || CHAINS.test(c)) return undefined;
  return c.split(/\s+/).slice(0, 2).join(" ");
}

// What "allow from now on" covers for this ask: undefined when nothing safely can.
export function standingScope(command: string | undefined): { prefix?: string } | undefined {
  if (command === undefined) return {};
  const prefix = commandPrefix(command);
  return prefix ? { prefix } : undefined;
}

export function ruleMatches(rules: Rule[], ask: { terminal: string; tool: string; command?: string }): Rule | undefined {
  return rules.find((r) => {
    if (r.terminal !== ask.terminal || r.tool !== ask.tool) return false;
    if (!r.prefix) return ask.command === undefined;
    const c = ask.command?.trim();
    return !!c && !CHAINS.test(c) && (c === r.prefix || c.startsWith(`${r.prefix} `));
  });
}

// The command a shell ask would run, in full (the log keeps it cut short).
export function commandOf(raw: Record<string, unknown>): string | undefined {
  const input = raw.toolInput ?? raw.toolArgs ?? raw.tool_input;
  const obj = typeof input === "string" ? (() => { try { return JSON.parse(input); } catch { return undefined; } })() : input;
  const c = obj && typeof obj === "object" ? (obj as Record<string, unknown>).command : undefined;
  return typeof c === "string" ? c : undefined;
}

export type HoldResult = { output: Record<string, unknown>; by: "pass" | "rule" | "desk-command" | "page" | "terminal" | "timeout" | "no-desk" | "desk-closed" | "terminal-mode"; choice?: Choice; waitedMs?: number; note?: string };

export type HoldDeps = { home?: string; now?: () => number; sleep?: (ms: number) => Promise<void>; pollMs?: number };

// Decide what the hook prints for one permission request.
export async function hold(e: DeskEvent, deps: HoldDeps = {}, command?: string): Promise<HoldResult> {
  const home = deps.home ?? deskHome();
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const cfg = loadConfig(home);
  const terminal = terminalOf(e);
  const tool = e.tool ?? "unknown";
  // `{}` means "go on as usual": Copilot applies its own rules and asks in the terminal.
  const usual = {};
  if (cfg.passThrough.includes(tool)) return { output: usual, by: "pass" };
  // A session sending a note or listing the threads: the desk's own command, nothing chained on.
  if (isDeskCommand(command)) return { output: { behavior: "allow" }, by: "desk-command", choice: "allow" };
  if (ruleMatches(readJson<Rule[]>(rulesFile(home), []), { terminal, tool, command })) return { output: { behavior: "allow" }, by: "rule", choice: "allow" };
  if ((readJson<Record<string, string>>(modesFile(home), {})[terminal] ?? cfg.asks) !== "desk") return { output: usual, by: "terminal-mode" };
  if (!deskOpen(home, now())) return { output: usual, by: "no-desk" };

  const start = now();
  const id = `${start}-${Math.random().toString(36).slice(2, 8)}`;
  const { asks, answers } = dirs(home);
  const askFile = path.join(asks, `${id}.json`);
  const answerFile = path.join(answers, `${id}.json`);
  const always = standingScope(command);
  const ask: Ask = { id, at: start, session: e.session, cwd: e.cwd, terminal, tool, ...(e.detail ? { detail: e.detail } : {}), ...(always ? { always } : {}), pid: process.pid };
  writeJson(askFile, ask);
  try {
    while (now() - start < cfg.holdSec * 1000) {
      const a = readJson<Answer | null>(answerFile, null);
      if (a) {
        const waitedMs = now() - start;
        if (a.choice === "terminal") return { output: usual, by: "terminal", choice: a.choice, waitedMs };
        if (a.choice === "deny") return { output: { behavior: "deny", message: a.note ? `Denied from the desk: ${a.note}` : "Denied from the desk." }, by: "page", choice: a.choice, waitedMs, ...(a.note ? { note: a.note } : {}) };
        return { output: { behavior: "allow" }, by: "page", choice: a.choice, waitedMs };
      }
      if (!deskOpen(home, now())) return { output: usual, by: "desk-closed", waitedMs: now() - start };
      await sleep(deps.pollMs ?? 300);
    }
    return { output: usual, by: "timeout", waitedMs: now() - start };
  } finally {
    fs.rmSync(askFile, { force: true });
    fs.rmSync(answerFile, { force: true });
  }
}

// What the page does when you answer: the answer file the hook is polling for, and for
// "always" a standing rule for this terminal and tool.
export function answer(id: string, choice: Choice, note: string | undefined, home = deskHome(), now = Date.now()): void {
  const { asks, answers } = dirs(home);
  const ask = readJson<Ask | null>(path.join(asks, `${id}.json`), null);
  if (!ask) throw new Error("that ask is gone: answered in the terminal, or its wait ran out");
  if (choice === "always") {
    if (!ask.always) throw new Error("this ask can only be answered once: it chains or redirects commands");
    const rules = readJson<Rule[]>(rulesFile(home), []);
    const rule: Rule = { terminal: ask.terminal, tool: ask.tool, ...(ask.always.prefix ? { prefix: ask.always.prefix } : {}), at: now };
    if (!rules.some((r) => r.terminal === rule.terminal && r.tool === rule.tool && r.prefix === rule.prefix)) writeJson(rulesFile(home), [...rules, rule]);
  }
  writeJson(path.join(answers, `${id}.json`), { choice, ...(note ? { note } : {}), at: now } satisfies Answer);
}

export function pending(home = deskHome()): Ask[] {
  const { asks } = dirs(home);
  let files: string[] = [];
  try {
    files = fs.readdirSync(asks).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return files.map((f) => readJson<Ask | null>(path.join(asks, f), null)).filter((a): a is Ask => !!a && alive(a.pid)).sort((a, b) => a.at - b.at);
}

// A hook Copilot killed (its own timeout, the terminal closed) can't take an answer.
function alive(pid: number | undefined): boolean {
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
