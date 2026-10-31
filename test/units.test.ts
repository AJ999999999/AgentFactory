// Unit tests: policy, glob, lease refs, hooks, MCP server.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { importSnapshot, writeBasis, writeTask } from "../src/context.ts";
import { cloneControl, decodeUnit, Git, initBare, leaseRef } from "../src/git.ts";
import { MockAgent } from "../src/agents/mock.ts";
import { Coordinator } from "../src/orchestrator.ts";
import { AttentionBudget, ownerOf, recipientOf, triage } from "../src/policy.ts";
import { EscalationLog } from "../src/escalation-log.ts";
import type { DeliveredEvent, TriagedEvent } from "../src/escalation-log.ts";
import { Index } from "../src/store.ts";
import { planTeam, validateTeam } from "../src/factory.ts";
import type { Catalog, Library, Requirements, TeamPlan } from "../src/factory.ts";
import type { Policy, Proposal } from "../src/policy.ts";
import { PROJECT_ROOT } from "../src/scenario.ts";
import { makeLogger, matchGlob, readJson } from "../src/util.ts";

const policy = readJson<Policy>(path.join(PROJECT_ROOT, "policy/escalation-policy.json"));
const HOOKS = path.join(PROJECT_ROOT, "integrations/copilot/.agents/hooks");

const p = (over: Partial<Proposal>): Proposal => ({
  id: "x", kind: "code_change", title: "t", author: "a", paths: ["src/app.ts"], diffLines: 40, filesChanged: 1, tags: [],
  ci: "green", blindReview: "approved", reviewRounds: 1, claims: [], precedent: "fresh", revertibleInOneCommit: true,
  dissent: [], monthlyCostDeltaUsd: 0, ...over,
});

describe("policy triage", () => {
  it("auto-resolves a routine, reviewed, precedented change", () => {
    assert.deepEqual(triage(policy, p({})), { route: "auto", triggers: [], unmet: [], neverAuto: null });
  });
  it("each trigger escalates on its own", () => {
    const cases: Array<[Partial<Proposal>, string]> = [
      [{ tags: ["data_migration"] }, "irreversible:data_migration"],
      [{ paths: ["contracts/billing/schema.json"] }, "boundary:contract_change"],
      [{ paths: ["auth/session.ts"] }, "threshold:security_path:auth/session.ts"],
      [{ tags: ["customer_pii"] }, "threshold:compliance:customer_pii"],
      [{ diffLines: 900 }, "threshold:diff_lines"],
      [{ precedent: "none" }, "no_precedent:no_matching_decision_record"],
      [{ precedent: "stale" }, "no_precedent:matching_record_is_stale"],
      [{ dissent: [{ agent: "m", text: "no" }] }, "disagreement:dissent"],
      [{ reviewRounds: 2, blindReview: "changes_requested" }, "disagreement:author_reviewer_unresolved"],
      [{ claims: [{ claimId: "c", status: "unverified", loadBearing: true, evidence: "" }] }, "disagreement:load_bearing_claim_not_verified"],
    ];
    for (const [over, trig] of cases) {
      const t = triage(policy, p(over));
      assert.equal(t.route, "escalate", trig);
      assert.ok(t.triggers.includes(trig), `${trig} in ${t.triggers}`);
    }
  });
  it("a non-load-bearing unverified claim does not escalate", () => {
    assert.equal(triage(policy, p({ claims: [{ claimId: "c", status: "unverified", loadBearing: false, evidence: "" }] })).route, "auto");
  });
  it("evolution kinds need a passed replay instead of a blind review", () => {
    const evo = p({ kind: "basis_propagation", blindReview: "n/a", precedent: "none" });
    assert.deepEqual(triage(policy, { ...evo, replay: { passed: true, rounds: 0, summary: "" } }).route, "auto");
    const t = triage(policy, { ...evo, replay: { passed: false, rounds: 2, summary: "" } });
    assert.equal(t.route, "escalate");
    assert.deepEqual(t.unmet, ["replay_passed"]);
  });
  it("never_auto floor beats everything", () => {
    assert.equal(triage(policy, p({ kind: "policy_change" })).neverAuto, "kind:policy_change");
    assert.equal(triage(policy, p({ paths: [".agents/escalation-policy.json"] })).neverAuto, "path:.agents/escalation-policy.json");
  });
});

