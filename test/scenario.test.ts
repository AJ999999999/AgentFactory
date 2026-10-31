// End-to-end: the whole loop on a real git remote, with mock agents.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { readLockfile } from "../src/context.ts";
import { runScenario } from "../src/scenario.ts";
import type { ScenarioResult } from "../src/scenario.ts";
import { Git } from "../src/git.ts";

let r: ScenarioResult;
let base: string;

before(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "raee-test-"));
  r = await runScenario({ baseDir: base });
});
after(() => fs.rmSync(base, { recursive: true, force: true }));

describe("phase 1: parallel agents under leases", () => {
  it("runs non-overlapping tasks concurrently", () => {
    const t1 = r.phase1.find((t) => t.id === "T1-report")!;
    const others = r.phase1.filter((t) => t.id !== "T1-report");
    assert.ok(others.some((o) => o.startedAt < t1.endedAt && t1.startedAt < o.endedAt), "T1 overlapped another task");
  });
  it("serializes overlapping leases (tools vs tools/opportunity-analyzer)", () => {
    const t2 = r.phase1.find((t) => t.id === "T2-analyzer")!;
    const t3 = r.phase1.find((t) => t.id === "T3-tools-docs")!;
    assert.equal([t2, t3].filter((t) => t.waitedForLease).length, 1, "exactly one of them waited");
    const acquired = r.log.filter((e) => e.event === "lease_acquired" && ["T2-analyzer", "T3-tools-docs"].includes(String(e.data?.task)));
    const released = r.log.filter((e) => e.event === "lease_released" && ["T2-analyzer", "T3-tools-docs"].includes(String(e.data?.task)));
    assert.equal(acquired.length, 2);
    // the second acquisition happens after the first release
    assert.ok(acquired[1].t >= released[0].t);
  });
  it("merged every task to main", () => {
    for (const t of r.phase1) assert.match(String(t.sha), /^[0-9a-f]{40}$/);
  });
});

describe("phase 2: basis change", () => {
  it("escalates and never auto-resolves", () => {
    assert.equal(r.basisChange.triage.route, "escalate");
    assert.ok(r.basisChange.triage.triggers.includes("basis_change:scope_or_definition_change"));
  });
  it("blind brief hides the recommendation", () => {
    assert.match(r.basisChange.brief, /A · confidence: medium/);
    assert.doesNotMatch(r.basisChange.blindBrief, /confidence: medium/);
    assert.match(r.basisChange.blindBrief, /hidden until you rule/);
  });
});

describe("phases 4-5: Observator -> Solver -> Evaluator -> adopt", () => {
  it("Observator finds exactly the stale analyzer, not the rebuilt report or the unpinned docs", () => {
    assert.deepEqual(
      r.observeBefore.breakpoints.map((b) => [b.artifact, b.pinned, b.current]),
      [["tools/opportunity-analyzer", "task-123/scope@v1", "task-123/scope@v2"]],
    );
    assert.deepEqual(r.observeBefore.unpinned, []);
  });
  it("replay: baseline fails the current basis, candidate passes and costs less", () => {
    const v = r.propagation.verdict;
    assert.equal(v.baseline.passRate, 0);
    assert.equal(v.candidate.passRate, 1);
    assert.equal(v.candidate.redLineViolations, 0);
    assert.ok(v.candidate.medianCost < v.baseline.medianCost);
    assert.equal(v.passed, true);
  });
  it("all load-bearing claims verified by lookup", () => {
    assert.deepEqual(r.propagation.claims.map((c) => c.status), ["verified", "verified", "verified"]);
  });
  it("policy auto-resolves propagation and the fix lands on main", () => {
    assert.equal(r.propagation.triage.route, "auto");
    assert.equal(r.propagation.portfolio.status, "adopted");
    assert.deepEqual(r.observeAfter.breakpoints, []);
    const control = new Git(r.dirs.control);
    control.run(["checkout", "-q", "--detach", "origin/main"]);
    const lock = readLockfile(r.dirs.control, "tools/opportunity-analyzer")!;
    assert.deepEqual(lock.basis, ["task-123/scope@v2", "task-123/sources@v1"]);
    const sample = JSON.parse(fs.readFileSync(path.join(r.dirs.control, "tools/opportunity-analyzer/sample.json"), "utf8"));
    assert.ok(sample.records.every((x: { segment: string }) => x.segment === "enterprise"));
    assert.ok(sample.records.every((x: Record<string, unknown>) => !("email" in x)));
  });
});

