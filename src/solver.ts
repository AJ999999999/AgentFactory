// Solver: turns a breakpoint (or a proposed config change) into a Context Portfolio:
// the corrected basis, required evidence, and the downstream work it targets. The
// portfolio freezes the acceptance criteria hash at creation, before any candidate
// exists, so the Solver can never move the goalposts it will be judged by.
import * as fs from "node:fs";
import * as path from "node:path";
import { currentPins, readLockfile, readTask } from "./context.ts";
import type { AgentConfig, RunSpec } from "./agents/runner.ts";
import type { Breakpoint } from "./store.ts";
import { sha256 } from "./util.ts";

export type ContextPortfolio = {
  id: string;
  kind: "basis_propagation" | "agent_config_change";
  task: string;
  target: string; // artifact whose downstream work this fixes
  requiredEvidence: string[];
  criteriaPath: string;
  criteriaHash: string;
  frozenRev: string;
  baseline: RunSpec;
  candidate: RunSpec;
  round: number;
  history: Array<{ round: number; candidate: RunSpec; failures: string[] }>;
  status: "candidate" | "adopted" | "stopped";
};

let seq = 0;

export function freezeCriteria(repoDir: string, task: string): { path: string; hash: string } {
  const t = readTask(repoDir, task);
  return { path: t.criteria, hash: sha256(fs.readFileSync(path.join(repoDir, t.criteria), "utf8")) };
}

// repoDir must be a checkout of frozenRev.
export function fromBreakpoint(repoDir: string, frozenRev: string, bp: Breakpoint, configs: Record<string, AgentConfig>, kindOf: Record<string, RunSpec["kind"]>): ContextPortfolio {
  const lock = readLockfile(repoDir, bp.artifact);
  if (!lock) throw new Error(`no lockfile for ${bp.artifact}`);
  const config = configs[lock.builtBy];
  const base: RunSpec = { agent: lock.builtBy, task: lock.task, artifact: bp.artifact, kind: kindOf[bp.artifact], config, pins: lock.basis };
  const crit = freezeCriteria(repoDir, lock.task);
  return {
    id: `P-${String(++seq).padStart(4, "0")}`,
    kind: "basis_propagation",
    task: lock.task,
    target: bp.artifact,
    requiredEvidence: ["every record keeps a traceable sourceId", `output matches ${bp.current}`],
    criteriaPath: crit.path,
    criteriaHash: crit.hash,
    frozenRev,
    baseline: base,
    candidate: { ...base, pins: currentPins(repoDir, lock.task) },
    round: 0,
    history: [],
    status: "candidate",
  };
}

export function fromConfigChange(repoDir: string, frozenRev: string, baseline: RunSpec, newConfig: AgentConfig): ContextPortfolio {
  const crit = freezeCriteria(repoDir, baseline.task);
  return {
    id: `P-${String(++seq).padStart(4, "0")}`,
    kind: "agent_config_change",
    task: baseline.task,
    target: baseline.artifact,
    requiredEvidence: ["no regression on outcome, red lines or cost"],
    criteriaPath: crit.path,
    criteriaHash: crit.hash,
    frozenRev,
    baseline,
    candidate: { ...baseline, config: newConfig },
    round: 0,
    history: [],
    status: "candidate",
  };
}

// Revise the candidate from the Evaluator's failure reasons. Returns null when the
// Solver has no remedy, which ends the loop early (stop and escalate).
export function revise(p: ContextPortfolio, failures: string[]): RunSpec | null {
  const c = p.candidate;
  const params = { ...c.config.params };
  let changed = false;
  if (failures.some((f) => f.startsWith("red_line:")) && params.leakPii) {
    params.leakPii = false;
    changed = true;
  }
  if (failures.some((f) => f.startsWith("outcome:")) && typeof params.flaky === "number" && params.flaky > 0) {
    params.flaky = Math.max(0, Number(params.flaky) - 0.3);
    changed = true;
  }
  // A cost regression that comes from the change itself has no remedy here.
  if (!changed) return null;
  return { ...c, config: { ...c.config, version: c.config.version + 1, params } };
}
