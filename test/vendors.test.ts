// Seats can run in Copilot, Claude Code, Codex, pi or omp, each held to the permission
// catalog the strongest way that CLI allows; none of them can push.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { allowedCommand, decide } from "../integrations/pi/turn-gate.ts";
import { CapacityError, CopilotTurnAgent, TurnRouter, turnEnv, vendorOfModel } from "../src/harness/agents.ts";
import { CodexStream, CodexTurnAgent, GATE, OmpTurnAgent, PiStream, PiTurnAgent, codexUserProvider } from "../src/harness/vendors.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const PROFILES = path.join(ROOT, "integrations", "copilot", "harness-agents");
const tmp = (n: string) => fs.mkdtempSync(path.join(os.tmpdir(), `af-vendors-${n}-`));
const MODELS = { "model-a": "pi:anthropic/claude-sonnet", "model-b": "codex:gpt-6", "model-c": "omp:opus", "model-d": "" };
// Codex turns read the provider from your own Codex config: never the real one in tests.
process.env.CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "af-vendors-codex-home-"));
const common = { models: MODELS, fallback: { agent: "author", model: "model-a" }, profileDirs: [PROFILES], timeoutMs: 30_000 };

test("which CLI a model id names", () => {
  assert.deepEqual(["claude:opus", "codex:", "pi:openai/gpt-x:high", "omp:opus", "gpt-6-luna", "", undefined, "mystery:x"].map(vendorOfModel), ["claude", "codex", "pi", "omp", "copilot", "copilot", "copilot", "copilot"]);
});

test("the turn gate: the seat's tools, its commands one at a time, writes in the write scope, nothing outside the worktree", () => {
  const root = path.resolve(tmp("gate"));
  const cfg = { root, write: ["work"], commands: ["git status", "git diff *", "npm test"], tools: ["read", "write", "bash"] };
  assert.equal(decide(cfg, "read", { path: "src/a.ts" }), null);
  assert.equal(decide(cfg, "write", { path: "work/a.md" }), null);
  assert.equal(decide(cfg, "write", { path: path.join(root, "work", "deep", "b.md") }), null, "an absolute path inside the scope");
  assert.match(decide(cfg, "write", { path: "workshop/a.md" })!, /only in work/, "a sibling that starts the same is outside");
  assert.match(decide(cfg, "write", { path: "work/../policy/x.json" })!, /only in work/);
  assert.match(decide(cfg, "read", { path: "../elsewhere.txt" })!, /outside this turn's worktree/);
  assert.match(decide(cfg, "read", { path: os.homedir() })!, /outside/);
  assert.match(decide(cfg, "edit", { path: "work/a.md" })!, /isn't one of this turn's tools/);
  assert.match(decide({ ...cfg, tools: [...cfg.tools, "edit"] }, "edit", {})!, /must name the one file/);
  assert.match(decide({ ...cfg, write: [] }, "write", { path: "work/a.md" })!, /may not write files/);
  for (const ok of ["git status", "git  status ", "git diff", "git diff --stat HEAD", "npm test"]) assert.ok(allowedCommand(ok, cfg.commands), ok);
  for (const no of ["git push", "git status; git push", "git status && rm -rf .", "git diff | sh", "git diff > x", "npm test`id`", "git diff $(rm x)", "npm test\nrm x", "npm testing", "git statusx"]) assert.ok(!allowedCommand(no, cfg.commands), no);
  assert.match(decide(cfg, "bash", { command: "git push" })!, /only these commands/);
  assert.equal(decide(cfg, "bash", { command: "git diff HEAD" }), null);
  assert.match(decide(cfg, "bash", { command: "git status", cwd: os.tmpdir() })!, /outside/, "and not run from somewhere else");
});

test("no turn can push: git's push URL for the remote points nowhere", () => {
  const dir = tmp("push");
  const remote = path.join(dir, "remote.git");
  const work = path.join(dir, "work");
  const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", windowsHide: true });
  git(dir, "init", "-q", "--bare", remote);
  git(dir, "init", "-q", "-b", "main", work);
  git(work, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "x");
  git(work, "remote", "add", "origin", remote);
  const env = turnEnv({ turn: "t-1" }, process.env);
  assert.equal(env.AF_TURN, "t-1");
  const r = spawnSync("git", ["push", "origin", "main"], { cwd: work, env, encoding: "utf8", windowsHide: true });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /agentfactory-turns-cannot-push/);
  assert.equal(spawnSync("git", ["push", "origin", "main"], { cwd: work, encoding: "utf8", windowsHide: true }).status, 0, "outside a turn the same push works");
  // Config already passed in the environment is kept.
  const e2 = turnEnv({ turn: "t" }, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "x" });
  assert.deepEqual([e2.GIT_CONFIG_COUNT, e2.GIT_CONFIG_KEY_0, e2.GIT_CONFIG_KEY_1], ["3", "user.name", "remote.origin.pushurl"]);
});