describe("phase 6: the loop refuses what it should", () => {
  it("red-line failure is revised once, then passes", () => {
    assert.equal(r.configLeak.outcome, "adopt");
    assert.equal(r.configLeak.rounds, 1);
    assert.equal(r.configLeak.triage.route, "auto");
  });
  it("cost regression with no remedy stops and escalates", () => {
    assert.equal(r.configWasteful.outcome, "escalate");
    assert.ok(r.configWasteful.verdict.failures.some((f) => f.startsWith("cost:+")));
    assert.equal(r.configWasteful.triage.route, "escalate");
    assert.ok(r.configWasteful.triage.unmet.includes("replay_passed"));
  });
  it("a candidate that edits frozen criteria is rejected outright", () => {
    assert.equal(r.tamper.outcome, "escalate");
    assert.match(String(r.tamper.verdict.rejectedReason), /^criteria_tampered:/);
  });
  it("criteria edits are never auto-resolved, even with an approved review", () => {
    assert.equal(r.tamper.triageCriteriaEdit.route, "escalate");
    assert.match(String(r.tamper.triageCriteriaEdit.neverAuto), /criteria\.json$/);
  });
  it("verdicts follow the pass-rate rule (1 run vs 5 runs)", () => {
    for (const v of [r.noise.single, r.noise.five]) assert.equal(v.passed, v.candidate.passRate >= 0.66 && v.candidate.redLineViolations === 0 && !v.failures.some((f) => f.startsWith("cost:")));
    assert.equal(r.noise.five.candidate.runs, 5);
  });
  it("contract change with an unverifiable claim and dissent escalates with both in the brief", () => {
    assert.equal(r.contract.triage.route, "escalate");
    assert.equal(r.contract.claims[0].status, "unverified");
    assert.match(r.contract.brief, /partner-webhook has no contract on file/);
    assert.match(r.contract.brief, /reporting-maintainer: "Dual fields/);
  });
});

describe("phase 7: trust ledger and staleness", () => {
  it("demotes the agent whose commit was reverted, from git history alone", () => {
    const a4 = r.ledger.find((a) => a.agent === "agent-04")!;
    assert.equal(a4.reverted, 1);
    assert.equal(a4.demoted, true);
    const a1 = r.ledger.find((a) => a.agent === "agent-01")!;
    assert.equal(a1.demoted, false);
    assert.ok(a1.survival > 0 && a1.survival <= 1);
  });
  it("a decision goes stale when its bound path changes", () => {
    assert.equal(r.staleness.before, "fresh");
    assert.equal(r.staleness.after, "stale");
  });
});

describe("phases 8-9: attention budget and lease atomicity", () => {
  it("caps briefs at 8/day, queues the rest, lets interrupts through", () => {
    const n = (s: string) => r.budget.results.filter((x) => x === s).length;
    assert.equal(n("delivered"), 8);
    assert.equal(n("queued"), 2);
    assert.equal(n("interrupt"), 1);
    assert.equal(r.budget.backpressure, true);
    assert.equal(r.budget.nextDay, 2);
  });
  it("logs every triage and every brief to the escalation log", () => {
    const triaged = r.escalations.filter((e) => e.type === "triaged");
    const delivered = r.escalations.filter((e) => e.type === "delivered");
    assert.equal(triaged.length, 6);
    // 11 submits on day 0, then the 2 queued briefs delivered on day 1.
    assert.equal(delivered.length, 13);
    const contract = triaged.find((e) => e.proposalId === "PR-billing-v4");
    assert.equal(contract?.route, "escalate");
    assert.equal(contract?.tunableOnly, false);
  });
  it("samples one auto-resolved proposal for the daily audit", () => {
    const sampled = r.escalations.filter((e) => e.type === "sampled");
    assert.equal(sampled.length, 1);
    const autoIds = r.escalations.filter((e) => e.type === "triaged" && e.route === "auto").map((e) => e.proposalId);
    assert.ok(autoIds.includes(sampled[0].proposalId));
  });
  it("overlapping lease is refused by the pre-check AND by git itself", () => {
    assert.deepEqual(r.leaseBackstop.prechecked, ["tools/opportunity-analyzer"]);
    assert.equal(r.leaseBackstop.rawPushRejected, true);
    assert.deepEqual(r.leaseBackstop.reaped, ["tools/opportunity-analyzer"]);
  });
});
