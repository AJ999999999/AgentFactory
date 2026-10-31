// Long-running harness, from the command line.
//
//   npm run harness -- open <engagement.json> [--remote <git url or path>]   start an engagement
//   npm run harness -- tick [--runner r1] [--caps shell,gpu] [--slots 2]    one wake (for Task Scheduler / cron)
//   npm run harness -- loop [--runner r1] ...                                 keep waking, sleeping as told
//   npm run harness -- status [--goal G] [--for partner]                      handoff packets and open questions
//   npm run harness -- answer <ask> --choice <id> [--by partner] [--note ..] [--revision file.json] [--budget turns=300]
//
// State lives in git (the control repo); .af/harness/<engagement>/config.json only
// says where that repo is. The runner (Copilot CLI, by default) and the world (job,
// metric and probe providers, checkers) are wired from --agent and --world.
import * as fs from "node:fs";
import * as path from "node:path";
import { cloneControl, Git, initBare } from "../git.ts";
import { CopilotTurnAgent } from "./agents.ts";
import type { LaneConfig, TurnAgent } from "./agents.ts";
import { Harness } from "./harness.ts";
import { buildPacket } from "./packet.ts";
import { beliefs, loadPolicy, seatPermissions } from "./project.ts";
import { blockers, phase } from "./select.ts";
import type { ToolConfig } from "./team.ts";
import { checkLibrary } from "./team.ts";
import type { EngagementDef, GoalRevision } from "./types.ts";
import type { World } from "./world.ts";
import { SystemClock } from "./world.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const policy = loadPolicy(path.join(ROOT, "policy", "harness.json"));
const [, , cmd, ...rest] = process.argv;
if (policy.team) {
  const bad = checkLibrary(policy.team.library, policy.team.catalog);
  if (bad.length) throw new Error(`policy/library.json: ${bad.join("; ")}`);
}

function flag(name: string, fallback?: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : fallback;
}

function home(engagement: string): string {
  return path.join(process.cwd(), ".af", "harness", engagement);
}

function currentEngagement(): string {
  const e = flag("engagement");
  if (e) return e;
  const dir = path.join(process.cwd(), ".af", "harness");
  const all = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  if (all.length !== 1) throw new Error(`pass --engagement (found: ${all.join(", ") || "none"})`);
  return all[0];
}

async function harness(engagement: string): Promise<Harness> {
  const cfg = JSON.parse(fs.readFileSync(path.join(home(engagement), "config.json"), "utf8")) as { repo: string };
  const lanesFile = path.join(ROOT, "policy", "harness-agents.json");
  const cfg2 = JSON.parse(fs.readFileSync(lanesFile, "utf8")) as { fallback: LaneConfig; lanes: Record<string, LaneConfig>; agents?: Record<string, string> } & ToolConfig;
  // A path to the binary is resolved here; turns run with the worktree as their cwd.
  const bin = flag("copilot", "copilot")!;
  const agent: TurnAgent = new CopilotTurnAgent({
    bin: bin.includes("/") || bin.includes("\\") ? path.resolve(bin) : bin, fallback: cfg2.fallback, lanes: cfg2.lanes, agents: cfg2.agents,
    tools: { tools: cfg2.tools, always: cfg2.always }, timeoutMs: policy.claims.turnTimeoutMinutes * 60_000,
  });
  // --world <module.ts> exporting `world` (your job, metric and probe providers and
  // checkers), or case:<name> for a built-in case's checkers and simulated sources.
  const worldFile = flag("world");
  const world: World = !worldFile ? {} : worldFile.startsWith("case:") ? await caseWorld(worldFile.slice(5)) : ((await import(path.resolve(worldFile))) as { world: World }).world;
  return new Harness({ control: new Git(cfg.repo), engagement, policy, clock: new SystemClock(), world, agent, worktreeRoot: path.join(home(engagement), "wt"), slots: Number(flag("slots", "2")), log: (e, d) => process.stderr.write(`${e} ${JSON.stringify(d)}\n`) });
}

async function caseWorld(name: string): Promise<World> {
  const setups: Record<string, () => Promise<{ world: World }>> = {
    "game-engine": async () => (await import("./cases/game-engine.ts")).gameEngine(),
    "kids-rockets": async () => (await import("./cases/kids-rockets.ts")).kidsRockets(),
    "senior-meds": async () => (await import("./cases/senior-meds.ts")).seniorMeds(),
    migration: async () => (await import("./cases/migration.ts")).migration(),
    research: async () => (await import("./cases/research.ts")).research(),
    stewardship: async () => (await import("./cases/stewardship.ts")).stewardship(),
  };
  if (!setups[name]) throw new Error(`no case ${name}`);
  return (await setups[name]()).world;
}

async function caseDef(name: string): Promise<EngagementDef> {
  const cases: Record<string, () => Promise<EngagementDef>> = {
    "game-engine": async () => (await import("./cases/game-engine.ts")).engineDef(),
    "kids-rockets": async () => (await import("./cases/kids-rockets.ts")).kidsDef(),
    "senior-meds": async () => (await import("./cases/senior-meds.ts")).medsDef(),
    migration: async () => (await import("./cases/migration.ts")).migrationDef(),
    research: async () => (await import("./cases/research.ts")).researchDef(),
    stewardship: async () => (await import("./cases/stewardship.ts")).stewardshipDef(),
  };
  if (!cases[name]) throw new Error(`no case ${name} (${Object.keys(cases).join(", ")})`);
  return cases[name]();
}

function runner() {
  return { id: flag("runner", "runner-1")!, capabilities: (flag("caps", "shell") ?? "").split(",").filter(Boolean) };
}

