// Sessions the desk drives: Copilot CLI started by the desk over ACP (acp.ts), so the
// desk can do everything the terminal can. It starts a session in a folder, sends your
// prompts (one waits in line while a turn runs), stops a turn, answers every permission
// Copilot asks with the options Copilot offers, answers its forms, switches its mode and
// model, and closes it. A PowerShell window can attach to the same session
// (attach.ts), and hand it to Copilot's own screen and take it back.
//
// From Herdr: the desk owns the session, so a window can come and go without stopping
// it; each session's state is one of a few plain words; and "done" means finished and
// not yet seen, so a finished session asks for your look once, not forever.
//
// Your sessions outlive the desk. Copilot saves each one; a session whose Copilot isn't
// running is "asleep", and the next prompt starts Copilot again and reloads it.
//
// Each session is one file under driven/, rewritten on change, so the desk's MCP tools
// (another process) and the next desk see the same sessions.
import * as fs from "node:fs";
import * as path from "node:path";
import { type AcpProcess, spawnAcp } from "./acp.ts";
import { readJson, ruleMatches, rulesFile, standingScope, writeJson, type Rule } from "./hold.ts";
import { contextFor } from "./knowledge.ts";
import { append, deskHome, type DeskEvent } from "./log.ts";
import { claim, renderNotes } from "./notes.ts";

export type Option = { optionId: string; name: string; kind: string };
export type Field = { type?: string; title?: string; description?: string; enum?: unknown[]; enumNames?: string[]; oneOf?: Array<{ const: unknown; title?: string }>; default?: unknown };
export type DrivenAsk =
  | { id: string; at: number; kind: "permission"; title: string; tool: string; command?: string; detail?: string; options: Option[]; always?: { prefix?: string } }
  | { id: string; at: number; kind: "question"; message: string; fields: Record<string, Field>; required: string[] };

export type Item = { n: number; rev: number; at: number; type: "you" | "agent" | "thought" | "tool" | "plan" | "ask" | "note" | "end" | "error"; text: string; ref?: string; status?: string; queued?: boolean };

// starting → working ⇄ waiting on you → done (finished, not yet seen) → idle. Asleep:
// Copilot isn't running; the next prompt wakes it. In its own screen: handed to
// Copilot's terminal UI in its window, until that window gives it back.
export type DrivenState = "starting" | "working" | "waiting on you" | "done" | "idle" | "asleep" | "failed" | "in its own screen" | "closed";

export type ConfigOption = { id: string; name: string; category?: string; type: string; currentValue: unknown; options?: Array<{ value: string; name: string; group?: undefined } | { group: string; name: string; options: Array<{ value: string; name: string }> }> };
export type Modes = { currentModeId: string; availableModes: Array<{ id: string; name: string; description?: string }> };

export type DrivenRecord = {
  name: string;
  cwd: string;
  session?: string;
  state: DrivenState;
  since: number;
  rev: number;
  items: Item[];
  queue: Array<{ n: number; text: string }>;
  error?: string;
  modes?: Modes;
  config?: ConfigOption[];
  commands?: string[];
  // Not yet prompted: its first prompt carries what's known about the repo.
  fresh?: boolean;
};

export type DrivenView = Omit<DrivenRecord, "fresh"> & { asks: DrivenAsk[]; choices: string[] };

export const NAME = /^[A-Za-z0-9][\w.-]{0,39}$/;
const URGENCY: DrivenState[] = ["waiting on you", "done", "failed", "working", "starting", "idle", "asleep", "in its own screen", "closed"];
const KEEP_ITEMS = 300;
const STARTUP_MS = 90_000;

export const drivenDir = (home = deskHome()) => path.join(home, "driven");

// The sessions on disk, for processes other than the desk (the MCP tools, the CLI).
export function readDriven(home = deskHome()): DrivenRecord[] {
  try {
    return fs.readdirSync(drivenDir(home)).filter((f) => f.endsWith(".json")).map((f) => readJson<DrivenRecord | null>(path.join(drivenDir(home), f), null)).filter((r): r is DrivenRecord => !!r && typeof r.name === "string");
  } catch {
    return [];
  }
}

