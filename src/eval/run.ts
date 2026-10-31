// Compares ways of running an engagement's turns on graded cases, with the real CLIs:
//
//   npm run eval -- --check                         the checks themselves: each case's start fails them, its solution passes
//   npm run eval -- --list                          the cases
//   npm run eval -- [--arms A,B,C] [--cases a,b] [--runs 2] [--models model-a=pi:] [--run-id <id>] [--max-ticks 10]
//                   [--wait-hours 12] [--no-wait] [--skip-preflight]
//
// Arms:
//   A  a role per lane, a fresh session every turn (the harness today)
//   B  one worker agent, given the lane's skill; still a fresh session every turn
//   C  B, plus the worker's session carried across the turns of a todo
//   D  B, plus one worker session across the whole goal
// Judges keep their roles and fresh sessions in every arm.
//
// Each case runs as a real engagement in its own folder under .af/eval/<run id>/, ticked
// until its work is done or stuck. Its merged result is graded by hidden checks. Results
// go to results.jsonl as they finish, so a run that stops (a usage limit, Ctrl+C) picks
// up where it left off with --run-id.
//
// The run looks after itself, so nobody has to watch it:
//   - before it starts, preflight checks the agent profiles and any model gateway; a
//     profile Copilot can't load stops it at once, before a single turn is wasted
//   - a usage limit, or a gateway that stops answering, ends the case run in progress
//     without recording it; the run waits (for the reset, or until the gateway answers
//     again), then does that case run again from the start, so a wait never counts
//     against an arm. --wait-hours (default 12) caps a wait; past it, the run stops and
//     prints how to continue. --no-wait stops at the first limit, as before.
import * as fs from "node:fs";
import * as path from "node:path";
import { cloneControl, initBare } from "../git.ts";
import { userAgentsDir, vendorOfModel } from "../harness/agents.ts";
import { Harness } from "../harness/harness.ts";
import { holds, preflight } from "../harness/preflight.ts";
import type { Problem } from "../harness/preflight.ts";
import { loadPolicy } from "../harness/project.ts";
import { sleepUntil } from "../proc.ts";
import { buildTurnAgent, loadAgentsConfig } from "../harness/setup.ts";
import { SystemClock } from "../harness/world.ts";
import type { EvalCase } from "./cases.ts";
import { buildSeed, grade, loadCases } from "./cases.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
export const ARMS: Record<string, { label: string; worker: boolean; sessions: "none" | "todo" | "goal" }> = {
  A: { label: "a role per lane, fresh session each turn (today)", worker: false, sessions: "none" },
  B: { label: "one worker with the lane's skill, fresh session each turn", worker: true, sessions: "none" },
  C: { label: "one worker, session carried across a todo's turns", worker: true, sessions: "todo" },
  D: { label: "one worker, one session across the goal", worker: true, sessions: "goal" },
};

export type Result = {
  case: string;
  arm: string;
  run: number;
  score: number;
  passed: number;
  total: number;
  failed: string[]; // the checks it missed
  turns: number;
  outcomes: Record<string, number>; // turn results
  todosDone: number;
  todos: number;
  premiumRequests: number;
  costUsd: number;
  tokensIn: number; // Codex reports tokens
  tokensOut: number;
  resumedTurns: number;
  minutes: number;
  stoppedBy: "done" | "stuck" | "max ticks";
  waitingOn: string[]; // open questions when it stopped
  dir: string;
};

type Wait = { kind: "limit" | "unreachable" | "setup"; until: number; vendor: string };
class WaitHit extends Error {
  wait: Wait;
  constructor(message: string, wait: Wait) {
    super(message);
    this.wait = wait;
  }
}

const args = process.argv.slice(2);
const flag = (n: string, d?: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : d;
};

