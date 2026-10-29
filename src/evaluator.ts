// Evaluator: independent replay. Same task, same frozen inputs (the portfolio's frozen
// commit), same acceptance criteria; baseline vs candidate, several runs per side
// because model runs are not deterministic. Runs execute in parallel, each in its own
// detached worktree, and nothing is committed.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Git } from "./git.ts";
import { addDetachedWorktree, removeWorktree } from "./git.ts";
import { currentBasis, taskContext } from "./context.ts";
import type { AgentRunner, RunSpec } from "./agents/runner.ts";
import type { ContextPortfolio } from "./solver.ts";
import { revise } from "./solver.ts";
import type { LogFn } from "./util.ts";
import { matchGlob, readJson, sha256 } from "./util.ts";

export type Check =
  | { id: string; kind: "records_within_basis"; field: string; basis: string; redLine?: boolean }
  | { id: string; kind: "field_present_all"; field: string; redLine?: boolean }
  | { id: string; kind: "field_absent_all"; field: string; redLine?: boolean };

export type Criteria = {
  task: string;
  artifactFile: string; // file inside the artifact dir the checks read
  checker?: string; // registered engagement checker; replaces `checks` when set
  checks?: Check[];
  minPassRate: number; // fraction of runs that must pass every outcome check
  cost: { mustNotIncrease: boolean; tolerancePct: number };
  protectedPaths: string[]; // a candidate that writes here is rejected outright
};

type RunEval = { outcomeFailures: string[]; redLineFailures: string[]; cost: number; tampered: string[]; error?: string };

// Engagement-specific checkers. A criteria file with `checker: "<name>"` is judged by
// the registered function instead of the generic checks below.
export type CheckerFn = (wtDir: string, spec: RunSpec, criteria: Criteria) => { outcomeFailures: string[]; redLineFailures: string[] };
const CHECKERS = new Map<string, CheckerFn>();
export function registerChecker(name: string, fn: CheckerFn): void {
  CHECKERS.set(name, fn);
}

export type SideSummary = { runs: number; passRate: number; redLineViolations: number; medianCost: number; failures: string[] };

export type Verdict = {
  passed: boolean;
  rejectedReason?: string;
  baseline: SideSummary;
  candidate: SideSummary;
  failures: string[];
};

function evaluateArtifact(wtDir: string, spec: RunSpec, criteria: Criteria): Omit<RunEval, "cost" | "tampered"> {
  if (criteria.checker) {
    const fn = CHECKERS.get(criteria.checker);
    if (!fn) return { outcomeFailures: [`outcome:unknown_checker:${criteria.checker}`], redLineFailures: [] };
    return fn(wtDir, spec, criteria);
  }
  const file = path.join(wtDir, spec.artifact, criteria.artifactFile);
  if (!fs.existsSync(file)) return { outcomeFailures: ["outcome:artifact_missing"], redLineFailures: [] };
  const out = readJson<{ records: Array<Record<string, unknown>> }>(file);
  const outcomeFailures: string[] = [];
  const redLineFailures: string[] = [];
  for (const c of criteria.checks ?? []) {
    let ok = true;
    if (c.kind === "records_within_basis") {
      // Judged against the CURRENT basis at the frozen commit, not the pins the run used.
      const allowed = (currentBasis(wtDir, spec.task, c.basis)?.value as { segments: string[] }).segments;
      ok = out.records.every((r) => allowed.includes(String(r[c.field])));
    } else if (c.kind === "field_present_all") {
      ok = out.records.every((r) => r[c.field] !== undefined && r[c.field] !== null && r[c.field] !== "");
    } else if (c.kind === "field_absent_all") {
      ok = out.records.every((r) => !(c.field in r));
    }
    if (!ok) (c.redLine ? redLineFailures : outcomeFailures).push(`${c.redLine ? "red_line" : "outcome"}:${c.id}`);
  }
  return { outcomeFailures, redLineFailures };
}

async function runOnce(control: Git, runner: AgentRunner, spec: RunSpec, rev: string, criteria: Criteria, dir: string): Promise<RunEval> {
  const wt = await addDetachedWorktree(control, dir, rev);
  try {
    const bundle = taskContext(dir, spec.task, "author", spec.pins);
    const res = await runner.run(spec, dir, bundle);
    if (!res.ok) return { outcomeFailures: ["outcome:run_failed"], redLineFailures: [], cost: res.costTokens, tampered: [], error: res.error };
    const touched = await wt.changedFiles();
    const tampered = touched.filter((f) => criteria.protectedPaths.some((g) => matchGlob(g, f)));
    return { ...evaluateArtifact(dir, spec, criteria), cost: res.costTokens, tampered };
  } finally {
    await removeWorktree(control, dir);
  }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : 0;
}