// Without an ask_user tool (Copilot has none over ACP), Copilot ends its turn with the
// options as a numbered list. Those become answers you can click.
const NUM = /^\s*(\d{1,2})[.)]\s+(.+?)\s*$/;
const CUE = /\b(would you|should i|shall i|do you|want me|which|choose|pick|prefer|options?|next steps?)\b/i;
export function choicesIn(text: string): string[] {
  const lines = text.split("\n");
  let i = lines.length - 1;
  let after = "";
  while (i >= 0 && !NUM.test(lines[i])) {
    if (lines[i].trim()) {
      if (after.split("\n").length > 2) return [];
      after = `${lines[i]}\n${after}`;
    }
    i--;
  }
  const found: string[] = [];
  let expect: number | undefined;
  for (; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    const m = NUM.exec(lines[i]);
    if (!m) break;
    const n = Number(m[1]);
    if (expect !== undefined && n !== expect) return [];
    found.unshift(m[2].replace(/\*\*/g, "").trim().slice(0, 200));
    expect = n - 1;
    if (n === 1) break;
  }
  if (expect !== 0 || found.length < 2 || found.length > 9) return [];
  let before = "";
  for (let j = i - 1; j >= 0 && !before; j--) before = lines[j].trim();
  // A list that answers nothing ("I changed: 1. … 2. …") isn't a question.
  const asks = before.endsWith("?") || after.includes("?") || (before.endsWith(":") && CUE.test(before));
  return asks ? found : [];
}

const pick = (options: Option[], ...kinds: string[]) => kinds.map((k) => options.find((o) => o.kind === k)).find(Boolean);
const selected = (o: Option | undefined) => (o ? { outcome: { outcome: "selected", optionId: o.optionId } } : { outcome: { outcome: "cancelled" } });
const textOf = (c: unknown): string => {
  if (!c || typeof c !== "object") return "";
  const b = c as Record<string, unknown>;
  if (typeof b.text === "string") return b.text;
  if (b.content) return textOf(b.content);
  return "";
};
// Kinds a standing answer may cover as a whole. Anything else (MCP tools, "other") is
// left to Copilot's own "always" option, which it scopes itself.
const WHOLE = new Set(["edit", "read", "search", "fetch"]);

export type DriverOptions = {
  home?: string;
  // Copilot's command and the ACP arguments; tests point these at a fake agent.
  copilot?: string;
  args?: string[];
  log?: (line: string) => void;
  now?: () => number;
  // How long a stopped turn gets to end before its Copilot is killed (it resumes later).
  stopGraceMs?: number;
};

type Live = { proc: AcpProcess; caps: Record<string, unknown>; loading: boolean; killed?: boolean };
type Waiting = { ask: DrivenAsk; resolve: (r: unknown) => void };

export class Driver {
  private recs = new Map<string, DrivenRecord>();
  private live = new Map<string, Live>();
  private starting = new Map<string, Promise<Live>>();
  private asks = new Map<string, Waiting[]>();
  private busy = new Set<string>();
  private turns = new Map<string, number>();
  private saves = new Map<string, NodeJS.Timeout>();
  private wakers: Array<() => void> = [];
  private rev = 0;
  private seq = 0;
  readonly home: string;
  private opts: DriverOptions;

  constructor(opts: DriverOptions = {}) {
    this.opts = opts;
    this.home = opts.home ?? deskHome();
    for (const r of readDriven(this.home)) {
      // Its Copilot went with the last desk; what it was asking went with it.
      if (!["closed", "in its own screen", "asleep"].includes(r.state)) Object.assign(r, { state: "asleep" });
      r.queue = [];
      this.recs.set(r.name, r);
      this.rev = Math.max(this.rev, r.rev);
    }
  }

  private now = () => (this.opts.now ?? Date.now)();
  private say = (l: string) => this.opts.log?.(l);

  get version(): number {
    return this.rev;
  }

