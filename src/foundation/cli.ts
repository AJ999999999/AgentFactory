// Run a challenge for real, one owner gate at a time:
//
//   npm run challenge -- start challenges/contract-registry.json --runner copilot
//   npm run challenge -- confirm --by partner [--reframe "..."] [--answer "..."]
//   npm run challenge -- decide --by partner --chosen risk.O1 --reject "user-value.O1=reason" ...
//   npm run challenge -- build
//   npm run challenge -- experiment --by you --assumption lead.A1 --result supported --method "..." --evidence "..."
//   npm run challenge -- report
//
// Each command picks up where the last one stopped: the state is the entries in git.
// --runner copilot runs each angle as a fresh headless Copilot CLI session;
// --runner scripted --script <file> replays a fixture.
import * as fs from "node:fs";
import * as path from "node:path";
import { Git } from "../git.ts";
import { Coordinator } from "../orchestrator.ts";
import { readJson, writeJson } from "../util.ts";
import type { ChallengeDef } from "./process.ts";
import { Challenge, loadAngles, PrototypeBuilder } from "./process.ts";
import { renderBrief, renderReport } from "./report.ts";
import { CopilotAngleRunner, ScriptedAngleRunner } from "./runners.ts";
import type { AngleRunner } from "./runners.ts";
import { createWorkspace } from "./workspace.ts";

type RunConfig = { def: ChallengeDef; runner: "copilot" | "scripted"; script?: string; copilotBin?: string };

function args(argv: string[]): { cmd: string; pos: string[]; flags: Record<string, string[]> } {
  const [cmd, ...rest] = argv;
  const pos: string[] = [];
  const flags: Record<string, string[]> = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith("--")) (flags[rest[i].slice(2)] ??= []).push(rest[i + 1]?.startsWith("--") || rest[i + 1] === undefined ? "true" : rest[++i]);
    else pos.push(rest[i]);
  }
  return { cmd: cmd ?? "help", pos, flags };
}

const one = (f: Record<string, string[]>, k: string, d?: string) => f[k]?.[0] ?? d;

function runnerFor(cfg: RunConfig): AngleRunner {
  if (cfg.runner === "copilot") return new CopilotAngleRunner({ bin: cfg.copilotBin });
  if (!cfg.script) throw new Error("--runner scripted needs --script <file>");
  return new ScriptedAngleRunner(readJson(cfg.script));
}

function load(dir: string): { ch: Challenge; cfg: RunConfig } {
  const file = path.join(dir, "run.json");
  if (!fs.existsSync(file)) throw new Error(`no challenge in ${dir}; run "start" first`);
  const cfg = readJson<RunConfig>(file);
  const ch = new Challenge({ control: new Git(path.join(dir, "control")), def: cfg.def, angles: loadAngles(path.resolve("policy/angles.json")), runner: runnerFor(cfg) });
  return { ch, cfg };
}

export async function main(argv: string[]): Promise<string> {
  const { cmd, pos, flags } = args(argv);
  const out: string[] = [];
  if (cmd === "start") {
    const def = readJson<ChallengeDef>(pos[0]);
    const dir = one(flags, "dir", path.join(".af", def.id))!;
    const runner = (one(flags, "runner", "copilot") as RunConfig["runner"]);
    const cfg: RunConfig = { def, runner, script: one(flags, "script") ? path.resolve(one(flags, "script")!) : undefined, copilotBin: one(flags, "copilot") };
    const control = await createWorkspace({ dir, seedFrom: process.cwd(), seedPaths: (one(flags, "seed", "src,policy,README.md")!).split(",") });
    writeJson(path.join(dir, "run.json"), cfg);
    const ch = new Challenge({ control, def, angles: loadAngles(path.resolve("policy/angles.json")), runner: runnerFor(cfg) });
    await ch.open();
    const qs = await ch.challengeFrame();
    out.push(`Challenge "${def.title}" opened in ${dir}.`, "", `Problem: ${def.problem}`, "", "The frame challenger asks:");
    for (const q of qs) out.push(`- ${q.body.text}${q.body.reframe ? `\n  reframe: ${q.body.reframe}` : ""}`);
    out.push("", `Next: confirm --by ${def.owner} [--reframe "..."] [--answer "..."]`);
    return out.join("\n");
  }
  const dir = one(flags, "dir") ?? (fs.existsSync(".af") ? path.join(".af", fs.readdirSync(".af")[0] ?? "") : "");
  const { ch, cfg } = load(dir);
  if (cmd === "confirm") {
    await ch.confirmFrame({ by: one(flags, "by")!, reframe: one(flags, "reframe"), answer: one(flags, "answer") });
    const div = await ch.diverge();
    const rev = await ch.reveal();
    await ch.critique();
    await ch.score();
    const brief = renderBrief(ch);
    fs.writeFileSync(path.join(dir, "BRIEF.md"), brief);
    out.push(`${div.commitments.length} angles submitted sealed; ${rev.revealed.length} entries revealed together.`, "", brief, `Brief saved to ${path.join(dir, "BRIEF.md")}`);
    return out.join("\n");
  }
  if (cmd === "decide") {
    const rejected = Object.fromEntries((flags.reject ?? []).map((r) => [r.slice(0, r.indexOf("=")), r.slice(r.indexOf("=") + 1)]));
    await ch.decide({ by: one(flags, "by")!, chosen: one(flags, "chosen")!, rejected, criteriaHash: ch.criteriaHash(), note: one(flags, "note") });
    const plan = await ch.planMvp();
    out.push("MVP plan, riskiest assumptions first:");
    for (const a of plan.body.test) out.push(`- test ${a.id} (priority ${a.priority}): ${a.text}\n  experiment: ${a.test}`);
    for (const a of plan.body.deferred) out.push(`- defer ${a.id} (priority ${a.priority}): ${a.text}`);
    out.push("", "Next: build, then experiment --assumption <id> --result supported|refuted ...");
    return out.join("\n");
  }
  if (cmd === "build") {
    const coord = new Coordinator({ control: ch.control, worktreeRoot: path.join(dir, "wt"), runner: new PrototypeBuilder(), concurrency: 1, log: () => {} });
    const a = await ch.build(coord, { id: "builder-1", version: 1, model: "model-b", harness: "author", params: {} });
    return `MVP skeleton at ${a.body.path}, pinned ${a.body.pins.join(", ")}`;
  }
  if (cmd === "experiment") {
    const r = await ch.experiment({ by: one(flags, "by", cfg.def.owner)!, assumption: one(flags, "assumption")!, method: one(flags, "method", "")!, result: one(flags, "result") as "supported" | "refuted", evidence: one(flags, "evidence", "")! });
    out.push(`${r.experiment.refs[0]}: ${r.experiment.body.result}`);
    for (const q of r.questions) out.push(`Question for you: ${q.body.text}`);
    for (const b of r.breakpoints) out.push(`Stale: ${b.artifact} pinned ${b.pinned}, now ${b.current}`);
    return out.join("\n");
  }
  if (cmd === "report") {
    const file = path.join(dir, "REPORT.md");
    fs.writeFileSync(file, renderReport(ch));
    return `Challenge record written to ${file}`;
  }
  return "commands: start <challenge.json> | confirm | decide | build | experiment | report (see src/foundation/cli.ts)";
}

if (process.argv[1]?.endsWith("cli.ts")) {
  main(process.argv.slice(2)).then((s) => console.log(s), (e) => { console.error(`error: ${(e as Error).message}`); process.exit(1); });
}
