// Reading what a Copilot CLI session did, from the file Copilot keeps for it:
// `~/.copilot/session-state/<session>/events.jsonl` (older versions: `<session>.jsonl`).
// One JSON object per line, `{ type, data, id, timestamp }`, the same shape
// `copilot --output-format json` prints. The format isn't documented, so everything
// here reads leniently and skips what it doesn't know.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CopilotStream } from "../harness/agents.ts";

export function copilotHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.COPILOT_HOME || path.join(os.homedir(), ".copilot");
}

// Where a session's file is: the path Copilot gave a hook, else where it keeps them.
export function sessionFile(session: string, known?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (known && fs.existsSync(known)) return known;
  if (!/^[\w.-]+$/.test(session)) return undefined;
  const root = path.join(copilotHome(env), "session-state");
  for (const f of [path.join(root, session, "events.jsonl"), path.join(root, `${session}.jsonl`)]) if (fs.existsSync(f)) return f;
  return undefined;
}

// The end of a session as readable lines, the same way the harness logs a turn: what
// it ran, what failed, what it said. Only the last bytes are read: files grow large.
export function sessionTail(file: string, lines = 14, bytes = 96 * 1024): string[] {
  let text = "";
  try {
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - bytes);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString("utf8");
      if (start > 0) text = text.slice(text.indexOf("\n") + 1); // drop the cut line
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
  const out: string[] = [];
  const s = new CopilotStream((...l) => out.push(...l));
  s.feed(text);
  s.end();
  // report_intent is Copilot saying what it's doing, shown as the thread's "now" instead.
  return out.filter((l) => !l.startsWith("model:") && !/^\W*report_intent\b/.test(l)).slice(-lines);
}

type Ev = { type?: string; data?: Record<string, any>; id?: string; timestamp?: string };

export function readEvents(file: string): Ev[] {
  const out: Ev[] = [];
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const e = JSON.parse(line) as Ev;
      if (typeof e.type === "string") out.push({ ...e, data: e.data ?? (e as { payload?: Record<string, any> }).payload ?? {} });
    } catch {
      /* a line being written */
    }
  }
  return out;
}

export type Digest = { text: string; repo?: string; cwd?: string; branch?: string; prompts: number; tools: number; failures: number; from?: string; to?: string };

const flat = (v: unknown, n: number) => {
  const s = (typeof v === "string" ? v : JSON.stringify(v ?? "")).replace(/\r/g, "");
  return s.length > n ? `${s.slice(0, n)} …[cut]` : s;
};

