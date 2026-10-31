// The first challenge, end to end, with scripted angles and scripted owner rulings:
// `npm run demo:challenge`. Writes the challenge record to challenges/out/.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Coordinator } from "../orchestrator.ts";
import { makeLogger, readJson } from "../util.ts";
import type { ChallengeDef } from "./process.ts";
import { Challenge, loadAngles, PrototypeBuilder } from "./process.ts";
import { renderBrief, renderReport } from "./report.ts";
import { ScriptedAngleRunner } from "./runners.ts";
import type { AngleRunner } from "./runners.ts";
import { createWorkspace } from "./workspace.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export async function runContractRegistry(baseDir: string, echo = false, wrap: (r: AngleRunner) => AngleRunner = (r) => r) {
  const sink: Array<{ t: number; event: string; data?: Record<string, unknown> }> = [];
  const log = makeLogger(sink, echo);
  const def = readJson<ChallengeDef>(path.join(ROOT, "challenges/contract-registry.json"));
  const script = readJson<Record<string, unknown>>(path.join(ROOT, "challenges/contract-registry.script.json"));
  const control = await createWorkspace({ dir: baseDir, seedFrom: ROOT, seedPaths: ["src", "policy"] });
  const ch = new Challenge({ control, def, angles: loadAngles(path.join(ROOT, "policy/angles.json")), runner: wrap(new ScriptedAngleRunner(script as never)), log });

  await ch.open();
  const reframes = await ch.challengeFrame();
  // You, as owner, accept the challenger's reframe (scripted).
  await ch.confirmFrame({ by: "partner", reframe: reframes[0]?.body.reframe, answer: "Accept the reframe: the goal is declared, pinned, checked dependencies." });
  const div = await ch.diverge();
  const rev = await ch.reveal();
  const crit = await ch.critique();
  const sc = await ch.score();
  const brief = renderBrief(ch);
  // Your ruling (scripted). Note it isn't simply the top score's job to decide.
  const decision = await ch.decide({
    by: "partner",
    chosen: "risk.O1",
    criteriaHash: ch.criteriaHash(),
    note: "Generate consumer tests from each contract's examples; that answers the critique about hand-written tests rotting.",
    rejected: {
      "user-value.O1": "Hand-written expectation tests put a maintenance cost on every consumer; generated tests keep the benefit",
      "feasibility.O1": "Structural diffs miss semantic changes like units, which is the failure we've already seen",
      "feasibility.O2": "Kept as part of the chosen option: consumers generate clients from pinned contracts",
      "contrarian.O1": "Client-owned repos can't join a monorepo",
      "outside-view.O1": "Pointers alone don't catch semantic changes; revisit if the tools gain example checks",
    },
  });
  const plan = await ch.planMvp();
  const coord = new Coordinator({ control, worktreeRoot: path.join(baseDir, "wt"), runner: new PrototypeBuilder(), concurrency: 1, log });
  const artifact = await ch.build(coord, { id: "builder-1", version: 1, model: "model-b", harness: "author", params: {} });
  const supported = await ch.experiment({ by: "builder-1", assumption: "lead.A1", method: "Changed the unit in one example of a sample contract", result: "supported", evidence: "The generated consumer test failed, as it should." });
  const refuted = await ch.experiment({ by: "builder-1", assumption: "risk.A1", method: "Checked 10 contracts drafted by agents in the trial (fixture)", result: "refuted", evidence: "3 of 10 had units, invariants and examples without being told to." });
  const report = renderReport(ch);
  return { ch, reframes, div, rev, crit, sc, brief, decision, plan, artifact, supported, refuted, report, log: sink };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const base = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : path.join(os.tmpdir(), "af-challenge");
  const r = await runContractRegistry(base, process.argv.includes("--verbose"));
  const h = (s: string) => console.log(`\n=== ${s} ===`);
  h("Frame");
  console.log(`challenger: ${r.reframes[0]?.body.text}`);
  console.log(`owner confirmed with reframe: ${r.ch.frameEntry().body.problem}`);
  h("Diverge (sealed) and reveal");
  for (const k of r.div.commitments) console.log(`${k.author.angle?.padEnd(13)} committed ${k.body.entries} entries · hash ${String(k.body.hash).slice(0, 12)}`);
  for (const j of r.div.rejected) console.log(`refused: ${j.angle} ${j.draft.type} "${j.draft.body.title ?? j.draft.body.text ?? ""}" (${j.reason})`);
  console.log(`revealed ${r.rev.revealed.length} entries together · failed reveals: ${r.rev.failed.length}`);
  h("Critique and score");
  console.log(`critiques kept: ${r.crit.accepted.filter((e) => e.status !== "discarded").length} · discarded (no evidence, no test): ${r.crit.accepted.filter((e) => e.status === "discarded").length}`);
  for (const j of [...r.crit.rejected, ...r.sc.rejected]) console.log(`refused: ${j.angle} ${j.draft.type} (${j.reason})`);
  h("Decision brief (excerpt)");
  console.log(r.brief.split("## Options")[1].split("## Filtered out")[0].trim().split("\n").filter((l) => l.startsWith("### ") || l.startsWith("Scores")).join("\n"));
  h("Decision and MVP plan");
  console.log(`you chose ${r.decision.body.chosen}: ${r.decision.body.note}`);
  for (const a of r.plan.body.test) console.log(`test ${a.id} (priority ${a.priority}): ${a.text}`);
  for (const a of r.plan.body.deferred) console.log(`defer ${a.id} (priority ${a.priority}): ${a.text}`);
  console.log(`MVP built at ${r.artifact.body.path}, pinned ${r.artifact.body.pins.join(", ")}`);
  h("Experiments");
  console.log(`${r.supported.experiment.refs[0]}: supported`);
  console.log(`${r.refuted.experiment.refs[0]}: refuted -> reopened ${r.refuted.reopened.map((d) => d.id).join(", ")}`);
  for (const q of r.refuted.questions) console.log(`question to you: ${q.body.text}`);
  for (const b of r.refuted.breakpoints) console.log(`breakpoint: ${b.artifact} pinned ${b.pinned}, current ${b.current}`);
  const out = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), "challenges/out");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "contract-registry.md"), r.report);
  console.log(`\nChallenge record: challenges/out/contract-registry.md`);
}
