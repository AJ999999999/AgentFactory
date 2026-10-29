// End-to-end scenario from the RulTriX example: a business-opportunity research
// report (agent-01) and an analysis tool (agent-03) built from the same task basis.
// The human narrows scope from "enterprise + individual" (v1) to "enterprise only"
// (v2); agent-01 picks it up, agent-03 doesn't; the loop finds and fixes the gap.
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AgentConfig, AgentRunner, RunResult, RunSpec } from "./agents/runner.ts";
import { MockAgent } from "./agents/mock.ts";
import { renderBrief } from "./brief.ts";
import type { Brief } from "./brief.ts";
import { basisRef, importSnapshot, writeBasis, writeTask } from "./context.ts";
import type { ContextBundle, TaskDef } from "./context.ts";
import { findPrecedent, recordDecision, supersede } from "./decisions.ts";
import { evaluateWithRevisions } from "./evaluator.ts";
import type { Criteria, Verdict } from "./evaluator.ts";
import { checkAll } from "./factcheck.ts";
import type { Claim } from "./factcheck.ts";
import { cloneControl, fetchOrigin, initBare, LeaseManager, leaseRef } from "./git.ts";
import { computeLedger } from "./ledger.ts";
import type { AgentRecord } from "./ledger.ts";
import { observe } from "./observator.ts";
import type { Observation } from "./observator.ts";
import { Coordinator } from "./orchestrator.ts";
import type { TxResult } from "./orchestrator.ts";
import { AttentionBudget, triage } from "./policy.ts";
import type { Policy, Proposal, Triage } from "./policy.ts";
import { fromBreakpoint, fromConfigChange } from "./solver.ts";
import type { ContextPortfolio } from "./solver.ts";
import { makeLogger, readJson, writeJson } from "./util.ts";
import type { LogFn } from "./util.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(HERE, "..");
const HUMAN = { name: "human", email: "human@example.com" };
const TASK = "task-123";

export const CONFIGS: Record<string, AgentConfig> = {
  "agent-01": { id: "agent-01", version: 1, model: "large-model", harness: "author", params: {} },
  "agent-03": { id: "agent-03", version: 1, model: "small-model", harness: "author", params: {} },
  "agent-04": { id: "agent-04", version: 1, model: "small-model", harness: "author", params: {} },
};
export const KIND: Record<string, RunSpec["kind"]> = {
  "reports/opportunity-research": "report",
  "tools/opportunity-analyzer": "analyzer",
  tools: "docs",
};

const CRITERIA: Criteria = {
  task: TASK,
  artifactFile: "sample.json",
  checks: [
    { id: "scope", kind: "records_within_basis", field: "segment", basis: "scope" },
    { id: "traceable", kind: "field_present_all", field: "sourceId" },
    { id: "no_pii", kind: "field_absent_all", field: "email", redLine: true },
  ],
  minPassRate: 0.66,
  cost: { mustNotIncrease: true, tolerancePct: 10 },
  protectedPaths: [".agents/context/tasks/*.criteria.json", ".agents/escalation-policy.json"],
};

function customers(): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 1; i <= 12; i++) {
    const enterprise = i <= 7;
    rows.push({
      id: `C${String(i).padStart(3, "0")}`,
      segment: enterprise ? "enterprise" : "individual",
      revenue: enterprise ? 40_000 + i * 1_500 : 900 + i * 40,
      sourceId: `crm-2026-10#${1000 + i}`,
      email: `contact${i}@example.com`,
    });
  }
  return rows;
}

// A candidate that also edits the frozen criteria: must be rejected outright.
class TamperingAgent implements AgentRunner {
  name = "tampering";
  inner: AgentRunner;
  constructor(inner: AgentRunner) {
    this.inner = inner;
  }
  async run(spec: RunSpec, dir: string, bundle: ContextBundle): Promise<RunResult> {
    const res = await this.inner.run(spec, dir, bundle);
    if (spec.config.params.tamper) {
      const f = path.join(dir, ".agents/context/tasks/task-123.criteria.json");
      const c = readJson<Criteria>(f);
      c.minPassRate = 0;
      writeJson(f, c);
    }
    return res;
  }
}