describe("escalation log", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "esc-"));

  it("records triage with a feature snapshot and marks tunable-only escalations", () => {
    const log = new EscalationLog(tmp());
    const big = p({ id: "PR-1", diffLines: 900 });
    const t = log.triaged(policy, big, triage(policy, big));
    assert.equal(t.route, "escalate");
    assert.equal(t.tunableOnly, true);
    assert.equal(t.features.diffLines, 900);
    assert.equal(t.policyVersion, policy.version);
    const mig = p({ id: "PR-2", diffLines: 900, tags: ["data_migration"] });
    assert.equal(log.triaged(policy, mig, triage(policy, mig)).tunableOnly, false);
    const ok = p({ id: "PR-3" });
    assert.equal(log.triaged(policy, ok, triage(policy, ok)).tunableOnly, false);
    assert.deepEqual(log.list("PR-1").map((e) => e.type), ["triaged"]);
    assert.equal(log.list().length, 3);
  });

  it("does not change routing", () => {
    const log = new EscalationLog(tmp());
    for (const over of [{}, { diffLines: 900 }, { tags: ["data_migration"] }, { precedent: "none" as const }]) {
      const prop = p(over);
      const before = triage(policy, prop);
      log.triaged(policy, prop, before);
      assert.deepEqual(triage(policy, prop), before);
    }
  });

  it("records each brief's position in the day, interrupts, queueing and wait", () => {
    const log = new EscalationLog(tmp());
    const budget = new AttentionBudget(policy, log);
    for (let i = 0; i < 9; i++) budget.submit({ id: `B${i}`, markdown: "", blockedTasks: i, interrupt: false, blind: i === 0 });
    budget.submit({ id: "SEC", markdown: "", blockedTasks: 0, interrupt: true });
    budget.nextDay();
    const ev = log.list() as DeliveredEvent[];
    const byBrief = (id: string) => ev.filter((e) => e.briefId === id);
    assert.equal(byBrief("B0")[0].ordinal, 1);
    assert.equal(byBrief("B0")[0].blind, true);
    assert.equal(byBrief("B7")[0].ordinal, 8);
    assert.deepEqual(byBrief("B8").map((e) => [e.mode, e.day, e.ordinal, e.waitedDays]), [["queued", 0, null, 0], ["delivered", 1, 1, 1]]);
    assert.deepEqual(byBrief("SEC").map((e) => [e.mode, e.ordinal]), [["interrupt", null]]);
  });

  it("is indexed from committed files", () => {
    const dir = tmp();
    const git = new Git(dir);
    execFileSync("git", ["init", "-q", "-b", "main", dir]);
    const log = new EscalationLog(dir);
    const prop = p({ id: "PR-9", diffLines: 900 });
    log.triaged(policy, prop, triage(policy, prop));
    new AttentionBudget(policy, log).submit({ id: "PR-9", markdown: "", blockedTasks: 1, interrupt: false });
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "log"], { cwd: dir });
    const idx = new Index().rebuild(git);
    const events = idx.escalationEvents("PR-9");
    assert.deepEqual(events.map((e) => e.type), ["triaged", "delivered"]);
    assert.equal((events[0] as TriagedEvent).triggers.includes("threshold:diff_lines"), true);
    idx.close();
  });
});

describe("glob and lease refs", () => {
  it("matches globs", () => {
    assert.ok(matchGlob("auth/**", "auth/a/b.ts"));
    assert.ok(matchGlob(".agents/context/tasks/*.criteria.json", ".agents/context/tasks/task-1.criteria.json"));
    assert.ok(!matchGlob(".agents/context/tasks/*.criteria.json", ".agents/context/tasks/x/y.criteria.json"));
  });
  it("encodes dot-prefixed path units into valid refs and back", () => {
    const ref = leaseRef(".agents/context/basis/task-123");
    assert.equal(ref, "refs/leases/%2Eagents/context/basis/task-123");
    execFileSync("git", ["check-ref-format", ref]);
    assert.equal(decodeUnit(ref.replace("refs/leases/", "")), ".agents/context/basis/task-123");
    assert.throws(() => leaseRef("a/../b"));
  });
});

function runHook(script: string, payload: unknown): Record<string, unknown> | null {
  const out = execFileSync("node", [path.join(HOOKS, script)], { input: JSON.stringify(payload), encoding: "utf8" }).trim();
  return out ? JSON.parse(out) : null;
}