async function main(): Promise<void> {
  switch (cmd) {
    case "open": {
      // A JSON file, or "case:<name>" for one of the six built-in cases' definitions.
      const def = rest[0].startsWith("case:") ? await caseDef(rest[0].slice(5)) : (JSON.parse(fs.readFileSync(rest[0], "utf8")) as EngagementDef);
      const dir = home(def.id);
      fs.mkdirSync(dir, { recursive: true });
      let remote = flag("remote");
      if (!remote) {
        // Local trial: a bare repo stands in for GitHub.
        remote = path.join(dir, "origin.git");
        if (!fs.existsSync(remote)) {
          initBare(remote);
          const seed = cloneControl(remote, path.join(dir, "seed"));
          fs.writeFileSync(path.join(seed.cwd, "README.md"), `# ${def.title}\n`);
          await seed.commitAll("start", {});
          seed.run(["push", "-q", "origin", "HEAD:main"]);
          fs.rmSync(seed.cwd, { recursive: true, force: true });
        }
      }
      const repo = path.join(dir, "control");
      if (!fs.existsSync(repo)) cloneControl(remote, repo);
      fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ repo, remote }, null, 2));
      await (await harness(def.id)).open(def);
      console.log(`opened ${def.id}: ${def.goals.length} goal(s), state in ${remote}`);
      return;
    }
    case "tick": {
      const h = await harness(currentEngagement());
      const r = await h.tick(runner(), { slots: Number(flag("slots", "1")) });
      console.log(JSON.stringify({ turns: r.turns, started: r.started, maintenance: r.maintenance.length, next: { ...r.hint, at: new Date(r.hint.at).toISOString() } }, null, 2));
      return;
    }
    case "loop": {
      const h = await harness(currentEngagement());
      for (;;) {
        const r = await h.tick(runner(), { slots: Number(flag("slots", "1")) });
        for (const t of r.turns) console.log(`${new Date().toISOString()} ${t.todo}: ${t.result}/${t.granularity}`);
        if (r.hint.action === "stop") {
          console.log("every goal is closed; stopping");
          return;
        }
        const ms = Math.max(1_000, r.hint.at - Date.now());
        if (r.turns.length || r.started.length) console.log(`next wake in ${Math.round(ms / 60_000)} min: ${r.hint.why}`);
        await new Promise((res) => setTimeout(res, ms));
      }
    }
    case "status": {
      const h = await harness(currentEngagement());
      const s = await h.state();
      const only = flag("goal");
      for (const g of s.goals.values()) {
        if (only && g.id !== only) continue;
        const ph = phase(s, g.id);
        console.log(`\n## ${g.id} v${g.version} (${g.status}): ${g.def.title}`);
        console.log(`phase: ${ph ? `${ph.category} (${ph.assumption})` : "-"} · spent ${g.spent.turns}/${g.def.budget.turns ?? "∞"} turns`);
        for (const b of beliefs(s, g.id)) console.log(`  ${b.def.id.padEnd(6)} ${b.status.padEnd(10)} ${b.def.text}`);
        const seats = [...s.seats.values()].filter((x) => x.goal === g.id);
        if (seats.length) console.log(`team: ${seats.map((x) => `${x.lane}=${x.template}${x.probation ? ` (probation, ${x.accepted} accepted)` : ""}${x.pending.length ? ` [${seatPermissions(s, x).length > x.permissions.length ? "granted" : "pending"}: ${x.pending.map((p) => p.permission).join(",")}]` : ""}`).join(" · ")}`);
        const open = [...s.todos.values()].filter((t) => t.goal === g.id && ["open", "running", "review", "blocked"].includes(t.status));
        for (const t of open) {
          const why = t.status === "open" ? blockers(s, t, Date.now()) : t.status === "running" ? [`running (${t.handle ?? t.ask ?? ""})`] : t.ask ? [`waiting on ${t.ask}`] : [];
          if (t.status === "open" && t.kind === "wait" && !h.world.metrics?.[t.wait!.source]) why.push(`no metric source "${t.wait!.source}" (pass --world)`);
          if (t.status === "open" && t.kind === "job" && !h.world.jobs) why.push("no job provider (pass --world)");
          console.log(`  [${t.status}] ${t.id}: ${t.text}${why.length ? `\n      waiting: ${why.join("; ")}` : ""}`);
        }
        const next = open.find((t) => t.kind === "task" && !blockers(s, t, Date.now()).length);
        if (next && rest.includes("--packet")) console.log(`\n${buildPacket(s, next, "status")}`);
      }
      const who = flag("for", "partner")!;
      const asks = h.digest(s, who);
      console.log(`\n## Waiting on ${who} (${asks.length})`);
      for (const a of asks) console.log(`${a.urgent ? "URGENT " : ""}${a.id} (blocks ${a.blocks}): ${a.question}\n    options: ${a.options.join(" | ")}`);
      return;
    }
    case "answer": {
      const h = await harness(currentEngagement());
      const revFile = flag("revision");
      const budget = flag("budget");
      await h.answer(rest[0], {
        by: flag("by", "partner")!,
        choice: flag("choice")!,
        note: flag("note"),
        revision: revFile ? (JSON.parse(fs.readFileSync(revFile, "utf8")) as GoalRevision) : undefined,
        budget: budget ? Object.fromEntries(budget.split(",").map((kv) => { const [k, v] = kv.split("="); return [k, Number(v)]; })) : undefined,
      });
      console.log(`answered ${rest[0]}: ${flag("choice")}`);
      return;
    }
    default:
      console.log("usage: npm run harness -- open <engagement.json> | tick | loop | status | answer <ask> --choice <id>");
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
