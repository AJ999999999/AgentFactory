// Turn agents: what does one bounded slice of work. The harness only sees this
// interface, so a scripted agent (tests, demos) and Copilot CLI are interchangeable.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RunError } from "../proc.ts";
import { spawnCommand } from "../proc.ts";
import type { Belief, State, TodoState } from "./project.ts";
import type { SeatView, ToolConfig } from "./team.ts";
import { REVIEW_LANE, toolFlags } from "./team.ts";
import type { Finding, GoalDef } from "./types.ts";
import type { TurnOutput } from "./validate.ts";


export type TurnContext = {
  turn: string;
  agent: string; // runner id
  now: number;
  packet: string;
  todo: TodoState;
  goal: GoalDef;
  beliefs: Belief[];
  findings: Finding[]; // evidence on what this todo tests or assumes
  wtDir: string; // write files here, inside the todo's write scope
  state: State; // read-only view, for scripted agents and debugging
  seat?: SeatView; // who does this lane: role, model, skills, effective permissions
  log?: (...lines: string[]) => void; // the turn's live log, which the panel shows
  signal?: AbortSignal; // aborted when the partner stops the turn, or it times out
  // Worker mode (modes.ts): one worker agent, given the lane's skill instead of a role.
  skill?: { name: string; text: string };
  // Session mode (modes.ts): the CLI session this turn continues, when the CLI can resume.
  session?: { id: string; scope: "todo" | "goal"; turn: number; resumed: boolean; dir: string };
};

export interface TurnAgent {
  name: string;
  run(ctx: TurnContext): Promise<TurnOutput>;
}

export type Behavior = { name: string; when: (ctx: TurnContext) => boolean; run: (ctx: TurnContext) => TurnOutput | Promise<TurnOutput> };

// Behaviors are tried in order; the first match handles the turn.
export class ScriptedTurnAgent implements TurnAgent {
  name = "scripted";
  behaviors: Behavior[];
  calls: Array<{ todo: string; lane: string; behavior: string; at: number; packet: string; seat?: string; role?: string; probation?: boolean }> = [];
  constructor(behaviors: Behavior[]) {
    this.behaviors = behaviors;
  }
  async run(ctx: TurnContext): Promise<TurnOutput> {
    const b = this.behaviors.find((x) => x.when(ctx));
    this.calls.push({ todo: ctx.todo.id, lane: ctx.todo.lane, behavior: b?.name ?? "none", at: ctx.now, packet: ctx.packet, seat: ctx.seat?.key, role: ctx.seat?.role, probation: ctx.seat?.probation });
    if (!b) return { note: `no scripted behavior for ${ctx.todo.id}` };
    return b.run(ctx);
  }
}

// Copilot CLI, headless, one fresh session per turn in the turn's worktree. The seat
// decides who runs it: the role's custom agent (a generated role uses the fallback
// agent with its charter in the prompt), the role's model, and tool flags from the
// seat's catalog permissions. Without a team, each lane maps to a custom agent and a
// model as before.
//
// Checked against Copilot CLI 1.0.105 on Windows.
export type LaneConfig = { agent: string; model: string };

