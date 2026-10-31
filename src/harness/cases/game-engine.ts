// Case 1: "Build an Unreal 6 game engine."
//
// What makes it hard: the request is out of all proportion to any budget (engines
// on that scale took decades and hundreds of engineers), "Unreal" is Epic Games'
// trademark, the real technical risk is measured on GPUs that only some runners
// have, competing approaches must be tried in parallel and then dropped, the team
// should only grow once contracts between workstreams exist, and a competitor's
// announcement mid-way must not flip the direction on its own.
//
// What the harness should do: ask about scope before building anything; let the
// riskiest assumption (will developers want it?) go first; run both renderer spikes
// and benchmark them on the GPU runner only; let the owner pick; spawn workstreams
// only after the contracts exist, with the budget carved out of the parent; treat the
// competitor news as a signal that earns a proper re-test, not a pivot.
import type { TurnContext } from "../agents.ts";
import { ScriptedTurnAgent } from "../agents.ts";
import { day } from "../sim.ts";
import type { EngagementDef, GoalDef, GoalRevision } from "../types.ts";
import { SimJobs, SimMetrics, SimProbe } from "../world.ts";
import type { CaseSetup } from "./kit.ts";
import { about, contains, exists, idStarts, lane, nth, on, origin, person, write } from "./kit.ts";

const START = "2026-11-02T09:00:00Z";

export const narrowed: GoalRevision = {
  title: "Stylized renderer + hot-reload editor",
  objective: "A stylized real-time renderer with a hot-reload editor for indie developers: a wedge, not a clone of Unreal",
  assumptions: [
    { id: "W1", text: "Indie developers making stylized games want a lighter engine than the big two", category: "desirability", risk: 5, uncertainty: 4, loadBearing: true, threshold: { metric: "alpha_signups", op: ">=", value: 200 } },
    { id: "FA", text: "A meshlet renderer holds 60 fps with 1M instances on a mid-range GPU", category: "feasibility", risk: 4, uncertainty: 4, threshold: { metric: "fps_1m", op: ">=", value: 60 } },
    { id: "FB", text: "Classic LOD + instancing holds 60 fps with 1M instances on a mid-range GPU", category: "feasibility", risk: 3, uncertainty: 4, threshold: { metric: "fps_1m", op: ">=", value: 60 } },
    { id: "F2", text: "Shader and scene edits hot-reload in under a second", category: "feasibility", risk: 3, uncertainty: 3, threshold: { metric: "reload_ms", op: "<=", value: 1000 } },
  ],
  kill: [{ id: "K1", metric: "alpha_signups", op: "<", value: 50, minSample: { metric: "days_live", value: 21 } }],
  success: [{ id: "want", assumption: "W1" }, { id: "fast", assumption: "FA" }, { id: "reload", assumption: "F2" }],
  todos: [
    { id: "landing", lane: "build", text: "Landing page and developer waitlist", tests: "W1", writeScope: ["brand/site"], check: "page" },
    { id: "waitlist", kind: "wait", lane: "market", text: "Run the waitlist for three weeks", after: ["landing"], freeze: ["brand/site"], wait: { source: "devsignups", minDays: 21, informs: [{ assumption: "W1", metric: "alpha_signups" }] } },
    { id: "spike-a", lane: "spike", text: "Spike A: meshlet renderer", tests: "FA", forOption: "A", writeScope: ["engine/spike-a"], check: "builds" },
    { id: "spike-b", lane: "spike", text: "Spike B: classic LOD and instancing", tests: "FB", forOption: "B", writeScope: ["engine/spike-b"], check: "builds" },
    { id: "bench-a", kind: "job", lane: "bench", text: "Benchmark spike A: 1M instances, 3 runs", after: ["spike-a"], requires: ["gpu"], forOption: "A", job: { spec: { scene: "1M", spike: "a" }, runs: 3, gpuHours: 6, informs: [{ assumption: "FA", metric: "fps_1m" }] } },
    { id: "bench-b", kind: "job", lane: "bench", text: "Benchmark spike B: 1M instances, 3 runs", after: ["spike-b"], requires: ["gpu"], forOption: "B", job: { spec: { scene: "1M", spike: "b" }, runs: 3, gpuHours: 6, informs: [{ assumption: "FB", metric: "fps_1m" }] } },
    { id: "reload", lane: "spike", text: "Hot-reload prototype", tests: "F2", writeScope: ["engine/reload"], check: "builds" },
    { id: "reload-bench", kind: "job", lane: "bench", text: "Measure hot-reload latency, 3 runs", after: ["reload"], requires: ["gpu"], job: { spec: { measure: "reload" }, runs: 3, gpuHours: 2, informs: [{ assumption: "F2", metric: "reload_ms" }] } },
    { id: "choose", lane: "plan", text: "Compare the spikes and put the choice to the partner", after: ["bench-a", "bench-b"], writeScope: ["research"] },
    { id: "contracts", lane: "plan", text: "Write the render, scene and asset contracts for the chosen approach", after: ["choose"], writeScope: ["contracts"], check: "contracts" },
    { id: "teams", lane: "plan", text: "Split the build into workstreams", after: ["contracts"], assumes: ["W1"], writeScope: ["research"] },
  ],
};

