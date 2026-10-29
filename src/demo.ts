// Narrated run of the scenario: `npm run demo`
import * as os from "node:os";
import * as path from "node:path";
import { gitLogGraph, runScenario } from "./scenario.ts";

const base = process.argv[2] ?? path.join(os.tmpdir(), "raee-demo");
const r = await runScenario({ baseDir: base, echo: process.argv.includes("--verbose") });

const h = (s: string) => console.log(`\n=== ${s} ===`);
const pct = (x: number) => `${Math.round(x * 100)}%`;

h("1. Parallel build on basis v1 (3 agents, concurrency 3)");
for (const t of r.phase1) {
  console.log(`${t.id.padEnd(14)} ${String(t.endedAt - r.phase1[0].startedAt).padStart(5)}ms done · waited for lease: ${t.waitedForLease} · ${t.costTokens} tokens`);
}

h("2. Basis change escalates (brief the human receives)");
console.log(`route=${r.basisChange.triage.route} triggers=${r.basisChange.triage.triggers.join(", ")}`);
console.log(r.basisChange.brief);
console.log("\n--- blind variant, recommendation section ---");
console.log(r.basisChange.blindBrief.split("### Recommendation")[1].split("###")[0].trim());

h("4. Observator: handoff breakpoints");
for (const b of r.observeBefore.breakpoints) console.log(`${b.artifact} built by ${b.builtBy}: pinned ${b.pinned}, current ${b.current}`);

h("5. Solver -> Evaluator -> policy");
const v = r.propagation.verdict;
console.log(`portfolio ${r.propagation.portfolio.id}: ${r.propagation.portfolio.baseline.pins.join(",")} -> ${r.propagation.portfolio.candidate.pins.join(",")}`);
console.log(`baseline:  pass ${pct(v.baseline.passRate)} · median cost ${v.baseline.medianCost} · ${v.baseline.failures.join("; ") || "no failures"}`);
console.log(`candidate: pass ${pct(v.candidate.passRate)} · median cost ${v.candidate.medianCost} · ${v.candidate.failures.join("; ") || "no failures"}`);
for (const c of r.propagation.claims) console.log(`claim ${c.claimId}: ${c.status} (${c.evidence})`);
console.log(`triage: ${r.propagation.triage.route} · adopted: ${r.propagation.portfolio.status}`);
console.log(`breakpoints after adoption: ${r.observeAfter.breakpoints.length}`);

h("6. The loop saying no");
console.log(`leakPii config:   ${r.configLeak.outcome} after ${r.configLeak.rounds} revision(s) · triage ${r.configLeak.triage.route}`);
console.log(`wasteful config:  ${r.configWasteful.outcome} · ${r.configWasteful.verdict.failures.join("; ")} · triage ${r.configWasteful.triage.route}`);
console.log(`tampering config: ${r.tamper.outcome} · ${r.tamper.verdict.rejectedReason}`);
console.log(`criteria edit PR: ${r.tamper.triageCriteriaEdit.route} (never_auto: ${r.tamper.triageCriteriaEdit.neverAuto})`);
console.log(`noise, flaky=0.25: 1 run/side pass=${pct(r.noise.single.candidate.passRate)} -> ${r.noise.single.passed ? "PASS" : "FAIL"} · 5 runs/side pass=${pct(r.noise.five.candidate.passRate)} -> ${r.noise.five.passed ? "PASS" : "FAIL"}`);
console.log(`contract change: ${r.contract.triage.route} · ${r.contract.triage.triggers.join(", ")}`);
console.log("\n--- contract brief ---");
console.log(r.contract.brief);

h("7. Trust ledger (from git history only)");
for (const a of r.ledger) {
  console.log(`${a.agent}: ${a.commits} commits · reverted ${a.reverted} (${pct(a.revertRate)}) · survival ${pct(a.survival)} (${a.linesSurviving}/${a.linesAdded} lines) · demoted ${a.demoted}`);
}
console.log(`decision D-0003 precedent: ${r.staleness.before} -> ${r.staleness.after} after a manual edit to its bound path`);

h("8. Attention budget (max 8/day)");
const count = (s: string) => r.budget.results.filter((x) => x === s).length;
console.log(`delivered ${count("delivered")} · queued ${count("queued")} · interrupts ${count("interrupt")} · backpressure ${r.budget.backpressure} · next day digest ${r.budget.nextDay}`);

h("9. Lease atomicity");
console.log(`pre-check conflicts: ${r.leaseBackstop.prechecked.join(", ")}`);
console.log(`raw push of overlapping lease rejected by git: ${r.leaseBackstop.rawPushRejected} · expired leases reaped: ${r.leaseBackstop.reaped.join(", ")}`);

h("main history (with trailers)");
console.log(gitLogGraph(r.dirs.control));