// A session told for someone who wasn't there: what you asked, what Copilot did and
// said, what failed and what fixed it, what you refused. What the analysis reads,
// and what's kept next to the knowledge it produced. Your words are kept whole (they
// carry the corrections); Copilot's long answers and tool output are cut. Past `max`
// characters the middle goes, never your prompts.
export function digest(events: Ev[], refusals: Array<{ tool?: string; note?: string }> = [], max = 40_000): Digest {
  const d: Digest = { text: "", prompts: 0, tools: 0, failures: 0 };
  const parts: Array<{ text: string; keep: boolean }> = [];
  const add = (text: string, keep = false) => parts.push({ text, keep });
  const pendingTool = new Map<string, string>();
  for (const e of events) {
    const x = e.data ?? {};
    if (e.timestamp) {
      d.from ??= e.timestamp;
      d.to = e.timestamp;
    }
    switch (e.type) {
      case "session.start": {
        const c = x.context ?? x;
        d.cwd = c.cwd ?? x.cwd;
        d.repo = c.repository ?? (c.gitRoot ? path.basename(c.gitRoot) : d.cwd ? path.basename(d.cwd) : undefined);
        d.branch = c.branch;
        break;
      }
      case "user.message":
        d.prompts++;
        add(`\n### You\n${flat(x.content ?? x.text ?? "", 4000)}`, true);
        break;
      case "assistant.message": {
        if (x.parentToolCallId) break; // a sub-agent's inner talk
        const t = typeof x.content === "string" ? x.content.trim() : "";
        if (t) add(`\n### Copilot\n${flat(t, 1500)}`);
        break;
      }
      case "tool.execution_start": {
        d.tools++;
        const a = x.arguments ?? x.args ?? x.input;
        const what = typeof a === "string" ? flat(a, 200) : flat(a?.command ?? a?.path ?? a?.url ?? a, 300);
        const line = `- ran ${x.toolName ?? x.name ?? "a tool"}: ${what}`;
        if (x.toolCallId) pendingTool.set(String(x.toolCallId), line);
        else add(line);
        break;
      }
      case "tool.execution_complete": {
        const start = x.toolCallId ? pendingTool.get(String(x.toolCallId)) : undefined;
        if (x.toolCallId) pendingTool.delete(String(x.toolCallId));
        const exit = x.shellExecution?.exitCode;
        const failed = x.success === false || (typeof exit === "number" && exit !== 0);
        if (failed) {
          d.failures++;
          add(`${start ?? `- ${x.toolName ?? "tool"}`}\n  FAILED${typeof exit === "number" ? ` (exit ${exit})` : ""}: ${flat(x.error?.message ?? x.result?.content ?? x.error ?? "", 600)}`, true);
        } else if (start) add(start);
        break;
      }
      default:
        if (/error/i.test(e.type ?? "")) add(`- ${e.type}: ${flat(x.message ?? x.error?.message ?? x, 300)}`);
    }
  }
  for (const r of refusals) add(`- you refused ${r.tool ?? "a tool"}${r.note ? `: "${flat(r.note, 500)}"` : ""}`, true);

  const head = [`# Session in ${d.repo ?? "a repo"}${d.branch ? ` (branch ${d.branch})` : ""}`, `${d.prompts} prompts, ${d.tools} tool calls, ${d.failures} failed`].join("\n");
  let body = parts.map((p) => p.text);
  if (body.join("\n").length > max) {
    // Keep your prompts and the failures; drop the rest from the middle out.
    const keep = parts.map((p) => p.keep);
    let size = body.join("\n").length;
    const order = [...body.keys()].filter((i) => !keep[i]).sort((a, b) => Math.abs(a - body.length / 2) - Math.abs(b - body.length / 2));
    const drop = new Set<number>();
    for (const i of order) {
      if (size <= max) break;
      drop.add(i);
      size -= body[i].length + 1;
    }
    body = body.flatMap((t, i) => (drop.has(i) ? (drop.has(i - 1) ? [] : ["…"]) : [t]));
  }
  d.text = `${head}\n${body.join("\n")}\n`;
  return d;
}

// ---------- a session as a thread ----------

export type Summary = {
  // Your first prompt, cut to its first sentence: what the thread is for.
  title?: string;
  branch?: string;
  // What it says it's doing (Copilot's report_intent), else the tool it's running.
  now?: string;
  said?: string;
  prompts: number;
  // Files its tools wrote, newest last; shell commands; tool calls that failed.
  files: string[];
  commands: number;
  failed: number;
};

const SHELL = /^(powershell|pwsh|bash|shell|sh|cmd|run_in_terminal|terminal)$/i;
const WRITES = /(edit|create|write|patch|replace|insert|delete|move|rename)/i;
const PATCHED = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm;

