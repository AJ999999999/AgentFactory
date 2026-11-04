// Shipping: done work becomes a pull request on GitHub once you approve it; its checks come
// back as evidence, and a failure goes back to the work. GitHub is played by a local bare
// repository and a fake API.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { Git, initBare } from "../src/git.ts";
import { apply, loadPolicy, project, type State } from "../src/harness/project.ts";
import { answerEvents } from "../src/harness/answers.ts";
import { settle } from "../src/harness/rules.ts";
import { GitHubShip, type ShipDef } from "../src/harness/ship.ts";
import { ScriptedTurnAgent } from "../src/harness/agents.ts";
import { Sim } from "../src/harness/sim.ts";
import { criteriaHash } from "../src/harness/validate.ts";
import type { GoalDef, HEvent } from "../src/harness/types.ts";
import type { JobOutcome } from "../src/harness/world.ts";

const policy = { ...loadPolicy(path.join(import.meta.dirname, "..", "policy", "harness.json")), team: undefined };
const T0 = Date.parse("2026-11-04T09:00:00Z");
const tmp = (n: string) => fs.mkdtempSync(path.join(os.tmpdir(), `af-ship-${n}-`));
const ship: ShipDef = { repo: "acme/pay", dir: "app", lanes: ["fix"], maxFiles: 2 };

function state() {
  const g: GoalDef = { id: "G", title: "Payments", objective: "o", owner: "partner", scope: ["app"], assumptions: [], budget: { turns: 50 }, perpetual: true, ship };
  const s = project([
    { id: "open", at: T0, by: "partner", type: "engagement_opened", engagement: { id: "e", title: "E", principals: { partner: "you" } } },
    { id: "goal-G", at: T0, by: "partner", type: "goal_opened", goal: g, criteriaHash: criteriaHash(g) },
  ], policy);
  const done = (id: string, lane: string, files: string[], at: number) => {
    for (const e of [
      { id: `add-${id}`, at, by: "partner", type: "todo_added", todo: { id, goal: "G", lane, kind: "task", text: `Fix ${id}` }, provenance: "seed" },
      { id: `turn-${id}`, at, by: "r1", type: "turn", turn: { id: `turn-${id}`, todo: id, goal: "G", agent: "r1", result: "completed", granularity: "substantive", reasons: [], files } },
      { id: `done-${id}`, at, by: "harness", type: "todo_done", todo: id },
    ] as HEvent[]) apply(s, e);
    settle(s, at);
  };
  return { s, done };
}
const askFor = (s: State, todo: string) => [...s.asks.values()].find((a) => a.todo === todo && a.origin.startsWith("rule:ship"));
const jobFor = (s: State, todo: string) => [...s.todos.values()].find((t) => t.job?.spec?.ship === todo);

test("done work in a shipping goal asks first, and only an approval opens its pull request", () => {
  const { s, done } = state();
  done("t1", "fix", ["app/total.ts"], T0 + 1);
  done("t2", "docs", ["app/readme.md"], T0 + 1); // not a shipping lane
  done("t3", "fix", ["notes/x.md"], T0 + 1); // nothing under app
  const a = askFor(s, "t1")!;
  assert.match(a.question, /"Fix t1" is done and checked\. Open a pull request for it on acme\/pay\?/);
  assert.equal(a.origin, "rule:ship");
  assert.equal(askFor(s, "t2"), undefined);
  assert.equal(askFor(s, "t3"), undefined);
  assert.equal(jobFor(s, "t1"), undefined, "nothing pushed before you say so");
  for (const e of answerEvents(s, a.id, { by: "partner", choice: "approve" }, T0 + 2)) apply(s, e);
  settle(s, T0 + 2);
  const job = jobFor(s, "t1")!;
  assert.equal(job.kind, "job");
  assert.equal(job.lane, "ship");
  const { ship: what, repo, dir, base, api, tokenEnv } = job.job!.spec as Record<string, unknown>;
  assert.deepEqual({ what, repo, dir, base, api, tokenEnv }, { what: "t1", repo: "acme/pay", dir: "app", base: "main", api: "https://api.github.com", tokenEnv: "AF_GITHUB_TOKEN" });
});

