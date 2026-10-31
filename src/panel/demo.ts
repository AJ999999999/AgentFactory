// A throwaway workspace for trying the panel: three of the built-in cases, simulated
// through the real harness over the last few weeks. People stop answering a few days
// before now, so the newest questions are still waiting.
import * as fs from "node:fs";
import * as path from "node:path";
import type { CaseSetup } from "../harness/cases/kit.ts";
import type { HarnessPolicy } from "../harness/project.ts";
import { Sim } from "../harness/sim.ts";

const DAY = 86_400_000;
const MIN = 60_000;

export async function makeDemo(dir: string, policy: HarnessPolicy, now = Date.now()): Promise<string[]> {
  const cases: Array<{ make: () => CaseSetup; days: number; quietDays: number; beat?: number }> = [
    { make: (await import("../harness/cases/kids-rockets.ts")).kidsRockets, days: 40, quietDays: 2, beat: 3 },
    { make: (await import("../harness/cases/migration.ts")).migration, days: 30, quietDays: 25, beat: 35 },
    { make: (await import("../harness/cases/game-engine.ts")).gameEngine, days: 25, quietDays: 3 },
  ];
  const ids: string[] = [];
  for (const c of cases) {
    const setup = c.make();
    const id = setup.def.id;
    const home = path.join(dir, ".af", "harness", id);
    const cutoff = now - c.quietDays * DAY;
    // Everyone stops answering at the cutoff: what came up since is waiting.
    const people = setup.people.map((p) => ({ ...p, answer: (a: Parameters<typeof p.answer>[0], s: Parameters<typeof p.answer>[1], t: number) => (t < cutoff ? p.answer(a, s, t) : null) }));
    const sim = await Sim.create({ dir: home, def: setup.def, policy, start: new Date(now - c.days * DAY).toISOString(), world: setup.world, agent: setup.agent, runners: setup.runners, people });
    await sim.run({ until: new Date(now - 10 * MIN).toISOString(), maxIterations: 300 });
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ repo: path.join(home, "control"), remote: path.join(home, "origin.git") }, null, 2));
    if (c.beat !== undefined) {
      const at = now - c.beat * MIN;
      fs.writeFileSync(path.join(home, `heartbeat-${setup.runners[0].runner.id}.json`), JSON.stringify({ at: new Date(at).toISOString(), pid: 0, quiet: true, next: { action: "sleep", at: new Date(at + 10 * MIN).toISOString(), why: "recheck for answers" } }, null, 2));
    }
    ids.push(id);
  }
  return ids;
}