// What every agent is told, whichever CLI runs it: the handoff packet, the role, and the
// one JSON object to end with.
export function turnPrompt(ctx: TurnContext): string {
  const seat = ctx.seat;
  const probation = seat?.probation ? ["You're on probation: an independent reviewer checks your finished work before it counts."] : [];
  const role = !seat ? [] : ctx.skill ? [
    `You are this engagement's worker. This todo is ${ctx.todo.lane} work: use the ${ctx.skill.name} skill.`,
    `Skill (${ctx.skill.name}):`,
    ...ctx.skill.text.split("\n"),
    ...probation,
  ] : [
    `Your role: ${seat.role} (${seat.skills.join(", ")}).${seat.charter ? ` ${seat.charter}` : ""}`,
    ...probation,
  ];
  const review = ctx.todo.lane === REVIEW_LANE ? [`This is a review: include "verdict": "accept" or "reject" in the JSON, and say why in "note".`] : [];
  // A resumed session remembers its earlier turns, but each turn starts in a fresh
  // checkout: say what carried over and what didn't.
  const continuing = ctx.session?.resumed ? [
    `This continues your session on this ${ctx.session.scope} (turn ${ctx.session.turn}). Your working directory is a fresh checkout: what the harness accepted from your earlier turns is in it, and anything that isn't was thrown away. The packet above is the current truth.`,
  ] : [];
  return [
    ctx.packet,
    ...role,
    ...continuing,
    "",
    ...review,
    "Do one bounded piece of this todo now, then stop. Write files only inside the scope above.",
    "Finish with ONE JSON object on the last lines, nothing after it:",
    `{"done": bool, "blocker": "why you can't continue" | null, "note": "<= 280 chars for whoever picks this up next",`,
    ` "findings": [{"assumption": "id", "direction": "supports|refutes|neutral", "grade": "opinion|reported", "source": "url or repo:path", "text": "...", "metrics": {}}],`,
    ` "todos": [{"lane": "...", "text": "...", "tests": "assumption id", "because": "finding/ask/todo id", "kind": "task|job|wait|action", "writeScope": []}],`,
    ` "asks": [{"question": "...", "options": [{"id": "...", "label": "..."}]}],`,
    ` "supersede": [{"todo": "id", "reason": "..."}], "discount": [{"finding": "id", "reason": "..."}]}`,
    "Rules: every todo needs a reason to exist (tests or because). You can't record measured, behavioral, stated or expert evidence; propose a job, wait or action that produces it.",
    "A blocker stops the work and asks a person. Set it only when you can't go on without them. If the todo is done, say done: true and put any doubts in the note.",
  ].join("\n");
}

// The environment every agent process runs with. It knows it's inside a turn, so the
// partner's tools (and any MCP server it starts) refuse to serve it. And `git push` to the
// engagement's remote goes nowhere: the harness alone merges a turn's work, after checking
// it. Git reads this extra config from GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n. It's a
// backstop for CLIs that can't limit commands; a push to a URL typed out in full isn't
// covered, which the CLIs' own limits (deny lists, the sandbox, the gate) are for.
export const PARTNER_SERVER = "agentfactory";
export function turnEnv(ctx: Pick<TurnContext, "turn">, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const n = Number(base.GIT_CONFIG_COUNT ?? 0) || 0;
  const env: NodeJS.ProcessEnv = { ...base, AF_TURN: ctx.turn, GIT_TERMINAL_PROMPT: "0" };
  ["origin", "upstream"].forEach((remote, i) => {
    env[`GIT_CONFIG_KEY_${n + i}`] = `remote.${remote}.pushurl`;
    env[`GIT_CONFIG_VALUE_${n + i}`] = "agentfactory-turns-cannot-push:";
  });
  env.GIT_CONFIG_COUNT = String(n + 2);
  return env;
}

// The CLIs a seat can run in besides Copilot: "models": { "model-b": "claude:opus" },
// "codex:", "pi:<provider/model>", "omp:<model>". Anything else is a Copilot model id.
export const VENDORS = ["claude", "codex", "pi", "omp"] as const;
export function vendorOfModel(mapped: string | undefined): string {
  const m = (mapped ?? "").match(/^([a-z]+):/);
  return m && (VENDORS as readonly string[]).includes(m[1]) ? m[1] : "copilot";
}

// Where Copilot CLI looks for your own custom agent profiles.
export function userAgentsDir(env: Record<string, string | undefined> = process.env): string {
  return env.COPILOT_HOME ? path.join(env.COPILOT_HOME, "agents") : path.join(os.homedir(), ".copilot", "agents");
}

export class CopilotTurnAgent implements TurnAgent {
  name = "copilot-cli";
  bin: string;
  lanes: Record<string, LaneConfig>;
  fallback: LaneConfig;
  agents: Record<string, string>; // role -> custom agent profile name, when it isn't <prefix><role>
  prefix: string;
  profileDirs: string[] | null; // where profiles are looked for; null = don't check
  models: Record<string, string>; // placeholder (model-a) -> your plan's model id
  tools: ToolConfig;
  timeoutMs: number;
  constructor(opts: { bin?: string; lanes?: Record<string, LaneConfig>; fallback: LaneConfig; agents?: Record<string, string>; profilePrefix?: string; profileDirs?: string[] | null; models?: Record<string, string>; tools?: ToolConfig; timeoutMs: number }) {
    this.models = opts.models ?? {};
    this.bin = opts.bin ?? "copilot";
    this.lanes = opts.lanes ?? {};
    this.fallback = opts.fallback;
    this.agents = opts.agents ?? {};
    this.prefix = opts.profilePrefix ?? "af-";
    this.profileDirs = opts.profileDirs === undefined ? [userAgentsDir()] : opts.profileDirs;
    this.tools = opts.tools ?? { always: DEFAULT_ALWAYS };
    this.timeoutMs = opts.timeoutMs;
  }