test("'from now on' lets a lane open its pull requests without asking; a large change is always asked", () => {
  const { s, done } = state();
  done("t1", "fix", ["app/a.ts"], T0 + 1);
  for (const e of answerEvents(s, askFor(s, "t1")!.id, { by: "partner", choice: "approve", standing: true }, T0 + 2)) apply(s, e);
  settle(s, T0 + 2);
  done("t2", "fix", ["app/b.ts"], T0 + 3);
  assert.equal(askFor(s, "t2")!.status, "auto_closed", "your standing answer covers it");
  assert.ok(jobFor(s, "t2"));
  done("t3", "fix", ["app/a.ts", "app/b.ts", "app/c.ts"], T0 + 4);
  const big = askFor(s, "t3")!;
  assert.equal(big.origin, "rule:ship_large");
  assert.equal(big.status, "open", "more files than maxFiles: you look at it");
});

// A local bare repository plays GitHub's git; `api` plays its REST API.
function github() {
  const root = tmp("gh");
  const bare = path.join(root, "pay.git");
  initBare(bare);
  const seed = path.join(root, "seed");
  execFileSync("git", ["clone", "-q", bare, seed]);
  fs.writeFileSync(path.join(seed, "total.ts"), BASE);
  for (const args of [["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"], ["push", "-q", "origin", "HEAD:main"]]) execFileSync("git", args, { cwd: seed });
  const calls: Array<{ method: string; url: string; auth: string; body?: string }> = [];
  let checks: Array<{ name: string; status: string; conclusion: string | null }> = [];
  const api = async (url: string, init: { method?: string; headers: Record<string, string>; body?: string }) => {
    calls.push({ method: init.method ?? "GET", url, auth: init.headers.Authorization, ...(init.body ? { body: init.body } : {}) });
    const p = new URL(url).pathname;
    const json = (v: unknown) => ({ ok: true, status: 200, json: async () => v, text: async () => JSON.stringify(v) });
    if (p.endsWith("/pulls") && (init.method ?? "GET") === "GET") return json(calls.some((c) => c.method === "POST") ? [{ number: 41 }] : []);
    if (p.endsWith("/pulls")) return json({ number: 41 });
    if (p.includes("/check-runs")) return json({ check_runs: checks });
    return { ok: false, status: 404, json: async () => ({}), text: async () => "not found" };
  };
  return { root, bare, calls, api, setChecks: (c: typeof checks) => (checks = c) };
}

// The engagement's repo: a copy of the repository under app/, then the work's commits,
// each with its Todo trailer.
const BASE = "export const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);\n";
function engagementRepo(copy = true) {
  const dir = tmp("eng");
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  const git = new Git(dir);
  if (copy) {
    fs.mkdirSync(path.join(dir, "app"));
    fs.writeFileSync(path.join(dir, "app", "total.ts"), BASE);
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "the repository, copied"], { cwd: dir });
  }
  return {
    git,
    async work(todo: string, file: string, text: string) {
      fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), text);
      await git.runAsync(["add", "-A"]);
      await git.commitAll(`turn ${todo}: completed`, { Todo: todo });
    },
  };
}