export function titleOf(prompt: string, max = 80): string {
  const first = prompt.trim().split(/\n/)[0].trim();
  const sentence = /^(.+?(?:[.?!](?=\s|$)|[。？！]))/.exec(first)?.[1] ?? first;
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 20)).trimEnd()}…`;
}

// What a session is about and how far it got, folded one event at a time, so a session
// still being written is read only where it grew (see SessionFollow).
class SummaryFold {
  private s: Summary = { prompts: 0, files: [], commands: 0, failed: 0 };
  private running = new Map<string, string>();
  private files = new Set<string>();
  private wrote(f: string) {
    this.files.delete(f); // newest last
    this.files.add(f);
  }
  feed(e: Ev): void {
    const s = this.s;
    const x = e.data ?? {};
    switch (e.type) {
      case "session.start":
        s.branch = (x.context ?? x).branch ?? s.branch;
        break;
      case "user.message": {
        const t = typeof x.content === "string" ? x.content : typeof x.text === "string" ? x.text : "";
        s.prompts++;
        if (!s.title && t.trim()) s.title = titleOf(t);
        break;
      }
      case "assistant.message":
        if (!x.parentToolCallId && typeof x.content === "string" && x.content.trim()) s.said = x.content.trim();
        break;
      case "tool.execution_start": {
        const name = String(x.toolName ?? x.name ?? "");
        const a = x.arguments ?? x.args ?? x.input;
        if (name === "report_intent") {
          const intent = typeof a === "string" ? a : a?.intent;
          if (typeof intent === "string" && intent.trim()) s.now = intent.trim();
          break;
        }
        if (SHELL.test(name)) s.commands++;
        const what = typeof a === "string" ? a : a?.command ?? a?.path ?? a?.file_path ?? a?.url ?? "";
        if (x.toolCallId) this.running.set(String(x.toolCallId), `${name}${what ? `: ${String(what).split("\n")[0].slice(0, 120)}` : ""}`);
        if (WRITES.test(name)) {
          const text = typeof a === "string" ? a : typeof a?.patch === "string" ? a.patch : typeof a?.input === "string" ? a.input : "";
          for (const m of text.matchAll(PATCHED)) this.wrote(m[1].trim());
          for (const p of [a?.path, a?.file_path, a?.filePath]) if (typeof p === "string" && p) this.wrote(p);
        }
        break;
      }
      case "tool.execution_complete": {
        if (x.toolCallId) this.running.delete(String(x.toolCallId));
        const exit = x.shellExecution?.exitCode;
        if (x.success === false || (typeof exit === "number" && exit !== 0)) s.failed++;
        break;
      }
    }
  }
  result(): Summary {
    const s: Summary = { ...this.s };
    // A tool still running says more about now than an intent stated earlier.
    const last = [...this.running.values()].pop();
    if (last) s.now = s.now ? `${s.now} (running ${last})` : `running ${last}`;
    s.files = [...this.files].slice(-30);
    return s;
  }
}

export function summarize(events: Ev[]): Summary {
  const f = new SummaryFold();
  for (const e of events) f.feed(e);
  return f.result();
}

export type Turn = { k: "you" | "said" | "run" | "now"; text: string; ok?: boolean; running?: boolean };

// A session as it goes, for following a terminal from the desk: your prompts, what
// Copilot said (not its sub-agents), each tool call with how it ended, and what it says
// it's doing. Its tools' output stays in the terminal. Each turn keeps the version it
// last changed at, so the page can ask for only what changed since it last looked.
class TalkFold {
  readonly turns: Turn[] = [];
  readonly changed: number[] = [];
  v = 0;
  private open = new Map<string, number>();
  private push(t: Turn) {
    this.turns.push(t);
    this.changed.push(++this.v);
  }
  feed(e: Ev): void {
    const x = e.data ?? {};
    switch (e.type) {
      case "user.message": {
        const t = typeof x.content === "string" ? x.content : typeof x.text === "string" ? x.text : "";
        if (t.trim()) this.push({ k: "you", text: t.trim() });
        break;
      }
      case "assistant.message":
        if (!x.parentToolCallId && typeof x.content === "string" && x.content.trim()) this.push({ k: "said", text: x.content.trim() });
        break;
      case "tool.execution_start": {
        const name = String(x.toolName ?? x.name ?? "tool");
        const a = x.arguments ?? x.args ?? x.input;
        if (name === "report_intent") {
          const intent = typeof a === "string" ? a : a?.intent;
          if (typeof intent === "string" && intent.trim()) this.push({ k: "now", text: intent.trim() });
          break;
        }
        // A patch reads as the files it touches.
        const patch = typeof a === "string" ? a : typeof a?.patch === "string" ? a.patch : typeof a?.input === "string" ? a.input : "";
        const files = [...patch.matchAll(PATCHED)].map((m) => m[1].trim());
        const what = files.length ? files.join(", ") : typeof a === "string" ? a : a?.command ?? a?.path ?? a?.file_path ?? a?.url ?? "";
        this.push({ k: "run", text: SHELL.test(name) && what ? String(what) : `${name}${what ? ` ${String(what).split("\n")[0]}` : ""}`, running: true });
        if (x.toolCallId) this.open.set(String(x.toolCallId), this.turns.length - 1);
        break;
      }
      case "tool.execution_complete": {
        const i = this.open.get(String(x.toolCallId));
        if (i === undefined) break;
        this.open.delete(String(x.toolCallId));
        const exit = x.shellExecution?.exitCode;
        const t = this.turns[i];
        t.running = false;
        t.ok = !(x.success === false || (typeof exit === "number" && exit !== 0));
        this.changed[i] = ++this.v;
        break;
      }
    }
  }
}

const cutTurn = (t: Turn): Turn => (t.text.length > 4000 ? { ...t, text: `${t.text.slice(0, 4000)}…` } : { ...t });

export function conversation(events: Ev[], max = 200): Turn[] {
  const f = new TalkFold();
  for (const e of events) f.feed(e);
  return f.turns.slice(-max).map(cutTurn);
}

// ---------- following a session while it's written ----------

export type Placed = Turn & { i: number };
export type Changes = {
  // Starts again when the file was rewritten from the beginning: drop what you have.
  epoch: string;
  // Pass this back as `since` to get only what changed after it.
  v: number;
  total: number;
  turns: Placed[];
};

// Copilot appends to a session's file as it works, and the file grows to megabytes. A
// follower remembers how far it read and reads only what was added, so the desk can look
// several times a second without parsing the whole session again.
export class SessionFollow {
  readonly epoch = Math.random().toString(36).slice(2, 10);
  private offset = 0;
  private talk = new TalkFold();
  private sum = new SummaryFold();
  private summary?: { v: number; value: Summary };
  // Counts every event read, not only those that change a turn, so a summary that
  // moves (a running tool) is seen too.
  private events = 0;
  readonly file: string;
  constructor(file: string) {
    this.file = file;
  }

  get v(): number {
    return this.talk.v;
  }
  get read(): number {
    return this.offset;
  }

  // Reads what was added since the last call. A last line still being written is left
  // for the next call; one that's whole without its newline is taken.
  update(): void {
    const size = fs.statSync(this.file, { throwIfNoEntry: false })?.size ?? 0;
    if (size <= this.offset) return;
    const fd = fs.openSync(this.file, "r");
    try {
      let carry = Buffer.alloc(0);
      let pos = this.offset;
      while (pos < size) {
        const buf = Buffer.alloc(Math.min(CHUNK, size - pos));
        const got = fs.readSync(fd, buf, 0, buf.length, pos);
        if (got <= 0) break;
        pos += got;
        const data = carry.length ? Buffer.concat([carry, buf.subarray(0, got)]) : buf.subarray(0, got);
        const nl = data.lastIndexOf(10);
        if (nl < 0) {
          carry = data;
          continue;
        }
        for (const line of data.subarray(0, nl).toString("utf8").split("\n")) this.line(line);
        carry = data.subarray(nl + 1);
        this.offset = pos - carry.length;
      }
      if (carry.length && this.line(carry.toString("utf8"))) this.offset = pos;
    } finally {
      fs.closeSync(fd);
    }
  }

  private line(l: string): boolean {
    const t = l.trim();
    if (!t.startsWith("{")) return false;
    let e: Ev;
    try {
      e = JSON.parse(t) as Ev;
    } catch {
      return false;
    }
    if (typeof e.type !== "string") return false;
    const ev = { ...e, data: e.data ?? (e as { payload?: Record<string, any> }).payload ?? {} };
    this.talk.feed(ev);
    this.sum.feed(ev);
    this.events++;
    return true;
  }

  summarize(): Summary {
    if (this.summary?.v !== this.events) this.summary = { v: this.events, value: this.sum.result() };
    return this.summary.value;
  }

  // What changed after version `since`. The first look (since 0) gets only the last
  // `last` turns; earlier ones come a page at a time with `earlier`.
  changes(since = 0, last = 200): Changes {
    const { turns, changed } = this.talk;
    const out: Placed[] = [];
    const from = since > 0 ? 0 : Math.max(0, turns.length - last);
    // Not only the newest turns: a tool call that started long ago can end now.
    if (since > 0) {
      for (let i = turns.length - 1; i >= 0; i--) if (changed[i] > since) out.push({ ...cutTurn(turns[i]), i });
      out.reverse();
    } else for (let i = from; i < turns.length; i++) out.push({ ...cutTurn(turns[i]), i });
    return { epoch: this.epoch, v: this.v, total: turns.length, turns: out };
  }

  earlier(before: number, n = 200): Changes {
    const end = Math.max(0, Math.min(before, this.talk.turns.length));
    const turns = this.talk.turns.slice(Math.max(0, end - n), end).map((t, k) => ({ ...cutTurn(t), i: Math.max(0, end - n) + k }));
    return { epoch: this.epoch, v: this.v, total: this.talk.turns.length, turns };
  }
}

const CHUNK = 4 * 1024 * 1024;
// One follower per file, made again when the file shrank (rewritten from the start).
const followers = new Map<string, SessionFollow>();
export function follow(file: string): SessionFollow {
  let f = followers.get(file);
  const size = fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0;
  if (!f || size < f.read) f = new SessionFollow(file);
  // Most recently looked at last: a desk runs for days, and sessions it no longer shows
  // needn't stay in memory.
  followers.delete(file);
  followers.set(file, f);
  if (followers.size > 40) followers.delete(followers.keys().next().value as string);
  f.update();
  return f;
}