  // The seat's profile, if it's installed (your user folder or the repo's .github/agents).
  // A missing profile mustn't fail every turn: the turn then runs without --agent, with
  // the role in the prompt.
  profile(seat: SeatView, wtDir: string): string | undefined {
    const name = this.agents[seat.role] ?? `${this.prefix}${seat.generated ? this.fallback.agent : seat.agent}`;
    if (!this.profileDirs) return name;
    const dirs = [...this.profileDirs, path.join(wtDir, ".github", "agents")];
    return dirs.some((d) => fs.existsSync(path.join(d, `${name}.agent.md`)) || fs.existsSync(path.join(d, `${name}.md`))) ? name : undefined;
  }

  prompt(ctx: TurnContext): string {
    return turnPrompt(ctx);
  }

  // Which custom agent, model and tools this turn gets.
  launch(ctx: TurnContext): { agent?: string; model?: string; flags: string[] } {
    const seat = ctx.seat;
    if (seat) return { agent: this.profile(seat, ctx.wtDir), model: this.model(seat.model), flags: toolFlags(seat.effective, this.tools) };
    const lane = this.lanes[ctx.todo.lane] ?? this.fallback;
    return { agent: lane.agent, model: this.model(lane.model), flags: ["--allow-tool", "write", ...(this.tools.always ?? DEFAULT_ALWAYS)] };
  }

  // A placeholder model name (model-a) that isn't mapped to a real one is left out, so
  // Copilot uses its default rather than failing every turn on an unknown model.
  model(name: string): string | undefined {
    return this.models[name] || (/^model-[a-z]$/.test(name) ? undefined : name);
  }

  async run(ctx: TurnContext): Promise<TurnOutput> {
    const l = this.launch(ctx);
    const prompt = this.prompt(ctx);
    // JSON output streams one event per line: what the agent is doing (for the log the
    // panel shows), its messages (the reply), the model that ran and any errors.
    // The partner's own MCP server is never a turn's tool, even if it's in your user config.
    // A session id resumes that session (Copilot keeps it whatever the working directory),
    // or starts it on the first turn.
    // Your own Copilot setup stays out of the turn: no custom instructions (yours or a
    // repo's AGENTS.md) and no skills, which in a real run took over most turns (a personal
    // skill insisted on "ownership confirmation" and refused to edit). The seat's profile
    // and the prompt are the turn's instructions.
    const args = ["-p", prompt, ...(l.agent ? ["--agent", l.agent] : []), ...(l.model ? ["--model", l.model] : []), ...(ctx.session ? ["--session-id", ctx.session.id] : []), "--output-format", "json", "--no-ask-user", "--no-custom-instructions", "--excluded-tools", "skill", "--disable-mcp-server", PARTNER_SERVER, ...l.flags];
    const say = ctx.log ?? (() => {});
    if (ctx.session) say(`session ${ctx.session.id} (${ctx.session.scope}, turn ${ctx.session.turn}${ctx.session.resumed ? ", resumed" : ", new"})`);
    const named = (flag: string) => l.flags.flatMap((f, i) => (l.flags[i - 1] === flag ? [f] : []));
    say(`copilot${l.agent ? ` --agent ${l.agent}` : ""}${l.model ? ` --model ${l.model}` : ""}`, `allowed: ${named("--allow-tool").join(", ") || "-"}`, `denied: ${named("--deny-tool").join(", ") || "-"}`);
    say("--- prompt ---", ...prompt.split("\n"), "--- work ---");
    const stream = new CopilotStream(say, ctx.now);
    // A usage limit or a dead connection reported mid-run ends the turn at once, as a wait.
    const own = new AbortController();
    ctx.signal?.addEventListener("abort", () => own.abort(), { once: true });
    stream.onLimit = () => own.abort();
    let stdout: string;
    try {
      ({ stdout } = await spawnCommand(this.bin, args, { cwd: ctx.wtDir, env: turnEnv(ctx), timeout: this.timeoutMs, maxBuffer: 32 * 1024 * 1024, signal: own.signal, onStdout: (s) => stream.feed(s), onStderr: (s) => stream.stderr(s) }));
    } catch (e) {
      stream.end();
      const x = e as RunError;
      if (x.stopped) {
        const limit = ctx.signal?.aborted ? null : stream.capacity();
        if (limit) throw CapacityError.of(limit, "copilot");
        throw new StoppedError();
      }
      const lost = stream.capacity();
      if (lost) throw CapacityError.of(lost, "copilot");
      // Only Copilot's own errors are read: never the prompt, the instructions of its MCP
      // servers or event ids (which contain digits like 429). Plain-text output from an
      // older CLI is read from its start.
      const cap = classifyCapacity(`${x.stderr ?? ""}\n${stream.errors()}${stream.events ? "" : `\n${(x.stdout ?? "").slice(0, 2000)}`}`, ctx.now);
      if (cap) throw new CapacityError(cap.reason, cap.resetAt, "copilot");
      throw new Error(`${x.message.split("\n")[0]}${stream.errors() ? `: ${stream.errors().slice(0, 240)}` : x.stderr ? `: ${x.stderr.trim().slice(0, 240)}` : ""}`);
    }
    stream.end();
    const reply = stream.events ? stream.reply() : stdout;
    try {
      return parseTurnOutput(reply);
    } catch (e) {
      // Exit 0 with a refusal in place of a reply.
      const cap = classifyCapacity(`${stream.errors()}${stream.events ? "" : reply.length < 2000 ? `\n${reply}` : ""}`, ctx.now);
      if (cap) throw new CapacityError(cap.reason, cap.resetAt, "copilot");
      throw new Error(`${(e as Error).message}${reply.trim() ? ` (reply ended: ${reply.trim().slice(-160)})` : " (no reply)"}`);
    }
  }
}