// What the turn logs say each turn cost: Copilot's premium requests, Codex's tokens,
// Claude's API price.
function usage(turnsDir: string): { premiumRequests: number; costUsd: number; tokensIn: number; tokensOut: number; resumedTurns: number } {
  const u = { premiumRequests: 0, costUsd: 0, tokensIn: 0, tokensOut: 0, resumedTurns: 0 };
  if (!fs.existsSync(turnsDir)) return u;
  for (const f of fs.readdirSync(turnsDir).filter((x) => x.endsWith(".log"))) {
    const text = fs.readFileSync(path.join(turnsDir, f), "utf8");
    for (const m of text.matchAll(/(\d+) premium requests?/g)) u.premiumRequests += Number(m[1]);
    for (const m of text.matchAll(/\$([\d.]+) at API prices/g)) u.costUsd += Number(m[1]);
    for (const m of text.matchAll(/(\d+) tokens in, (\d+) out/g)) {
      u.tokensIn += Number(m[1]);
      u.tokensOut += Number(m[2]);
    }
    if (/^\S+ session \S+ \([a-z]+, turn \d+, resumed\)/m.test(text)) u.resumedTurns++;
  }
  return u;
}

export async function runCase(c: EvalCase, arm: string, run: number, o: { out: string; runId: string; models?: string; maxTicks: number; log: (s: string) => void; bins?: Record<string, string | undefined> }): Promise<Result> {
  const dir = path.join(o.out, c.id, `${arm}-r${run}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  // The engagement's repo, seeded with the case's starting point.
  const origin = path.join(dir, "origin.git");
  initBare(origin);
  const seed = cloneControl(origin, path.join(dir, "seed"));
  buildSeed(c, seed.cwd);
  await seed.commitAll(`seed ${c.id}`, {});
  seed.run(["push", "-q", "origin", "HEAD:main"]);
  fs.rmSync(seed.cwd, { recursive: true, force: true, maxRetries: 5 });
  const control = cloneControl(origin, path.join(dir, "control"));

  const policy = loadPolicy(path.join(ROOT, "policy", "harness.json"));
  const a = ARMS[arm];
  const agent = buildTurnAgent(loadAgentsConfig(ROOT, o.models), {
    root: ROOT, timeoutMs: policy.claims.turnTimeoutMinutes * 60_000, bins: o.bins,
    judgeLanes: [...(policy.team?.library.judgeLanes ?? []), "review"],
    sessionDir: path.join(dir, "sessions"), salt: `${o.runId}/${c.id}/${arm}/r${run}`,
    worker: a.worker, sessions: a.sessions,
  });
  const h = new Harness({ control, engagement: c.id, policy, clock: new SystemClock(), world: {}, agent, worktreeRoot: path.join(dir, "wt"), turnsDir: path.join(dir, "turns"), slots: 1 });
  await h.open(c.engagement);
  // A seat that wants a permission the factory can't grant by itself asks you first. The
  // cases hold no private data, so the eval answers for you: work without it.
  const settleStaffing = async () => {
    for (const a of (await h.state()).asks.values()) {
      if (a.status === "open" && a.origin === "rule:staffing") await h.answer(a.id, { by: "partner", choice: "without", note: "eval: the cases hold no private data" });
    }
  };

  const started = Date.now();
  let stoppedBy: Result["stoppedBy"] = "max ticks";
  for (let i = 0; i < o.maxTicks; i++) {
    await settleStaffing();
    const r = await h.tick({ id: "eval", capabilities: ["shell"] }, { slots: 1 });
    for (const t of r.turns) o.log(`    ${t.todo}: ${t.result}${t.granularity !== "none" ? ` (${t.granularity})` : ""}${t.reasons.length ? ` ${t.reasons.join("; ").slice(0, 160)}` : ""}`);
    const cap = r.turns.find((t) => t.result === "capacity");
    if (cap) throw new WaitHit(cap.reasons.join("; "), cap.wait ?? { kind: "limit", until: Date.now() + 30 * 60_000, vendor: "model" });
    if (!r.turns.length && !r.started.length) {
      const s = await h.state();
      stoppedBy = [...s.todos.values()].every((t) => t.status === "done" || t.status === "superseded") ? "done" : "stuck";
      break;
    }
  }
  const minutes = (Date.now() - started) / 60_000;
  const s = await h.state();
  const final = cloneControl(origin, path.join(dir, "final"));
  const g = grade(c, final.cwd);
  const outcomes: Record<string, number> = {};
  for (const t of s.turns) outcomes[t.result] = (outcomes[t.result] ?? 0) + 1;
  const todos = [...s.todos.values()].filter((t) => t.kind === "task");
  return {
    case: c.id, arm, run, score: g.score, passed: g.passed, total: g.total, failed: g.checks.filter((x) => !x.ok).map((x) => `${x.name}${x.error ? `: ${x.error}` : ""}`),
    turns: s.turns.length, outcomes, todosDone: todos.filter((t) => t.status === "done").length, todos: todos.length,
    ...usage(path.join(dir, "turns")), minutes: Math.round(minutes * 10) / 10, stoppedBy,
    waitingOn: [...s.asks.values()].filter((x) => x.status === "open").map((x) => x.origin), dir,
  };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const f2 = (x: number) => x.toFixed(2);

export function report(runId: string, results: Result[], arms: string[], about = ""): string {
  const caseIds = [...new Set(results.map((r) => r.case))];
  const by = (arm: string) => results.filter((r) => r.arm === arm);
  const lines = [
    `# Eval ${runId}`,
    "",
    ...(about ? [about, ""] : []),
    ...arms.map((a) => `- **${a}**: ${ARMS[a].label}`),
    "",
    "| Arm | Case runs | Mean score | Fully solved | Turns per case | Premium requests | Codex tokens (k) | Claude $ | Minutes per case | Resumed turns |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...arms.map((a) => {
      const r = by(a);
      return `| ${a} | ${r.length} | ${f2(mean(r.map((x) => x.score)))} | ${r.filter((x) => x.score === 1).length} | ${f2(mean(r.map((x) => x.turns)))} | ${r.reduce((s, x) => s + x.premiumRequests, 0)} | ${Math.round(r.reduce((s, x) => s + (x.tokensIn ?? 0) + (x.tokensOut ?? 0), 0) / 1000)} | ${f2(r.reduce((s, x) => s + x.costUsd, 0))} | ${f2(mean(r.map((x) => x.minutes)))} | ${r.reduce((s, x) => s + x.resumedTurns, 0)} |`;
    }),
    "",
    "## By case (mean score over runs; turns in brackets)",
    "",
    `| Case | ${arms.join(" | ")} |`,
    `|---|${arms.map(() => "---").join("|")}|`,
    ...caseIds.map((c) => `| ${c} | ${arms.map((a) => {
      const r = results.filter((x) => x.case === c && x.arm === a);
      return r.length ? `${f2(mean(r.map((x) => x.score)))} (${f2(mean(r.map((x) => x.turns)))})` : "-";
    }).join(" | ")} |`),
    "",
    "## Where the arms differ by half the checks or more",
    "",
  ];
  const flips = caseIds.flatMap((c) => {
    const s = arms.map((a) => ({ a, m: mean(results.filter((x) => x.case === c && x.arm === a).map((x) => x.score)) }));
    const hi = s.reduce((x, y) => (y.m > x.m ? y : x));
    const lo = s.reduce((x, y) => (y.m < x.m ? y : x));
    return hi.m - lo.m >= 0.5 ? [`- ${c}: ${s.map((x) => `${x.a} ${f2(x.m)}`).join(", ")}`] : [];
  });
  lines.push(...(flips.length ? flips : ["- none"]), "", "## Turn outcomes", "", "| Arm | completed | progress | validation_failed | host_failure | other |", "|---|---|---|---|---|---|");
  for (const a of arms) {
    const o: Record<string, number> = {};
    for (const r of by(a)) for (const [k, v] of Object.entries(r.outcomes)) o[k] = (o[k] ?? 0) + v;
    const other = Object.entries(o).filter(([k]) => !["completed", "progress", "validation_failed", "host_failure"].includes(k)).map(([k, v]) => `${k} ${v}`).join(", ");
    lines.push(`| ${a} | ${o.completed ?? 0} | ${o.progress ?? 0} | ${o.validation_failed ?? 0} | ${o.host_failure ?? 0} | ${other || "-"} |`);
  }
  lines.push("", "## Checks missed", "");
  for (const r of results.filter((x) => x.failed.length)) lines.push(`- ${r.case} ${r.arm} run ${r.run} (${r.stoppedBy}${r.waitingOn.length ? `, waiting on ${r.waitingOn.join(", ")}` : ""}): ${r.failed.join(" · ").slice(0, 400)}`);
  return lines.join("\n");
}

