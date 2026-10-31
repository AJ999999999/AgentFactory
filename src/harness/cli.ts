// Long-running harness, from the command line.
//
//   npm run harness -- open <engagement.json> [--remote <git url or path>] [--world world.mjs] [--seed dir] [--memory dir]   start an engagement
//   npm run harness -- tick [--runner r1] [--caps shell,gpu] [--slots 2]    one wake (for Task Scheduler / cron)
//   npm run harness -- loop [--runner r1] [--poll 10] [--log file] ...        keep waking, sleeping as told
//   npm run harness -- doctor [--copilot path]                                check this machine end to end
//   npm run harness -- status [--goal G] [--for partner]                      handoff packets and open questions
//   npm run harness -- answer <ask> --choice <id> [--by partner] [--note ..] [--revision file.json] [--budget turns=300]
//                     [--result supports|refutes|neutral --metrics attempts=9,minutes=40 --runs 3]   what you observed, as evidence
//   npm run harness -- pause [--reason ..] | resume                         stop anything new from starting, or let it start
//   npm run harness -- budget <goal> turns=300[,usd=50]                     a new budget for a goal
//
// npm run panel shows all of this (and answers) in a page on this PC.
//
// State lives in git (the control repo); .af/harness/<engagement>/config.json only
// says where that repo is. The runner (Copilot CLI, by default) and the world (job,
// metric and probe providers, checkers) are wired from --agent and --world.
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { cloneControl, Git, initBare } from "../git.ts";
import { resolveCommand, runCommand, sleepUntil } from "../proc.ts";
import { aboutLines, loadMemoryPolicy, readMemory, understand } from "../memory/memory.ts";
import { userAgentsDir, vendorOfModel } from "./agents.ts";
import type { TurnAgent } from "./agents.ts";
import { buildTurnAgent, loadAgentsConfig, usedVendors } from "./setup.ts";
import { VENDOR_DEFAULTS } from "./vendors.ts";
import { Harness } from "./harness.ts";
import { buildPacket } from "./packet.ts";
import { beliefs, loadPolicy, seatPermissions } from "./project.ts";
import { blockers, phase } from "./select.ts";
import { checkLibrary } from "./team.ts";
import type { EngagementDef, GoalRevision } from "./types.ts";
import type { World } from "./world.ts";
import { SystemClock } from "./world.ts";
import { rememberFolder } from "../panel/folders.ts";

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
  const cfg = JSON.parse(fs.readFileSync(path.join(home(engagement), "config.json"), "utf8")) as { repo: string; world?: string; memory?: string };
  const lib = policy.team?.library;
  const agent: TurnAgent = buildTurnAgent(agentsConfig(), {
    root: ROOT, timeoutMs: policy.claims.turnTimeoutMinutes * 60_000,
    bins: Object.fromEntries(["copilot", "claude", "codex", "pi", "omp"].map((v) => [v, flag(v)])),
    judgeLanes: [...(lib?.judgeLanes ?? []), "review"],
    sessionDir: path.join(home(engagement), "sessions"), salt: engagement,
  });
  // --world <module.ts> exporting `world` (your job, metric and probe providers and
  // checkers), or case:<name> for a built-in case's checkers and simulated sources.
  // The engagement's world (checkers, providers) is saved when it's opened, so the
  // scheduled loop loads the same red lines a manual run does.
  const worldFile = flag("world") ?? cfg.world;
  const world: World = !worldFile ? {} : worldFile.startsWith("case:") ? await caseWorld(worldFile.slice(5)) : ((await import(path.resolve(worldFile))) as { world: World }).world;
  // Memory about the people this engagement serves (open --memory <dir>), read fresh
  // for every turn so a lapsed plan is gone the moment it lapses.
  const memPolicy = loadMemoryPolicy(path.join(ROOT, "policy", "memory.json"));
  const about = (s: { engagement: { memory?: { principal: string; subjects: string[] } } | null }) => {
    const m = s.engagement?.memory;
    if (!m || !cfg.memory) return [];
    return aboutLines(understand(readMemory(cfg.memory, m.principal), Date.now(), memPolicy, { subjects: m.subjects }), m.principal);
  };
  return new Harness({ control: new Git(cfg.repo), engagement, policy, clock: new SystemClock(), world, agent, worktreeRoot: path.join(home(engagement), "wt"), turnsDir: path.join(home(engagement), "turns"), slots: Number(flag("slots", "2")), log: (e, d) => process.stderr.write(`${e} ${JSON.stringify(d)}\n`), about });
}