// The partner stopped this turn from the panel.
export class StoppedError extends Error {
  constructor() {
    super("stopped by the partner");
  }
}

// Reads Copilot CLI's JSON output (one event per line) as it arrives: a short line per
// step for the log, the assistant's messages for the reply, and the errors. Lines that
// aren't events (an older CLI printing text) are passed through as they are.
export class CopilotStream {
  events = 0;
  model = "";
  private buf = "";
  private messages: string[] = [];
  private errs: string[] = [];
  private say: (...lines: string[]) => void;
  private now: number;
  private limited: Capacity | null = null;
  private conn = new ConnectionWatch();
  onLimit?: () => void; // called when Copilot reports a limit, or can't reach its service, mid-run
  constructor(say: (...lines: string[]) => void, now = Date.now()) {
    this.say = say;
    this.now = now;
  }

  // What ended the turn early, if anything: a limit, or a connection that kept failing.
  capacity(): Capacity | null {
    return this.limited ?? this.conn.result();
  }

  feed(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      this.line(this.buf.slice(0, i).replace(/\r$/, ""));
      this.buf = this.buf.slice(i + 1);
    }
  }

  stderr(chunk: string): void {
    for (const l of chunk.split(/\r?\n/).filter((x) => x.trim())) this.say(`stderr: ${l.slice(0, 400)}`);
  }

  end(): void {
    if (this.buf) this.line(this.buf);
    this.buf = "";
  }

  reply(): string {
    return this.messages.join("\n");
  }

  errors(): string {
    return this.errs.join("\n");
  }

  private line(l: string): void {
    if (!l.trim()) return;
    let e: { type?: unknown; data?: Record<string, unknown> } | null = null;
    if (l.startsWith("{")) {
      try {
        e = JSON.parse(l);
      } catch {
        /* text */
      }
    }
    if (!e || typeof e.type !== "string") {
      this.say(l.slice(0, 400));
      return;
    }
    this.events++;
    const d = (e.data ?? {}) as Record<string, any>;
    const short = (v: unknown, n = 160) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
    switch (e.type) {
      case "session.auto_mode_resolved":
        this.model = String(d.chosenModel ?? "");
        this.say(`model: ${this.model} (picked by Copilot from ${Array.isArray(d.availableModels) ? d.availableModels.join(", ") : "its list"})`);
        return;
      case "session.tools_updated":
        if (d.model && d.model !== this.model) {
          this.model = String(d.model);
          this.say(`model: ${this.model}`);
        }
        return;
      case "tool.execution_start": {
        const a = d.arguments;
        const what = typeof a === "string"
          ? [...a.matchAll(/\*\*\* (?:Add|Update|Delete) File: (.+)/g)].map((m) => m[1].trim()).join(", ") || short(a, 120)
          : short(a?.command ?? a?.path ?? a?.url ?? JSON.stringify(a ?? {}), 160);
        this.say(`→ ${d.toolTitle ?? d.toolName}${what ? `: ${what}` : ""}`);
        return;
      }
      case "tool.execution_complete": {
        const exit = d.shellExecution?.exitCode;
        if (d.success === false) this.say(`  ✗ ${d.toolName ?? "tool"}: ${short(d.error?.message ?? d.result?.content ?? d.error, 240)}`);
        else if (typeof exit === "number" && exit !== 0) this.say(`  exit ${exit}`);
        return;
      }
      case "assistant.message": {
        const text = typeof d.content === "string" ? d.content : "";
        if (!text.trim()) return;
        this.messages.push(text);
        const lines = text.split(/\r?\n/);
        this.say(...lines.slice(0, 40).map((x) => `  ${x}`), ...(lines.length > 40 ? [`  … ${lines.length - 40} more lines`] : []));
        return;
      }
      case "model.call_final_result":
        if (d.result && d.result !== "success") this.error(`model call ${d.result}${d.error ? `: ${short(d.error?.message ?? d.error, 300)}` : ""}${d.message ? `: ${short(d.message, 300)}` : ""}`);
        return;
      case "result": {
        const u = (e as { usage?: Record<string, unknown> }).usage ?? {};
        const code = (e as { exitCode?: unknown }).exitCode;
        this.say(`result: exit ${code ?? "?"}${u.premiumRequests !== undefined ? `, ${u.premiumRequests} premium request${u.premiumRequests === 1 ? "" : "s"}` : ""}${typeof u.sessionDurationMs === "number" ? `, ${Math.round(u.sessionDurationMs / 1000)}s` : ""}`);
        return;
      }
      default:
        // Errors and warnings by whatever name this version gives them.
        if (/error|warning|limit|quota|throttl/i.test(e.type)) this.error(`${e.type}: ${short(d.message ?? d.error?.message ?? d.error ?? JSON.stringify(d), 300)}`);
    }
  }

  private error(text: string): void {
    this.errs.push(text);
    this.say(`! ${text}`);
    if (!this.limited) this.limited = classifyCapacity(text, this.now);
    if (this.limited || this.conn.see(text)) this.onLimit?.();
  }
}