test("the work's commits are replayed on af/<todo> from main, pushed with the token in git's environment, and the pull request opened", async () => {
  const gh = github();
  const eng = engagementRepo();
  await eng.work("t0", "app/other.ts", "export {}\n"); // another todo's work stays behind
  await eng.work("t1", "app/total.ts", "export const total = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;\n");
  await eng.work("t1", "app/total.test.ts", "// rounding\n");
  const argv: string[][] = [];
  const envs: NodeJS.ProcessEnv[] = [];
  const run = async (args: string[], o: { cwd: string; env?: NodeJS.ProcessEnv }) => {
    argv.push(args);
    envs.push(o.env ?? {});
    return execFileSync("git", args, { cwd: o.cwd, env: { ...process.env, ...o.env }, encoding: "utf8" }).trim();
  };
  const shipper = new GitHubShip({ control: eng.git, root: path.join(gh.root, "ship"), env: { ...process.env, AF_GITHUB_TOKEN: "s3cret" }, fetch: gh.api, run });
  const todo = { job: { spec: { ship: "t1", turns: 1, repo: "acme/pay", dir: "app", base: "main", api: "https://api.github.com", tokenEnv: "AF_GITHUB_TOKEN", remote: gh.bare, title: "Fix rounding" } } };
  const handle = await shipper.start(todo as never, T0);
  assert.match(handle, /^gh\|https:\/\/api\.github\.com\|acme\/pay\|41\|[0-9a-f]{40}\|\d+\|AF_GITHUB_TOKEN$/);

  const files = execFileSync("git", ["ls-tree", "-r", "--name-only", "af/t1"], { cwd: gh.bare, encoding: "utf8" }).trim().split("\n");
  assert.deepEqual(files, ["total.test.ts", "total.ts"], "only t1's work, at the repository's root");
  assert.match(execFileSync("git", ["show", "af/t1:total.ts"], { cwd: gh.bare, encoding: "utf8" }), /Math\.round/);
  assert.ok(!argv.flat().some((a) => a.includes("s3cret")), "the token is on no command line");
  assert.ok(envs.some((e) => (e.GIT_CONFIG_VALUE_0 ?? "").startsWith("AUTHORIZATION: basic ")), "it's in git's environment");
  const post = gh.calls.find((c) => c.method === "POST")!;
  assert.equal(post.auth, "Bearer s3cret");
  assert.deepEqual({ head: JSON.parse(post.body!).head, base: JSON.parse(post.body!).base }, { head: "af/t1", base: "main" });

  // The checks: running, then failed, as GitHub reports them.
  gh.setChecks([{ name: "test", status: "in_progress", conclusion: null }]);
  assert.equal((await shipper.poll(handle, T0 + 60_000)).status, "running");
  gh.setChecks([{ name: "test", status: "completed", conclusion: "failure" }, { name: "lint", status: "completed", conclusion: "success" }]);
  const failed = (await shipper.poll(handle, T0 + 120_000)) as JobOutcome & { note?: string };
  assert.equal(failed.status, "failed");
  assert.match(failed.note!, /checks failed on https:\/\/github\.com\/acme\/pay\/pull\/41: test \(failure\)/);

  // Shipped again after a fix: the same branch is updated, and the open pull request found.
  await eng.work("t1", "app/total.ts", "export const total = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100; // fixed\n");
  const again = await shipper.start(todo as never, T0 + 200_000);
  assert.match(again, /\|41\|/);
  assert.equal(gh.calls.filter((c) => c.method === "POST").length, 1, "no second pull request");
  gh.setChecks([{ name: "test", status: "completed", conclusion: "success" }]);
  assert.deepEqual((await shipper.poll(again, T0 + 300_000)).status, "succeeded");
});