  // Resolves at the next change, or after `ms`.
  next(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.wakers = this.wakers.filter((w) => w !== done);
        resolve();
      };
      const t = setTimeout(done, ms);
      this.wakers.push(done);
    });
  }

  // Most in need of you first, as the page lists them.
  list(now = this.now()): DrivenView[] {
    return [...this.recs.values()].filter((r) => r.state !== "closed" || now - r.since < 86_400_000).map((r) => this.view(r)).sort((a, b) => URGENCY.indexOf(a.state) - URGENCY.indexOf(b.state) || a.name.localeCompare(b.name));
  }

  get(name: string): DrivenView | undefined {
    const r = this.recs.get(name);
    return r ? this.view(r) : undefined;
  }

  private view(r: DrivenRecord, keep = 80): DrivenView {
    const { fresh: _fresh, items, ...rest } = r;
    const lastAgent = [...items].reverse().find((i) => i.type === "agent" || i.type === "you");
    return {
      ...rest,
      items: items.slice(-keep).map((i) => (i.text.length > 8000 ? { ...i, text: `…${i.text.slice(-8000)}` } : i)),
      asks: (this.asks.get(r.name) ?? []).map((w) => w.ask),
      choices: (r.state === "done" || r.state === "idle") && lastAgent?.type === "agent" ? choicesIn(lastAgent.text) : [],
    };
  }

  // Everything changed after `rev`, for a window following one session.
  since(name: string, rev: number): { view: DrivenView; items: Item[] } | undefined {
    const r = this.recs.get(name);
    if (!r) return undefined;
    return { view: { ...this.view(r, 0), items: [] }, items: r.items.filter((i) => i.rev > rev) };
  }

  private changed(r: DrivenRecord): void {
    r.rev = ++this.rev;
    // Unref'd: shutdown() writes whatever is still waiting.
    if (!this.saves.has(r.name)) this.saves.set(r.name, setTimeout(() => this.save(r.name), 300).unref());
    const w = this.wakers;
    this.wakers = [];
    for (const f of w) f();
  }

  private save(name: string): void {
    clearTimeout(this.saves.get(name));
    this.saves.delete(name);
    const r = this.recs.get(name);
    if (r) writeJson(path.join(drivenDir(this.home), `${name}.json`), r);
  }

  private set(r: DrivenRecord, state: DrivenState, error?: string): void {
    if (r.state !== state) r.since = this.now();
    r.state = state;
    if (error) r.error = error;
    else delete r.error;
    this.changed(r);
  }

  private add(r: DrivenRecord, item: Omit<Item, "n" | "rev" | "at">): Item {
    const it: Item = { n: (r.items.at(-1)?.n ?? 0) + 1, rev: 0, at: this.now(), ...item };
    r.items.push(it);
    if (r.items.length > KEEP_ITEMS) r.items.splice(0, r.items.length - KEEP_ITEMS);
    this.touch(r, it);
    return it;
  }

  private touch(r: DrivenRecord, it: Item): void {
    this.changed(r);
    it.rev = r.rev;
  }

  private event(r: DrivenRecord, e: Omit<DeskEvent, "at" | "session" | "cwd" | "terminal">): void {
    if (r.session) append({ at: this.now(), session: r.session, cwd: r.cwd, terminal: r.name, ...e } as DeskEvent, this.home);
  }

  private need(name: string): DrivenRecord {
    const r = this.recs.get(name);
    if (!r) throw new Error(`no session named ${name}`);
    return r;
  }

  // ---------- starting and waking Copilot ----------

  async start(name: string, cwd: string, prompt?: string): Promise<DrivenView> {
    if (!NAME.test(name)) throw new Error("a name is letters, digits, '.', '-' or '_', up to 40");
    const dir = path.resolve(cwd);
    if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`no folder ${dir}`);
    const old = this.recs.get(name);
    if (old && old.state !== "closed") throw new Error(`there's already a session named ${name}`);
    const r: DrivenRecord = { name, cwd: dir, state: "starting", since: this.now(), rev: 0, items: [], queue: [] };
    this.recs.set(name, r);
    this.changed(r);
    await this.ensure(r);
    this.say(`${name}: started in ${dir}`);
    if (prompt?.trim()) this.prompt(name, prompt);
    return this.view(r);
  }

  private ensure(r: DrivenRecord): Promise<Live> {
    const have = this.live.get(r.name);
    if (have?.proc.acp.alive) return Promise.resolve(have);
    const going = this.starting.get(r.name);
    if (going) return going;
    const p = this.wake(r).finally(() => this.starting.delete(r.name));
    this.starting.set(r.name, p);
    return p;
  }

  private async wake(r: DrivenRecord): Promise<Live> {
    const env: NodeJS.ProcessEnv = { ...process.env, AF_DESK_DRIVEN: "1", AF_DESK_TERMINAL: r.name };
    delete env.AF_DESK_QUIET;
    let proc: AcpProcess;
    try {
      proc = spawnAcp(this.opts.copilot ?? "copilot", this.opts.args ?? ["--acp", "--stdio"], { cwd: r.cwd, env });
    } catch (e) {
      // Not on PATH, or a .cmd shim without its script (proc.ts says which).
      const why = (e as Error).message.split("\n")[0];
      this.add(r, { type: "error", text: why });
      this.set(r, "failed", why);
      throw e;
    }
    const live: Live = { proc, caps: {}, loading: false };
    this.live.set(r.name, live);
    const acp = proc.acp;
    acp.onNotify = (method, p) => this.notified(r, live, method, p);
    acp.handle("session/request_permission", (p) => this.permission(r, p));
    acp.handle("elicitation/create", (p) => this.question(r, p));
    void proc.exited.then(({ code, stderr }) => this.gone(r, live, code, stderr));
    const within = <T>(p: Promise<T>, what: string) =>
      Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Copilot didn't ${what} within ${STARTUP_MS / 1000}s; is it signed in? Run copilot once in a terminal`)), STARTUP_MS).unref())]);
    try {
      const init = await within(acp.request<{ agentCapabilities?: Record<string, unknown> }>("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } },
        clientInfo: { name: "agentfactory-desk", version: "0.1.0" },
      }), "start");
      live.caps = init.agentCapabilities ?? {};
      const sc = (live.caps.sessionCapabilities ?? {}) as Record<string, unknown>;
      if (r.session) {
        // Copilot replays the history on load; the desk already has it.
        live.loading = true;
        try {
          if (live.caps.loadSession) this.took(r, await within(acp.request("session/load", { sessionId: r.session, cwd: r.cwd, mcpServers: [] }), "reopen the session"));
          else if (sc.resume) this.took(r, await within(acp.request("session/resume", { sessionId: r.session, cwd: r.cwd, mcpServers: [] }), "reopen the session"));
          else throw new Error("this Copilot can't reopen a saved session over ACP; close it and start a new one");
        } finally {
          live.loading = false;
        }
      } else {
        const res = await within(acp.request<{ sessionId: string }>("session/new", { cwd: r.cwd, mcpServers: [] }), "open a session");
        if (typeof res.sessionId !== "string") throw new Error("Copilot opened a session without an id");
        r.session = res.sessionId;
        r.fresh = true;
        this.took(r, res);
        this.event(r, { event: "sessionStart" });
      }
      if (["starting", "asleep", "failed"].includes(r.state)) this.set(r, "idle");
      return live;
    } catch (e) {
      live.killed = true;
      proc.kill();
      this.live.delete(r.name);
      const why = (e as Error).message.split("\n")[0];
      this.add(r, { type: "error", text: why });
      this.set(r, "failed", why);
      throw e;
    }
  }

  // Modes, settings and commands a session/new or load answered with.
  private took(r: DrivenRecord, res: Record<string, unknown>): void {
    if (res.modes && typeof res.modes === "object") r.modes = res.modes as Modes;
    if (Array.isArray(res.configOptions)) r.config = res.configOptions as ConfigOption[];
    this.changed(r);
  }

  // Its Copilot exited: on purpose (stopped, handed over, desk closing) or not.
  private gone(r: DrivenRecord, live: Live, code: number | null, stderr: string): void {
    if (this.live.get(r.name) !== live) return;
    this.live.delete(r.name);
    this.cancelAsks(r);
    if (["closed", "in its own screen", "failed"].includes(r.state)) return;
    if (live.killed) return this.set(r, "asleep");
    const why = `Copilot exited${code === null ? "" : ` with code ${code}`}${stderr.trim() ? `: ${stderr.trim().split("\n").slice(-2).join(" ").slice(0, 300)}` : ""}`;
    this.add(r, { type: "error", text: why });
    this.set(r, "failed", why);
  }

  // ---------- what Copilot tells the desk ----------

  private notified(r: DrivenRecord, live: Live, method: string, p: Record<string, unknown>): void {
    if (method !== "session/update") return;
    const u = (p.update ?? {}) as Record<string, unknown>;
    switch (u.sessionUpdate) {
      case "available_commands_update":
        r.commands = Array.isArray(u.availableCommands) ? (u.availableCommands as Array<{ name?: string }>).map((c) => String(c.name ?? "")).filter(Boolean) : r.commands;
        return this.changed(r);
      case "current_mode_update":
        if (r.modes && typeof u.currentModeId === "string") r.modes = { ...r.modes, currentModeId: u.currentModeId };
        return this.changed(r);
      case "config_option_update":
        if (Array.isArray(u.configOptions)) r.config = u.configOptions as ConfigOption[];
        return this.changed(r);
    }
    if (live.loading) return;
    const last = r.items.at(-1);
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const type = u.sessionUpdate === "agent_message_chunk" ? "agent" : "thought";
        const text = textOf(u.content);
        const id = typeof u.messageId === "string" ? u.messageId : undefined;
        if (last && last.type === type && (!id || !last.ref || last.ref === id)) {
          last.text += text;
          this.touch(r, last);
        } else this.add(r, { type, text, ...(id ? { ref: id } : {}) });
        return;
      }
      case "tool_call": {
        const id = String(u.toolCallId ?? "");
        const it = r.items.find((i) => i.type === "tool" && i.ref === id);
        const raw = u.rawInput as Record<string, unknown> | undefined;
        const title = String(u.title ?? raw?.command ?? u.kind ?? "tool");
        if (it) {
          it.text = title;
          it.status = String(u.status ?? it.status ?? "pending");
          this.touch(r, it);
        } else this.add(r, { type: "tool", text: title, ref: id, status: String(u.status ?? "pending") });
        return;
      }
      case "tool_call_update": {
        const it = r.items.find((i) => i.type === "tool" && i.ref === String(u.toolCallId ?? ""));
        if (!it) return;
        if (typeof u.title === "string" && u.title) it.text = u.title;
        if (typeof u.status === "string") it.status = u.status;
        if (u.status === "failed" && Array.isArray(u.content)) {
          const why = (u.content as unknown[]).map(textOf).find(Boolean);
          if (why && !it.text.includes(" — ")) it.text += ` — ${why.split("\n")[0].slice(0, 200)}`;
        }
        this.touch(r, it);
        return;
      }
      case "plan": {
        const entries = Array.isArray(u.entries) ? (u.entries as Array<{ content?: string; status?: string }>) : [];
        const text = entries.map((e) => `${e.status === "completed" ? "✓" : e.status === "in_progress" ? "▸" : "○"} ${e.content ?? ""}`).join("\n");
        const lastYou = r.items.findLastIndex((i) => i.type === "you");
        const plan = r.items.findLastIndex((i) => i.type === "plan");
        if (plan > lastYou) {
          r.items[plan].text = text;
          this.touch(r, r.items[plan]);
        } else this.add(r, { type: "plan", text });
        return;
      }
    }
  }

  // Copilot asks before a tool it isn't allowed to run on its own, with its options
  // ("Allow once", "Always allow", "Reject"). A standing answer you gave on the desk
  // answers it at once; otherwise it waits for you on the desk or in an attached window.
  private permission(r: DrivenRecord, p: Record<string, unknown>): Promise<unknown> | unknown {
    const tc = (p.toolCall ?? {}) as Record<string, unknown>;
    const options = (Array.isArray(p.options) ? p.options : []) as Option[];
    const raw = (tc.rawInput && typeof tc.rawInput === "object" ? tc.rawInput : undefined) as Record<string, unknown> | undefined;
    const command = typeof raw?.command === "string" ? raw.command : undefined;
    const tool = typeof tc.kind === "string" && tc.kind ? tc.kind : "other";
    const title = String(tc.title ?? command ?? tool);
    const allow = pick(options, "allow_once", "allow_always");
    const rules = readJson<Rule[]>(rulesFile(this.home), []);
    if (allow && ruleMatches(rules, { terminal: r.name, tool, command })) {
      this.add(r, { type: "ask", text: command ?? title, status: "allowed by your standing answer" });
      this.event(r, { event: "decision", tool, by: "rule", choice: "allow" });
      return selected(allow);
    }
    const scope = command !== undefined ? standingScope(command) : WHOLE.has(tool) ? {} : undefined;
    const ask: DrivenAsk = { id: `${r.name}-${++this.seq}-${this.now()}`, at: this.now(), kind: "permission", title, tool, ...(command !== undefined ? { command } : {}), ...(raw && command === undefined ? { detail: JSON.stringify(raw).slice(0, 2000) } : {}), options, ...(allow && scope ? { always: scope } : {}) };
    this.event(r, { event: "permissionRequest", tool, detail: (command ?? title).slice(0, 300) });
    return this.wait(r, ask, command ?? title);
  }

  // A form Copilot sends when it needs an answer (ACP elicitation, if Copilot sends them).
  private question(r: DrivenRecord, p: Record<string, unknown>): Promise<unknown> | unknown {
    if (p.mode !== undefined && p.mode !== "form") return { action: "decline" };
    const schema = (p.requestedSchema ?? {}) as { properties?: Record<string, Field>; required?: string[] };
    const ask: DrivenAsk = { id: `${r.name}-${++this.seq}-${this.now()}`, at: this.now(), kind: "question", message: String(p.message ?? "Copilot asks"), fields: schema.properties ?? {}, required: Array.isArray(schema.required) ? schema.required : [] };
    return this.wait(r, ask, ask.message);
  }

  private wait(r: DrivenRecord, ask: DrivenAsk, text: string): Promise<unknown> {
    return new Promise((resolve) => {
      const list = this.asks.get(r.name) ?? [];
      list.push({ ask, resolve });
      this.asks.set(r.name, list);
      this.add(r, { type: "ask", text, ref: ask.id, status: "waiting" });
      this.set(r, "waiting on you");
    });
  }

  private settle(r: DrivenRecord, id: string, result: unknown, status: string): DrivenAsk {
    const list = this.asks.get(r.name) ?? [];
    const w = list.find((x) => x.ask.id === id);
    if (!w) throw new Error("that ask is gone: answered elsewhere, or its turn was stopped");
    this.asks.set(r.name, list.filter((x) => x !== w));
    w.resolve(result);
    const it = r.items.find((i) => i.type === "ask" && i.ref === id);
    if (it) {
      it.status = status;
      this.touch(r, it);
    }
    if (r.state === "waiting on you" && !this.asks.get(r.name)?.length) this.set(r, "working");
    return w.ask;
  }

  private cancelAsks(r: DrivenRecord): void {
    for (const w of [...(this.asks.get(r.name) ?? [])]) this.settle(r, w.ask.id, w.ask.kind === "permission" ? selected(undefined) : { action: "cancel" }, "cancelled");
  }

  // ---------- what you do ----------

  // One of Copilot's own options, or the desk's: "always" (a standing answer for this
  // terminal), "deny" with a note (rejected, the turn stopped, and the note sent as
  // your next prompt, the way Copilot's own screen takes feedback on a rejection).
  answer(name: string, id: string, a: { option?: string; always?: boolean; deny?: boolean; note?: string }): void {
    const r = this.need(name);
    const ask = (this.asks.get(name) ?? []).find((w) => w.ask.id === id)?.ask;
    if (!ask || ask.kind !== "permission") throw new Error("that ask is gone: answered elsewhere, or its turn was stopped");
    const waitedMs = this.now() - ask.at;
    let opt: Option | undefined;
    let status: string;
    if (a.always) {
      if (!ask.always) throw new Error("this ask can only be answered once: it chains or redirects commands");
      opt = pick(ask.options, "allow_once", "allow_always");
      const rules = readJson<Rule[]>(rulesFile(this.home), []);
      const rule: Rule = { terminal: name, tool: ask.tool, ...(ask.always.prefix ? { prefix: ask.always.prefix } : {}), at: this.now() };
      if (!rules.some((x) => x.terminal === rule.terminal && x.tool === rule.tool && x.prefix === rule.prefix)) writeJson(rulesFile(this.home), [...rules, rule]);
      status = `allowed from now on (${ask.always.prefix ? `${ask.always.prefix} …` : ask.tool})`;
    } else if (a.deny) {
      opt = pick(ask.options, "reject_once", "reject_always");
      status = a.note ? `denied: ${a.note}` : "denied";
    } else {
      opt = ask.options.find((o) => o.optionId === a.option);
      if (!opt) throw new Error(`Copilot offered ${ask.options.map((o) => o.optionId).join(", ")}`);
      status = opt.name;
    }
    this.settle(r, id, selected(opt), status);
    this.event(r, { event: "decision", tool: ask.tool, by: "page", choice: a.always ? "always" : a.deny || opt?.kind.startsWith("reject") ? "deny" : "allow", waitedMs, ...(a.note ? { message: a.note } : {}) });
    if (a.deny && a.note?.trim()) {
      const it = this.add(r, { type: "you", text: `About ${ask.command ? `\`${ask.command}\`` : ask.title}, which I didn't allow: ${a.note.trim()}`, queued: true });
      r.queue.unshift({ n: it.n, text: it.text });
      this.cancel(r);
    }
  }

  reply(name: string, id: string, action: "accept" | "decline" | "cancel", content?: Record<string, unknown>): void {
    const r = this.need(name);
    const ask = (this.asks.get(name) ?? []).find((w) => w.ask.id === id)?.ask;
    if (!ask || ask.kind !== "question") throw new Error("that question is gone");
    this.settle(r, id, action === "accept" ? { action, content: content ?? {} } : { action }, action === "accept" ? `answered: ${JSON.stringify(content ?? {}).slice(0, 200)}` : action);
  }

  // A prompt for a session: sent now, or after the running turn (as in Copilot's own
  // screen). A session that's asleep or failed starts Copilot again first.
  prompt(name: string, text: string): { queued: boolean } {
    const r = this.need(name);
    const t = text.trim();
    if (!t) throw new Error("a prompt needs some text");
    if (t.length > 20_000) throw new Error("keep a prompt under 20,000 characters; put the rest in a file and name it");
    if (r.state === "closed") throw new Error(`${name} is closed; start a new session`);
    if (r.state === "in its own screen") throw new Error(`${name} is open in Copilot's own screen in its window; quit Copilot there to drive it from here`);
    if (this.busy.has(name) || this.starting.has(name)) {
      const it = this.add(r, { type: "you", text: t, queued: true });
      r.queue.push({ n: it.n, text: t });
      this.changed(r);
      return { queued: true };
    }
    void this.run(r, t);
    return { queued: false };
  }

  private async run(r: DrivenRecord, text: string, queued?: number): Promise<void> {
    const name = r.name;
    this.busy.add(name);
    const turn = (this.turns.get(name) ?? 0) + 1;
    this.turns.set(name, turn);
    const it = queued !== undefined ? r.items.find((i) => i.n === queued) : undefined;
    if (it) {
      delete it.queued;
      this.touch(r, it);
    } else this.add(r, { type: "you", text });
    this.set(r, "working");
    let ok = true;
    try {
      const live = await this.ensure(r);
      if (r.state !== "waiting on you") this.set(r, "working");
      const res = await live.proc.acp.request<{ stopReason?: string }>("session/prompt", { sessionId: r.session, prompt: this.blocks(r, text, live.caps) });
      const why = res.stopReason ?? "end_turn";
      this.add(r, { type: "end", text: why });
      if (why === "cancelled") this.set(r, "idle");
      else {
        this.set(r, "done");
        const said = [...r.items].reverse().find((i) => i.type === "agent")?.text;
        this.event(r, { event: "notification", kind: "agent_idle", ...(said ? { message: said.slice(-300) } : {}) });
      }
    } catch (e) {
      ok = false;
      const why = (e as Error).message.split("\n")[0];
      const live = this.live.get(name);
      if (["closed", "in its own screen", "failed"].includes(r.state)) {
        /* said already */
      } else if (!live && r.state === "asleep") this.add(r, { type: "end", text: "stopped" });
      else {
        this.add(r, { type: "error", text: why });
        this.set(r, live?.proc.acp.alive ? "idle" : "failed", why);
      }
    } finally {
      this.busy.delete(name);
      this.changed(r);
    }
    const next = r.queue.shift();
    if (next && (ok || r.state === "asleep" || r.state === "idle")) void this.run(r, next.text, next.n);
    else if (next) this.drop(r, [next, ...r.queue.splice(0)]);
  }

  private drop(r: DrivenRecord, queue: DrivenRecord["queue"]): void {
    for (const q of queue) {
      const it = r.items.find((i) => i.n === q.n);
      if (it) {
        it.status = "not sent";
        delete it.queued;
        this.touch(r, it);
      }
    }
  }

  // What Copilot gets for one prompt: your words, and before them, marked as the desk's,
  // what's known about the repo (first prompt only) and notes that waited for it.
  private blocks(r: DrivenRecord, text: string, caps: Record<string, unknown>): unknown[] {
    const parts: string[] = [];
    if (r.fresh) {
      const known = contextFor(r.cwd, this.home);
      if (known) parts.push(known);
      delete r.fresh;
    }
    const notes = claim(r.name, r.session ?? "", { home: this.home });
    for (const n of notes) this.add(r, { type: "note", text: `${n.from === "you" ? "your note" : `note from ${n.from}`}: ${n.text}` });
    if (notes.length) parts.push(renderNotes(notes, r.name));
    const out: unknown[] = [];
    if (parts.length) {
      const ctx = `Context from the user's desk (not part of their request):\n\n${parts.join("\n\n")}`;
      const embedded = (caps.promptCapabilities as Record<string, unknown> | undefined)?.embeddedContext;
      out.push(embedded ? { type: "resource", resource: { uri: "af-desk://context", mimeType: "text/markdown", text: ctx } } : { type: "text", text: ctx });
    }
    out.push({ type: "text", text });
    return out;
  }

  // Stop the running turn (Esc in Copilot's own screen): every open ask is cancelled and
  // prompts waiting in line are dropped. A turn that won't stop is killed; Copilot saved
  // it, and the next prompt reloads it.
  stop(name: string): void {
    const r = this.need(name);
    this.drop(r, r.queue.splice(0));
    this.cancel(r);
  }

  private cancel(r: DrivenRecord): void {
    const live = this.live.get(r.name);
    if (!this.busy.has(r.name) || !live) return;
    this.cancelAsks(r);
    live.proc.acp.notify("session/cancel", { sessionId: r.session });
    const turn = this.turns.get(r.name);
    setTimeout(() => {
      if (this.busy.has(r.name) && this.turns.get(r.name) === turn && this.live.get(r.name) === live) {
        this.say(`${r.name}: the turn didn't stop; stopping its Copilot`);
        this.kill(r, live);
      }
    }, this.opts.stopGraceMs ?? 10_000).unref();
  }

  private kill(r: DrivenRecord, live: Live): void {
    live.killed = true;
    live.proc.kill();
    this.live.delete(r.name);
    this.cancelAsks(r);
    if (!["closed", "in its own screen"].includes(r.state)) this.set(r, "asleep");
  }

  // A mode (agent, plan, …) or a setting Copilot offers (its model, …).
  async setOption(name: string, id: string, value: string): Promise<void> {
    const r = this.need(name);
    if (r.state === "closed" || r.state === "in its own screen") throw new Error(`${name} isn't on the desk now`);
    const live = await this.ensure(r);
    const opt = r.config?.find((o) => o.id === id);
    if (opt) {
      const res = await live.proc.acp.request<{ configOptions?: ConfigOption[] }>("session/set_config_option", { sessionId: r.session, configId: id, value });
      r.config = Array.isArray(res.configOptions) ? res.configOptions : r.config!.map((o) => (o.id === id ? { ...o, currentValue: value } : o));
    } else if (id === "mode" && r.modes) {
      if (!r.modes.availableModes.some((m) => m.id === value)) throw new Error(`modes: ${r.modes.availableModes.map((m) => m.id).join(", ")}`);
      await live.proc.acp.request("session/set_mode", { sessionId: r.session, modeId: value });
      r.modes = { ...r.modes, currentModeId: value };
    } else throw new Error(`Copilot offers no setting ${id} here`);
    this.changed(r);
  }

  seen(name: string): void {
    const r = this.need(name);
    if (r.state === "done") this.set(r, "idle");
  }

  async close(name: string): Promise<void> {
    const r = this.need(name);
    if (r.state === "closed") return;
    this.drop(r, r.queue.splice(0));
    const live = this.live.get(name);
    this.cancelAsks(r);
    if (live) {
      const sc = (live.caps.sessionCapabilities ?? {}) as Record<string, unknown>;
      if (this.busy.has(name)) live.proc.acp.notify("session/cancel", { sessionId: r.session });
      if (sc.close) await Promise.race([live.proc.acp.request("session/close", { sessionId: r.session }).catch(() => {}), new Promise((res) => setTimeout(res, 5_000).unref())]);
    }
    this.set(r, "closed");
    if (live) this.kill(r, live);
    // Ended, so learning reads it.
    this.event(r, { event: "sessionEnd", reason: "closed on the desk" });
    this.say(`${name}: closed`);
  }

  // Give the session to Copilot's own screen (`copilot --resume <id>` in a window) and
  // back. Two Copilots on one session would talk over each other, so the desk lets go
  // of it first, and won't drive it until it's given back.
  handoff(name: string): { session: string; cwd: string } {
    const r = this.need(name);
    if (this.busy.has(name)) throw new Error(`${name} is working: stop it first, or let it finish`);
    if (!r.session || r.state === "closed") throw new Error(`${name} has no session to hand over`);
    const live = this.live.get(name);
    this.set(r, "in its own screen");
    if (live) this.kill(r, live);
    this.add(r, { type: "note", text: "handed to Copilot's own screen" });
    return { session: r.session, cwd: r.cwd };
  }

  back(name: string): void {
    const r = this.need(name);
    if (r.state !== "in its own screen") return;
    this.add(r, { type: "note", text: "back on the desk" });
    this.set(r, "asleep");
  }

  // The desk is closing: every Copilot stops; each session is asleep until its next prompt.
  shutdown(): string[] {
    const working = [...this.busy];
    for (const [name, live] of [...this.live]) {
      const r = this.recs.get(name);
      if (r) this.kill(r, live);
    }
    for (const name of [...this.saves.keys()]) this.save(name);
    return working;
  }
}