// ---------- routing ----------

// Sends each seat to the CLI its model maps to ("claude:", "codex:", "pi:", "omp:"),
// anything else to Copilot. A usage limit names the seats that wait: only those on that
// vendor.
export class TurnRouter implements TurnAgent {
  name = "router";
  copilot: CopilotTurnAgent;
  others: Record<string, TurnAgent>;
  constructor(copilot: CopilotTurnAgent, others: Record<string, TurnAgent | null> = {}) {
    this.copilot = copilot;
    this.others = Object.fromEntries(Object.entries(others).filter(([, a]) => a)) as Record<string, TurnAgent>;
  }

  vendorOf(placeholder: string): string {
    return vendorOfModel(this.copilot.models[placeholder]);
  }

  vendor(ctx: TurnContext): string {
    const lane = this.copilot.lanes[ctx.todo.lane] ?? this.copilot.fallback;
    return this.vendorOf(ctx.seat?.model ?? lane.model);
  }

  async run(ctx: TurnContext): Promise<TurnOutput> {
    const v = this.vendor(ctx);
    try {
      if (v !== "copilot") {
        const a = this.others[v];
        if (!a) throw new Error(`this seat's model maps to ${v}: but ${v} isn't set up here (policy/harness-agents.json "cli")`);
        return await a.run(ctx);
      }
      return await this.copilot.run(ctx);
    } catch (e) {
      let err = e;
      // A CLI that can't start as configured: the vendor waits rather than failing every todo.
      if (!(err instanceof CapacityError) && !(err instanceof StoppedError) && err instanceof Error) {
        const setup = classifySetup(err.message);
        if (setup) err = CapacityError.of(setup, v);
      }
      if (err instanceof CapacityError) {
        // Placeholders the library uses that route to the same vendor, and the one this seat used.
        const known = new Set([...Object.keys(this.copilot.models), ctx.seat?.model ?? ""].filter(Boolean));
        err.models = [...known].filter((m) => this.vendorOf(m) === v);
      }
      throw err;
    }
  }
}