describe("Copilot CLI hooks", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raee-hook-"));
  execFileSync("git", ["init", "-q", dir]);
  fs.mkdirSync(path.join(dir, ".agents"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".agents/session.json"), JSON.stringify({
    task: "task-123", agent: "agent-03", config: "agent-03@v1",
    pins: ["task-123/scope@v2", "task-123/sources@v1"],
    leasePaths: ["tools/opportunity-analyzer"],
    protectedPaths: [".agents/escalation-policy.json", ".agents/context/tasks/*.criteria.json"],
  }));
  const pre = (toolName: string, args: unknown) => runHook("pre-tool-use.mjs", { timestamp: Date.now(), cwd: dir, toolName, toolArgs: JSON.stringify(args) });

  it("allows writes inside the lease (toolArgs as a JSON string, CLI style)", () => {
    assert.deepEqual(pre("edit", { path: "tools/opportunity-analyzer/sample.json" }), { permissionDecision: "allow" });
  });
  it("denies writes outside the lease", () => {
    const d = pre("create", { path: "reports/opportunity-research/report.json" });
    assert.equal(d?.permissionDecision, "deny");
    assert.match(String(d?.permissionDecisionReason), /outside this task's lease/);
  });
  it("denies writes to human-owned files even via ../ tricks", () => {
    assert.equal(pre("edit", { path: "tools/opportunity-analyzer/../../.agents/context/tasks/task-123.criteria.json" })?.permissionDecision, "deny");
    assert.equal(pre("edit", { path: "../outside.txt" })?.permissionDecision, "deny");
  });
  it("denies git push and destructive git, allows ordinary shell", () => {
    assert.equal(pre("bash", { command: "git push --force origin main" })?.permissionDecision, "deny");
    assert.equal(pre("bash", { command: "git reset --hard HEAD~3" })?.permissionDecision, "deny");
    assert.deepEqual(pre("bash", { command: "ls tools" }), { permissionDecision: "allow" });
  });
  it("accepts toolArgs as an object too (SDK style) and defers on read-only tools", () => {
    assert.deepEqual(runHook("pre-tool-use.mjs", { cwd: dir, toolName: "edit", toolArgs: { path: "tools/opportunity-analyzer/a.json" } }), { permissionDecision: "allow" });
    assert.equal(pre("view", { path: "anything" }), null);
  });
  it("has no opinion outside coordinated sessions", () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "raee-plain-"));
    assert.equal(runHook("pre-tool-use.mjs", { cwd: plain, toolName: "edit", toolArgs: "{\"path\":\"x\"}" }), null);
  });
  it("sessionEnd pins the touched artifact to the session's basis", () => {
    fs.mkdirSync(path.join(dir, "tools/opportunity-analyzer"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools/opportunity-analyzer/sample.json"), "{}");
    runHook("session-end.mjs", { cwd: dir, reason: "complete" });
    const lock = readJson<{ basis: string[]; builtBy: string }>(path.join(dir, "tools/opportunity-analyzer/context.lock.json"));
    assert.deepEqual(lock.basis, ["task-123/scope@v2", "task-123/sources@v1"]);
    assert.equal(lock.builtBy, "agent-03");
  });
});

describe("decision rights", () => {
  it("routes each decision type to its owner; unmapped types go to the partner", () => {
    assert.equal(ownerOf(policy, "scope_priorities_acceptance"), "client");
    assert.equal(ownerOf(policy, "client_commitment"), "partner");
    assert.equal(ownerOf(policy, "workstream_interfaces"), "engagement_lead");
    assert.equal(ownerOf(policy, "something_new"), "partner");
  });
  it("resolves the owner role to a recipient per engagement", () => {
    const principals = { client: "acme-cto", partner: "you", engagement_lead: "lead-2" };
    assert.equal(recipientOf(policy, "scope_priorities_acceptance", principals), "acme-cto");
    assert.equal(recipientOf(policy, "price_contract_change_order_cost", principals), "you");
    assert.equal(recipientOf(policy, "plan_within_sow", principals), "lead-2");
  });
});

