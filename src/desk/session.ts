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
  // The latest prompts as the story reads them (see StoryFold), oldest first, and the
  // first sentence of what it said last.
  arc?: Arc[];
  headline?: string;
};
export type Arc = { ask: string; tone: Tone; kind: StepKind };

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
  const st = new StoryFold();
  for (const e of events) {
    f.feed(e);
    st.feed(e);
  }
  return withStory(f.result(), st);
}

function withStory(s: Summary, st: StoryFold): Summary {
  const steps = st.steps();
  const arc = steps.slice(-30).map((x) => ({ ask: x.ask, tone: x.tone, kind: x.kind }));
  const headline = s.said ? gistOf(s.said, 0)[0] : undefined;
  return { ...s, ...(arc.length ? { arc } : {}), ...(headline ? { headline } : {}) };
}

// ---------- a session as a story: each prompt you gave, and what it led to ----------
// A long session is dozens of prompts and thousands of tool calls. Read as a story it's
// one step per prompt: a few words for what you asked, which earlier step it follows
// from, how it went, and a handful of bullets for what Copilot did and said. Nothing
// here asks a model: it's read from the events as they are, so it's instant and free.

export type Tone = "ok" | "warn" | "bad" | "run" | "talk";
// ask: a new instruction. reply: a short answer to Copilot (yes, b, continue). resume: a
// session picked up again after its context was compacted. stop: you interrupted it.
export type StepKind = "ask" | "reply" | "resume" | "stop";
export type Step = {
  i: number;
  kind: StepKind;
  ask: string;
  // The step this one follows from; -1 is the start (a new topic).
  parent: number;
  tone: Tone;
  at?: number;
  ms?: number;
  tools: number;
  commands: number;
  failed: number;
  edits: number;
  // Where the prompt is among the session's turns (see TalkFold), to open it raw.
  turn: number;
};
export type StepDetail = Step & { prompt: string; did: string[]; errors: string[]; said: string[]; intents: string[]; files: string[] };

type Acc = {
  kind: StepKind;
  ask: string;
  prompt: string;
  turn: number;
  at?: number;
  last?: number;
  keys: Set<string>;
  words: number;
  files: Set<string>;
  reads: Set<string>;
  searches: number;
  cmds: Map<string, number>;
  commands: number;
  tools: number;
  failed: number;
  lastFailed: boolean;
  failures: string[];
  web: string[];
  agents: string[];
  intents: string[];
  said?: string;
  open: Map<string, { cat: string; head: string }>;
};

const catOf = (n: string) =>
  n === "report_intent" ? "intent"
  : SHELL.test(n) || /run_command|run_in_terminal/i.test(n) ? "shell"
  : /^(task|agent)$|subagent/i.test(n) ? "agent"
  : /todo|^task[a-z]+$/i.test(n) ? "plan"
  : /fetch|web|browse|url/i.test(n) ? "web"
  : /grep|^rg$|glob|search|find/i.test(n) ? "search"
  : WRITES.test(n) ? "write"
  : /read|view|list|^cat$|open/i.test(n) ? "read"
  : "other";

const ONE_LINE = (s: unknown) => String(s ?? "").replace(/\r/g, "").split("\n").find((l) => l.trim())?.trim() ?? "";
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const baseName = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? p;