// The model service refused for now (a usage limit, a rate limit, a spent quota). It is
// not a failure of the work: the harness waits and tries the same work again.
//
// Three kinds, each waited out on its own schedule:
//   limit        a usage or rate limit: wait for the reset it names
//   unreachable  the service (or a local gateway) can't be reached: retry soon
//   setup        the CLI can't start the turn as configured (a profile it can't load, a
//                flag it doesn't know, signed out): retry after a while; someone has to fix it
// None of them is a failure of the work, so no turn is counted against the todo.
export type CapacityKind = "limit" | "unreachable" | "setup";
export type Capacity = { reason: string; resetAt?: number; kind?: CapacityKind };

export class CapacityError extends Error {
  resetAt?: number; // when the service says it's back, if it says
  vendor: string; // whose limit: "copilot", "claude"
  models?: string[]; // the model placeholders that route to that vendor and wait; unset = all
  kind: CapacityKind;
  constructor(reason: string, resetAt: number | undefined, vendor: string, models?: string[], kind: CapacityKind = "limit") {
    super(reason);
    this.resetAt = resetAt;
    this.vendor = vendor;
    this.models = models;
    this.kind = kind;
  }
  static of(c: Capacity, vendor: string): CapacityError {
    return new CapacityError(c.reason, c.resetAt, vendor, undefined, c.kind ?? "limit");
  }
}

// A CLI that can't reach its service says so and keeps retrying: Codex logged
// "Reconnecting... waiting for network" every 73 seconds for an hour when the owner's
// local gateway stopped, and the turn then counted as failed work. Read only the CLI's own
// errors with this, never tool output (a test the agent runs may well print ECONNREFUSED).
const UNREACHABLE = /reconnecting|waiting for network|connection (?:failed|refused|reset|timed out|error)|error sending request|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|network is unreachable|socket hang up|fetch failed|getaddrinfo/i;
export const UNREACHABLE_AFTER = 3; // this many of the CLI's own connection errors end the turn

export function classifyUnreachable(text: string): Capacity | null {
  const line = text.split(/\r?\n/).find((l) => UNREACHABLE.test(l));
  return line ? { reason: `can't reach the service: ${line.replace(/\s+/g, " ").trim().slice(0, 140)}`, kind: "unreachable" } : null;
}

// Counts the CLI's own connection errors over a turn.
export class ConnectionWatch {
  hits = 0;
  first: Capacity | null = null;
  // True once the turn should end.
  see(text: string): boolean {
    const c = classifyUnreachable(text);
    if (!c) return false;
    this.hits++;
    this.first ??= c;
    return this.hits >= UNREACHABLE_AFTER;
  }
  result(): Capacity | null {
    return this.hits >= UNREACHABLE_AFTER && this.first ? { ...this.first, reason: `${this.first.reason} (${this.hits} times)` } : null;
  }
}

// The CLI couldn't start the turn as it's set up. Retrying every todo against it only burns
// their retries (Copilot refused a malformed agent profile on every data-lane turn), so the
// vendor waits instead and the reason shows in status and the panel.
const SETUP = /failed to load|frontmatter is malformed|malformed (?:front ?matter|yaml)|unknown (?:option|flag|argument)|unexpected argument|unrecognized (?:option|argument)|not (?:logged|signed) in|please (?:log|sign) in|login required|is not recognized as an internal or external command|spawn \S+ ENOENT|command not found/i;
export function classifySetup(text: string): Capacity | null {
  const line = text.split(/\r?\n/).find((l) => SETUP.test(l));
  return line ? { reason: `setup: ${line.replace(/\s+/g, " ").trim().slice(0, 160)}`, kind: "setup" } : null;
}

const CAPACITY = /rate[-_ ]?limit|too many requests|\b(?:http|status|code|error)\W{0,3}429\b|\b429\s+too many|quota|usage limit|premium requests?|out of (?:credits|requests)|exceeded (?:your|the) (?:\w+ )?(?:limit|allowance)|limit (?:has been )?(?:reached|exceeded)|hit (?:your|the) (?:\w+ )?limit|insufficient credits/i;
const UNITS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 };