async function check(cases: EvalCase[]): Promise<boolean> {
  let ok = true;
  const tmp = fs.mkdtempSync(path.join(ROOT, ".af", "eval-check-"));
  try {
    console.log("case               start  solution");
    for (const c of cases) {
      const start = path.join(tmp, c.id, "start");
      const sol = path.join(tmp, c.id, "solution");
      buildSeed(c, start);
      buildSeed(c, sol, true);
      const a = grade(c, start);
      const b = grade(c, sol);
      const good = a.score < 1 && b.score === 1;
      ok &&= good;
      console.log(`${good ? "ok  " : "BAD "} ${c.id.padEnd(16)} ${f2(a.score)}   ${f2(b.score)}${b.score < 1 ? `  solution misses: ${b.checks.filter((x) => !x.ok).map((x) => `${x.name}: ${x.error}`).join(" · ")}` : ""}${a.score === 1 ? "  the start already passes" : ""}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
  }
  return ok;
}

async function main(): Promise<void> {
  fs.mkdirSync(path.join(ROOT, ".af"), { recursive: true });
  const cases = loadCases(flag("cases")?.split(",").filter(Boolean));
  if (args.includes("--list")) {
    for (const c of cases) console.log(`${c.id.padEnd(16)} ${c.about}`);
    return;
  }
  if (args.includes("--check")) {
    process.exitCode = (await check(cases)) ? 0 : 1;
    return;
  }
  const arms = (flag("arms", "A,B,C") ?? "").split(",").filter(Boolean);
  for (const a of arms) if (!ARMS[a]) throw new Error(`no arm ${a} (there are: ${Object.keys(ARMS).join(", ")})`);
  if (arms.some((a) => ARMS[a].worker) && !fs.existsSync(path.join(userAgentsDir(), "af-worker.agent.md"))) {
    throw new Error(`the worker's Copilot profile isn't installed in ${userAgentsDir()}: npm run harness -- agents install`);
  }
  const runs = Number(flag("runs", "1"));
  const runId = flag("run-id") ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const out = path.resolve(flag("out") ?? path.join(ROOT, ".af", "eval"), runId);
  fs.mkdirSync(out, { recursive: true });
  const resultsFile = path.join(out, "results.jsonl");
  const results: Result[] = fs.existsSync(resultsFile) ? fs.readFileSync(resultsFile, "utf8").trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as Result) : [];
  const done = new Set(results.map((r) => `${r.case}/${r.arm}/${r.run}`));
  const log = (s: string) => {
    console.log(s);
    fs.appendFileSync(path.join(out, "eval.log"), `${new Date().toISOString()} ${s}\n`);
  };
  // Which CLI each worker placeholder runs on in this run.
  const cfg = loadAgentsConfig(ROOT, flag("models"));
  const about = `Work done in: ${["model-a", "model-c"].map((m) => `${m} = ${vendorOfModel(cfg.models?.[m])}${cfg.models?.[m]?.includes(":") && cfg.models[m].split(":")[1] ? ` (${cfg.models[m].split(":").slice(1).join(":")})` : cfg.models?.[m] && !cfg.models[m].includes(":") ? ` (${cfg.models[m]})` : " (its default model)"}`).join(", ")}. Judges: model-b = ${cfg.models?.["model-b"] || "Copilot's default"}.`;
  log(`eval ${runId}: arms ${arms.join(", ")}, ${cases.length} cases, ${runs} run(s), in ${out}`);
  log(about);
  const waitMs = Number(flag("wait-hours", "12")) * 3_600_000;
  const noWait = args.includes("--no-wait");
  const setupCheck = () => preflight({ agents: cfg, installedDir: userAgentsDir(), repoDir: path.join(ROOT, "integrations", "copilot", "harness-agents") });
  // Until the gateways answer again, checking every minute, for at most the wait cap.
  const untilReachable = async (problems: Problem[]): Promise<boolean> => {
    const deadline = Date.now() + waitMs;
    let p = problems;
    for (let i = 0; p.some((x) => x.kind === "unreachable"); i++) {
      if (noWait || Date.now() >= deadline) return false;
      if (i % 15 === 0) log(`  waiting: ${p.filter((x) => x.kind === "unreachable").map((x) => x.what).join("; ")}`);
      await sleepUntil(Math.min(Date.now() + 60_000, deadline));
      p = await setupCheck();
    }
    return true;
  };
  // Wait out what stopped a case run; false when the run should stop instead.
  const waitOut = async (w: Wait): Promise<boolean> => {
    if (noWait || w.kind === "setup") return false;
    if (w.kind === "unreachable") {
      // A gateway preflight knows about is polled until it answers; anything else is
      // simply tried again after the harness's backoff.
      log(`  waiting until ${new Date(w.until).toISOString()}, then this case run starts again`);
      await sleepUntil(w.until);
      return untilReachable(await setupCheck());
    }
    if (w.until - Date.now() > waitMs) return false;
    log(`  ${w.vendor} usage limit: waiting until ${new Date(w.until).toISOString()}, then this case run starts again`);
    await sleepUntil(w.until);
    return true;
  };
  try {
    const first = await setupCheck();
    for (const p of first) log(`preflight: ${p.what} (fix: ${p.fix})`);
    const stop = first.filter((p) => p.kind === "setup" && holds(p));
    if (stop.length && !args.includes("--skip-preflight")) throw new WaitHit(stop.map((p) => p.what).join("; "), { kind: "setup", until: Date.now(), vendor: stop[0].vendor });
    if (!(await untilReachable(first))) throw new WaitHit("a model gateway isn't answering", { kind: "unreachable", until: Date.now(), vendor: first[0].vendor });
    for (let run = 1; run <= runs; run++) {
      for (const [ci, c] of cases.entries()) {
        // Rotate the arms' order case by case, so no arm always goes first.
        const order = arms.map((_, i) => arms[(i + ci + run) % arms.length]);
        for (const arm of order) {
          if (done.has(`${c.id}/${arm}/${run}`)) continue;
          let r: Result;
          const firstTry = Date.now();
          for (;;) {
            log(`  ${c.id} · ${arm} · run ${run}`);
            try {
              r = await runCase(c, arm, run, { out, runId, models: flag("models"), maxTicks: Number(flag("max-ticks", "10")), log });
              break;
            } catch (e) {
              if (!(e instanceof WaitHit)) throw e;
              log(`    ${e.wait.kind === "limit" ? "usage limit" : e.wait.kind === "unreachable" ? "can't reach the service" : "setup problem"}: ${e.message.slice(0, 200)}`);
              if (Date.now() - firstTry > waitMs || !(await waitOut(e.wait))) throw e;
            }
          }
          log(`    score ${f2(r.score)} (${r.passed}/${r.total}) · ${r.turns} turns · ${r.premiumRequests} premium requests · ${r.minutes} min · ${r.stoppedBy}`);
          results.push(r);
          fs.appendFileSync(resultsFile, `${JSON.stringify(r)}\n`);
        }
      }
    }
  } catch (e) {
    if (!(e instanceof WaitHit)) throw e;
    log(`the run stopped: ${e.message}${e.wait.kind === "setup" ? " (fix the setup first: npm run harness -- doctor)" : ""}`);
    log(`continue it later with: npm run eval -- --run-id ${runId} ${args.filter((x, i) => x !== "--run-id" && args[i - 1] !== "--run-id").join(" ")}`);
    process.exitCode = 3;
  } finally {
    const md = report(runId, results, arms, about);
    fs.writeFileSync(path.join(out, "report.md"), `${md}\n`);
    console.log(`\n${md}\n\nreport: ${path.join(out, "report.md")}`);
  }
}

if (import.meta.main ?? path.resolve(process.argv[1] ?? "") === import.meta.filename) await main();
