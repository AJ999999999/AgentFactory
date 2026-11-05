// A turn is told which commands its seat may run, built from the grant its CLI enforces
// (docs/next/180). A builder that wasn't told tried python, inline scripts and PowerShell,
// was refused each time, and gave up on testing without trying `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CopilotTurnAgent, commandsLine, grantedCommands } from "../src/harness/agents.ts";
import { ClaudeCodeTurnAgent, CodexTurnAgent, OmpTurnAgent, PiTurnAgent } from "../src/harness/vendors.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const policy = JSON.parse(fs.readFileSync(path.join(ROOT, "policy", "harness-agents.json"), "utf8"));
const MODELS = { "model-a": "", "model-b": "claude:opus", "model-c": "codex:", "model-d": "pi:x/y", "model-e": "omp:z" };
const common = { models: MODELS, fallback: { agent: "author", model: "model-a" }, profileDirs: [], timeoutMs: 30_000 };
process.env.CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "af-commands-codex-home-"));

function ctx(model: string, perms: string[], wtDir = ".") {
  return { turn: "build-1-x", agent: "r1", now: 0, packet: "Your todo build", wtDir, todo: { id: "build", lane: "build", text: "t", writeScope: ["src"] }, seat: { key: "G/build", lane: "build", role: "builder", agent: "builder", model, skills: [], effective: perms, generated: false, probation: false } } as never;
}
const BUILD = ["repo:read", "repo:write:lease", "shell:test"];
const TOLD = "Commands you can run: `npm test`, `npm run build`, `git status`, `git diff` with any arguments.";

const copilot = new CopilotTurnAgent({ ...common, profileDirs: null, tools: { tools: policy.tools, always: policy.always } });
const claude = new ClaudeCodeTurnAgent({ ...common, config: policy.cli.claude });
const codex = new CodexTurnAgent({ ...common, config: policy.cli.codex });
const pi = new PiTurnAgent({ ...common, config: policy.cli.pi });
const omp = new OmpTurnAgent({ ...common, config: policy.cli.omp });
const sorted = (c: { list: string[] } | { any: string }) => ("list" in c ? [...c.list].sort() : c);

test("a build seat is told the same commands whichever CLI runs it, read from that CLI's own grant", () => {
  const p = copilot.prompt(ctx("model-a", BUILD));
  assert.ok(p.includes(TOLD), p);
  for (const agent of [claude, pi, omp]) {
    const c = agent.commands(ctx("model-a", BUILD), agent.seat(ctx("model-a", BUILD)));
    assert.deepEqual(sorted(c), ["git diff *", "git status", "npm run build", "npm test"].sort(), agent.name);
    assert.equal(commandsLine(c)[0].split(". Anything")[0] + ".", TOLD, agent.name);
  }
});

test("the line says that anything else is refused, and what to do when the todo names a command that isn't there", () => {
  const p = copilot.prompt(ctx("model-a", BUILD));
  assert.match(p, /Anything else is refused, so don't try other ways to run code \(another test runner, python, node, a script, PowerShell\)\./);
  assert.match(p, /If the todo or its checks name a command that isn't here, use what's here and say in your note which command you needed\./);
  assert.ok(p.indexOf("Do one bounded piece") < p.indexOf("Commands you can run"), "it comes with the work instruction, before the JSON");
});

test("a seat without the test permission is told it has git status and diff only, and can't run the tests", () => {
  const p = copilot.prompt(ctx("model-a", ["repo:read"]));
  assert.match(p, /Commands you can run: `git status`, `git diff` with any arguments\./);
  assert.ok(!p.includes("`npm test`"));
  assert.deepEqual(sorted(pi.commands(ctx("model-a", ["repo:read"]), pi.seat(ctx("model-a", ["repo:read"])))), ["git diff *", "git status"]);
});

test("a seat with no commands at all is told it can only read and write files", () => {
  const bare = new PiTurnAgent({ ...common, config: { ...policy.cli.pi, commands: {} } });
  const c = bare.commands(ctx("model-a", ["repo:read"]), bare.seat(ctx("model-a", ["repo:read"])));
  assert.deepEqual(c, { list: [] });
  assert.match(commandsLine(c)[0], /can't run any commands in this turn, tests included: read and write files only/);
});

test("a grant of the whole shell says so, with what's still denied", () => {
  const c = grantedCommands(["write", "shell"], ["shell(git push)", "shell(rm:*)", "write"], "shell");
  assert.deepEqual(c, { any: "You can run any shell command, except `git push`, `rm` with any arguments." });
});

test("Codex, which can't limit commands, is told what holds them instead", () => {
  const w = codex.commands(ctx("model-c", BUILD), codex.seat(ctx("model-c", BUILD)));
  assert.match(commandsLine(w)[0], /inside a sandbox that lets you write only in this worktree\. Its \.git is read-only, so don't commit/);
  const r = codex.commands(ctx("model-c", ["repo:read"]), codex.seat(ctx("model-c", ["repo:read"])));
  assert.match(commandsLine(r)[0], /read-only sandbox/);
});

test("a scripted agent with no grant to read gets no commands line", () => {
  assert.deepEqual(commandsLine(undefined), []);
});
