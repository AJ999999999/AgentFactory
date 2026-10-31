// Turn agents for the CLIs other than Copilot: Claude Code, Codex, pi and omp. A seat runs
// in one of them when its model maps to "<cli>:<model>" in policy/harness-agents.json
// ("claude:opus", "codex:", "pi:anthropic/claude-sonnet", "omp:opus"); the router in
// agents.ts sends it here.
//
// Every one gets the same prompt as Copilot (turnPrompt), the role's profile as its
// standing instructions, and only what the permission catalog grants the seat, enforced
// the strongest way that CLI allows:
//   claude  allowed and disallowed tools; anything else refused, never asked
//   codex   its OS sandbox: read-only, or writes only inside the worktree with .git
//           protected and no network unless granted. It runs any command inside that.
//   pi/omp  the turn gate extension (integrations/pi/turn-gate.ts): the seat's tools, its
//           commands one at a time, writes in the write scope, nothing outside the worktree
// None of them loads your own settings, MCP servers, plugins, skills or saved sessions
// where the CLI lets that be switched off.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RunError } from "../proc.ts";
import { spawnCommand } from "../proc.ts";
import type { LaneConfig, TurnAgent, TurnContext } from "./agents.ts";
import { CapacityError, StoppedError, classifyCapacity, parseTurnOutput, turnEnv, turnPrompt } from "./agents.ts";
import type { TurnOutput } from "./validate.ts";

export const GATE = path.resolve(import.meta.dirname, "..", "..", "integrations", "pi", "turn-gate.ts");

// What a seat's catalog permissions become in one CLI. Keys of `tools` and `commands` are
// catalog permissions ("repo:write:lease" stands for every repo:write:*); "always" in
// `commands` is given to every seat.
export type VendorConfig = {
  bin?: string;
  tools?: Record<string, string[]>; // permission -> tool names (claude, pi, omp) or -c settings (codex)
  always?: string[]; // tools every seat gets (claude)
  deny?: string[]; // tools no seat gets (claude)
  noWrite?: string[]; // tools a seat that can't write loses (claude)
  read?: string[]; // reading tools (pi, omp)
  write?: string[]; // writing tools, for seats that may write (pi, omp)
  shell?: string[]; // shell tools, limited to `commands` by the gate (pi, omp)
  commands?: Record<string, string[]>; // permission -> shell commands, "git diff *" for a prefix (pi, omp)
  config?: string[]; // -c settings for every turn (codex)
  windowsConfig?: string[]; // and on Windows (codex)
  userProvider?: boolean; // use the model provider and default model from your own Codex config (codex)
};

// The environment variable a Codex turn gets your provider's token in. Codex leaves
// variables named like *TOKEN* out of the shells it runs, so commands never see it.
export const CODEX_TOKEN_ENV = "AF_CODEX_PROVIDER_TOKEN";

// The model provider your own Codex config uses: its [model_providers.<name>] section and
// your default model. Turns ignore the rest of your config (plugins, MCP servers, hooks),
// but without this they'd quietly use OpenAI's account instead of the provider you set up.
// An inline token is handed over in an environment variable, never on the command line.
export function codexUserProvider(home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex")): { name: string; model?: string; settings: string[]; token?: string } | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(home, "config.toml"), "utf8");
  } catch {
    return null;
  }
  const unq = (v?: string) => v?.trim().replace(/^["']|["']$/g, "");
  let section = "";
  const top: Record<string, string> = {};
  const providers: Record<string, Record<string, string>> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const sec = line.match(/^\[([^\]]+)\]$/);
    if (sec) {
      section = sec[1].trim();
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    if (!section) top[kv[1]] = kv[2].trim();
    const p = section.match(/^model_providers\.["']?([^"']+)["']?$/);
    if (p) (providers[p[1]] ??= {})[kv[1]] = kv[2].trim();
  }
  const name = unq(top.model_provider);
  if (!name || name === "openai" || !providers[name]) return null;
  const settings = [`model_provider="${name}"`];
  let token: string | undefined;
  for (const [k, v] of Object.entries(providers[name])) {
    if (k === "experimental_bearer_token") token = unq(v);
    else settings.push(`model_providers.${name}.${k}=${v}`);
  }
  if (token) settings.push(`model_providers.${name}.env_key="${CODEX_TOKEN_ENV}"`);
  return { name, ...(top.model ? { model: unq(top.model) } : {}), settings, ...(token ? { token } : {}) };
}