export type ScenarioResult = {
  phase1: TxResult[];
  basisChange: { triage: Triage; brief: string; blindBrief: string };
  observeBefore: Observation;
  propagation: { portfolio: ContextPortfolio; verdict: Verdict; outcome: string; triage: Triage; claims: ReturnType<typeof checkAll> };
  observeAfter: Observation;
  configLeak: { verdict: Verdict; outcome: string; rounds: number; triage: Triage };
  configWasteful: { verdict: Verdict; outcome: string; triage: Triage; brief: string };
  tamper: { verdict: Verdict; outcome: string; triageCriteriaEdit: Triage };
  noise: { single: Verdict; five: Verdict };
  contract: { triage: Triage; brief: string; claims: ReturnType<typeof checkAll> };
  ledger: AgentRecord[];
  budget: { results: string[]; backpressure: boolean; nextDay: number };
  leaseBackstop: { prechecked: string[]; rawPushRejected: boolean; reaped: string[] };
  staleness: { before: string; after: string };
  log: Array<{ t: number; event: string; data?: Record<string, unknown> }>;
  dirs: { base: string; origin: string; control: string };
};

function baseProposal(p: Partial<Proposal> & Pick<Proposal, "id" | "kind" | "title" | "author" | "paths">): Proposal {
  return {
    diffLines: 40,
    filesChanged: p.paths.length,
    tags: [],
    ci: "green",
    blindReview: "n/a",
    reviewRounds: 0,
    claims: [],
    precedent: "fresh",
    revertibleInOneCommit: true,
    dissent: [],
    monthlyCostDeltaUsd: 0,
    ...p,
  };
}