// A command as you'd name it: the program and, for the usual tools, what it does.
export function commandHead(cmd: string): string {
  let c = ONE_LINE(cmd);
  for (let k = 0; k < 3; k++) c = c.replace(/^(cd|Set-Location|pushd)\s+("[^"]*"|\S+)\s*(&&|;)\s*/i, "").replace(/^\$env:\w+\s*=\s*("[^"]*"|'[^']*'|\S+)\s*;\s*/i, "").replace(/^[\w]+=\S+\s+/, "");
  const w = c.split(/\s+/).filter(Boolean);
  if (!w.length) return "";
  // A script typed inline (if, foreach, $x = …) has no program to name.
  if (/^(if|foreach|for|while|try|function|param|\$|\(|\{|@)/i.test(w[0])) return "a script";
  const prog = baseName(w[0].replace(/^["'&]+|["']+$/g, "")).replace(/\.(exe|cmd|ps1)$/i, "");
  const arg = w.slice(1).map((x) => x.replace(/^["']|["']$/g, "")).find((x) => !x.startsWith("-") && /^[\w.:\\/@-]+$/.test(x));
  if (arg &&/^(git|npm|npx|pnpm|yarn|gh|dotnet|cargo|go|docker|kubectl|az|copilot|claude|codex|node|python3?|py|pwsh|powershell)$/i.test(prog)) {
    const a = /[\\/]/.test(arg) ? baseName(arg.replace(/^["']|["']$/g, "")) : arg;
    return cut(`${prog} ${a}`, 40);
  }
  return cut(prog, 40);
}

// What a prompt asks, in a few words: "Fix following first", "Said yes", "Chose b".
export function askOf(prompt: string): { kind: StepKind; ask: string } {
  const t = prompt.trim();
  if (/^\[Request interrupted/i.test(t)) return { kind: "stop", ask: "Stopped it" };
  if (/^This session is being continued from a previous conversation/i.test(t)) return { kind: "resume", ask: "Picked up after a context reset" };
  const first = ONE_LINE(t).replace(/^[>#*\s]+/, "");
  const short = first.split(/\s+/).length <= 4 && first.length <= 32 && !/\n\s*\S/.test(t);
  if (short) {
    const l = first.toLowerCase().replace(/[.!。！]+$/, "");
    if (/^(y|yes|yep|yeah|sure|ok|okay|go ahead|do it|lgtm)\b|^(好|好的|是|是的|可以|对|行)$/.test(l)) return { kind: "reply", ask: "Said yes" };
    if (/^(n|no|nope)\b|^(不|不要|不用|别)$/.test(l)) return { kind: "reply", ask: "Said no" };
    if (/^(continue|resume|go on|keep going|carry on|next|proceed|继续)/.test(l)) return { kind: "reply", ask: "Continue" };
    if (/^([a-h]|\d{1,2})$/i.test(l)) return { kind: "reply", ask: `Chose ${first.replace(/[.!]+$/, "")}` };
  }
  let s = first;
  for (let k = 0; k < 4; k++)
    s = s.replace(/^(ok(ay)?|so|now|hi|hey|well|great|cool|alright|thanks|thank you|好的?|那么?|嗯|然后|现在)[\s,，.:：!！]+/i, "")
      .replace(/^(can|could|would|will) you\s+(please\s+)?/i, "")
      .replace(/^(please|pls|plz|请|帮我|麻烦)\s*/i, "")
      .replace(/^(i want( you)? to|i'd like( you)? to|i need( you)? to|let's|let us|lets|we need to|we should|help me( to)?|go and|go)\s+/i, "")
      .replace(/^(really|just|also|then)\s+/i, "");
  const clause = s.split(/(?<=[^\d])[.?!;](?=\s|$)|[。？！；，\n]|,\s+(?=and\b|but\b|then\b|so\b|which\b|how\b|what\b)|\s+-\s+/)[0].trim() || s;
  let ask: string;
  if (/[一-鿿]/.test(clause) && !/\s\S+\s\S+\s/.test(clause)) ask = cut(clause, 22);
  else {
    const w = clause.split(/\s+/);
    ask = w.length > 7 ? `${w.slice(0, 7).join(" ").replace(/[,，:]+$/, "")}…` : clause;
  }
  ask = ask.replace(/[,:;，：]+$/, "");
  return { kind: "ask", ask: ask ? ask[0].toUpperCase() + ask.slice(1) : cut(first, 40) };
}

const STOP_WORDS = new Set("this that with from have what when then them they there their will would could should about into your just like some more also make made need want lets please thanks okay sure continue doing done does here only been were than each other first know think right good work still even much very really yeah".split(" "));
function keysOf(text: string): Set<string> {
  const s = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? []) if (!STOP_WORDS.has(w)) s.add(w.replace(/(ing|ed|es|s)$/, ""));
  for (const run of text.match(/[一-鿿]{2,}/g) ?? []) for (let k = 0; k + 1 < run.length; k++) s.add(run.slice(k, k + 2));
  return s;
}
const FOLLOWS = /^(continue|yes|yeah|yep|ok|okay|sure|no|nope|now|then|also|and|but|next|resume|go on|great|good|perfect|right|same|again|do (it|that|this|both|all|[a-h]\b)|[a-h]\b[,.:)]|\d{1,2}\s*[,.:)]|option|好|继续|然后|再|还有|那|对|是|不|可以)/i;
const overlap = (a: Set<string>, b: Set<string>) => {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
};

// What an answer says, as bullets: its first sentence, then its list items. `n` items.
export function gistOf(text: string, n = 4): string[] {
  const plain = (s: string) => s.replace(/\*\*|__|`/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\s+/g, " ").trim();
  const out: string[] = [];
  let fence = false;
  let head = "";
  const items: string[] = [];
  for (const l of text.replace(/\r/g, "").split("\n")) {
    if (/^\s*(```|~~~)/.test(l)) { fence = !fence; continue; }
    if (fence || !l.trim()) continue;
    const item = /^\s{0,4}(?:[-*+]|\d+[.)])\s+(.*)$/.exec(l);
    if (item) { if (items.length < n) items.push(cut(plain(item[1]), 150)); continue; }
    if (!head && !/^\s*(#|\|)/.test(l)) {
      const p = plain(l);
      head = /^(.+?[.?!。？！])(\s|$)/.exec(p)?.[1] ?? p;
    }
  }
  if (head) out.push(cut(head, 200));
  return [...out, ...items];
}

export class StoryFold {
  private acc: Acc[] = [];
  private changed: number[] = [];
  v = 0;
  private bump(i: number) {
    if (i >= 0) this.changed[i] = ++this.v;
  }
  private get cur(): Acc | undefined {
    return this.acc[this.acc.length - 1];
  }
  private start(prompt: string, turn: number, at?: number): Acc {
    const { kind, ask } = askOf(prompt);
    const a: Acc = { kind, ask, prompt, turn, at, last: at, keys: kind === "ask" ? keysOf(prompt) : new Set(), words: prompt.trim().split(/\s+/).length, files: new Set(), reads: new Set(), searches: 0, cmds: new Map(), commands: 0, tools: 0, failed: 0, lastFailed: false, failures: [], web: [], agents: [], intents: [], open: new Map() };
    this.acc.push(a);
    this.changed.push(0);
    this.bump(this.acc.length - 2); // the step before stops being the latest
    this.bump(this.acc.length - 1);
    return a;
  }
  // `turn`: how many talk turns there were before this event (TalkFold's count).
  feed(e: Ev, turn = 0): void {
    const x = e.data ?? {};
    const at = e.timestamp ? Date.parse(e.timestamp) : NaN;
    const when = Number.isFinite(at) ? at : undefined;
    if (e.type === "user.message") {
      const t = typeof x.content === "string" ? x.content : typeof x.text === "string" ? x.text : "";
      if (t.trim()) this.start(t, turn, when);
      return;
    }
    if (!/^(assistant\.message|tool\.execution_(start|complete))$/.test(e.type ?? "")) return;
    // Work before any prompt: a session picked up from an earlier one.
    const a = this.cur ?? this.start("This session is being continued from a previous conversation.", turn, when);
    if (when) a.last = when;
    switch (e.type) {
      case "assistant.message":
        if (!x.parentToolCallId && typeof x.content === "string" && x.content.trim()) a.said = x.content.trim();
        break;
      case "tool.execution_start": {
        const name = String(x.toolName ?? x.name ?? "");
        const args = x.arguments ?? x.args ?? x.input;
        const cat = catOf(name);
        if (cat === "intent") {
          const intent = typeof args === "string" ? args : args?.intent;
          if (typeof intent === "string" && intent.trim() && a.intents[a.intents.length - 1] !== intent.trim() && a.intents.length < 12) a.intents.push(cut(intent.trim(), 80));
          break;
        }
        if (cat === "plan") break;
        a.tools++;
        let head = name;
        if (cat === "shell") {
          a.commands++;
          head = commandHead(typeof args === "string" ? args : args?.command ?? "") || name;
          a.cmds.set(head, (a.cmds.get(head) ?? 0) + 1);
        } else if (cat === "write") {
          const text = typeof args === "string" ? args : typeof args?.patch === "string" ? args.patch : typeof args?.input === "string" ? args.input : "";
          for (const m of text.matchAll(PATCHED)) a.files.add(m[1].trim());
          for (const p of [args?.path, args?.file_path, args?.filePath]) if (typeof p === "string" && p) a.files.add(p);
          head = `${name} ${baseName(String(args?.path ?? args?.file_path ?? args?.filePath ?? ""))}`.trim();
        } else if (cat === "read") {
          const p = args?.path ?? args?.file_path ?? args?.filePath;
          if (typeof p === "string" && p) a.reads.add(p);
        } else if (cat === "search") a.searches++;
        else if (cat === "web") {
          const u = String(args?.url ?? args?.query ?? args?.q ?? "");
          const host = /^https?:\/\/([^/]+)/.exec(u)?.[1];
          const w = cut(host ?? u, 50);
          if (w && !a.web.includes(w) && a.web.length < 6) a.web.push(w);
        } else if (cat === "agent") {
          const d = args?.description ?? args?.prompt ?? "";
          if (d && a.agents.length < 4) a.agents.push(cut(ONE_LINE(d), 80));
        }
        if (x.toolCallId) a.open.set(String(x.toolCallId), { cat, head });
        break;
      }
      case "tool.execution_complete": {
        const id = String(x.toolCallId ?? "");
        // A tool call can end after the next prompt started; it belongs to its own step.
        let k = this.acc.length - 1;
        while (k >= 0 && !this.acc[k].open.has(id)) k--;
        const owner = k >= 0 ? this.acc[k] : a;
        const t = owner.open.get(id);
        owner.open.delete(id);
        if (!t) break;
        const exit = x.shellExecution?.exitCode;
        const bad = x.success === false || (typeof exit === "number" && exit !== 0);
        owner.lastFailed = bad;
        if (bad) {
          owner.failed++;
          const msg = String(x.error?.message ?? (typeof x.error === "string" ? x.error : "") ?? "") || String(x.result?.content ?? "");
          const lines = msg.replace(/\r/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
          // The line that says what went wrong, not a passing test whose name has "fail" in it.
          const said = lines.filter((l) => !/^(✔|ok\b|√|PASS\b|#\s*(pass|tests|suites)\b)/i.test(l));
          const why = said.find((l) => /^(✖|×|not ok\b|FAIL\b|fatal:|error\b|\w*(Error|Exception)\b)/i.test(l))
            ?? said.find((l) => /error|fail|not found|cannot|can't|denied|exception|invalid|refused|timed? ?out/i.test(l))
            ?? said[0] ?? (typeof exit === "number" ? `exit ${exit}` : "failed");
          const line = `${t.head}: ${cut(why, 140)}`;
          if (owner.failures.length < 3 && !owner.failures.includes(line)) owner.failures.push(line);
        }
        if (k >= 0 && k !== this.acc.length - 1) this.bump(k);
        break;
      }
    }
    this.bump(this.acc.length - 1);
  }

  get total(): number {
    return this.acc.length;
  }

  // Which step a step follows from. A short prompt answers the step before. A longer one
  // follows the step before when they share words (or files it wrote), else the earlier
  // step it shares most with, else it starts a new topic.
  private parentOf(i: number): number {
    if (i === 0) return -1;
    const a = this.acc[i];
    if (a.kind !== "ask" || a.words <= 8) return i - 1;
    // "continue and…", "yes, run it", "1, build…", "do A": an answer to the step before.
    if (FOLLOWS.test(a.prompt.trim())) return i - 1;
    const keyOf = (j: number) => {
      const b = this.acc[j];
      const k = new Set(b.keys);
      for (const f of b.files) k.add(baseName(f).toLowerCase().replace(/\.[^.]+$/, ""));
      return k;
    };
    // The step before, with the steps it follows from on the same line of work.
    const chain = new Set<string>();
    for (let j = i - 1, n = 0; j >= 0 && n < 5; j = this.parentOf0(j), n++) for (const k of keyOf(j)) chain.add(k);
    if (overlap(a.keys, chain) >= 2) return i - 1;
    let best = -1;
    let score = 2;
    for (let j = 0; j < i - 1; j++) {
      const s = overlap(a.keys, keyOf(j));
      if (s > score) { best = j; score = s; }
    }
    return best;
  }
  // parentOf without recursion past one level, for walking a chain cheaply.
  private parents: number[] = [];
  private parentOf0(j: number): number {
    return this.parents[j] ?? j - 1;
  }

  private step(i: number): Step {
    const a = this.acc[i];
    const last = i === this.acc.length - 1;
    const tone: Tone = a.open.size && last ? "run" : a.failed && a.lastFailed ? "bad" : a.failed ? "warn" : a.tools ? "ok" : "talk";
    return {
      i, kind: a.kind, ask: a.ask, parent: this.parents[i] ?? -1, tone,
      ...(a.at ? { at: a.at } : {}), ...(a.at && a.last ? { ms: a.last - a.at } : {}),
      tools: a.tools, commands: a.commands, failed: a.failed, edits: a.files.size, turn: a.turn,
    };
  }
  private settle(): void {
    // A step's parent only depends on the steps before it and its own files, so only
    // the ones not worked out yet, and the latest (still writing files), are redone.
    for (let i = Math.max(0, Math.min(this.parents.length - 1, this.acc.length - 1)); i < this.acc.length; i++) this.parents[i] = this.parentOf(i);
  }

  steps(since = 0): Step[] {
    this.settle();
    const out: Step[] = [];
    for (let i = 0; i < this.acc.length; i++) if (!since || this.changed[i] > since) out.push(this.step(i));
    return out;
  }

  detail(i: number): StepDetail | undefined {
    const a = this.acc[i];
    if (!a) return undefined;
    this.settle();
    const did: string[] = [];
    const list = (xs: string[], n: number) => `${xs.slice(0, n).join(", ")}${xs.length > n ? ` +${xs.length - n}` : ""}`;
    if (a.files.size) did.push(`Edited ${a.files.size === 1 ? "1 file" : `${a.files.size} files`}: ${list([...a.files].reverse().map(baseName), 4)}`);
    if (a.commands) {
      const top = [...a.cmds.entries()].sort((x, y) => y[1] - x[1]).map(([c, n]) => (n > 1 ? `${c} ×${n}` : c));
      did.push(`Ran ${a.commands === 1 ? "1 command" : `${a.commands} commands`}: ${list(top, 4)}`);
    }
    if (a.reads.size || a.searches) did.push([a.reads.size ? `Read ${a.reads.size === 1 ? "1 file" : `${a.reads.size} files`}` : "", a.searches ? `searched ${a.searches === 1 ? "once" : `${a.searches} times`}` : ""].filter(Boolean).join(", ").replace(/^s/, "S"));
    if (a.web.length) did.push(`Looked up ${list(a.web, 3)}`);
    for (const g of a.agents) did.push(`Sent a helper: ${g}`);
    return {
      ...this.step(i),
      prompt: cut(a.prompt, a.kind === "resume" ? 600 : 3000),
      did,
      errors: a.failures,
      said: a.said ? gistOf(a.said, 5) : [],
      intents: a.intents,
      files: [...a.files].reverse().slice(0, 40),
    };
  }
}

export function story(events: Ev[]): StoryFold {
  const s = new StoryFold();
  const talk = new TalkFold();
  for (const e of events) {
    s.feed(e, talk.turns.length);
    talk.feed(e);
  }
  return s;
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
export type StoryChanges = { epoch: string; v: number; total: number; steps: Step[] };

// Copilot appends to a session's file as it works, and the file grows to megabytes. A
// follower remembers how far it read and reads only what was added, so the desk can look
// several times a second without parsing the whole session again.
export class SessionFollow {
  readonly epoch = Math.random().toString(36).slice(2, 10);
  private offset = 0;
  private talk = new TalkFold();
  private sum = new SummaryFold();
  private tale = new StoryFold();
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
  get storyV(): number {
    return this.tale.v;
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
    this.tale.feed(ev, this.talk.turns.length);
    this.talk.feed(ev);
    this.sum.feed(ev);
    this.events++;
    return true;
  }

  summarize(): Summary {
    if (this.summary?.v !== this.events) this.summary = { v: this.events, value: withStory(this.sum.result(), this.tale) };
    return this.summary.value;
  }

  // The session as steps, one per prompt: all of them on the first look (since 0), then
  // only the ones that changed after version `since`.
  story(since = 0): StoryChanges {
    return { epoch: this.epoch, v: this.tale.v, total: this.tale.total, steps: this.tale.steps(since) };
  }
  step(i: number): StepDetail | undefined {
    return this.tale.detail(i);
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
