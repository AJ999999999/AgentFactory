// The partner's panel and the controls behind it: pause, budget, the page's server,
// and the lock that lets the loop, the command line and the panel share a checkout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { acquireFileLock, lockIsStale } from "../src/git.ts";
import { createWorkspace } from "../src/foundation/workspace.ts";
import type { TurnAgent } from "../src/harness/agents.ts";
import { Harness } from "../src/harness/harness.ts";
import { LiveTurns } from "../src/harness/live.ts";
import { loadPolicy } from "../src/harness/project.ts";
import { blockers, readyTodos } from "../src/harness/select.ts";
import type { EngagementDef } from "../src/harness/types.ts";
import { SystemClock } from "../src/harness/world.ts";
import { answerFromBody, startPanel, Workspace } from "../src/panel/server.ts";
import { askView, splitLabel } from "../src/panel/view.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const policy = loadPolicy(path.join(ROOT, "policy", "harness.json"));
const tmp = (n: string) => fs.mkdtempSync(path.join(os.tmpdir(), `af-panel-${n}-`));
const noTurns: TurnAgent = { name: "none", run: async () => ({ note: "unused" }) };

// A small engagement whose first questions are waiting the moment it opens: the parent
// has a playtest to do, $500 of ads needs approving, and goal "h" has no turns at all.
const def = (): EngagementDef => ({
  id: "shop",
  title: "A game for one boy",
  principals: { partner: "you", parent: "the parent" },
  experts: ["parent"],
  goals: [
    {
      id: "g", title: "Game", objective: "A game he picks on his own", owner: "partner", scope: ["game"], budget: { turns: 10 },
      assumptions: [{ id: "A1", text: "He picks it on three days a week", category: "desirability", risk: 5, uncertainty: 5, loadBearing: true }],
      todos: [
        { id: "play", kind: "action", lane: "playtest", text: "Play it with him this week", assignee: "parent", tests: "A1" },
        { id: "ads", lane: "build", text: "Buy ads", cost: { usd: 500 } },
        { id: "core", lane: "build", text: "Build the core loop" },
      ],
    },
    { id: "h", title: "Levels", objective: "More levels", owner: "partner", scope: ["levels"], budget: { turns: 0 }, assumptions: [], todos: [{ id: "lv", lane: "build", text: "Ten levels" }] },
  ],
});

// A workspace laid out the way `npm run harness -- open` leaves it.
async function workspace(): Promise<{ dir: string; h: Harness }> {
  const dir = tmp("ws");
  const home = path.join(dir, ".af", "harness", "shop");
  const control = await createWorkspace({ dir: home });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ repo: control.cwd, remote: path.join(home, "origin.git") }));
  const h = new Harness({ control, engagement: "shop", policy, clock: new SystemClock(), world: {}, agent: noTurns, worktreeRoot: path.join(home, "wt") });
  await h.open(def());
  return { dir, h };
}