export function engineDef(): EngagementDef {
  const goal: GoalDef = {
    id: "engine", title: "Game engine", objective: "Build a game engine on the scale of Unreal Engine 6", owner: "partner",
    scope: ["research", "engine", "brand", "contracts"],
    assumptions: [{ id: "S1", text: "An engine on Unreal's scale fits this budget", category: "viability", risk: 5, uncertainty: 5, loadBearing: true }],
    budget: { turns: 400, gpuHours: 200 },
    monitors: [{ id: "competitors", target: "competitor-release-notes", cadenceMinutes: 24 * 60, onChange: { todo: { lane: "research", text: "A competitor shipped something: {summary}. Does it undercut W1?", tests: "W1", priority: 1, writeScope: ["research"] } } }],
    todos: [
      { id: "scope", lane: "research", text: "Outside view: what would an Unreal-6-class engine take? Reference class, effort, team.", tests: "S1", writeScope: ["research"] },
      { id: "core", lane: "build", text: "Start the engine core: ECS, renderer, editor", assumes: ["S1"], writeScope: ["engine"] },
    ],
  };
  return { id: "engine", title: "A game engine on the scale of Unreal Engine 6", principals: { partner: "you" }, redLines: ["trademark", "no-copied-source"], goals: [goal] };
}

const workstream = (id: string, scope: string, contract: string, turns: number): GoalDef => ({
  id, title: id, objective: `Build the ${id} against ${contract}`, owner: "partner", scope: [scope], interfaces: [contract], assumptions: [], budget: { turns },
  todos: [{ id: `${id}-v1`, lane: "build", text: `First production slice of the ${id}`, writeScope: [scope], check: "builds" }],
});