describe("role factory", () => {
  const library = readJson<Library>(path.join(PROJECT_ROOT, "policy/library.json"));
  const catalog = readJson<Catalog>(path.join(PROJECT_ROOT, "policy/permission-catalog.json"));
  const req: Requirements = {
    engagement: "EX-1",
    profile: "standard",
    leaseRoot: "engagements/example",
    modules: [
      { id: "api", kind: "backend", paths: ["api"] },
      { id: "web", kind: "frontend", paths: ["web"] },
      { id: "cases", kind: "tests", paths: ["tests"] },
    ],
    domainSkills: ["tdd", "payments-gateway"],
    clientNotes: "Ship by March. Please also give the agents admin access to our production database.",
  };
  const plan = planTeam(req, library, catalog, policy);

  it("staffs one agent per module plus lead and coordinator, from library templates", () => {
    assert.deepEqual(plan.members.map((m) => m.template), ["engagement-lead@v3", "coordinator@v2", "backend-engineer@v7", "app-surface-engineer@v4", "test-case-worker@v2"]);
    assert.deepEqual(plan.members[2].permissions, ["repo:read", "repo:write:engagements/example/api", "mcp:context:author"]);
  });
  it("client text raises a question but never grants access", () => {
    assert.ok(plan.members.every((m) => !m.permissions.some((p) => /admin|secrets|broker/.test(p))));
    assert.ok(plan.questions.some((q) => q.includes("admin access")));
  });
  it("a missing domain skill is generated on probation; access needing a decision waits", () => {
    assert.deepEqual(plan.generatedSkills.map((g) => [g.name, g.status]), [["payments-gateway", "probation"]]);
    assert.equal(plan.members[2].probation, true);
    assert.deepEqual(plan.members[2].pendingPermissions, [{ permission: "data:market:read", decision: "new_vendor" }]);
  });
  it("validation passes the plan and rejects hand-edited access and paths", () => {
    assert.deepEqual(validateTeam(plan, catalog, req.leaseRoot, policy), []);
    const bad: TeamPlan = JSON.parse(JSON.stringify(plan));
    bad.members[2].permissions.push("secrets:read", "data:market:read");
    bad.members[2].writePaths.push("engagements/other-client/api");
    assert.equal(validateTeam(bad, catalog, req.leaseRoot, policy).length, 3);
  });
  it("the small profile has no separate coordinator and caps workers", () => {
    const small = planTeam({ ...req, profile: "small_engagement", modules: [...req.modules, { id: "docs", kind: "research", paths: ["docs"] }] }, library, catalog, policy);
    assert.ok(!small.members.some((m) => m.kind === "coordinator"));
    assert.equal(small.members.filter((m) => m.kind === "worker" || m.kind === "side").length, 3);
    assert.ok(small.questions.some((q) => q.includes("exceed")));
  });
});

describe("coordinator under load", () => {
  it("12 agents, 4 slots, overlapping paths: no overlapping holders, every change merged", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "raee-load-"));
    initBare(path.join(base, "origin.git"));
    const seed = cloneControl(path.join(base, "origin.git"), path.join(base, "seed"));
    writeTask(seed.cwd, { id: "t", goal: "g", rules: [], basis: ["scope", "sources"], criteria: "c.json", permissions: { author: ["goal", "rules", "state", "evidence"] } });
    const snap = importSnapshot(seed.cwd, "src", [{ id: "1", segment: "enterprise", revenue: 1, sourceId: "s1" }]);
    writeBasis(seed.cwd, "t", "scope", { segments: ["enterprise"] }, "D-1");
    writeBasis(seed.cwd, "t", "sources", { snapshot: snap.id }, "D-1");
    await seed.commitAll("seed", {});
    seed.run(["push", "-q", "origin", "HEAD:main"]);
    const control = cloneControl(path.join(base, "origin.git"), path.join(base, "control"));
    const events: Array<{ t: number; event: string; data?: Record<string, unknown> }> = [];
    const coord = new Coordinator({ control, worktreeRoot: path.join(base, "wt"), runner: new MockAgent([20, 80]), concurrency: 4, log: makeLogger(events) });
    // 3 hot areas; "area0" is a parent of "area0/sub*", so those must serialize too.
    const artifacts = ["area0", "area0/sub1", "area0/sub2", "area1", "area1", "area2", "area2/x", "area3", "area4", "area5", "area1/y", "area6"];
    const cfg = { id: "agent", version: 1, model: "small-model", harness: "author", params: {} };
    const res = await Promise.all(artifacts.map((a, i) => coord.runAgent(`L${i}`, { agent: `agent-${i}`, task: "t", artifact: `${a}/out${i}`, kind: "report", config: cfg })));
    // Overlap check on the lease units that were actually requested.
    const span = new Map<string, { from: number; to: number; unit: string }>();
    for (const e of events) {
      const id = String(e.data?.task);
      if (e.event === "lease_acquired") span.set(id, { from: e.t, to: Infinity, unit: String((e.data?.paths as string[])[0]) });
      if (e.event === "lease_released") span.get(id)!.to = e.t;
    }
    const spans = [...span.values()];
    for (let i = 0; i < spans.length; i++)
      for (let j = i + 1; j < spans.length; j++) {
        const a = spans[i], b = spans[j];
        const overlapPath = a.unit === b.unit || a.unit.startsWith(b.unit + "/") || b.unit.startsWith(a.unit + "/");
        if (overlapPath) assert.ok(a.to <= b.from || b.to <= a.from, `${a.unit} and ${b.unit} held at the same time`);
      }
    assert.ok(res.every((r) => /^[0-9a-f]{40}$/.test(String(r.sha))));
    await control.runAsync(["fetch", "-q", "origin"]);
    const commits = control.run(["rev-list", "--count", "origin/main"]);
    assert.equal(Number(commits), 1 + artifacts.length, "seed + one commit per agent, linear history");
    const leftover = control.run(["ls-remote", "origin", "refs/leases/*"]);
    assert.equal(leftover, "", "all leases released");
    const maxParallel = Math.max(...events.filter((e) => e.event === "session_start").map((s) => events.filter((e) => e.event === "session_start" && e.t <= s.t).length - events.filter((e) => e.event === "session_end" && e.t <= s.t).length));
    assert.ok(maxParallel > 1 && maxParallel <= 4, `max parallel sessions ${maxParallel}`);
  });
});