function request(port: number, opts: { method?: string; path: string; host?: string; token?: string; origin?: string; body?: unknown; type?: string }): Promise<{ status: number; body: string; json: () => any }> {
  return new Promise((resolve, reject) => {
    const data = opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    const req = http.request({
      host: "127.0.0.1", port, method: opts.method ?? (data ? "POST" : "GET"), path: opts.path,
      headers: {
        host: opts.host ?? `127.0.0.1:${port}`,
        ...(opts.token ? { "x-panel-token": opts.token } : {}),
        ...(opts.origin ? { origin: opts.origin } : {}),
        ...(data ? { "content-type": opts.type ?? "application/json", "content-length": Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode!, body, json: () => JSON.parse(body) }));
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// ---------- the controls ----------

test("pause: nothing new starts, not even a person's task; resume lets it all start again", async () => {
  const { h } = await workspace();
  let s = await h.state();
  assert.ok(readyTodos(s, Date.now(), { id: "r1", capabilities: ["shell"] }, new Set(), ["task"]).some((t) => t.id === "core"));
  assert.equal(await h.pause(true, "partner", "away this week"), true);
  assert.equal(await h.pause(true), false, "already paused");
  s = await h.state();
  assert.deepEqual(s.paused && { by: s.paused.by, reason: s.paused.reason }, { by: "partner", reason: "away this week" });
  assert.equal(readyTodos(s, Date.now(), { id: "r1", capabilities: ["shell"] }, new Set(), ["task", "job", "wait"]).length, 0);
  assert.ok(blockers(s, s.todos.get("core")!, Date.now()).includes("paused"));
  assert.equal(await h.pause(false), true);
  s = await h.state();
  assert.equal(s.paused, null);
  assert.deepEqual(blockers(s, s.todos.get("core")!, Date.now()), []);
});

test("a new budget answers the harness's own question about it, or is recorded as the partner's change", async () => {
  const { h } = await workspace();
  let s = await h.state();
  const out = [...s.asks.values()].find((a) => a.goal === "h" && a.origin === "rule:budget_exhausted");
  assert.ok(out && out.status === "open", "a goal with no turns asks at once");
  await h.setBudget("h", { turns: 30 });
  s = await h.state();
  assert.equal(s.asks.get(out.id)!.status, "answered");
  assert.equal(s.asks.get(out.id)!.choice, "raise");
  assert.equal(s.goals.get("h")!.def.budget.turns, 30);
  await h.setBudget("g", { turns: 25 });
  s = await h.state();
  assert.deepEqual(s.goals.get("g")!.def.budget, { turns: 25 });
  await assert.rejects(h.setBudget("g", { turns: -1 }), /0 or more/);
  await assert.rejects(h.setBudget("nope", { turns: 5 }), /no goal/);
});

// ---------- what the page shows ----------

test("options say what they need: a parenthesis that asks for something becomes the prompt", () => {
  assert.deepEqual(splitLabel("Send back (answer with what to fix)"), { label: "Send back", hint: "What to fix" });
  assert.deepEqual(splitLabel("Continue as planned (recorded with your reason)"), { label: "Continue as planned", hint: "Your reason" });
  assert.deepEqual(splitLabel("Reject (the todo is dropped)"), { label: "Reject (the todo is dropped)" }, "a consequence stays in the label");
  assert.deepEqual(splitLabel("Approve"), { label: "Approve" });
});

test("questions as the page shows them: what each option needs, and which can't be undone", async () => {
  const { h } = await workspace();
  const s = await h.state();
  const play = [...s.asks.values()].find((a) => a.todo === "play")!;
  const v = askView(s, "shop", play);
  assert.equal(v.to, "parent");
  assert.deepEqual(v.tests, { id: "A1", text: "He picks it on three days a week" });
  assert.deepEqual(v.options.map((o) => [o.id, o.needs, o.confirm, o.danger]), [["done", "observation", undefined, undefined], ["cannot", undefined, true, true]]);
  const spend = askView(s, "shop", [...s.asks.values()].find((a) => a.origin === "rule:money")!);
  assert.deepEqual(spend.options.map((o) => [o.id, o.confirm ?? false]), [["approve", false], ["reject", true]]);
  const out = askView(s, "shop", [...s.asks.values()].find((a) => a.origin === "rule:budget_exhausted")!);
  assert.equal(out.options.find((o) => o.id === "raise")!.needs, "budget");
  assert.deepEqual(out.budget, { turns: 0 });
  assert.ok(out.holds.includes("Ten levels"), "it shows the work it holds up");
});

// ---------- the server ----------

test("the panel: local requests only, a token on every call, and answers that land in the log", async () => {
  const { dir, h } = await workspace();
  const panel = await startPanel({ dir, policy, port: 0 });
  try {
    const port = panel.port;
    const page = await request(port, { path: "/" });
    assert.equal(page.status, 200);
    assert.ok(page.body.includes(panel.token) && !page.body.includes("__TOKEN__"));
    assert.equal((await request(port, { path: "/", host: `evil.example:${port}` })).status, 403, "a page elsewhere pointing its domain here is refused");
    assert.equal((await request(port, { path: "/api/state" })).status, 403, "no token");
    assert.equal((await request(port, { path: "/api/state", token: "x".repeat(panel.token.length) })).status, 403, "wrong token");

    const state = await request(port, { path: "/api/state", token: panel.token });
    assert.equal(state.status, 200);
    const eng = state.json().engagements[0];
    assert.equal(eng.id, "shop");
    assert.ok(eng.asks.length >= 3);
    assert.equal(eng.goals[0].turns.budget, 10);

    const play = eng.asks.find((a: { about?: string; question: string }) => a.question.startsWith("Play it"));
    const answer = { engagement: "shop", ask: play.id, choice: "done", relayed: true, note: "Played three days running", observation: { direction: "supports", metrics: { days_chosen: 3 }, runs: 1 } };
    assert.equal((await request(port, { path: "/api/answer", token: panel.token, origin: "https://evil.example", body: answer })).status, 403, "another site can't post");
    assert.equal((await request(port, { path: "/api/answer", token: panel.token, body: answer, type: "text/plain" })).status, 415);
    assert.equal((await request(port, { path: "/api/answer", token: panel.token, body: "{not json" })).status, 400);
    const ok = await request(port, { path: "/api/answer", token: panel.token, origin: `http://127.0.0.1:${port}`, body: answer });
    assert.equal(ok.status, 200, ok.body);
    let s = await h.state();
    assert.equal(s.asks.get(play.id)!.status, "answered");
    assert.equal(s.asks.get(play.id)!.answeredBy, "parent", "passed on for whoever it was for, when you say so");
    const f = [...s.findings.values()].find((x) => x.source === `ask:${play.id}`)!;
    assert.deepEqual([f.grade, f.direction, f.assumption, f.metrics], ["expert", "supports", "A1", { days_chosen: 3 }]);
    assert.equal(s.todos.get("play")!.status, "done");

    const again = await request(port, { path: "/api/answer", token: panel.token, body: answer });
    assert.ok(again.status >= 400 && /already answered/.test(again.json().error), "a second answer is refused with the reason");
    assert.equal((await request(port, { path: "/api/answer", token: panel.token, body: { ...answer, observation: { direction: "sideways" } } })).status, 400);

    assert.equal((await request(port, { path: "/api/pause", token: panel.token, body: { engagement: "shop", paused: true } })).status, 200);
    assert.equal((await request(port, { path: "/api/budget", token: panel.token, body: { engagement: "shop", goal: "g", budget: { turns: 40 } } })).status, 200);
    assert.equal((await request(port, { path: "/api/budget", token: panel.token, body: { engagement: "shop", goal: "g", budget: { turns: "lots" } } })).status, 400);
    assert.equal((await request(port, { path: "/api/pause", token: panel.token, body: { engagement: "../etc", paused: true } })).status, 400);
    s = await h.state();
    assert.ok(s.paused);
    assert.equal(s.goals.get("g")!.def.budget.turns, 40);
    const after = (await request(port, { path: "/api/state", token: panel.token })).json().engagements[0];
    assert.ok(after.paused);
  } finally {
    await panel.close();
  }
});

test("an answer counts as yours unless you say you're passing it on", async () => {
  const { dir, h } = await workspace();
  const ws = new Workspace(dir, policy);
  const play = [...(await h.state()).asks.values()].find((a) => a.todo === "play")!;
  await answerFromBody(ws, { engagement: "shop", ask: play.id, choice: "done", note: "I tried it myself", observation: { direction: "supports" } });
  const s = await h.state();
  assert.equal(s.asks.get(play.id)!.answeredBy, "partner");
  const f = [...s.findings.values()].find((x) => x.source === `ask:${play.id}`)!;
  assert.equal(f.author, "partner");
  assert.notEqual(f.grade, "expert", "the partner's own report isn't graded as the parent's");
});

test("the panel shows turns running on this PC with the end of their log, and asks the runner to stop one", async () => {
  const { dir } = await workspace();
  const live = new LiveTurns(path.join(dir, ".af", "harness", "shop", "turns"));
  const t = live.start({ turn: "core-1-ab12", todo: "core", goal: "g", text: "Build the core loop", runner: "pc-1", role: "builder", pid: process.pid, startedAt: Date.now(), until: Date.now() + 60_000 });
  t.log("→ Running command: npm test", "  exit 1");
  const panel = await startPanel({ dir, policy, port: 0 });
  try {
    const port = panel.port;
    const eng = (await request(port, { path: "/api/state", token: panel.token })).json().engagements[0];
    assert.equal(eng.running.length, 1);
    assert.deepEqual([eng.running[0].turn, eng.running[0].role, eng.running[0].stopping], ["core-1-ab12", "builder", false]);
    assert.ok(eng.running[0].tail.at(-1).endsWith("  exit 1"));
    assert.equal((await request(port, { path: "/api/stop", token: panel.token, body: { engagement: "shop", turn: "nope-1" } })).status, 400, "a turn that isn't running");
    assert.equal((await request(port, { path: "/api/stop", token: panel.token, body: { engagement: "../x", turn: "core-1-ab12" } })).status, 400);
    assert.equal((await request(port, { path: "/api/stop", body: { engagement: "shop", turn: "core-1-ab12" } })).status, 403, "no token");
    assert.equal(t.stopRequested(), false);
    assert.equal((await request(port, { path: "/api/stop", token: panel.token, body: { engagement: "shop", turn: "core-1-ab12" } })).status, 200);
    assert.equal(t.stopRequested(), true, "the runner sees the request");
    assert.equal((await request(port, { path: "/api/state", token: panel.token })).json().engagements[0].running[0].stopping, true);
    t.finish("stopped");
    assert.equal((await request(port, { path: "/api/state", token: panel.token })).json().engagements[0].running.length, 0);
  } finally {
    await panel.close();
  }
});

// ---------- one checkout, several processes ----------

test("the write lock holds across processes: a second process waits for the first", async () => {
  const dir = tmp("lock");
  const file = path.join(dir, "agentfactory.lock");
  const holder = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e",
    `import { acquireFileLock } from ${JSON.stringify(new URL("../src/git.ts", import.meta.url).href)};
     const release = await acquireFileLock(process.argv[1]);
     console.log("held");
     setTimeout(() => { console.log("released"); release(); }, 700);`, file], { stdio: ["ignore", "pipe", "inherit"] });
  const exited = new Promise((r) => holder.on("exit", r));
  const lines: string[] = [];
  await new Promise<void>((resolve) => holder.stdout.on("data", (c: Buffer) => {
    lines.push(...c.toString().split("\n").filter(Boolean));
    if (lines.includes("held")) resolve();
  }));
  const t0 = Date.now();
  const release = await acquireFileLock(file);
  const waited = Date.now() - t0;
  lines.push("parent");
  release();
  await exited;
  assert.ok(waited >= 400, `waited ${waited} ms`);
  assert.deepEqual(lines.slice(0, 3), ["held", "released", "parent"]);
  assert.ok(!fs.existsSync(file), "released");
});

test("a lock left by a process that died is taken over; one held by a live process is not", async () => {
  const dir = tmp("stale");
  const file = path.join(dir, "agentfactory.lock");
  const gone = spawn(process.execPath, ["-e", ""]);
  await new Promise((r) => gone.on("exit", r));
  const now = Date.now();
  assert.equal(lockIsStale({ pid: gone.pid!, host: os.hostname(), at: now }, now), true, "its process is gone");
  assert.equal(lockIsStale({ pid: gone.pid!, host: "another-pc", at: now }, now), false, "can't tell for another machine: wait it out");
  assert.equal(lockIsStale({ pid: gone.pid!, host: "another-pc", at: now - 11 * 60_000 }, now), true, "too old");
  assert.equal(lockIsStale({ at: now - 1000 }, now), false, "just created, not written yet");
  fs.writeFileSync(file, JSON.stringify({ pid: gone.pid, host: os.hostname(), at: now, token: "dead" }));
  const t0 = Date.now();
  const release = await acquireFileLock(file);
  assert.ok(Date.now() - t0 < 2000);
  assert.notEqual(JSON.parse(fs.readFileSync(file, "utf8")).token, "dead");
  release();
  assert.deepEqual(fs.readdirSync(dir), [], "nothing left behind");
});