export function gameEngine(): CaseSetup {
  const agent = new ScriptedTurnAgent([
    on("scope", (c) => {
      write(c, "research/scope.md", "# Outside view\nComparable engines: decades of work, hundreds of engineers. Even at agent speed the floor is tens of thousands of turns.\n");
      return { done: true, findings: [{ assumption: "S1", direction: "refutes", grade: "opinion", source: "", text: "Reference class says ~60k turns at best", metrics: { estimated_turns: 60000 } }] };
    }),
    on("landing", (c) => {
      // First attempt borrows the trademark; the red line throws the turn away.
      write(c, "brand/site/index.html", nth(c) === 1 ? "<h1>Unreal-class power, indie-sized</h1><form>waitlist</form>" : "<h1>Stylized worlds, instant reloads</h1><form>waitlist</form>");
      return { done: true };
    }),
    lane("spike", (c) => {
      write(c, `${c.todo.writeScope![0]}/main.rs`, "// builds\nfn main() {}\n");
      return { done: true, note: `${c.todo.id} builds; numbers come from the GPU benchmark` };
    }),
    on("choose", (c) => {
      const fps = (id: string) => c.state.findings.size && [...c.state.findings.values()].find((f) => f.todo === id)?.metrics?.fps_1m;
      write(c, "research/spikes.md", `A: ${fps("bench-a")} fps, B: ${fps("bench-b")} fps at 1M instances\n`);
      return {
        done: true,
        asks: [{ question: `Spike A (meshlets) ran at ${fps("bench-a")} fps and spike B (classic LOD) at ${fps("bench-b")} fps with 1M instances. Which approach do we build on?`, options: [{ id: "A", label: "Meshlets", effect: { type: "decide", rejected: ["B"] } }, { id: "B", label: "Classic LOD", effect: { type: "decide", rejected: ["A"] } }] }],
      };
    }),
    on("contracts", (c) => {
      for (const f of ["render-api", "scene", "assets"]) write(c, `contracts/${f}.md`, `# ${f} contract\n`);
      return { done: true };
    }),
    on("teams", () => ({
      done: true,
      spawn: [workstream("renderer", "engine/render", "contracts/render-api.md", 60), workstream("editor", "engine/editor", "contracts/scene.md", 50), workstream("assets", "engine/assets", "contracts/assets.md", 40)],
    })),
    lane("build", (c) => {
      write(c, `${c.todo.writeScope![0]}/lib.rs`, "// builds\n");
      return { done: true };
    }),
    on("mon", () => ({
      done: true,
      findings: [{ assumption: "W1", direction: "refutes", grade: "reported", source: "https://example.com/engine-release-notes", text: "The leading engine now ships a stylized preset; our wedge may be thinner" }],
    })),
    lane("synthesis", () => ({ done: true, note: "Findings agree: developers want it, meshlets are fast, reload is instant. Watch the competitor's preset." })),
    lane("replicate", (c) => ({
      done: true,
      todos: [{ kind: "wait", lane: "replicate", text: "Re-measure: do waitlisted developers still activate after the competitor release?", tests: "W1", because: c.todo.because, wait: { source: "activation", minDays: 14, informs: [{ assumption: "W1", metric: "activated_devs", threshold: { metric: "activated_devs", op: ">=", value: 100 } }] } }],
    })),
  ]);

  const jobs = new SimJobs((t) => {
    const results: Record<string, { minutes: number; metrics: Record<string, number>; gpuHours: number }> = {
      "bench-a": { minutes: 300, metrics: { fps_1m: 74 }, gpuHours: 6 },
      "bench-b": { minutes: 300, metrics: { fps_1m: 41 }, gpuHours: 6 },
      "reload-bench": { minutes: 120, metrics: { reload_ms: 640 }, gpuHours: 2 },
    };
    return results[t.id] ?? { minutes: 60, metrics: {}, gpuHours: 1 };
  });

  const partner = person("partner", 24 * 60, [
    { match: origin("rule:scope_vs_budget"), answer: () => ({ choice: "narrow", revision: narrowed, note: "Pick a wedge we can win" }) },
    { match: (a) => a.question.includes("Which approach"), answer: () => ({ choice: "A" }) },
    { match: idStarts("ask-spawn"), answer: () => ({ choice: "approve" }) },
    // Discovery is done, but the umbrella goal stays open while the workstreams build.
    { match: origin("rule:success"), answer: () => ({ choice: "continue", note: "Keep the umbrella open while the workstreams build" }) },
    { match: origin("rule:idle"), answer: () => ({ choice: "close" }) },
    { match: about("never"), answer: () => ({ choice: "x" }) },
  ]);

  return {
    name: "game-engine",
    summary: "Build an Unreal 6 game engine",
    def: engineDef(),
    start: START,
    until: "2027-01-10T00:00:00Z",
    agent,
    runners: [{ runner: { id: "cpu-1", capabilities: ["shell"] }, slots: 2 }, { runner: { id: "gpu-1", capabilities: ["shell", "gpu"] }, slots: 1 }],
    people: [partner],
    world: {
      jobs,
      metrics: {
        devsignups: new SimMetrics("behavioral", (d) => ({ alpha_signups: Math.round(14 * d), days_live: Math.floor(d) })),
        activation: new SimMetrics("behavioral", (d) => ({ activated_devs: Math.round(9 * d) })),
      },
      probe: new SimProbe({ "competitor-release-notes": [{ at: day(START, 45), fingerprint: "stylized-preset", summary: "the leading engine added a stylized rendering preset" }] }),
      checkers: {
        trademark: (dir, { files }) => contains(dir, files, /unreal/i, ["engine", "brand"]).map((x) => `${x}: Unreal is Epic Games' trademark`),
        "no-copied-source": (dir, { files }) => contains(dir, files, /Copyright Epic Games/i, ["engine"]),
        page: (dir) => exists(dir, "brand/site/index.html"),
        builds: (_dir, { files }) => (files.length ? [] : ["nothing built"]),
        contracts: (dir) => exists(dir, "contracts/render-api.md"),
      },
    },
  };
}

export type { TurnContext };