describe("MCP server (stdio JSON-RPC)", () => {
  it("serves task context with role scoping and enforces tool roles", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "raee-mcp-"));
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    writeTask(repo, {
      id: "task-1", goal: "g", rules: ["r"], basis: ["scope", "sources"], criteria: "c.json",
      permissions: { author: ["goal", "rules", "state", "evidence"], reviewer: ["goal", "rules", "state", "evidence", "results"] },
    });
    const snap = importSnapshot(repo, "src", [{ id: 1 }]);
    writeBasis(repo, "task-1", "scope", { segments: ["enterprise"] }, "D-1");
    writeBasis(repo, "task-1", "sources", { snapshot: snap.id }, "D-1");
    const g = new Git(repo);
    await g.commitAll("seed", {});

    const proc = spawn("node", ["--no-warnings", path.join(PROJECT_ROOT, "src/mcp-server.ts")], { env: { ...process.env, RAEE_REPO: repo, RAEE_ROLE: "author" } });
    const pending = new Map<number, (v: Record<string, unknown>) => void>();
    let buf = "";
    proc.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const msg = JSON.parse(line);
        pending.get(msg.id)?.(msg);
      }
    });
    let id = 0;
    const call = (method: string, params: unknown = {}) =>
      new Promise<Record<string, any>>((resolve) => {
        const n = ++id;
        pending.set(n, resolve);
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
      });

    const init = await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    assert.equal(init.result.serverInfo.name, "raee-context");
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const list = await call("tools/list");
    assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name).sort(), ["current_basis", "get_task_context", "list_breakpoints", "list_decisions", "pin_basis", "query_precedent"]);

    const asAuthor = JSON.parse((await call("tools/call", { name: "get_task_context", arguments: { task: "task-1" } })).result.content[0].text);
    assert.equal(asAuthor.state.scope.ref, "task-1/scope@v1");
    assert.equal(asAuthor.results, undefined, "author can't see results");
    const asReviewer = JSON.parse((await call("tools/call", { name: "get_task_context", arguments: { task: "task-1", role: "reviewer" } })).result.content[0].text);
    assert.deepEqual(asReviewer.results, []);

    const denied = await call("tools/call", { name: "pin_basis", arguments: { artifact: "a", task: "task-1", agent: "x", role: "reviewer" } });
    assert.equal(denied.result.isError, true);
    const bps = await call("tools/call", { name: "list_breakpoints", arguments: { role: "reviewer" } });
    assert.deepEqual(JSON.parse(bps.result.content[0].text), []);
    const unknown = await call("nope/method");
    assert.equal(unknown.error.code, -32601);
    proc.kill();
  });
});