// --models model-a=pi:,model-b=codex: tries other CLIs for one run without editing the
// policy (the scheduled loop goes by the policy file).
const agentsConfig = () => loadAgentsConfig(ROOT, flag("models"));

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

// "turns=300,usd=50" -> { turns: 300, usd: 50 }
function kv(x: string): Record<string, number> {
  return Object.fromEntries(x.split(",").map((p) => {
    const [k, v] = p.split("=");
    if (!k?.trim() || v === undefined || !Number.isFinite(Number(v))) throw new Error(`can't read "${p}" (use name=number)`);
    return [k.trim(), Number(v)];
  }));
}

function runner() {
  return { id: flag("runner", "runner-1")!, capabilities: (flag("caps", "shell") ?? "").split(",").filter(Boolean) };
}

async function main(): Promise<void> {
  switch (cmd) {
    case "open": {
      // A JSON file, or "case:<name>" for one of the six built-in cases' definitions.
      const def = rest[0].startsWith("case:") ? await caseDef(rest[0].slice(5)) : (JSON.parse(fs.readFileSync(rest[0], "utf8")) as EngagementDef);
      // Check what's passed before anything is created.
      if (flag("seed") && !fs.statSync(path.resolve(flag("seed")!), { throwIfNoEntry: false })?.isDirectory()) throw new Error(`--seed ${flag("seed")} is not a folder`);
      if (flag("world") && !flag("world")!.startsWith("case:")) await import(path.resolve(flag("world")!));
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
      // --seed <dir>: files the work builds on (a brief, contracts) committed into the
      // engagement repo first, where agents read them and you can edit them.
      const seedDir = flag("seed");
      if (seedDir) {
        const src = path.resolve(seedDir);
        const g = new Git(repo, { name: "partner", email: "partner@agents.local" });
        await g.runAsync(["fetch", "-q", "origin"]);
        await g.tryAsync(["reset", "-q", "--hard", "origin/main"]);
        for (const e of fs.readdirSync(src)) {
          if ([".agents", "policy", ".git", ".af"].includes(e)) throw new Error(`--seed can't write ${e}/: it belongs to the harness`);
          fs.cpSync(path.join(src, e), path.join(repo, e), { recursive: true });
        }
        if (await g.commitAll(`seed ${def.id}: ${fs.readdirSync(src).join(", ")}`, { Engagement: def.id })) await g.runAsync(["push", "-q", "origin", "HEAD:main"]);
      }
      const w = flag("world");
      const world = w ? (w.startsWith("case:") ? w : path.resolve(w)) : undefined;
      if (world && !world.startsWith("case:")) await import(world); // fail now, not in the scheduled task
      const mem = flag("memory") ? path.resolve(flag("memory")!) : undefined;
      fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ repo, remote, ...(world ? { world } : {}), ...(mem ? { memory: mem } : {}) }, null, 2));
      await (await harness(def.id)).open(def);
      // So `npm run panel` from anywhere shows it next to the other projects' work.
      rememberFolder(process.cwd());
      console.log(`opened ${def.id}: ${def.goals.length} goal(s), state in ${remote}`);
      return;
    }
    case "tick": {
      // One wake, for a scheduler that starts a fresh process each time. The quiet-wake
      // memory is kept on disk, so an unchanged engagement costs one ls-remote.
      const eng = currentEngagement();
      const h = await harness(eng);
      const rn = runner();
      const mem = path.join(home(eng), `runner-${safeName(rn.id)}.json`);
      try {
        h.remember(rn.id, JSON.parse(fs.readFileSync(mem, "utf8")));
      } catch {
        /* first wake on this machine */
      }
      const r = await h.tick(rn, { slots: Number(flag("slots", "1")) });
      const m = h.memory(rn.id);
      if (m) fs.writeFileSync(mem, JSON.stringify(m));
      heartbeat(eng, rn.id, r.hint, !!r.quiet);
      console.log(JSON.stringify({ quiet: !!r.quiet, turns: r.turns, started: r.started, maintenance: r.maintenance.length, next: { ...r.hint, at: new Date(r.hint.at).toISOString() } }, null, 2));
      return;
    }
    case "loop": {
      // Keep waking. Sleeps by the wall clock (a laptop that sleeps doesn't run timers),
      // rechecks at least every --poll minutes so your answers are picked up (a quiet
      // recheck is one ls-remote), and rides out network drops instead of exiting.
      const eng = currentEngagement();
      const h = await harness(eng);
      const rn = runner();
      const poll = Number(flag("poll", "10")) * 60_000;
      const logFile = flag("log");
      const say = (line: string) => {
        const l = `${new Date().toISOString()} ${line}`;
        console.log(l);
        if (logFile) appendLog(logFile, l);
      };
      say(`loop started: ${eng}, runner ${rn.id}, pid ${process.pid}`);
      let backoff = 60_000;
      for (;;) {
        let next: number;
        try {
          const r = await h.tick(rn, { slots: Number(flag("slots", "1")) });
          heartbeat(eng, rn.id, r.hint, !!r.quiet);
          for (const t of r.turns) say(`${t.todo}: ${t.result}/${t.granularity}${t.reasons.length ? ` (${t.reasons.join("; ").slice(0, 200)})` : ""}`);
          for (const s of r.started) say(`started ${s}`);
          if (r.hint.action === "stop") {
            say("every goal is closed; stopping");
            return;
          }
          next = Math.max(Date.now() + 1_000, Math.min(r.hint.at, Date.now() + poll));
          if (r.turns.length || r.started.length || r.maintenance.length) say(`next wake ${new Date(next).toISOString()}: ${r.hint.why}`);
          backoff = 60_000;
        } catch (e) {
          // Offline, VPN down, a git lock held by an editor: wait and try again.
          say(`tick failed: ${(e as Error).message.split("\n")[0].slice(0, 300)}`);
          next = Date.now() + Math.min(backoff, poll);
          backoff = Math.min(backoff * 2, poll);
        }
        await sleepUntil(next);
      }
    }
    case "doctor": {
      process.exitCode = (await doctor()) ? 0 : 1;
      return;
    }
    case "agents": {
      // The harness's Copilot custom agent profiles, one per library role, installed in
      // your user folder so every engagement repo can use them.
      const src = path.join(ROOT, "integrations", "copilot", "harness-agents");
      const dest = userAgentsDir();
      const files = fs.readdirSync(src).filter((f) => f.endsWith(".agent.md"));
      if (rest[0] === "install") {
        fs.mkdirSync(dest, { recursive: true });
        for (const f of files) {
          const to = path.join(dest, f);
          if (fs.existsSync(to) && !rest.includes("--force")) {
            console.log(`kept    ${to} (yours may be edited; --force replaces it)`);
            continue;
          }
          fs.copyFileSync(path.join(src, f), to);
          console.log(`wrote   ${to}`);
        }
      } else {
        for (const f of files) console.log(`${fs.existsSync(path.join(dest, f)) ? "installed" : "missing  "} ${path.join(dest, f)}`);
        console.log("install with: npm run harness -- agents install");
      }
      return;
    }
    case "status": {
      const h = await harness(currentEngagement());
      const s = await h.state();
      const only = flag("goal");
      if (s.paused) console.log(`PAUSED since ${new Date(s.paused.at).toISOString()}${s.paused.reason ? `: ${s.paused.reason}` : ""} (npm run harness -- resume)`);
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
      // What you observed (a playtest, a review), as evidence on the assumption the
      // action tests. Its grade comes from who you are, never from the answer.
      const result = flag("result") as "supports" | "refutes" | "neutral" | undefined;
      if (result && !["supports", "refutes", "neutral"].includes(result)) throw new Error("--result is supports, refutes or neutral");
      const s = await h.state();
      const ask = s.asks.get(rest[0]);
      const tests = ask?.todo ? s.todos.get(ask.todo)?.tests : undefined;
      const metrics = flag("metrics");
      // You answer as yourself (partner). The grade of what you report depends on who
      // it comes from, so passing on what the parent or the lawyer saw takes an
      // explicit --by <their role>: it's never assumed from who the question was for.
      await h.answer(rest[0], {
        by: flag("by") ?? "partner",
        choice: flag("choice")!,
        note: flag("note"),
        revision: revFile ? (JSON.parse(fs.readFileSync(revFile, "utf8")) as GoalRevision) : undefined,
        budget: budget ? kv(budget) : undefined,
        finding: result ? { assumption: flag("assumption") ?? tests, direction: result, text: flag("note") ?? "", metrics: metrics ? kv(metrics) : undefined, runs: flag("runs") ? Number(flag("runs")) : undefined } : undefined,
      });
      console.log(`answered ${rest[0]}: ${flag("choice")}${result ? ` (${result}${tests ? ` ${tests}` : ""})` : ""}`);
      return;
    }
    case "pause":
    case "resume": {
      const eng = currentEngagement();
      const changed = await (await harness(eng)).pause(cmd === "pause", flag("by", "partner"), flag("reason"));
      console.log(changed ? `${eng}: ${cmd === "pause" ? "paused (running jobs still finish)" : "resumed"}` : `${eng} was already ${cmd === "pause" ? "paused" : "running"}`);
      return;
    }
    case "budget": {
      if (!rest[0] || !rest[1] || rest[0].startsWith("--")) throw new Error("usage: budget <goal> turns=300[,usd=50,gpuHours=10]");
      await (await harness(currentEngagement())).setBudget(rest[0], kv(rest[1]), flag("by", "partner"));
      console.log(`${rest[0]}: budget ${rest[1]}`);
      return;
    }
    default:
      console.log("usage: npm run harness -- open <engagement.json> | tick | loop | status | answer <ask> --choice <id> | pause | resume | budget <goal> turns=N | doctor | agents [install]");
  }
}

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "_");
}