function summarize(evals: RunEval[]): SideSummary {
  const clean = evals.filter((e) => e.outcomeFailures.length === 0 && e.redLineFailures.length === 0).length;
  const failures = new Map<string, number>();
  for (const e of evals) for (const f of [...e.outcomeFailures, ...e.redLineFailures]) failures.set(f, (failures.get(f) ?? 0) + 1);
  return {
    runs: evals.length,
    passRate: evals.length ? clean / evals.length : 0,
    redLineViolations: evals.filter((e) => e.redLineFailures.length).length,
    medianCost: median(evals.map((e) => e.cost)),
    failures: [...failures].map(([f, n]) => `${f} in ${n}/${evals.length} runs`),
  };
}

export async function replay(control: Git, runner: AgentRunner, p: ContextPortfolio, opts: { runs: number; scratch: string; log?: LogFn }): Promise<Verdict> {
  // 1. The criteria at the frozen commit must still be the ones frozen at portfolio creation.
  const critText = control.show(p.frozenRev, p.criteriaPath);
  const empty: SideSummary = { runs: 0, passRate: 0, redLineViolations: 0, medianCost: 0, failures: [] };
  if (sha256(critText + "\n") !== p.criteriaHash && sha256(critText) !== p.criteriaHash) {
    return { passed: false, rejectedReason: "criteria_changed_since_freeze", baseline: empty, candidate: empty, failures: ["criteria_changed_since_freeze"] };
  }
  const criteria = JSON.parse(critText) as Criteria;

  // 2. Baseline and candidate, N runs each, all in parallel.
  const side = (spec: RunSpec, label: string) =>
    Promise.all(
      Array.from({ length: opts.runs }, (_, i) =>
        runOnce(control, runner, { ...spec, seed: `replay-${i}` }, p.frozenRev, criteria, path.join(opts.scratch, `${p.id}-r${p.round}-${label}-${i}`)),
      ),
    );
  const [base, cand] = await Promise.all([side(p.baseline, "base"), side(p.candidate, "cand")]);

  // 3. A candidate that touched protected files is rejected, whatever its scores.
  const tampered = [...new Set(cand.flatMap((e) => e.tampered))];
  const baseline = summarize(base);
  const candidate = summarize(cand);
  if (tampered.length) {
    return { passed: false, rejectedReason: `criteria_tampered:${tampered.join(",")}`, baseline, candidate, failures: [`criteria_tampered:${tampered.join(",")}`] };
  }

  // 4. Verdict: outcome, red lines, cost.
  const failures: string[] = [];
  if (candidate.passRate < criteria.minPassRate) failures.push(...candidate.failures.filter((f) => f.startsWith("outcome:")), `outcome:pass_rate ${candidate.passRate.toFixed(2)} < ${criteria.minPassRate}`);
  if (candidate.redLineViolations > 0) failures.push(...candidate.failures.filter((f) => f.startsWith("red_line:")));
  const costLimit = baseline.medianCost * (1 + criteria.cost.tolerancePct / 100);
  if (criteria.cost.mustNotIncrease && candidate.medianCost > costLimit) {
    failures.push(`cost:+${Math.round((candidate.medianCost / baseline.medianCost - 1) * 100)}% (limit +${criteria.cost.tolerancePct}%)`);
  }
  opts.log?.("replay", { portfolio: p.id, round: p.round, baselinePass: baseline.passRate, candidatePass: candidate.passRate, baseCost: baseline.medianCost, candCost: candidate.medianCost, failures });
  return { passed: failures.length === 0, baseline, candidate, failures };
}

// Evaluate -> (fail) revise -> evaluate ..., at most `maxRounds` revisions, then stop.
export async function evaluateWithRevisions(control: Git, runner: AgentRunner, p: ContextPortfolio, opts: { runs: number; scratch: string; maxRounds: number; log?: LogFn }): Promise<{ verdict: Verdict; portfolio: ContextPortfolio; outcome: "adopt" | "escalate" }> {
  for (;;) {
    const verdict = await replay(control, runner, p, opts);
    p.history.push({ round: p.round, candidate: p.candidate, failures: verdict.failures });
    if (verdict.passed) return { verdict, portfolio: p, outcome: "adopt" };
    if (verdict.rejectedReason) {
      p.status = "stopped";
      return { verdict, portfolio: p, outcome: "escalate" };
    }
    const next = p.round < opts.maxRounds ? revise(p, verdict.failures) : null;
    if (!next) {
      p.status = "stopped";
      return { verdict, portfolio: p, outcome: "escalate" };
    }
    opts.log?.("solver_revise", { portfolio: p.id, round: p.round + 1, params: next.config.params });
    p.round += 1;
    p.candidate = next;
  }
}