export type VendorOptions = { bin?: string; models: Record<string, string>; fallback: LaneConfig; lanes?: Record<string, LaneConfig>; profilePrefix?: string; profileDirs?: string[]; config?: VendorConfig; timeoutMs: number };

export type Seat = { model?: string; role: string; perms: string[]; writes: boolean; scope: string[] };

export interface TurnStream {
  events: number;
  model: string;
  feed(chunk: string): void;
  stderr(chunk: string): void;
  end(): void;
  onLimit?: () => void; // called when the CLI reports a usage limit while it runs
  reply(): string;
  errors(): string;
  capacity(): { reason: string; resetAt?: number } | null;
}

const permKey = (p: string) => (p.startsWith("repo:write:") ? "repo:write:lease" : p);
const short = (v: unknown, n = 160) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

abstract class CliTurnAgent implements TurnAgent {
  abstract name: string;
  abstract vendor: string; // the "<vendor>:" prefix in models
  bin: string;
  models: Record<string, string>;
  fallback: LaneConfig;
  lanes: Record<string, LaneConfig>;
  prefix: string;
  profileDirs: string[];
  cfg: VendorConfig;
  timeoutMs: number;
  constructor(opts: VendorOptions, defaults: VendorConfig) {
    this.cfg = { ...defaults, ...(opts.config ?? {}) };
    this.bin = opts.bin ?? this.cfg.bin ?? defaults.bin!;
    this.models = opts.models;
    this.fallback = opts.fallback;
    this.lanes = opts.lanes ?? {};
    this.prefix = opts.profilePrefix ?? "af-";
    this.profileDirs = opts.profileDirs ?? [];
    this.timeoutMs = opts.timeoutMs;
  }

