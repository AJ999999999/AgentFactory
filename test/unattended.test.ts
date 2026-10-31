// Running without someone watching: what the first real eval needed a babysitter for.
// A dead gateway, a broken profile, a question the work had already answered, a question
// answered before. Each is handled by the harness, and recorded as the harness's own call.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { createWorkspace } from "../src/foundation/workspace.ts";
import { CapacityError, ConnectionWatch, CopilotStream, CopilotTurnAgent, TurnRouter, UNREACHABLE_AFTER, classifySetup, classifyUnreachable } from "../src/harness/agents.ts";
import type { TurnContext } from "../src/harness/agents.ts";
import { Harness } from "../src/harness/harness.ts";
import { loadPolicy, project } from "../src/harness/project.ts";
import type { State } from "../src/harness/project.ts";
import { codexGateway, lintProfile, preflight, profileProblems, reachable } from "../src/harness/preflight.ts";
import { blockers } from "../src/harness/select.ts";
import { criteriaHash, validateTurn } from "../src/harness/validate.ts";
import type { TurnOutput } from "../src/harness/validate.ts";
import { SimClock } from "../src/harness/world.ts";
import type { EngagementDef, GoalDef, HEvent, TodoDraft } from "../src/harness/types.ts";

const policy = loadPolicy(path.join(import.meta.dirname, "..", "policy", "harness.json"));
const plain = { ...policy, team: undefined };
const MIN = 60_000;
const T0 = Date.parse("2026-11-02T09:00:00Z");
const tmp = (n: string) => fs.mkdtempSync(path.join(os.tmpdir(), `af-unattended-${n}-`));

// ---------- a service that can't be reached ----------