// Does this text from the CLI say "capacity"? And when does it say it's back? Reads
// "try again in 2 hours 5 minutes", "retry after 90 seconds", "Retry-After: 120",
// "resets at 2026-11-01T00:00:00Z" or "resets on Nov 1, 2026". Text it can't read a time
// from still counts; the harness then backs off by its own schedule.
export function classifyCapacity(text: string, now: number): { reason: string; resetAt?: number } | null {
  const m = text.match(CAPACITY);
  if (!m) return null;
  const line = text.split(/\r?\n/).find((l) => CAPACITY.test(l)) ?? m[0];
  const reason = line.replace(/\s+/g, " ").trim().slice(0, 160);
  let resetAt: number | undefined;
  const retryAfter = text.match(/retry-after\W+(\d+)\b/i);
  const iso = text.match(/(?:reset|resets|until|after|at)\W+(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)/i);
  const dur = text.match(/(?:in|after|within)\s+((?:\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b\s*(?:and\s+|,\s*)?)+)/i);
  // A calendar date, with or without a time: "resets on Nov 1", "try again at Nov 17th,
  // 2026 10:18 PM" (Codex). Read where this machine is.
  const date = text.match(/(?:resets?|try again|available again)\s+(?:on\s+|at\s+|after\s+)?([A-Z][a-z]{2,8})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?(?:,?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?)?/i);
  // Claude Code: "usage limit reached|1793426400" (seconds) or "resets 5pm", "resets at 3:30 PM".
  const epoch = text.match(/limit[^|\n]{0,40}\|(\d{10})\b/i);
  const clock = text.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\b/i);
  const onDate = date ? (() => {
    const [, mon, day, year, hh, mm, ap] = date;
    const h = hh ? (Number(hh) % 12) + (ap.toLowerCase() === "p" ? 12 : 0) : 0;
    const d = new Date(`${mon} ${day}, ${year ?? new Date(now).getFullYear()} 00:00:00`);
    if (Number.isNaN(d.getTime())) return undefined;
    d.setHours(h, Number(mm ?? 0), 0, 0);
    return d.getTime() > now ? d.getTime() : undefined;
  })() : undefined;
  if (retryAfter) resetAt = now + Number(retryAfter[1]) * 1000;
  else if (epoch) resetAt = Number(epoch[1]) * 1000;
  else if (iso && !Number.isNaN(Date.parse(iso[1]))) resetAt = Date.parse(iso[1]);
  else if (onDate !== undefined) resetAt = onDate;
  else if (dur) {
    let ms = 0;
    for (const p of dur[1].matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/gi)) ms += Number(p[1]) * UNITS[p[2].toLowerCase()];
    if (ms > 0) resetAt = now + ms;
  } else if (clock) {
    // The next time the clock shows that, where this machine is.
    const d = new Date(now);
    d.setHours((Number(clock[1]) % 12) + (clock[3].toLowerCase() === "p" ? 12 : 0), Number(clock[2] ?? 0), 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    resetAt = d.getTime();
  }
  return { reason, ...(resetAt !== undefined ? { resetAt } : {}) };
}

// Every turn may look at its own changes and may not commit, push or delete.
export const DEFAULT_ALWAYS = [
  "--allow-tool", "shell(git status)", "--allow-tool", "shell(git diff:*)",
  "--deny-tool", "shell(git push)", "--deny-tool", "shell(git commit:*)", "--deny-tool", "shell(rm:*)",
];

// The last top-level JSON object in the reply: the earliest "{" from which the text
// up to the final "}" parses (braces inside strings make counting unreliable).
export function parseTurnOutput(text: string): TurnOutput {
  const end = text.lastIndexOf("}");
  if (end < 0) throw new Error("agent reply has no JSON object");
  for (let i = text.indexOf("{"); i >= 0 && i < end; i = text.indexOf("{", i + 1)) {
    try {
      const v = JSON.parse(text.slice(i, end + 1));
      if (v && typeof v === "object" && !Array.isArray(v)) return v as TurnOutput;
    } catch {
      /* not this one */
    }
  }
  throw new Error("no parseable JSON object at the end of the agent reply");
}