  // The role's standing instructions: the body of its Copilot profile, so every CLI gets the same.
  charter(role: string): string | undefined {
    for (const d of this.profileDirs) {
      const f = path.join(d, `${this.prefix}${role}.agent.md`);
      if (fs.existsSync(f)) return fs.readFileSync(f, "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
    }
    return undefined;
  }

  seat(ctx: TurnContext): Seat {
    const seat = ctx.seat;
    const lane = seat ? undefined : this.lanes[ctx.todo.lane] ?? this.fallback;
    const mapped = this.models[seat?.model ?? lane!.model] ?? "";
    const p = `${this.vendor}:`;
    const perms = seat ? seat.effective : ["repo:write:lease"];
    return {
      model: mapped.startsWith(p) ? mapped.slice(p.length) || undefined : undefined,
      role: seat ? (seat.generated ? this.fallback.agent : seat.agent) : lane!.agent,
      perms,
      writes: perms.some((x) => x.startsWith("repo:write:")),
      scope: ctx.todo.writeScope ?? [],
    };
  }

  granted(map: Record<string, string[]> | undefined, s: Seat): string[] {
    return [...new Set([...(map?.always ?? []), ...s.perms.flatMap((p) => map?.[permKey(p)] ?? [])])];
  }

  abstract command(ctx: TurnContext, s: Seat, prompt: string): { args: string[]; input?: string; env?: Record<string, string>; header: string[] };
  abstract stream(say: (...lines: string[]) => void, now: number): TurnStream;

  // Whether this CLI can pick a session up again by id from a new worktree.
  resumes = false;
  // Whether this session can be resumed now (Codex: only once it has Codex's own id for it).
  canResume(_ctx: TurnContext): boolean {
    return true;
  }
  // After the CLI ran, with what it printed (Codex: note its id for the session).
  protected finish(_ctx: TurnContext, _stream: TurnStream): void {}

  async run(ctx: TurnContext): Promise<TurnOutput> {
    const say = ctx.log ?? (() => {});
    if (ctx.session && !this.resumes) {
      // Claude Code keeps sessions per folder and omp's can't be named: the turn
      // starts fresh, and its prompt doesn't claim otherwise.
      say(`session: ${this.vendor} can't carry a session across worktrees here; this turn starts fresh`);
      ctx = { ...ctx, session: undefined };
    } else if (ctx.session) {
      if (ctx.session.resumed && !this.canResume(ctx)) ctx = { ...ctx, session: { ...ctx.session, resumed: false } };
      say(`session ${ctx.session!.id} (${ctx.session!.scope}, turn ${ctx.session!.turn}${ctx.session!.resumed ? ", resumed" : ", new"})`);
    }
    const s = this.seat(ctx);
    const prompt = turnPrompt(ctx);
    const c = this.command(ctx, s, prompt);
    say(...c.header);
    say("--- prompt ---", ...prompt.split("\n"), "--- work ---");
    const stream = this.stream(say, ctx.now);
    // A usage limit the CLI reports mid-run ends the turn at once. Codex, answered with a
    // 429, said it would reconnect and then sat silent until the hour-long turn timeout,
    // which then counted as a failure of the work.
    const own = new AbortController();
    const outer = () => own.abort();
    ctx.signal?.addEventListener("abort", outer, { once: true });
    stream.onLimit = () => own.abort();
    try {
      await spawnCommand(this.bin, c.args, { cwd: ctx.wtDir, env: { ...turnEnv(ctx), ...(c.env ?? {}) }, timeout: this.timeoutMs, maxBuffer: 32 * 1024 * 1024, signal: own.signal, input: c.input, onStdout: (x) => stream.feed(x), onStderr: (x) => stream.stderr(x) });
    } catch (e) {
      stream.end();
      this.finish(ctx, stream);
      const x = e as RunError;
      if (x.stopped) {
        // Stopped by its own limit (not by the partner): a wait, not a failure.
        const limit = ctx.signal?.aborted ? null : stream.capacity();
        if (limit) throw new CapacityError(limit.reason, limit.resetAt, this.vendor);
        throw new StoppedError();
      }
      // Only the CLI's own errors are read, never the prompt.
      const cap = stream.capacity() ?? classifyCapacity(`${x.stderr ?? ""}\n${stream.errors()}`, ctx.now);
      if (cap) throw new CapacityError(cap.reason, cap.resetAt, this.vendor);
      throw new Error(`${x.message.split("\n")[0]}${stream.errors() ? `: ${stream.errors().slice(0, 240)}` : x.stderr ? `: ${x.stderr.trim().slice(0, 240)}` : ""}`);
    }
    stream.end();
    this.finish(ctx, stream);
    const cap = stream.capacity();
    if (cap) throw new CapacityError(cap.reason, cap.resetAt, this.vendor);
    const reply = stream.reply();
    try {
      return parseTurnOutput(reply);
    } catch (e) {
      throw new Error(`${(e as Error).message}${stream.errors() ? `: ${stream.errors().slice(0, 200)}` : reply.trim() ? ` (reply ended: ${reply.trim().slice(-160)})` : " (no reply)"}`);
    }
  }
}

// One JSON event per line; lines that aren't events are passed through as text.
abstract class LineStream implements TurnStream {
  events = 0;
  model = "";
  protected say: (...lines: string[]) => void;
  protected now: number;
  protected texts: string[] = [];
  protected errs: string[] = [];
  protected limited: { reason: string; resetAt?: number } | null = null;
  private buf = "";
  constructor(say: (...lines: string[]) => void, now: number) {
    this.say = say;
    this.now = now;
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
    return this.texts.join("\n");
  }
  errors(): string {
    return this.errs.join("\n");
  }
  capacity(): { reason: string; resetAt?: number } | null {
    return this.limited ?? (this.errs.length ? classifyCapacity(this.errors(), this.now) : null);
  }
  protected text(t: string): void {
    if (!t.trim()) return;
    this.texts.push(t);
    const lines = t.split(/\r?\n/);
    this.say(...lines.slice(0, 40).map((x) => `  ${x}`), ...(lines.length > 40 ? [`  … ${lines.length - 40} more lines`] : []));
  }
  onLimit?: () => void;
  protected error(t: string): void {
    this.errs.push(t);
    this.say(`! ${t}`);
    if (this.onLimit && classifyCapacity(t, this.now)) this.onLimit();
  }
  private line(l: string): void {
    if (!l.trim()) return;
    let e: Record<string, any> | null = null;
    try {
      e = JSON.parse(l);
    } catch {
      /* text */
    }
    if (!e || typeof e.type !== "string") return this.say(l.slice(0, 400));
    this.events++;
    this.event(e);
  }
  protected abstract event(e: Record<string, any>): void;
}

// ---------- Claude Code ----------

export const CLAUDE_DEFAULTS: VendorConfig = {
  bin: "claude",
  tools: { "repo:write:lease": ["Edit", "Write"], "shell:test": ["Bash(npm test)", "Bash(npm run build)"], "web:read": ["WebFetch", "WebSearch"] },
  always: ["Read", "Grep", "Glob", "Bash(git status)", "Bash(git diff *)"],
  deny: ["Bash(git push *)", "Bash(git commit *)", "Bash(rm *)"],
  noWrite: ["Edit", "Write", "NotebookEdit"],
};

// Checked against Claude Code 2.1.314 on Windows. The prompt goes in on stdin; --verbose
// is what stream-json needs to print every event.
export class ClaudeCodeTurnAgent extends CliTurnAgent {
  name = "claude-code";
  vendor = "claude";
  constructor(opts: VendorOptions) {
    super(opts, CLAUDE_DEFAULTS);
  }
  launch(ctx: TurnContext): { model?: string; charter?: string; allow: string[]; deny: string[] } {
    const s = this.seat(ctx);
    const deny = [...(this.cfg.deny ?? []), ...(s.writes ? [] : this.cfg.noWrite ?? [])];
    const allow = [...s.perms.flatMap((p) => this.cfg.tools?.[permKey(p)] ?? []), ...(this.cfg.always ?? [])];
    return { model: s.model, charter: this.charter(s.role), allow: [...new Set(allow)].filter((t) => !deny.includes(t)), deny };
  }
  command(ctx: TurnContext, _s: Seat, prompt: string) {
    const l = this.launch(ctx);
    return {
      args: [
        "-p", "--output-format", "stream-json", "--verbose",
        "--permission-mode", "dontAsk", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence",
        ...(l.model ? ["--model", l.model] : []),
        ...(l.charter ? ["--append-system-prompt", l.charter] : []),
        "--allowedTools", ...l.allow,
        "--disallowedTools", ...l.deny,
      ],
      input: prompt,
      header: [`claude${l.model ? ` --model ${l.model}` : ""}`, `allowed: ${l.allow.join(", ") || "-"}`, `denied: ${l.deny.join(", ") || "-"}`],
    };
  }
  stream(say: (...lines: string[]) => void, now: number): ClaudeStream {
    return new ClaudeStream(say, now);
  }
}

// Claude Code's stream-json: the final result is the reply, and its own rate-limit events
// say exactly when a limit resets.
export class ClaudeStream extends LineStream {
  private result: string | null = null;
  private warned = false;
  reply(): string {
    return this.result ?? super.reply();
  }
  capacity(): { reason: string; resetAt?: number } | null {
    return this.limited;
  }
  protected event(e: Record<string, any>): void {
    if (e.type === "system" && e.subtype === "init") {
      this.model = String(e.model ?? "");
      this.say(`model: ${this.model}`);
    } else if (e.type === "system" && e.subtype === "permission_denied") {
      this.say(`  ✗ denied: ${e.tool_name ?? "tool"}${e.message ? ` (${short(e.message)})` : ""}`);
    } else if (e.type === "assistant") {
      for (const c of (e.message?.content ?? []) as Array<Record<string, any>>) {
        if (c.type === "text") this.text(String(c.text ?? ""));
        else if (c.type === "tool_use") {
          const i = c.input ?? {};
          const what = i.command ?? i.file_path ?? i.pattern ?? i.url ?? i.query;
          this.say(`→ ${c.name}${what ? `: ${short(what)}` : ""}`);
        }
      }
    } else if (e.type === "user") {
      for (const c of (e.message?.content ?? []) as Array<Record<string, any>>) {
        if (c.type === "tool_result" && c.is_error && !/^Permission to use/.test(String(c.content ?? ""))) this.say(`  ✗ ${short(typeof c.content === "string" ? c.content : JSON.stringify(c.content), 240)}`);
      }
    } else if (e.type === "rate_limit_event") {
      const r = e.rate_limit_info ?? {};
      const resetAt = typeof r.resetsAt === "number" ? r.resetsAt * 1000 : undefined;
      const when = resetAt ? new Date(resetAt).toISOString() : "?";
      if (r.status === "rejected") {
        this.limited = { reason: `Claude ${r.rateLimitType ?? ""} limit reached`.replace(/\s+/g, " "), ...(resetAt ? { resetAt } : {}) };
        this.say(`! ${this.limited.reason}; resets ${when}`);
        this.onLimit?.();
      } else if (r.status === "allowed_warning" && !this.warned) {
        this.warned = true;
        this.say(`usage: ${r.rateLimitType ?? "plan"} ${Math.round((r.utilization ?? 0) * 100)}% used, resets ${when}`);
      }
    } else if (e.type === "result") {
      if (typeof e.result === "string") this.result = e.result;
      if (e.is_error) {
        this.errs.push(short(`${e.subtype}${e.api_error_status ? ` (HTTP ${e.api_error_status})` : ""}: ${e.result ?? ""}`, 300));
        if (!this.limited) this.limited = classifyCapacity(`${e.api_error_status === 429 ? "HTTP 429 " : ""}${e.result ?? ""}`, this.now);
      }
      this.say(`result: ${e.subtype}${e.num_turns !== undefined ? `, ${e.num_turns} steps` : ""}${typeof e.total_cost_usd === "number" ? `, $${e.total_cost_usd.toFixed(4)} at API prices` : ""}${typeof e.duration_ms === "number" ? `, ${Math.round(e.duration_ms / 1000)}s` : ""}`);
    }
  }
}

// ---------- Codex ----------

export const CODEX_DEFAULTS: VendorConfig = {
  bin: "codex",
  // Web reads open the sandbox's network for that seat.
  tools: { "web:read": ["sandbox_workspace_write.network_access=true", 'web_search="live"'] },
  config: [],
  // --ignore-user-config drops your [windows] sandbox setting too, and without it Codex
  // treats workspace-write as read-only on Windows.
  windowsConfig: ['windows.sandbox="elevated"'],
  userProvider: true,
};

// Checked against Codex CLI 0.166.0 on Windows. Codex has no instructions flag, so the
// role's profile leads the prompt, which goes in on stdin.
//
// Sessions: Codex names a session itself (the thread id it prints first), so the first
// turn of a session runs normally but kept on disk, its thread id is noted against the
// harness's session id, and later turns run `codex exec resume <thread>`. A resumed
// session works in the folder it's started from, the new worktree, and its sandbox
// follows that folder. Without a session, turns leave nothing on disk (--ephemeral).
export class CodexTurnAgent extends CliTurnAgent {
  name = "codex-cli";
  vendor = "codex";
  resumes = true;
  constructor(opts: VendorOptions) {
    super(opts, CODEX_DEFAULTS);
  }
  private threads(dir: string): Record<string, string> {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, "codex-threads.json"), "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  }
  canResume(ctx: TurnContext): boolean {
    return !!ctx.session && !!this.threads(ctx.session.dir)[ctx.session.id];
  }
  protected finish(ctx: TurnContext, stream: TurnStream): void {
    const thread = (stream as CodexStream).thread;
    if (!ctx.session || !thread) return;
    const t = this.threads(ctx.session.dir);
    if (t[ctx.session.id] === thread) return;
    t[ctx.session.id] = thread;
    fs.mkdirSync(ctx.session.dir, { recursive: true });
    fs.writeFileSync(path.join(ctx.session.dir, "codex-threads.json"), JSON.stringify(t, null, 2));
  }
  command(ctx: TurnContext, s: Seat, prompt: string) {
    const sandbox = s.writes ? "workspace-write" : "read-only";
    const settings = [...(this.cfg.config ?? []), ...(process.platform === "win32" ? this.cfg.windowsConfig ?? [] : []), ...s.perms.flatMap((p) => this.cfg.tools?.[permKey(p)] ?? [])];
    const charter = this.charter(s.role);
    const thread = ctx.session?.resumed ? this.threads(ctx.session.dir)[ctx.session.id] : undefined;
    const provider = this.cfg.userProvider ? codexUserProvider() : null;
    const model = s.model ?? provider?.model;
    const common = [
      "--json", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "-c", 'approval_policy="never"',
      ...[...new Set([...settings, ...(provider?.settings ?? [])])].flatMap((x) => ["-c", x]),
      ...(model ? ["-m", model] : []),
    ];
    // `exec resume` takes neither --sandbox nor --cd: the sandbox is set as config, and the
    // folder is the one it's started in.
    const args = thread
      ? ["exec", "resume", ...common, "-c", `sandbox_mode="${sandbox}"`, thread, "-"]
      : ["exec", ...common, ...(ctx.session ? [] : ["--ephemeral"]), "--sandbox", sandbox, "--cd", ctx.wtDir, "-"];
    return {
      args,
      // A resumed session already has the role's instructions.
      input: `${charter && !thread ? `Your role's standing instructions:\n${charter}\n\n` : ""}${prompt}`,
      ...(provider?.token ? { env: { [CODEX_TOKEN_ENV]: provider.token } } : {}),
      header: [
        `codex exec${thread ? ` resume ${thread}` : ""}${model ? ` -m ${model}` : ""} --sandbox ${sandbox}`,
        `provider: ${provider ? `${provider.name} (from your Codex config)` : "OpenAI, with your Codex sign-in"}`,
        `settings: ${settings.join(", ") || "-"}`,
        "commands: any, inside the sandbox (Codex can't limit them to the catalog's list)",
      ],
    };
  }
  stream(say: (...lines: string[]) => void, now: number): CodexStream {
    return new CodexStream(say, now);
  }
}

// Codex's --json events: items as they start and finish, then the turn's usage or failure.
export class CodexStream extends LineStream {
  thread = ""; // the session's own id, which a later turn resumes
  protected event(e: Record<string, any>): void {
    const it = e.item ?? {};
    if (e.type === "thread.started") this.thread = String(e.thread_id ?? "");
    else if (e.type === "item.started" && it.type === "command_execution") {
      // Codex wraps commands in the shell it runs them with: show the command.
      const cmd = String(it.command ?? "");
      const inner = cmd.match(/-(?:Command|c)\s+"([\s\S]*)"\s*$/)?.[1] ?? cmd;
      this.say(`→ ${short(inner, 200)}`);
    } else if (e.type === "item.completed") {
      if (it.type === "agent_message") this.text(String(it.text ?? ""));
      else if (it.type === "command_execution" && typeof it.exit_code === "number" && it.exit_code !== 0) this.say(`  exit ${it.exit_code}${it.aggregated_output ? `: ${short(String(it.aggregated_output).split(/\r?\n/).filter(Boolean).at(-1), 200)}` : ""}`);
      else if (it.type === "file_change") this.say(`→ changed: ${(it.changes ?? []).map((c: { path?: string; kind?: string }) => `${c.kind ?? ""} ${c.path ?? ""}`.trim()).join(", ")}`);
      else if (it.type === "web_search") this.say(`→ web search: ${short(it.query)}`);
      else if (it.type === "mcp_tool_call") this.say(`→ ${it.server ?? "mcp"}.${it.tool ?? "tool"}`);
      else if (it.type === "error") this.error(short(it.message, 300));
    } else if (e.type === "turn.completed") {
      const u = e.usage ?? {};
      this.say(`result: done${u.input_tokens !== undefined ? `, ${u.input_tokens} tokens in, ${u.output_tokens ?? 0} out` : ""}`);
    } else if (e.type === "turn.failed") {
      this.error(short(e.error?.message ?? JSON.stringify(e.error ?? {}), 300));
    } else if (e.type === "error") {
      this.error(short(e.message ?? JSON.stringify(e), 300));
    }
  }
}

// ---------- pi and omp ----------

const PI_COMMANDS = { always: ["git status", "git diff *"], "shell:test": ["npm test", "npm run build"] };

export const PI_DEFAULTS: VendorConfig = {
  bin: "pi",
  read: ["read", "grep", "find", "ls"],
  write: ["write", "edit"],
  shell: ["bash", "powershell"],
  tools: {},
  commands: PI_COMMANDS,
};

export const OMP_DEFAULTS: VendorConfig = {
  bin: "omp",
  read: ["read", "grep", "glob"],
  write: ["write", "edit"],
  shell: ["bash"],
  tools: { "web:read": ["web_search"] },
  commands: PI_COMMANDS,
};

abstract class GatedTurnAgent extends CliTurnAgent {
  // The tools this turn gets and what the gate lets them do.
  grant(ctx: TurnContext, s: Seat): { tools: string[]; commands: string[]; env: Record<string, string> } {
    const commands = this.granted(this.cfg.commands, s);
    const tools = [...new Set([
      ...(this.cfg.read ?? []),
      ...(s.writes ? this.cfg.write ?? [] : []),
      ...(commands.length ? this.cfg.shell ?? [] : []),
      ...s.perms.flatMap((p) => this.cfg.tools?.[permKey(p)] ?? []),
    ])];
    const gate = { root: ctx.wtDir, write: s.writes ? s.scope : [], commands, tools };
    return { tools, commands, env: { AF_GATE: JSON.stringify(gate) } };
  }
  header(name: string, s: Seat, g: { tools: string[]; commands: string[] }): string[] {
    return [`${name}${s.model ? ` --model ${s.model}` : ""} (turn gate on)`, `tools: ${g.tools.join(", ")}`, `commands: ${g.commands.join(", ") || "-"}`, `writes: ${s.writes ? s.scope.join(", ") || "none (no write scope)" : "none"}`];
  }
}

// Checked against pi 1.4.0 (@earendil-works/pi-coding-agent) on Windows. pi has no
// approvals at all, so the gate is what holds a turn to its grant. Your extensions,
// skills, prompt templates, MCP servers and context files are all switched off, and so
// is anything the engagement repo could add under .pi/.
export class PiTurnAgent extends GatedTurnAgent {
  name = "pi";
  vendor = "pi";
  resumes = true; // sessions live in a folder the harness picks, found by id
  constructor(opts: VendorOptions) {
    super(opts, PI_DEFAULTS);
  }
  command(ctx: TurnContext, s: Seat, prompt: string) {
    const g = this.grant(ctx, s);
    const charter = this.charter(s.role);
    const session = ctx.session ? ["--session-dir", path.join(ctx.session.dir, "pi"), "--session-id", ctx.session.id] : ["--no-session"];
    return {
      args: [
        "-p", "--mode", "json", ...session,
        "--no-extensions", "-e", GATE, "--no-skills", "--no-prompt-templates", "--no-themes", "--no-mcp", "--no-approve", "--no-context-files",
        "--tools", g.tools.join(","),
        ...(s.model ? ["--model", s.model] : []),
        ...(charter ? ["--append-system-prompt", charter] : []),
        "--", prompt,
      ],
      env: g.env,
      header: this.header("pi", s, g),
    };
  }
  stream(say: (...lines: string[]) => void, now: number): PiStream {
    return new PiStream(say, now);
  }
}

// omp (oh-my-pi), checked for flags against omp 18.12.6. Its approvals are switched off
// for the turn because nobody is there to answer them: the gate is the approval, and it
// refuses anything outside the grant. Your extensions, skills and rules are switched
// off, and so are its language servers and the session title.
export class OmpTurnAgent extends GatedTurnAgent {
  name = "omp";
  vendor = "omp";
  constructor(opts: VendorOptions) {
    super(opts, OMP_DEFAULTS);
  }
  command(ctx: TurnContext, s: Seat, prompt: string) {
    const g = this.grant(ctx, s);
    const charter = this.charter(s.role);
    return {
      args: [
        "-p", "--mode=json", "--no-session",
        "--no-extensions", "-e", GATE, "--no-skills", "--no-rules", "--no-lsp", "--no-pty", "--no-title",
        "--approval-mode=yolo", `--max-time=${Math.max(60, Math.floor(this.timeoutMs / 1000))}`,
        `--tools=${g.tools.join(",")}`,
        ...(s.model ? [`--model=${s.model}`] : []),
        ...(charter ? [`--append-system-prompt=${charter}`] : []),
        "--", prompt,
      ],
      env: g.env,
      header: this.header("omp", s, g),
    };
  }
  stream(say: (...lines: string[]) => void, now: number): PiStream {
    return new PiStream(say, now);
  }
}

// pi's JSON mode (omp keeps the same events): finished messages, tool runs, retries.
export class PiStream extends LineStream {
  private cost = 0;
  protected event(e: Record<string, any>): void {
    const m = e.message ?? {};
    if (e.type === "message_end" && m.role === "assistant") {
      const model = [m.provider, m.model].filter(Boolean).join("/");
      if (model && model !== this.model) {
        this.model = model;
        this.say(`model: ${model}`);
      }
      for (const c of (Array.isArray(m.content) ? m.content : []) as Array<Record<string, any>>) if (c.type === "text") this.text(String(c.text ?? ""));
      if (typeof m.usage?.cost?.total === "number") this.cost += m.usage.cost.total;
      if (m.stopReason === "error") this.error(short(m.errorMessage ?? "the model call failed", 300));
    } else if (e.type === "tool_execution_start") {
      const a = e.args ?? {};
      const what = a.command ?? a.path ?? a.file_path ?? a.pattern ?? a.query ?? a.url;
      this.say(`→ ${e.toolName}${what ? `: ${short(what, 200)}` : ""}`);
    } else if (e.type === "tool_execution_end" && e.isError) {
      const text = (e.result?.content ?? []).map((c: { text?: string }) => c.text ?? "").join(" ");
      this.say(`  ✗ ${e.toolName}: ${short(text, 240)}`);
    } else if (e.type === "auto_retry_start") {
      this.say(`retrying (${e.attempt}/${e.maxAttempts}): ${short(e.errorMessage, 200)}`);
    } else if (e.type === "auto_retry_end" && e.success === false) {
      this.error(short(e.finalError ?? "retries failed", 300));
    } else if (e.type === "agent_settled") {
      this.say(`result: ${e.aborted ? "aborted" : "done"}${this.cost ? `, $${this.cost.toFixed(4)}` : ""}`);
    }
  }
}

export const VENDOR_DEFAULTS: Record<string, VendorConfig> = { claude: CLAUDE_DEFAULTS, codex: CODEX_DEFAULTS, pi: PI_DEFAULTS, omp: OMP_DEFAULTS };

export function vendorAgent(vendor: string, opts: VendorOptions): TurnAgent {
  switch (vendor) {
    case "claude":
      return new ClaudeCodeTurnAgent(opts);
    case "codex":
      return new CodexTurnAgent(opts);
    case "pi":
      return new PiTurnAgent(opts);
    case "omp":
      return new OmpTurnAgent(opts);
    default:
      throw new Error(`no turn agent for ${vendor}`);
  }
}