test("the CLI's own connection errors end a turn after a few in a row, as a wait; tool output saying ECONNREFUSED doesn't count", () => {
  assert.equal(classifyUnreachable("Reconnecting... waiting for network (Connection failed: error sending request)")?.kind, "unreachable");
  assert.equal(classifyUnreachable("TypeError: cannot read properties of undefined"), null);
  const w = new ConnectionWatch();
  for (let i = 1; i < UNREACHABLE_AFTER; i++) assert.equal(w.see("Reconnecting... waiting for network"), false);
  assert.equal(w.result(), null, "one or two drops are a blip");
  assert.equal(w.see("Reconnecting... waiting for network"), true);
  assert.match(w.result()!.reason, /can't reach the service.*\(3 times\)/);

  // Copilot: error events end the turn; an agent's tool output never reaches error().
  let ended = 0;
  const lines: string[] = [];
  const s = new CopilotStream((...l) => lines.push(...l), T0);
  s.onLimit = () => ended++;
  s.feed(`${JSON.stringify({ type: "tool.execution_complete", data: { toolName: "bash", success: false, error: { message: "connect ECONNREFUSED 127.0.0.1:5432" } } })}\n`);
  assert.equal(s.capacity(), null, "a failing test's output is the work's business");
  for (let i = 0; i < UNREACHABLE_AFTER; i++) s.feed(`${JSON.stringify({ type: "session.error", data: { message: "Connection failed: error sending request" } })}\n`);
  assert.ok(ended >= 1, "the turn is ended");
  assert.equal(s.capacity()?.kind, "unreachable");
});

test("Copilot reporting a usage limit mid-run ends the turn at once, as a wait", async () => {
  const dir = tmp("cop-limit");
  const fake = path.join(dir, "copilot.js");
  // Says it's limited, then would hang for the whole turn timeout.
  fs.writeFileSync(fake, `console.log(JSON.stringify({ type: "session.error", data: { message: "429 Too Many Requests. Try again in 2 hours." } })); setTimeout(() => {}, 60000);\n`);
  const agent = new CopilotTurnAgent({ bin: fake, fallback: { agent: "author", model: "model-a" }, profileDirs: null, timeoutMs: 50_000 });
  const t0 = Date.now();
  const ctx = { turn: "x", agent: "r", now: T0, packet: "p", todo: { id: "t", lane: "build", text: "t" }, goal: {}, beliefs: [], findings: [], wtDir: dir, state: {} } as unknown as TurnContext;
  await assert.rejects(agent.run(ctx), (e: unknown) => e instanceof CapacityError && e.kind === "limit" && e.resetAt === T0 + 2 * 3_600_000);
  assert.ok(Date.now() - t0 < 20_000, "didn't sit out the timeout");
});

function def(todos: TodoDraft[]): EngagementDef {
  return { id: "u", title: "U", principals: { partner: "you" }, goals: [{ id: "G", title: "G", objective: "o", owner: "partner", scope: ["work"], assumptions: [], budget: { turns: 50 }, todos }] };
}

async function one(agent: CopilotTurnAgent | TurnRouter, todos: TodoDraft[]) {
  const dir = tmp("h");
  const control = await createWorkspace({ dir });
  const clock = new SimClock("2026-11-02T09:00:00Z");
  const h = new Harness({ control, engagement: "u", policy, clock, world: {}, agent, worktreeRoot: path.join(dir, "wt") });
  await h.open(def(todos));
  return { h, clock, dir };
}

test("a gateway that stops answering: the vendor waits a few minutes, then longer, and the todo spends nothing", async () => {
  const dir = tmp("gw");
  const fake = path.join(dir, "copilot.js");
  const lines = Array.from({ length: UNREACHABLE_AFTER }, () => JSON.stringify({ type: "session.error", data: { message: "Reconnecting... waiting for network (Connection failed)" } }));
  fs.writeFileSync(fake, `for (const l of ${JSON.stringify(lines)}) console.log(l); setTimeout(() => {}, 60000);\n`);
  const agent = new CopilotTurnAgent({ bin: fake, fallback: { agent: "author", model: "model-a" }, profileDirs: null, timeoutMs: 50_000 });
  const { h, clock } = await one(agent, [{ id: "t", lane: "build", text: "t", writeScope: ["work"] }]);
  const base = policy.capacity!.unreachableBackoffMinutes! * MIN;
  let t = clock.now();
  let r = await h.tick({ id: "r1", capabilities: [] });
  assert.equal(r.turns[0].result, "capacity");
  assert.equal(r.turns[0].wait?.kind, "unreachable");
  let s = await h.state();
  assert.equal(s.capacity.get("copilot")!.until, t + base, "retried soon: a gateway usually comes back");
  assert.equal(s.capacity.get("copilot")!.kind, "unreachable");
  assert.equal(s.todos.get("t")!.failures, 0);
  assert.equal(s.turns.length, 0);
  assert.ok(blockers(s, s.todos.get("t")!, clock.now()).some((b) => b.startsWith("copilot can't be reached")));
  clock.set(t + base + 1);
  t = clock.now();
  await h.tick({ id: "r1", capabilities: [] });
  s = await h.state();
  assert.equal(s.capacity.get("copilot")!.until, t + 2 * base, "then twice as long");
});

// ---------- a CLI that can't start as set up ----------

test("a profile Copilot can't load holds Copilot's turns for a while instead of failing every todo", async () => {
  assert.equal(classifySetup("Custom agent 'af-data-engineer' failed to load: agents\\af-data-engineer.agent.md: custom agent markdown frontmatter is malformed")?.kind, "setup");
  assert.equal(classifySetup("Error: spawn failed"), null);
  const dir = tmp("setup");
  const fake = path.join(dir, "copilot.js");
  fs.writeFileSync(fake, `console.error("Custom agent 'af-data-engineer' failed to load: frontmatter is malformed"); process.exit(1);\n`);
  const copilot = new CopilotTurnAgent({ bin: fake, fallback: { agent: "author", model: "model-a" }, profileDirs: null, timeoutMs: 30_000 });
  const { h, clock } = await one(new TurnRouter(copilot), [{ id: "t", lane: "build", text: "t", writeScope: ["work"] }]);
  const t = clock.now();
  const r = await h.tick({ id: "r1", capabilities: [] });
  assert.equal(r.turns[0].result, "capacity", JSON.stringify(r.turns));
  assert.equal(r.turns[0].wait?.kind, "setup");
  const s = await h.state();
  assert.equal(s.capacity.get("copilot")!.until, t + policy.capacity!.setupBackoffMinutes! * MIN);
  assert.equal(s.todos.get("t")!.failures, 0, "the work isn't at fault");
  assert.ok(blockers(s, s.todos.get("t")!, clock.now()).some((b) => /setup problem/.test(b)));
});

// ---------- preflight ----------

test("preflight: an installed profile Copilot can't read holds turns; one that differs from the repo's is only noted", async () => {
  assert.equal(lintProfile(`---\nname: af-x\ndescription: "a: b"\n---\nbody`), null);
  assert.match(lintProfile(`---\nname: af-x\ndescription: Prepares datasets: reproducible splits\n---\nbody`)!, /needs quotes/);
  assert.equal(lintProfile("no front matter"), "no front matter");
  const installed = tmp("inst");
  const repo = tmp("repo");
  fs.writeFileSync(path.join(repo, "af-a.agent.md"), `---\nname: af-a\n---\nnew`);
  fs.writeFileSync(path.join(installed, "af-a.agent.md"), `---\nname: af-a\n---\nold`);
  fs.writeFileSync(path.join(installed, "af-b.agent.md"), `---\nname: af-b\ndescription: x: y\n---\n`);
  fs.writeFileSync(path.join(installed, "mine.agent.md"), `---\nbroken: a: b\n---\n`); // not ours: left alone
  const p = profileProblems(installed, repo);
  assert.deepEqual(p.map((x) => x.what.split(" ").slice(0, 3).join(" ")), ["agent profile af-a.agent.md", "agent profile af-b.agent.md"]);
  assert.match(p[0].what, /older or newer/);
  assert.match(p[1].what, /can't be loaded/);
});

test("preflight: Codex's own gateway is checked with one connection; a dead one is a wait for Codex's turns", async () => {
  const server = net.createServer((s) => s.end());
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  assert.equal(await reachable(`http://127.0.0.1:${port}/v1`), null);
  server.close();
  await new Promise((r) => setTimeout(r, 50));
  assert.match((await reachable(`http://127.0.0.1:${port}/v1`, 1_000))!, /ECONNREFUSED|no answer/);

  const home = tmp("codex");
  fs.writeFileSync(path.join(home, "config.toml"), `model_provider = "magpie"\nmodel = "m"\n\n[model_providers.magpie]\nname = "magpie"\nbase_url = "http://127.0.0.1:${port}/v1"\n`);
  assert.deepEqual(codexGateway(home), { name: "magpie", url: `http://127.0.0.1:${port}/v1` });
  const agents = { fallback: { agent: "author", model: "model-a" }, lanes: {}, models: { "model-a": "codex:" }, cli: { codex: { userProvider: true } } };
  const found = await preflight({ agents, installedDir: tmp("none"), repoDir: tmp("none2"), codexHome: home, timeoutMs: 1_000 });
  assert.equal(found.length, 1);
  assert.equal(found[0].vendor, "codex");
  assert.equal(found[0].kind, "unreachable");
  // Nothing on Codex: nothing to check.
  assert.deepEqual(await preflight({ agents: { ...agents, models: { "model-a": "" } }, installedDir: tmp("none3"), repoDir: tmp("none4"), codexHome: home }), []);
});

test("a hold from preflight makes that vendor's turns wait, and doesn't stack on a longer wait", async () => {
  const copilot = new CopilotTurnAgent({ bin: "copilot-not-called", fallback: { agent: "author", model: "model-a" }, profileDirs: null, timeoutMs: 30_000 });
  const { h, clock } = await one(copilot, [{ id: "t", lane: "build", text: "t", writeScope: ["work"] }]);
  assert.equal(await h.hold("copilot", "setup", "agent profile af-x can't be loaded", 30), true);
  assert.equal(await h.hold("copilot", "setup", "agent profile af-x can't be loaded", 10), false, "a shorter hold adds nothing");
  const r = await h.tick({ id: "r1", capabilities: [] });
  assert.equal(r.turns.length, 0, "no turn starts while it holds");
  const s = await h.state();
  assert.equal(s.capacity.get("copilot")!.until, clock.now() + 30 * MIN);
  assert.equal(s.capacity.get("copilot")!.kind, "setup");
});

// ---------- questions the harness answers itself ----------

const goal = (g: Partial<GoalDef> & { id: string }): HEvent => {
  const d: GoalDef = { title: g.id, objective: "o", owner: "partner", scope: ["work"], assumptions: [], budget: { turns: 100 }, ...g };
  return { id: `goal-${d.id}`, at: T0, by: "partner", type: "goal_opened", goal: d, criteriaHash: criteriaHash(d) };
};
const todo = (g: string, d: TodoDraft & { id: string }): HEvent => ({ id: `add-${d.id}`, at: T0, by: "partner", type: "todo_added", todo: { ...d, goal: g }, provenance: "seed" });
const opened: HEvent = { id: "open", at: T0, by: "partner", type: "engagement_opened", engagement: { id: "e", title: "E", principals: { partner: "you" } } };
const st = (...events: HEvent[]): State => project([opened, ...events], plain);
const wt = tmp("wt");
let n = 0;
const validate = (s: State, todoId: string, output: TurnOutput, extra: Partial<Parameters<typeof validateTurn>[0]> = {}) =>
  validateTurn({ s, todo: s.todos.get(todoId)!, agent: "r1", turn: `turn-${++n}`, now: T0 + MIN, why: "test", output, files: ["work/a.ts"], checkFailures: [], checked: false, wtDir: wt, knownSources: [], ...extra });

test("a blocker on work the todo's own checker passed: the ask is opened and closed by the harness, and the todo is done", () => {
  const s = st(goal({ id: "G" }), todo("G", { id: "t", lane: "build", text: "fix the bug", writeScope: ["work"], check: "tests" }));
  const v = validate(s, "t", { done: false, blocker: "Fixed and tested. Should I close this todo?" }, { checked: true });
  assert.equal(v.result, "completed");
  const types = v.events.map((e) => e.type);
  assert.ok(types.includes("todo_done"));
  assert.ok(!types.includes("todo_blocked"));
  const op = v.events.find((e) => e.type === "ask_opened");
  const auto = v.events.find((e) => e.type === "ask_auto_closed");
  assert.ok(op && auto && auto.type === "ask_auto_closed" && op.type === "ask_opened");
  assert.equal(auto.ask, op.ask.id, "the auto-close is about a real ask, not a made-up answer");
  assert.equal(auto.reason, "criteria_met");
  assert.ok(!v.events.some((e) => e.type === "ask_answered"), "never dressed up as a person's answer");
  const after = project([opened, goal({ id: "G" }), todo("G", { id: "t", lane: "build", text: "fix the bug", writeScope: ["work"], check: "tests" }), ...v.events], plain);
  assert.equal(after.asks.get(op.ask.id)!.status, "auto_closed");
  assert.equal(after.asks.get(op.ask.id)!.autoReason, "criteria_met");
  assert.equal(after.todos.get("t")!.status, "done");

  // Without a checker that passed, a blocker still stops the work and asks.
  const v2 = validate(s, "t", { blocker: "Fixed and tested. Should I close this todo?" });
  assert.equal(v2.result, "blocked");
  assert.ok(!v2.events.some((e) => e.type === "ask_auto_closed"));
});

test("a question a person already answered, same words and options: the answer stands, and the agent is told", () => {
  const q = "Should the report use UTC dates?";
  const options = [{ id: "utc", label: "UTC" }, { id: "local", label: "Local time" }];
  const base = [goal({ id: "G" }), todo("G", { id: "t", lane: "build", text: "t", writeScope: ["work"] }), todo("G", { id: "u", lane: "build", text: "u", writeScope: ["work"] })];
  const first = validate(st(...base), "t", { asks: [{ question: q, options }] });
  const ask = first.events.find((e) => e.type === "ask_opened")!;
  assert.equal(ask.type, "ask_opened");
  const answered: HEvent = { id: "ans-1", at: T0 + 2 * MIN, by: "partner", type: "ask_answered", ask: ask.ask.id, answeredBy: "partner", choice: "utc", note: "always UTC" };
  const s = st(...base, ...first.events, answered);

  const again = validate(s, "u", { asks: [{ question: "should the report use  UTC dates", options: [...options].reverse() }] });
  const auto = again.events.find((e) => e.type === "ask_auto_closed");
  assert.ok(auto && auto.type === "ask_auto_closed");
  assert.equal(auto.reason, "precedent");
  assert.equal(auto.precedentAsk, ask.ask.id);
  assert.equal(auto.choice, "utc");
  const note = again.events.find((e) => e.type === "note");
  assert.ok(note && note.type === "note" && /chose "utc": always UTC/.test(note.text), "the next turn reads the answer");

  // Answers that change something by themselves are asked again.
  const risky = [{ id: "go", label: "Go", effect: { type: "revise" as const, pivot: true } }, { id: "stay", label: "Stay" }];
  const r1 = validate(st(...base), "t", { asks: [{ question: "Pivot?", options: risky }] });
  const rAsk = r1.events.find((e) => e.type === "ask_opened")!;
  assert.equal(rAsk.type, "ask_opened");
  const s2 = st(...base, ...r1.events, { id: "ans-2", at: T0 + 2 * MIN, by: "partner", type: "ask_answered", ask: rAsk.ask.id, answeredBy: "partner", choice: "go" });
  const r2 = validate(s2, "u", { asks: [{ question: "Pivot?", options: risky }] });
  assert.ok(!r2.events.some((e) => e.type === "ask_auto_closed"));

  // The harness's own answers (moot) are never precedent.
  const s3 = st(...base, ...first.events, { id: "moot-1", at: T0 + 2 * MIN, by: "harness", type: "ask_answered", ask: ask.ask.id, answeredBy: "harness", choice: "moot" });
  const r3 = validate(s3, "u", { asks: [{ question: q, options }] });
  assert.ok(!r3.events.some((e) => e.type === "ask_auto_closed"));
});