test("Codex's events: commands without their shell wrapper, the reply, and a usage limit with its wait", () => {
  const lines: string[] = [];
  const s = new CodexStream((...l) => lines.push(...l), 0);
  const ev = (o: unknown) => s.feed(`${JSON.stringify(o)}\n`);
  ev({ type: "thread.started", thread_id: "x" });
  ev({ type: "item.completed", item: { type: "agent_message", text: "I'll write it." } });
  ev({ type: "item.started", item: { type: "command_execution", command: '"C:\\pwsh.exe" -Command "git status --short"' } });
  ev({ type: "item.completed", item: { type: "command_execution", command: "x", exit_code: 1, aggregated_output: "line\nfatal: no\n" } });
  ev({ type: "item.completed", item: { type: "file_change", changes: [{ path: "work/a.md", kind: "add" }] } });
  ev({ type: "item.completed", item: { type: "agent_message", text: '{"done": true}' } });
  ev({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } });
  s.end();
  assert.deepEqual(lines, ["  I'll write it.", "→ git status --short", "  exit 1: fatal: no", "→ changed: add work/a.md", '  {"done": true}', "result: done, 10 tokens in, 2 out"]);
  assert.ok(s.reply().endsWith('{"done": true}'));
  assert.equal(s.capacity(), null);
  const t = new CodexStream(() => {}, 1_000);
  t.feed(`${JSON.stringify({ type: "turn.failed", error: { message: "You've hit your usage limit. Try again in 2 hours 30 minutes." } })}\n`);
  t.end();
  assert.equal(t.capacity()?.resetAt, 1_000 + 2.5 * 3_600_000);
});

test("pi's events: the model, each tool, a refusal by the gate, the reply; a 429 is a usage limit", () => {
  const lines: string[] = [];
  const s = new PiStream((...l) => lines.push(...l), 0);
  const ev = (o: unknown) => s.feed(`${JSON.stringify(o)}\n`);
  ev({ type: "session", id: "x" });
  ev({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "the prompt" }] } });
  ev({ type: "tool_execution_start", toolName: "bash", args: { command: "git status | head" } });
  ev({ type: "tool_execution_end", toolName: "bash", isError: true, result: { content: [{ type: "text", text: "only these commands, one at a time: git status" }] } });
  ev({ type: "message_end", message: { role: "assistant", provider: "anthropic", model: "claude-sonnet", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: 'Done.\n{"done": true}' }], usage: { cost: { total: 0.002 } } } });
  ev({ type: "agent_settled", aborted: false });
  s.end();
  assert.deepEqual(lines, ["→ bash: git status | head", "  ✗ bash: only these commands, one at a time: git status", "model: anthropic/claude-sonnet", "  Done.", '  {"done": true}', "result: done, $0.0020"]);
  assert.ok(s.reply().endsWith('{"done": true}'), "the user's own prompt is never taken for the reply");
  const t = new PiStream(() => {}, 0);
  t.feed(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "429 rate_limit_error: retry after 120 seconds" } })}\n`);
  t.end();
  assert.equal(t.capacity()?.resetAt, 120_000);
});

// A fake CLI that records how it was started and answers in its own format.
function fake(dir: string, name: string, out: string): string {
  const f = path.join(dir, `${name}.js`);
  fs.writeFileSync(f, `const fs = require("node:fs");
