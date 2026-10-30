// Run the six case simulations and print what happened, month by month.
//   npm run demo:harness                 all six
//   npm run demo:harness -- kids-rockets one of them
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beliefs, loadPolicy } from "./project.ts";
import { Sim } from "./sim.ts";
import type { CaseSetup } from "./cases/kit.ts";
import { gameEngine } from "./cases/game-engine.ts";
import { kidsRockets } from "./cases/kids-rockets.ts";
import { seniorMeds } from "./cases/senior-meds.ts";
import { migration } from "./cases/migration.ts";
import { research } from "./cases/research.ts";
import { stewardship } from "./cases/stewardship.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const policy = loadPolicy(path.join(ROOT, "policy", "harness.json"));
const all: Array<() => CaseSetup> = [gameEngine, kidsRockets, seniorMeds, migration, research, stewardship];
const pick = process.argv[2];
const outDir = path.join(ROOT, ".af", "harness-demo");
fs.mkdirSync(outDir, { recursive: true });

const fmt = (t: number) => new Date(t).toISOString().slice(5, 16).replace("T", " ");

for (const make of all) {
  const c = make();
  if (pick && c.name !== pick) continue;
  const t0 = Date.now();
  const sim = await Sim.create({ dir: fs.mkdtempSync(path.join(os.tmpdir(), `af-demo-${c.name}-`)), def: c.def, policy, start: c.start, world: c.world, agent: c.agent, runners: c.runners, people: c.people });
  await sim.run({ until: c.until });
  const s = await sim.harness.state();
  const lines: string[] = [];
  const turns = s.turns.length;
  const spent = [...s.goals.values()].reduce((a, g) => ({ usd: a.usd + g.spent.usd, gpu: a.gpu + g.spent.gpuHours }), { usd: 0, gpu: 0 });
  const end = sim.log.at(-1)!;
  lines.push(`# ${c.summary}`, "");
  lines.push(`Simulated ${fmt(Date.parse(c.start))} to ${fmt(end.at)} (${Math.round((end.at - Date.parse(c.start)) / 86_400_000)} days): ${sim.ticks.length} wakes (${sim.ticks.filter((t) => t.quiet).length} quiet), ${turns} model turns, $${spent.usd}, ${spent.gpu} GPU hours. Ran in ${((Date.now() - t0) / 1000).toFixed(1)}s.`, "");
  lines.push("```");
  for (const l of sim.log) lines.push(`${fmt(l.at)}  ${l.kind.padEnd(6)} ${l.detail.length > 150 ? l.detail.slice(0, 149) + "…" : l.detail}`);
  for (const e of s.asks.values()) if (e.status === "open") lines.push(`${"".padEnd(11)}  open   ${e.id} -> ${e.to}: ${e.question.slice(0, 120)}`);
  lines.push("```", "");
  for (const g of s.goals.values()) {
    lines.push(`**${g.id}** v${g.version}, ${g.status}: ${g.def.title}. Spent ${g.spent.turns} turns${g.def.budget.turns ? ` of ${g.def.budget.turns}` : ""}.`);
    for (const b of beliefs(s, g.id)) lines.push(`- ${b.def.id} ${b.status}: ${b.def.text}${b.adequate.length ? ` (${b.adequate.map((f) => f.grade).join(", ")})` : ""}`);
    const team = [...s.seats.values()].filter((x) => x.goal === g.id);
    if (team.length) lines.push(`- team: ${team.map((x) => `${x.lane} = ${x.generated ? `generated (${x.probation ? `probation, ${x.accepted} accepted, ${x.rejected} sent back` : "promoted"})` : x.template}`).join("; ")}`);
    const dropped = [...s.todos.values()].filter((t) => t.goal === g.id && t.status === "superseded");
    if (dropped.length) lines.push(`- dropped: ${dropped.map((t) => `${t.id} (${t.reason})`).join("; ")}`);
    lines.push("");
  }
  const text = lines.join("\n");
  fs.writeFileSync(path.join(outDir, `${c.name}.md`), text);
  console.log(text);
}
console.log(`(written to ${path.relative(process.cwd(), outDir)}/)`);