test("a step that fails becomes a failed result, never an error in the wake: no token, or work that no longer applies", async () => {
  const gh = github();
  const eng = engagementRepo(false); // the work's first commit is the repository's first
  await eng.work("t1", "app/total.ts", "export const total = 1;\n");
  const todo = { job: { spec: { ship: "t1", turns: 1, repo: "acme/pay", dir: "app", base: "main", api: "https://api.github.com", tokenEnv: "AF_GITHUB_TOKEN", remote: gh.bare, title: "Fix" } } };
  const noToken = new GitHubShip({ control: eng.git, root: path.join(gh.root, "ship1"), env: {}, fetch: gh.api });
  const h1 = await noToken.start(todo as never, T0);
  assert.match((await noToken.poll(h1, T0)).status, /failed/);
  assert.match(((await noToken.poll(h1, T0)) as { note?: string }).note!, /set AF_GITHUB_TOKEN/);

  // main moved on under the same lines: the work doesn't apply.
  const other = path.join(gh.root, "other");
  execFileSync("git", ["clone", "-q", gh.bare, other]);
  fs.writeFileSync(path.join(other, "total.ts"), "export const total = 2; // someone else\n");
  for (const args of [["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "theirs"], ["push", "-q", "origin", "HEAD:main"]]) execFileSync("git", args, { cwd: other });
  await eng.work("t1", "app/total.ts", "export const total = 3;\n");
  const shipper = new GitHubShip({ control: eng.git, root: path.join(gh.root, "ship2"), env: { AF_GITHUB_TOKEN: "x", PATH: process.env.PATH }, fetch: gh.api });
  const h2 = await shipper.start(todo as never, T0);
  const r = (await shipper.poll(h2, T0)) as { status: string; note?: string };
  assert.equal(r.status, "failed");
  assert.match(r.note!, /doesn't apply on main any more/);
});

test("through the real harness: approved work's pull request fails its checks, the work goes back, and the fixed one passes", async () => {
  const shipped: string[] = [];
  const outcomes: JobOutcome[] = [{ status: "failed", metrics: { checks: 1, checks_failed: 1 }, note: "checks failed on https://github.com/acme/pay/pull/41: test (failure)" }, { status: "succeeded", metrics: { checks: 1, checks_failed: 0 }, note: "1 check passed on https://github.com/acme/pay/pull/41" }];
  const fakeShip = {
    async start(t: { id: string }) { shipped.push(t.id); return `fake-${shipped.length}`; },
    async poll(h: string): Promise<JobOutcome> { return outcomes[Number(h.split("-")[1]) - 1]; },
  };
  let fixes = 0;
  const agent = new ScriptedTurnAgent([{ name: "fix", when: (c) => c.todo.lane === "fix", run: (c) => {
    fixes++;
    fs.mkdirSync(path.join(c.wtDir, "app"), { recursive: true });
    fs.writeFileSync(path.join(c.wtDir, "app", "total.ts"), `export const v = ${fixes};\n`);
    return { done: true };
  } }]);
  const def = {
    id: "pay", title: "Pay", principals: { partner: "you" },
    goals: [{ id: "G", title: "Payments", objective: "o", owner: "partner", scope: ["app"], assumptions: [], budget: { turns: 20 }, perpetual: true, ship: { repo: "acme/pay", dir: "app" }, todos: [{ id: "fix-1", lane: "fix", text: "Round totals per invoice", writeScope: ["app"] }] }],
  };
  const sim = await Sim.create({
    dir: tmp("sim"), def, policy, start: "2026-11-04T09:00:00Z", agent, runners: [{ runner: { id: "r1", capabilities: ["shell"] } }], world: {}, ship: fakeShip as never,
    people: [{ role: "partner", answer: (a) => (a.origin === "rule:ship" ? { by: "partner", choice: "approve" } : null) }],
  });
  await sim.run({ until: "2026-11-05T09:00:00Z", maxIterations: 80 });
  const s = await sim.harness.state();
  assert.equal(fixes, 2, "the failed checks sent the work back once");
  assert.equal(shipped.length, 2, "and it was shipped again after the fix");
  assert.equal(s.todos.get("fix-1")!.status, "done");
  const notes = (await sim.harness.events()).filter((e) => e.type === "note").map((e) => (e as { text: string }).text);
  assert.ok(notes.some((n) => /checks failed on .*pull\/41/.test(n)));
  assert.ok(notes.some((n) => /1 check passed/.test(n)));
});

test("ship test says whether the identity can push without administering, and whether main needs a pull request", async () => {
  const fake = (perm: { admin: boolean; push: boolean }, rules: Array<{ type: string }>) => async (url: string) => {
    const p = new URL(url).pathname;
    const body = p.includes("/rules/branches/") ? rules : { default_branch: "main", permissions: perm };
    return { ok: true, status: 200, json: async () => body, text: async () => "" };
  };
  const { shipTest } = await import("../src/harness/ship.ts");
  const good = await shipTest(ship, { env: { AF_GITHUB_TOKEN: "t" }, fetch: fake({ admin: false, push: true }, [{ type: "pull_request" }, { type: "required_status_checks" }]) });
  assert.equal(good.ok, true, good.lines.join("\n"));
  const admin = await shipTest(ship, { env: { AF_GITHUB_TOKEN: "t" }, fetch: fake({ admin: true, push: true }, []) });
  assert.equal(admin.ok, false);
  assert.ok(admin.lines.some((l) => /administers the repository/.test(l)));
  assert.ok(admin.lines.some((l) => /no rule requiring a pull request/.test(l)));
  assert.match((await shipTest(ship, { env: {} })).lines[0], /AF_GITHUB_TOKEN isn't set/);
});

test("watching for the merge: merged is noted and the goal's production check runs once; closed without merging is noted and the work stays", async () => {
  const pulls: Record<string, { state: string; merged: boolean; merged_by?: { login: string } }> = { "41": { state: "open", merged: false } };
  const api = async (url: string) => ({ ok: true, status: 200, json: async () => pulls[new URL(url).pathname.split("/").pop()!], text: async () => "" });
  const shipper = new GitHubShip({ control: new Git(tmp("w")), root: tmp("wr"), env: { AF_GITHUB_TOKEN: "t" }, fetch: api as never });
  const handle = await shipper.start({ job: { spec: { watch: "gh|https://api.github.com|acme/pay|41|abc|0|AF_GITHUB_TOKEN" } } } as never, T0);
  assert.equal((await shipper.poll(handle, T0)).status, "running");
  pulls["41"] = { state: "closed", merged: true, merged_by: { login: "jack" } };
  const merged = (await shipper.poll(handle, T0)) as { status: string; note?: string };
  assert.equal(merged.status, "succeeded");
  assert.match(merged.note!, /acme\/pay\/pull\/41 was merged by jack/);
  pulls["41"] = { state: "closed", merged: false };
  assert.match(((await shipper.poll(handle, T0)) as { note?: string }).note!, /closed without merging/);

  // Through the harness: checks pass, the merge is seen, the production check runs.
  const fake = {
    async start(t: { job?: { spec?: Record<string, unknown> } }) { return t.job?.spec?.watch ? `watch|${t.job.spec.watch}` : "gh|https://api.github.com|acme/pay|41|abc|0|AF_GITHUB_TOKEN"; },
    async poll(h: string): Promise<JobOutcome> { return h.startsWith("watch|") ? { status: "succeeded", metrics: { merged: 1 }, note: "https://github.com/acme/pay/pull/41 was merged by jack" } : { status: "succeeded", metrics: { checks: 1, checks_failed: 0 }, note: "1 check passed on https://github.com/acme/pay/pull/41" }; },
  };
  const probed: string[] = [];
  const agent = new ScriptedTurnAgent([{ name: "fix", when: (c) => c.todo.lane === "fix", run: (c) => { fs.mkdirSync(path.join(c.wtDir, "app"), { recursive: true }); fs.writeFileSync(path.join(c.wtDir, "app", "a.ts"), "x\n"); return { done: true }; } }]);
  const def = { id: "pay2", title: "Pay", principals: { partner: "you" }, goals: [{ id: "G", title: "Payments", objective: "o", owner: "partner", scope: ["app"], assumptions: [], budget: { turns: 20 }, perpetual: true, ship: { repo: "acme/pay", dir: "app", syncMinutes: 0, check: "payments-health" }, todos: [{ id: "fix-1", lane: "fix", text: "Fix it", writeScope: ["app"] }] }] };
  const sim = await Sim.create({
    dir: tmp("sim2"), def, policy, start: "2026-11-04T09:00:00Z", agent, runners: [{ runner: { id: "r1", capabilities: ["shell"] } }], ship: fake as never,
    world: { probe: { async check(target: string) { probed.push(target); return { fingerprint: "ok", summary: "error rate 0.1%, p95 220 ms" }; } } },
    people: [{ role: "partner", answer: (a) => (a.origin === "rule:ship" ? { by: "partner", choice: "approve" } : null) }],
  });
  await sim.run({ until: "2026-11-05T09:00:00Z", maxIterations: 60 });
  const notes = (await sim.harness.events()).filter((e) => e.type === "note").map((e) => (e as { text: string }).text);
  assert.ok(notes.some((n) => /was merged by jack/.test(n)));
  assert.ok(notes.some((n) => n === "after the merge, payments-health: error rate 0.1%, p95 220 ms"));
  assert.deepEqual(probed, ["payments-health"], "once");
});

test("the engagement's copy keeps in step: the first look notes the base, a later change applies, one that clashes is noted and left", async () => {
  const gh = github();
  const push = (file: string, text: string, msg: string) => {
    const w = path.join(gh.root, `w-${msg}`);
    execFileSync("git", ["clone", "-q", gh.bare, w]);
    fs.writeFileSync(path.join(w, file), text);
    for (const args of [["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", msg], ["push", "-q", "origin", "HEAD:main"]]) execFileSync("git", args, { cwd: w });
  };
  const prev = process.env.AF_GITHUB_TOKEN;
  process.env.AF_GITHUB_TOKEN = "t";
  try {
    const def = { id: "pay3", title: "Pay", principals: { partner: "you" }, goals: [{ id: "G", title: "Payments", objective: "o", owner: "partner", scope: ["app"], assumptions: [], budget: { turns: 20 }, perpetual: true, ship: { repo: "acme/pay", dir: "app", remote: gh.bare, syncMinutes: 60 } }] };
    const sim = await Sim.create({
      dir: tmp("sim3"), def, policy, start: "2026-11-04T09:00:00Z", agent: new ScriptedTurnAgent([]), runners: [{ runner: { id: "r1", capabilities: ["shell"] } }], world: {}, people: [],
      seed: async (repo) => {
        fs.mkdirSync(path.join(repo.cwd, "app"), { recursive: true });
        fs.writeFileSync(path.join(repo.cwd, "app", "total.ts"), BASE);
        await repo.runAsync(["add", "-A"]);
        await repo.commitAll("the repository, copied", {});
        await repo.runAsync(["push", "-q", "origin", "HEAD:main"]);
      },
    });
    await sim.run({ until: "2026-11-04T09:30:00Z", maxIterations: 10 });
    let s = await sim.harness.state();
    assert.ok(s.shipSynced.get("G"), "the first look notes where the base is");
    push("other.ts", "export const other = 1;\n", "theirs");
    await sim.run({ until: "2026-11-04T10:30:00Z", maxIterations: 10 });
    s = await sim.harness.state();
    const copy = path.join(sim.harness.control.cwd, "app", "other.ts");
    await sim.harness.control.runAsync(["pull", "-q", "origin", "main"]).catch(() => {});
    assert.equal(fs.readFileSync(copy, "utf8"), "export const other = 1;\n", "what changed on the base is in the copy");
    // The copy changed total.ts's line one way, the base another: noted, left as it is.
    fs.writeFileSync(path.join(sim.harness.control.cwd, "app", "total.ts"), "export const total = 0; // ours\n");
    await sim.harness.control.runAsync(["commit", "-qam", "ours"]);
    await sim.harness.control.runAsync(["push", "-q", "origin", "HEAD:main"]);
    push("total.ts", "export const total = 9; // theirs\n", "clash");
    await sim.run({ until: "2026-11-04T11:30:00Z", maxIterations: 10 });
    const ev = (await sim.harness.events()).filter((e) => e.type === "ship_synced") as Array<{ applied: boolean; note?: string }>;
    assert.deepEqual(ev.map((e) => e.applied), [true, true, false]);
    assert.match(ev[2].note!, /doesn't apply to app/);
  } finally {
    if (prev === undefined) delete process.env.AF_GITHUB_TOKEN; else process.env.AF_GITHUB_TOKEN = prev;
  }
});