let input = "";
const done = () => {
  fs.writeFileSync(${JSON.stringify(path.join(dir, `${name}.json`))}, JSON.stringify({ args: process.argv.slice(2), gate: process.env.AF_GATE, turn: process.env.AF_TURN, push: process.env.GIT_CONFIG_VALUE_0, input }));
  ${out}
};
if (process.stdin.isTTY === undefined && !process.stdin.readableEnded) { process.stdin.on("data", (c) => (input += c)); process.stdin.on("end", done); process.stdin.on("error", done); } else done();
`);
  return f;
}
const said = (dir: string, name: string) => JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), "utf8")) as { args: string[]; gate?: string; turn?: string; push?: string; input: string };
const after = (a: string[], flag: string) => a[a.indexOf(flag) + 1];

const PI_OUT = `console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: '{"done": true}' }] } }));`;
const CODEX_OUT = `console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: '{"done": true}' } }));`;

function ctx(wtDir: string, lane: string, model: string, perms: string[], role = "builder", writeScope = ["work"]) {
  return { turn: `${lane}-1-abc`, agent: "r1", now: 0, packet: `Your todo ${lane}`, todo: { id: lane, lane, text: "t", writeScope }, wtDir, seat: { key: `G/${lane}`, lane, role, agent: role, model, skills: [], effective: perms, generated: false, probation: false } } as never;
}

test("a seat on pi runs with the gate, its grant, and none of your extensions, skills, MCP servers or context files", async () => {
  const dir = tmp("pi");
  const wt = tmp("pi-wt");
  const router = new TurnRouter(new CopilotTurnAgent({ ...common, bin: fake(dir, "copilot", ""), profileDirs: null }), { pi: new PiTurnAgent({ ...common, bin: fake(dir, "pi", PI_OUT) }) });
  assert.deepEqual(await router.run(ctx(wt, "build", "model-a", ["repo:read", "repo:write:lease", "shell:test"])), { done: true });
  const c = said(dir, "pi");
  for (const f of ["-p", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-mcp", "--no-approve", "--no-context-files"]) assert.ok(c.args.includes(f), f);
  assert.equal(after(c.args, "--mode"), "json");
  assert.equal(after(c.args, "-e"), GATE);
  assert.equal(after(c.args, "--model"), "anthropic/claude-sonnet");
  assert.match(after(c.args, "--append-system-prompt"), /Every turn:/, "the role's profile");
  assert.ok(c.args.at(-1)!.includes("Your todo build") && c.args.at(-2) === "--", "the prompt last, after --");
  assert.deepEqual(after(c.args, "--tools").split(","), ["read", "grep", "find", "ls", "write", "edit", "bash", "powershell"]);
  const g = JSON.parse(c.gate!);
  assert.deepEqual([g.root, g.write, g.commands], [wt, ["work"], ["git status", "git diff *", "npm test", "npm run build"]]);
  assert.deepEqual([c.turn, c.push], ["build-1-abc", "agentfactory-turns-cannot-push:"]);

  // A seat that may only read gets no writing tools, and the gate lets it write nothing.
  await router.run(ctx(wt, "review", "model-a", ["repo:read"], "blind-reviewer"));
  const r = said(dir, "pi");
  assert.deepEqual(after(r.args, "--tools").split(","), ["read", "grep", "find", "ls", "bash", "powershell"]);
  assert.deepEqual(JSON.parse(r.gate!).write, []);
  assert.deepEqual(JSON.parse(r.gate!).commands, ["git status", "git diff *"], "only the commands every seat has");
});

test("a seat on omp runs with the gate as its only approval, and its own extras switched off", async () => {
  const dir = tmp("omp");
  const wt = tmp("omp-wt");
  const omp = new OmpTurnAgent({ ...common, bin: fake(dir, "omp", PI_OUT) });
  assert.deepEqual(await omp.run(ctx(wt, "build", "model-c", ["repo:read", "repo:write:lease", "web:read"])), { done: true });
  const c = said(dir, "omp");
  for (const f of ["-p", "--mode=json", "--no-session", "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--no-pty", "--no-title", "--approval-mode=yolo", "--model=opus", "--max-time=60"]) assert.ok(c.args.includes(f), f);
  assert.equal(after(c.args, "-e"), GATE);
  assert.ok(c.args.some((a) => a.startsWith("--append-system-prompt=") && a.includes("Every turn:")));
  assert.equal(c.args.find((a) => a.startsWith("--tools=")), "--tools=read,grep,glob,write,edit,bash,web_search");
  assert.deepEqual(JSON.parse(c.gate!).commands, ["git status", "git diff *"], "no test commands without shell:test");
});

test("a seat on Codex: the sandbox follows its write permission, nothing of yours is loaded, and the role leads the prompt", async () => {
  const dir = tmp("codex");
  const wt = tmp("codex-wt");
  const codex = new CodexTurnAgent({ ...common, bin: fake(dir, "codex", CODEX_OUT) });
  await codex.run(ctx(wt, "spike", "model-b", ["repo:read", "repo:write:lease", "shell:test"], "experimenter"));
  let c = said(dir, "codex");
  assert.equal(c.args[0], "exec");
  for (const f of ["--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check"]) assert.ok(c.args.includes(f), f);
  assert.equal(after(c.args, "--sandbox"), "workspace-write");
  assert.equal(after(c.args, "-m"), "gpt-6");
  assert.equal(after(c.args, "--cd"), wt);
  assert.equal(c.args.at(-1), "-", "the prompt comes on stdin");
  assert.ok(c.args.includes('approval_policy="never"'));
  assert.equal(c.args.includes('windows.sandbox="elevated"'), process.platform === "win32");
  assert.ok(c.input.startsWith("Your role's standing instructions:") && c.input.includes("Your todo spike"));
  assert.ok(!c.args.includes("sandbox_workspace_write.network_access=true"), "no network without web:read");
  await codex.run(ctx(wt, "research", "model-b", ["repo:read", "web:read"], "researcher"));
  c = said(dir, "codex");
  assert.equal(after(c.args, "--sandbox"), "read-only");
  assert.ok(c.args.includes("sandbox_workspace_write.network_access=true") && c.args.includes('web_search="live"'));
});

test("Codex uses the provider from your own Codex config, with its token in the environment and nowhere else", async () => {
  const home = tmp("codex-home");
  fs.writeFileSync(path.join(home, "config.toml"), [
    'model = "gateway/flash-1"',
    'model_provider = "magpie"',
    "",
    "[model_providers.magpie]",
    'name = "magpie"',
    'base_url = "http://127.0.0.1:3425/v1"',
    'wire_api = "responses"',
    'experimental_bearer_token = "sk-secret-123"',
    'http_headers = { "x-actor" = "magpie" }',
    "",
    "[mcp_servers.notes]",
    'command = "node"',
  ].join("\n"));
  const p = codexUserProvider(home)!;
  assert.equal(p.name, "magpie");
  assert.equal(p.model, "gateway/flash-1");
  assert.equal(p.token, "sk-secret-123");
  assert.deepEqual(p.settings, ['model_provider="magpie"', 'model_providers.magpie.name="magpie"', 'model_providers.magpie.base_url="http://127.0.0.1:3425/v1"', 'model_providers.magpie.wire_api="responses"', 'model_providers.magpie.http_headers={ "x-actor" = "magpie" }', 'model_providers.magpie.env_key="AF_CODEX_PROVIDER_TOKEN"']);
  assert.ok(!p.settings.some((x) => x.includes("sk-secret") || x.includes("mcp_servers")));
  assert.equal(codexUserProvider(tmp("empty-home")), null, "no config: OpenAI with your sign-in");

  const dir = tmp("codex-prov");
  const f = path.join(dir, "codex.js");
  fs.writeFileSync(f, `const fs = require("node:fs"); let input = ""; process.stdin.on("data", (c) => (input += c)); process.stdin.on("end", () => {
fs.writeFileSync(${JSON.stringify(path.join(dir, "seen.json"))}, JSON.stringify({ args: process.argv.slice(2), token: process.env.AF_CODEX_PROVIDER_TOKEN }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: '{"done": true}' } })); });`);
  const before = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  const log: string[] = [];
  try {
    await new CodexTurnAgent({ ...common, models: { ...MODELS, "model-b": "codex:" }, bin: f }).run({ ...(ctx(tmp("codex-prov-wt"), "spike", "model-b", ["repo:read"]) as object), log: (...l: string[]) => log.push(...l) } as never);
  } finally {
    process.env.CODEX_HOME = before;
  }
  const seen = JSON.parse(fs.readFileSync(path.join(dir, "seen.json"), "utf8")) as { args: string[]; token: string };
  assert.equal(seen.token, "sk-secret-123", "the token reaches Codex in its environment");
  assert.ok(!seen.args.some((a) => a.includes("sk-secret")), "and never on the command line");
  assert.ok(!log.some((l) => l.includes("sk-secret")), "or in the turn log");
  assert.equal(after(seen.args, "-m"), "gateway/flash-1", "your default model, when the seat names none");
  assert.ok(seen.args.includes('model_provider="magpie"') && seen.args.includes("--ignore-user-config"));
  assert.ok(log.includes("provider: magpie (from your Codex config)"));
});

test("a usage limit reported mid-run ends the turn at once, as a wait, instead of hanging to the timeout", async () => {
  // As Codex really did: a 429 from the provider, "reconnecting", then silence.
  const dir = tmp("hang");
  const bin = fake(dir, "codex", `console.log(JSON.stringify({ type: "error", message: "Reconnecting... 1/5 (exceeded retry limit, last status: 429 Too Many Requests, request id: x)" })); setTimeout(() => {}, 60000);`);
  const codex = new CodexTurnAgent({ ...common, bin, timeoutMs: 120_000 });
  const started = Date.now();
  await assert.rejects(codex.run(ctx(tmp("hang-wt"), "spike", "model-b", ["repo:read"])), (e: unknown) => e instanceof CapacityError && e.vendor === "codex");
  assert.ok(Date.now() - started < 20_000, `took ${Date.now() - started} ms`);
});

test("a usage limit in one of these CLIs holds up the seats on it, by name", async () => {
  const dir = tmp("cap");
  const bin = fake(dir, "codex", `console.log(JSON.stringify({ type: "turn.failed", error: { message: "429 Too Many Requests: rate limit, retry after 600 seconds" } })); process.exit(1);`);
  const router = new TurnRouter(new CopilotTurnAgent({ ...common, bin: fake(dir, "copilot", ""), profileDirs: null }), { codex: new CodexTurnAgent({ ...common, bin }) });
  await assert.rejects(router.run(ctx(tmp("cap-wt"), "spike", "model-b", ["repo:read"])), (e: unknown) => e instanceof CapacityError && e.vendor === "codex" && e.resetAt === 600_000 && JSON.stringify(e.models) === '["model-b"]');
});