// When this runner last woke and what it's waiting for: proof the scheduled task is alive.
function heartbeat(eng: string, runnerId: string, hint: { action: string; at: number; why: string }, quiet: boolean): void {
  try {
    fs.writeFileSync(path.join(home(eng), `heartbeat-${safeName(runnerId)}.json`), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, quiet, next: { ...hint, at: new Date(hint.at).toISOString() } }, null, 2));
  } catch {
    /* best effort */
  }
}

function appendLog(file: string, line: string): void {
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, `${file}.1`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line + "\n");
  } catch {
    /* a log must never stop the loop */
  }
}

// Check this machine: node, git, Copilot CLI, the engagement's repo and remote, the
// library, and (on Windows) the scheduled task and its heartbeat.
async function doctor(): Promise<boolean> {
  let ok = true;
  const line = (good: boolean, what: string, fix = "", warnOnly = false) => {
    console.log(`${good ? "ok  " : warnOnly ? "warn" : "FAIL"} ${what}${!good && fix ? `\n     fix: ${fix}` : ""}`);
    if (!good && !warnOnly) ok = false;
  };
  const [maj, min] = process.versions.node.split(".").map(Number);
  line(maj > 22 || (maj === 22 && min >= 18), `node ${process.versions.node}`, "install Node 22.18 or later (TypeScript runs without a build step from 22.18)");
  let gitV = "";
  try {
    gitV = execFileSync("git", ["--version"], { encoding: "utf8", windowsHide: true }).trim();
  } catch {
    /* missing */
  }
  const gm = gitV.match(/(\d+)\.(\d+)/);
  line(!!gm && (Number(gm[1]) > 2 || (Number(gm[1]) === 2 && Number(gm[2]) >= 32)), gitV || "git not found", "install Git 2.32 or later (Git for Windows on Windows)");
  const bin = flag("copilot", "copilot")!;
  try {
    const r = resolveCommand(bin.includes("/") || bin.includes("\\") ? path.resolve(bin) : bin);
    const v = (await runCommand(bin.includes("/") || bin.includes("\\") ? path.resolve(bin) : bin, ["--version"], { timeout: 60_000 })).stdout.trim().split("\n")[0];
    line(true, `copilot ${v} (${[r.file, ...r.prefix].join(" ")})`);
  } catch (e) {
    line(false, `copilot: ${(e as Error).message.split("\n")[0]}`, "install Copilot CLI (npm install -g @github/copilot, or winget) and run `copilot` once to sign in; or pass --copilot <path>");
  }
  if (policy.team) {
    const bad = checkLibrary(policy.team.library, policy.team.catalog);
    line(!bad.length, `library: ${bad.length ? bad.join("; ") : `${Object.keys(policy.team.library.lanes ?? {}).length} lanes staffed`}`);
    // With worker mode on, every seat that does the work runs as af-worker.
    const roles = [...new Set([...Object.values(policy.team.library.lanes ?? {}), policy.team.library.generated?.agent ?? "author", ...(agentsConfig().worker ? ["worker"] : [])])];
    const dir = userAgentsDir();
    const missing = roles.filter((r) => !fs.existsSync(path.join(dir, `af-${r}.agent.md`)));
    line(!missing.length, `agent profiles in ${dir}: ${missing.length ? `missing ${missing.map((r) => `af-${r}`).join(", ")}` : `${roles.length} installed`}`, "npm run harness -- agents install (turns still run without them, with the role in the prompt)");
    const ac = agentsConfig();
    const lib = policy.team.library;
    const used = [...new Set([...Object.values(lib.roles).map((r) => r.model), lib.generated?.model ?? ""])].filter((m) => /^model-[a-z]$/.test(m));
    // What each placeholder really runs on. Unmapped ones all get Copilot's default model,
    // so they're the same model as each other.
    const real = (m: string) => {
      const x = ac.models?.[m] ?? "";
      return !x ? "Copilot's default model" : x.endsWith(":") ? `${x.slice(0, -1)}'s default model` : x;
    };
    const judges = new Set((lib.judgeLanes ?? []).map((l) => lib.roles[lib.lanes?.[l] ?? ""]?.model).filter(Boolean));
    const workers = new Set(Object.entries(lib.lanes ?? {}).filter(([l]) => !(lib.judgeLanes ?? []).includes(l)).map(([, r]) => lib.roles[r]?.model).filter(Boolean));
    const shared = [...judges].filter((j) => [...workers].some((w) => real(w) === real(j!)));
    line(!shared.length, `models: ${used.map((m) => `${m}=${real(m)}`).join(", ")}${shared.length ? `; judges (${shared.join(", ")}) run on the same model as the work they judge` : ""}`, "map the judges' model to another vendor in policy/harness-agents.json, e.g. \"model-b\": \"claude:opus\" (Copilot on some plans offers only one model)", true);
    // Each other CLI a placeholder maps to: is it there, and how is the catalog held.
    const how: Record<string, string> = {
      claude: "allowed and disallowed tools; anything else refused",
      codex: "its sandbox: writes only in the worktree, no network unless granted. It runs any command inside that, so the catalog's command list isn't enforced",
      pi: "the turn gate: the seat's tools, its commands one at a time, writes in the write scope",
      omp: "the turn gate: the seat's tools, its commands one at a time, writes in the write scope",
    };
    const signIn: Record<string, string> = { claude: "install Claude Code and sign in (claude, then /login)", codex: "install Codex CLI and sign in (codex login)", pi: "npm install -g @earendil-works/pi-coding-agent, then set up a provider (pi, then /login)", omp: "install omp and log in to a provider (omp login)" };
    for (const v of usedVendors(ac)) {
      const bin = flag(v) ?? ac.cli?.[v]?.bin ?? VENDOR_DEFAULTS[v].bin!;
      const seats = used.filter((m) => vendorOfModel(ac.models?.[m]) === v).join(", ");
      try {
        const ver = (await runCommand(bin, ["--version"], { timeout: 60_000 })).stdout.trim().split("\n")[0];
        line(v !== "codex", `${v} ${ver}, for ${seats}; held to the catalog by ${how[v]}`, "fine if you accept that; or map those seats to a CLI that limits commands", true);
      } catch (e) {
        line(false, `${v}: ${(e as Error).message.split("\n")[0]}`, `${signIn[v]}, or pass --${v} <path>; or map ${seats} to another CLI`);
      }
    }
  }
  const dir = path.join(process.cwd(), ".af", "harness");
  const engs = flag("engagement") ? [flag("engagement")!] : fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  if (!engs.length) console.log("     (no engagement opened in this directory yet: npm run harness -- open <engagement.json> --remote <url>)");
  for (const eng of engs) {
    const cfgFile = path.join(home(eng), "config.json");
    if (!fs.existsSync(cfgFile)) {
      line(false, `${eng}: no config.json`, "open the engagement again from this directory");
      continue;
    }
    const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8")) as { repo: string; remote?: string };
    const g = new Git(cfg.repo);
    const conf = (k: string) => g.tryAsync(["config", "--get", k]).then((r) => r.out);
    line((await conf("core.autocrlf")) === "false", `${eng}: control repo has no line-ending conversion`, `git -C "${cfg.repo}" config core.autocrlf false`);
    const remote = await g.tryAsync(["ls-remote", "origin", "refs/heads/main"]);
    line(remote.ok, `${eng}: remote reachable${remote.ok ? "" : ` (${remote.err.split("\n")[0]})`}`, "check the network or VPN and your git credentials (the scheduled task runs as you, so it uses the same ones)");
    for (const f of fs.readdirSync(home(eng)).filter((x) => x.startsWith("heartbeat-"))) {
      const hb = JSON.parse(fs.readFileSync(path.join(home(eng), f), "utf8")) as { at: string; next: { at: string; why: string } };
      const age = (Date.now() - Date.parse(hb.at)) / 60_000;
      line(age < 60, `${eng}: ${f.slice(10, -5)} last woke ${Math.round(age)} min ago; next ${hb.next.at} (${hb.next.why})`, "is the scheduled task running? (scripts/windows/install-harness-task.ps1)");
    }
    if (process.platform === "win32") {
      try {
        const q = execFileSync("schtasks", ["/Query", "/TN", `AgentFactory harness - ${eng}`, "/FO", "LIST"], { encoding: "utf8", windowsHide: true });
        const status = q.match(/Status:\s*(.+)/)?.[1]?.trim() ?? "?";
        line(true, `${eng}: scheduled task installed (${status})`);
      } catch {
        line(false, `${eng}: no scheduled task`, `powershell -ExecutionPolicy Bypass -File scripts\\windows\\install-harness-task.ps1 -Engagement ${eng}`);
      }
    }
  }
  return ok;
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