export async function runScenario(opts: { baseDir: string; echo?: boolean }): Promise<ScenarioResult> {
  const sink: ScenarioResult["log"] = [];
  const log: LogFn = makeLogger(sink, opts.echo);
  const base = opts.baseDir;
  fs.rmSync(base, { recursive: true, force: true });
  const originDir = path.join(base, "origin.git");
  const controlDir = path.join(base, "control");
  const scratch = path.join(base, "replays");
  fs.mkdirSync(scratch, { recursive: true });
  const policy = readJson<Policy>(path.join(PROJECT_ROOT, "policy/escalation-policy.json"));

  // ---------- seed the repo: policy, task, criteria, sources, basis v1, decision D-0001 ----------
  initBare(originDir);
  const seed = cloneControl(originDir, path.join(base, "seed")).as(HUMAN);
  const s = seed.cwd;
  writeJson(path.join(s, ".agents/escalation-policy.json"), policy);
  const task: TaskDef = {
    id: TASK,
    goal: "Size the business opportunity for the new connectivity bundle",
    rules: ["Use only imported source snapshots", "Every record keeps its sourceId", "Never copy customer contact fields"],
    basis: ["scope", "sources"],
    criteria: ".agents/context/tasks/task-123.criteria.json",
    permissions: {
      author: ["goal", "rules", "state", "evidence"],
      reviewer: ["goal", "rules", "state", "evidence", "results"],
      "fact-checker": ["state", "evidence", "results"],
      solver: ["goal", "rules", "state", "evidence", "results"],
      coordinator: ["goal", "rules", "state", "evidence", "results"],
    },
  };
  writeTask(s, task);
  writeJson(path.join(s, task.criteria), CRITERIA);
  writeJson(path.join(s, ".agents/context/registry/consumers.json"), {
    "contracts/billing-events": { consumers: ["billing-api", "reporting", "notifications"], unregistered: ["partner-webhook"] },
  });
  writeJson(path.join(s, "contracts/billing-events/schema.json"), { version: 3, fields: ["customer_id", "amount", "ts"] });
  const snap = importSnapshot(s, "crm-export 2026-10-20", customers());
  await seed.commitAll("seed: policy, task-123, criteria, sources", { "Decided-by": "human" });
  writeBasis(s, TASK, "scope", { segments: ["enterprise", "individual"] }, "D-0001");
  writeBasis(s, TASK, "sources", { snapshot: snap.id }, "D-0001");
  recordDecision(s, seed, {
    id: "D-0001",
    kind: "basis_change",
    subject: `${TASK}/scope`,
    question: "Which customer segments does the opportunity study cover?",
    chosen: "enterprise + individual",
    rejected: [{ option: "enterprise only", reason: "not decided yet" }],
    boundPaths: [`.agents/context/basis/${TASK}`],
    decidedBy: "human",
  });
  await seed.commitAll("basis v1: enterprise + individual", { Decision: "D-0001", "Decided-by": "human" });
  seed.run(["push", "-q", "origin", "HEAD:main"]);

  const control = cloneControl(originDir, controlDir);
  const syncControl = async () => {
    await fetchOrigin(control);
    await control.runAsync(["checkout", "-q", "--detach", "origin/main"]);
  };
  const runner = new MockAgent();
  const coord = new Coordinator({ control, worktreeRoot: path.join(base, "wt"), runner, concurrency: 3, log });

  // ---------- phase 1: three agents in parallel; T2 and T3 overlap on "tools" ----------
  log("phase", { n: 1, name: "parallel build on basis v1" });
  const phase1 = await Promise.all([
    coord.runAgent("T1-report", { agent: "agent-01", task: TASK, artifact: "reports/opportunity-research", kind: "report", config: CONFIGS["agent-01"] }),
    coord.runAgent("T2-analyzer", { agent: "agent-03", task: TASK, artifact: "tools/opportunity-analyzer", kind: "analyzer", config: CONFIGS["agent-03"] }),
    coord.runAgent("T3-tools-docs", { agent: "agent-04", task: TASK, artifact: "tools", kind: "docs", config: CONFIGS["agent-04"], pins: [] }),
  ]);

  // ---------- phase 2: the human narrows scope (a basis change always escalates) ----------
  log("phase", { n: 2, name: "basis change escalates to the human" });
  await syncControl();
  const bcProposal = baseProposal({
    id: "PR-basis-scope-v2",
    kind: "basis_change",
    title: "Narrow task-123 scope to enterprise customers only",
    author: "coordinator",
    paths: [`.agents/context/basis/${TASK}/scope.v2.json`],
    precedent: findPrecedent(controlDir, control, "basis_change", `${TASK}/scope`).status,
  });
  const bcTriage = triage(policy, bcProposal);
  const bcBrief: Brief = {
    id: "D-0002",
    question: "Narrow the opportunity study to enterprise customers only?",
    blocking: "2 artifacts (research report, analysis tool)",
    triage: bcTriage,
    options: [
      { key: "A", text: "Enterprise only", consequence: "drops 5 of 12 records; report and tool must be rebuilt", reversible: true },
      { key: "B", text: "Keep enterprise + individual", consequence: "no rebuild; individual segment stays in the sizing", reversible: true },
    ],
    recommendation: { key: "A", confidence: "medium", why: "The bundle is sold to business accounts; individual revenue is under 3% of the sample." },
    claimsVerified: { verified: 1, total: 1 },
    irreversible: [],
    dissent: [],
    evidence: [`Sources: snapshot ${snap.id} (crm-export 2026-10-20)`, "Current basis: task-123/scope@v1 (D-0001)"],
    unverified: [],
    precedent: "Supersedes D-0001 (enterprise + individual). No contradiction with other rulings.",
  };
  const basisChange = { triage: bcTriage, brief: renderBrief(bcBrief), blindBrief: renderBrief(bcBrief, { blind: true }) };

  // Human rules "approve A": the coordinator applies it as the human's commit.
  await coord.transaction({
    id: "H-scope-v2",
    identity: HUMAN,
    lockPaths: [`.agents/context/basis/${TASK}`],
    work: async (wt, g) => {
      writeBasis(wt, TASK, "scope", { segments: ["enterprise"] }, "D-0002");
      supersede(wt, "D-0001");
      recordDecision(wt, g, {
        id: "D-0002",
        kind: "basis_change",
        subject: `${TASK}/scope`,
        question: bcBrief.question,
        chosen: "enterprise only",
        rejected: [{ option: "enterprise + individual", reason: "individual segment is out of scope for a business bundle" }],
        boundPaths: [`.agents/context/basis/${TASK}`],
        decidedBy: "human",
      });
      return { message: "basis v2: enterprise customers only", trailers: { Decision: "D-0002", "Decided-by": "human" } };
    },
  });

  // ---------- phase 3: agent-01 rebuilds on v2; agent-03 does not ----------
  log("phase", { n: 3, name: "agent-01 rebuilds on v2, agent-03 does not" });
  await coord.runAgent("T4-report-v2", { agent: "agent-01", task: TASK, artifact: "reports/opportunity-research", kind: "report", config: CONFIGS["agent-01"] });

  // ---------- phase 4: Observator ----------
  log("phase", { n: 4, name: "Observator finds the handoff breakpoint" });
  const observeBefore = await observe(control);
  log("breakpoints", { found: observeBefore.breakpoints });

  // ---------- phase 5: Solver -> Evaluator -> policy -> adopt ----------
  log("phase", { n: 5, name: "Solver proposes, Evaluator replays, policy auto-resolves" });
  await syncControl();
  const frozenRev = control.head();
  const bp = observeBefore.breakpoints[0];
  const portfolio = fromBreakpoint(controlDir, frozenRev, bp, CONFIGS, KIND);
  const ev = await evaluateWithRevisions(control, runner, portfolio, { runs: 3, scratch, maxRounds: policy.evolution.revise_max_rounds, log });
  const claims = checkAll(controlDir, control, [
    { id: "c1", text: "rebuilt on the current scope", loadBearing: true, kind: "basis_current", args: { ref: basisRef(TASK, "scope", 2) } },
    { id: "c2", text: "the scope decision is active", loadBearing: true, kind: "decision_valid", args: { id: "D-0002" } },
    { id: "c3", text: "replay checks green", loadBearing: true, kind: "ci_green", args: { results: { replay: ev.verdict.passed }, check: "replay" } },
  ] satisfies Claim[]);
  const propProposal = baseProposal({
    id: portfolio.id,
    kind: "basis_propagation",
    title: `Re-pin ${bp.artifact} from ${bp.pinned} to ${bp.current}`,
    author: "solver",
    paths: [`${bp.artifact}/sample.json`, `${bp.artifact}/context.lock.json`],
    claims,
    precedent: findPrecedent(controlDir, control, "basis_change", `${TASK}/scope`).status,
    replay: { passed: ev.verdict.passed, rounds: ev.portfolio.round, summary: ev.verdict.failures.join("; ") },
  });
  const propTriage = triage(policy, propProposal);
  log("triage", { proposal: propProposal.id, route: propTriage.route, triggers: propTriage.triggers, unmet: propTriage.unmet });
  if (propTriage.route === "auto" && ev.outcome === "adopt") {
    await coord.runAgent(
      `${portfolio.id}-adopt`,
      { ...ev.portfolio.candidate },
      { Replay: `passed ${portfolio.id} (${ev.verdict.candidate.runs} runs/side)`, Decision: "D-0003", "Decided-by": "auto:policy-v2" },
      (wt, g) => {
        recordDecision(wt, g, {
          id: "D-0003",
          kind: "basis_propagation",
          subject: bp.artifact,
          question: `Re-pin ${bp.artifact} to ${bp.current}?`,
          chosen: "rebuild on current basis",
          rejected: [{ option: `keep ${bp.pinned}`, reason: `replay: baseline pass rate ${ev.verdict.baseline.passRate.toFixed(2)}` }],
          boundPaths: [bp.artifact],
          decidedBy: "auto:policy-v2",
          evidence: [`replay ${portfolio.id}: candidate ${ev.verdict.candidate.passRate.toFixed(2)} vs baseline ${ev.verdict.baseline.passRate.toFixed(2)}, cost ${ev.verdict.candidate.medianCost} vs ${ev.verdict.baseline.medianCost}`],
        });
        portfolio.status = "adopted";
      },
    );
    ev.portfolio.status = "adopted";
  }
  const observeAfter = await observe(control);
  log("breakpoints", { found: observeAfter.breakpoints });

  // ---------- phase 6: the loop refusing things ----------
  log("phase", { n: 6, name: "config changes: revise, stop, tamper, noise; contract claim" });
  await syncControl();
  const rev6 = control.head();
  const analyzerNow: RunSpec = { agent: "agent-03", task: TASK, artifact: "tools/opportunity-analyzer", kind: "analyzer", config: CONFIGS["agent-03"], pins: [basisRef(TASK, "scope", 2), basisRef(TASK, "sources", 1)] };

  // (a) red line, fixed by one revision
  const leak = await evaluateWithRevisions(control, runner, fromConfigChange(controlDir, rev6, analyzerNow, { ...CONFIGS["agent-03"], version: 2, params: { leakPii: true } }), { runs: 3, scratch, maxRounds: 2, log });
  const leakTriage = triage(policy, baseProposal({ id: leak.portfolio.id, kind: "agent_config_change", title: "agent-03 v2 config", author: "solver", paths: ["agents/agent-03.json"], replay: { passed: leak.verdict.passed, rounds: leak.portfolio.round, summary: "" } }));

  // (b) cost regression the Solver can't fix: stop and escalate
  const waste = await evaluateWithRevisions(control, runner, fromConfigChange(controlDir, rev6, analyzerNow, { ...CONFIGS["agent-03"], version: 2, params: { wasteful: true } }), { runs: 3, scratch, maxRounds: 2, log });
  const wasteTriage = triage(policy, baseProposal({ id: waste.portfolio.id, kind: "agent_config_change", title: "agent-03 bigger reasoning budget", author: "solver", paths: ["agents/agent-03.json"], replay: { passed: waste.verdict.passed, rounds: waste.portfolio.round, summary: waste.verdict.failures.join("; ") } }));
  const wasteBrief = renderBrief({
    id: waste.portfolio.id,
    question: "Give agent-03 a bigger reasoning budget?",
    blocking: "nothing (optional improvement)",
    triage: wasteTriage,
    options: [
      { key: "A", text: "Reject the change", consequence: "keep current cost", reversible: true },
      { key: "B", text: "Accept the higher cost", consequence: waste.verdict.failures.join("; "), reversible: true },
    ],
    recommendation: { key: "A", confidence: "high", why: "Same outcome and red lines, but cost rises with no quality gain on this task." },
    claimsVerified: { verified: 0, total: 0 },
    irreversible: [],
    dissent: [],
    evidence: [`replay ${waste.portfolio.id}: baseline cost ${waste.verdict.baseline.medianCost}, candidate ${waste.verdict.candidate.medianCost}`],
    unverified: [],
    precedent: "No precedent for agent-03 budget changes.",
  });

  // (c) a candidate that edits the frozen criteria is rejected, and a criteria edit can never auto-resolve
  const tamper = await evaluateWithRevisions(control, new TamperingAgent(runner), fromConfigChange(controlDir, rev6, analyzerNow, { ...CONFIGS["agent-03"], version: 2, params: { tamper: true } }), { runs: 2, scratch, maxRounds: 2, log });
  const triageCriteriaEdit = triage(policy, baseProposal({ id: "PR-criteria", kind: "code_change", title: "relax pass rate", author: "solver", paths: [task.criteria], blindReview: "approved" }));

  // (d) noise: one run per side vs five, same flaky candidate
  const noisyCfg = { ...CONFIGS["agent-03"], version: 2, params: { flaky: 0.25 } };
  const single = (await evaluateWithRevisions(control, runner, fromConfigChange(controlDir, rev6, analyzerNow, noisyCfg), { runs: 1, scratch, maxRounds: 0, log })).verdict;
  const five = (await evaluateWithRevisions(control, runner, fromConfigChange(controlDir, rev6, analyzerNow, noisyCfg), { runs: 5, scratch, maxRounds: 0, log })).verdict;

  // (e) contract change with an unverifiable "no other consumers" claim
  const cClaims = checkAll(controlDir, control, [
    { id: "k1", text: "no consumers outside these 3 repos", loadBearing: true, kind: "no_other_consumers", args: { contract: "contracts/billing-events", claimed: ["billing-api", "reporting", "notifications"] } },
  ] satisfies Claim[]);
  const cTriage = triage(policy, baseProposal({ id: "PR-billing-v4", kind: "contract_change", title: "Rename customer_id to account_id", author: "agent-02", paths: ["contracts/billing-events/schema.json"], claims: cClaims, blindReview: "approved", dissent: [{ agent: "reporting-maintainer", text: "Dual fields double the column in our warehouse for two releases." }] }));
  const cBrief = renderBrief({
    id: "D-0004",
    question: "Rename customer_id to account_id in the billing-events contract?",
    blocking: "3 tasks in billing-api, reporting, notifications",
    triage: cTriage,
    options: [
      { key: "A", text: "Breaking rename now", consequence: "all consumers redeploy together", reversible: false },
      { key: "B", text: "Add account_id beside customer_id; remove later", consequence: "two releases with both fields", reversible: true },
    ],
    recommendation: { key: "B", confidence: "medium", why: "Fixes the naming without a lockstep release." },
    claimsVerified: { verified: cClaims.filter((c) => c.status === "verified").length, total: cClaims.length },
    irreversible: ["Under A, archived events keep customer_id; replay tooling must map both names."],
    dissent: [{ agent: "reporting-maintainer", text: "Dual fields double the column in our warehouse for two releases." }],
    evidence: ["Contract diff: billing-events v3 -> v4"],
    unverified: cClaims.filter((c) => c.status !== "verified").map((c) => c.evidence),
    precedent: "No precedent for this contract.",
  });

  // ---------- phase 7: trust ledger after a revert ----------
  log("phase", { n: 7, name: "trust ledger from git history" });
  const t3 = phase1.find((r) => r.id === "T3-tools-docs");
  await coord.transaction({
    id: "H-revert-T3",
    identity: HUMAN,
    lockPaths: ["tools"],
    work: async (_wt, g) => {
      await g.runAsync(["revert", "--no-edit", String(t3?.sha)]);
      return { message: "", trailers: {}, committed: true };
    },
  });
  await syncControl();
  const ledger = computeLedger(control, policy, "HEAD");

  // Decision staleness: D-0003 binds the analyzer dir; touching it makes D-0003 stale.
  const before = findPrecedent(controlDir, control, "basis_propagation", "tools/opportunity-analyzer").status;
  await coord.transaction({
    id: "H-touch-analyzer",
    identity: HUMAN,
    lockPaths: ["tools/opportunity-analyzer"],
    work: async (wt) => {
      fs.writeFileSync(path.join(wt, "tools/opportunity-analyzer/NOTES.md"), "manual note\n");
      return { message: "note on analyzer", trailers: { "Decided-by": "human" } };
    },
  });
  await syncControl();
  const after = findPrecedent(controlDir, control, "basis_propagation", "tools/opportunity-analyzer").status;

  // ---------- phase 8: attention budget ----------
  log("phase", { n: 8, name: "attention budget and backpressure" });
  const budget = new AttentionBudget(policy);
  const results: string[] = [];
  for (let i = 0; i < 10; i++) results.push(budget.submit({ id: `B${i}`, markdown: "", blockedTasks: i, interrupt: false }));
  results.push(budget.submit({ id: "SEC", markdown: "", blockedTasks: 0, interrupt: true }));
  const backpressure = budget.backpressure;
  const nextDay = budget.nextDay().length;

  // ---------- phase 9: lease backstop ----------
  log("phase", { n: 9, name: "lease atomicity backstop" });
  const lm = new LeaseManager(control);
  const held = await lm.tryAcquire("X1", "agent-x", ["tools/opportunity-analyzer"], 1);
  const pre = await lm.tryAcquire("X2", "agent-y", ["tools"]);
  // Bypass the pre-check entirely: git's own ref rules still reject the overlapping unit.
  const sha = (await control.runAsync(["commit-tree", "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "-m", "{}"])).trim();
  const raw = await control.tryAsync(["push", "-q", "--atomic", "origin", `--force-with-lease=${leaseRef("tools")}:`, `${sha}:${leaseRef("tools")}`]);
  await new Promise((r) => setTimeout(r, 5));
  const reaped = await lm.reapExpired();
  if (held.lease) await lm.release(held.lease);

  return {
    phase1,
    basisChange,
    observeBefore,
    propagation: { portfolio: ev.portfolio, verdict: ev.verdict, outcome: ev.outcome, triage: propTriage, claims },
    observeAfter,
    configLeak: { verdict: leak.verdict, outcome: leak.outcome, rounds: leak.portfolio.round, triage: leakTriage },
    configWasteful: { verdict: waste.verdict, outcome: waste.outcome, triage: wasteTriage, brief: wasteBrief },
    tamper: { verdict: tamper.verdict, outcome: tamper.outcome, triageCriteriaEdit },
    noise: { single, five },
    contract: { triage: cTriage, brief: cBrief, claims: cClaims },
    ledger,
    budget: { results, backpressure, nextDay },
    leaseBackstop: { prechecked: pre.conflicts, rawPushRejected: !raw.ok, reaped },
    staleness: { before, after },
    log: sink,
    dirs: { base, origin: originDir, control: controlDir },
  };
}

export function gitLogGraph(dir: string): string {
  return execFileSync("git", ["log", "--format=%h %an: %s%n    %(trailers:only,unfold,separator=%x0a    )", "origin/main"], { cwd: dir, encoding: "utf8" });
}
