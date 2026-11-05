// Checks `open` runs on the seeded repo before the first turn (docs/real-runs.md). In the
// second private engagement, five of about eight times the operator stepped in, the cause
// was the setup, not an agent: each of these would have caught one before a turn was spent.
// Only a log git would ignore stops the open; everything else is a warning to read.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Git } from "../git.ts";
import { eventsDir } from "./store.ts";
import type { EngagementDef, TodoDraft } from "./types.ts";
import type { World } from "./world.ts";
import type { TodoState } from "./project.ts";

export type OpenProblems = { stop: string[]; warn: string[] };

// The event log is the engagement's whole state. A seeded app whose .gitignore ignored
// `.agents/` and every `*.json` would have hidden it, and the harness's own files with it.
export async function ignoredHarnessFiles(repo: Git, engagement: string): Promise<string[]> {
  const probes = [`${eventsDir(engagement)}/000000000000000-probe.json`, ".agents/harness/probe.json", "policy/probe.json"];
  const out: string[] = [];
  for (const p of probes) {
    // check-ignore exits 0 when the path is ignored, 1 when it isn't.
    const r = await repo.tryAsync(["check-ignore", "-q", "--no-index", p]);
    if (r.ok) out.push(p);
  }
  return out;
}

// Seats may only run the test commands the permission catalog grants (`shell:test`). A
// Python project needed a package.json whose `test` ran pytest, added by hand, before any
// turn could run its tests.
export function missingTestCommands(repoDir: string, commands: string[]): string[] {
  const npm = commands.map((c) => /^npm (?:test|run (\S+))$/.exec(c.trim())).filter((m): m is RegExpExecArray => !!m);
  if (!npm.length || npm.length < commands.length) return []; // something other than npm scripts: nothing to check here
  let scripts: Record<string, string> = {};
  try {
    scripts = (JSON.parse(fs.readFileSync(path.join(repoDir, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    /* no package.json, or not JSON: no scripts */
  }
  return npm.some((m) => scripts[m[1] ?? "test"]) ? [] : npm.map((m) => m[0]);
}

// Todo text is all a turn gets of its todo. "The build steps below" in one todo's text was
// invisible to the agent reading it: it saw only its own todo.
const VAGUE = /\b(?:(?:the|these|those)\s+(?:\w+\s+)?(?:steps?|todos?|tasks?|items?)\s+(?:below|above)|(?:see|as)\s+(?:above|below)|the\s+(?:previous|next|following|last)\s+(?:step|todo|task))\b/i;
export function vagueTodoText(def: EngagementDef): string[] {
  const out: string[] = [];
  for (const g of def.goals) for (const t of g.todos ?? []) {
    const m = VAGUE.exec(t.text);
    if (m) out.push(`${g.id}/${t.id}: "${m[0]}" points at other work without naming it. A turn sees only its own todo's text: name the todos (by id) or say what they are.`);
  }
  return out;
}

// The checks on the starting commit. A red line that fails before any work fails every
// turn. A todo's checker may fail because its output doesn't exist yet, which is expected;
// one that runs the project's tests should pass, or every turn on it is thrown away.
export async function checksAtStart(repoDir: string, def: EngagementDef, world: World): Promise<string[]> {
  const checkers = world.checkers ?? {};
  // A checker that throws on a repo with nothing in it yet is a warning, not a failed open.
  const call = async (fn: NonNullable<World["checkers"]>[string], todo: TodoState): Promise<string[]> => {
    try {
      return await fn(repoDir, { todo, files: [] });
    } catch (e) {
      return [`it threw: ${(e as Error).message.slice(0, 160)}`];
    }
  };
  const out: string[] = [];
  const asTodo = (t: TodoDraft, goal: string) => ({ ...t, goal, kind: t.kind ?? "task", priority: t.priority ?? 2, status: "open", goalVersion: 1, addedAt: 0, failures: 0, turns: 0, capFrom: 0 }) as unknown as TodoState;
  const first = def.goals.flatMap((g) => (g.todos ?? []).map((t) => asTodo(t, g.id)))[0];
  for (const name of def.redLines ?? []) {
    const fn = checkers[name];
    if (!fn) {
      out.push(`red line ${name}: no checker by that name in the world (pass --world)`);
      continue;
    }
    if (!first) continue;
    const f = await call(fn, first);
    if (f.length) out.push(`red line ${name} fails before any work, so every turn would be thrown away: ${f.join("; ").slice(0, 300)}`);
  }
  const seen = new Set<string>();
  for (const g of def.goals) for (const t of g.todos ?? []) {
    if (!t.check || seen.has(t.check)) continue;
    seen.add(t.check);
    const fn = checkers[t.check];
    if (!fn) {
      out.push(`${g.id}/${t.id}: no checker "${t.check}" in the world (pass --world)`);
      continue;
    }
    const f = await call(fn, asTodo(t, g.id));
    if (f.length) out.push(`${t.check} fails before any work (${f.join("; ").slice(0, 200)}). Fine if it checks what ${g.id}/${t.id} will make; if it runs the project's tests, fix the setup first, or every turn on it is thrown away.`);
  }
  return out;
}

export async function openProblems(o: { repo: Git; def: EngagementDef; world: World; testCommands: string[] }): Promise<OpenProblems> {
  const stop: string[] = [];
  const ignored = await ignoredHarnessFiles(o.repo, o.def.id);
  if (ignored.length) {
    stop.push(`The repo's .gitignore hides the harness's own files (${ignored.join(", ")}), and the event log is the engagement's whole state. Add these lines at the end of .gitignore in what you seed, then open again:\n  !.agents/\n  !.agents/**\n  !policy/\n  !policy/**`);
  }
  const warn: string[] = [];
  const codeWork = o.def.goals.some((g) => (g.todos ?? []).some((t) => t.check || t.writeScope?.length));
  const missing = codeWork ? missingTestCommands(o.repo.cwd, o.testCommands) : [];
  if (missing.length) warn.push(`Seats can test only with ${missing.map((c) => `\`${c}\``).join(" or ")}, and this repo's package.json has no such script. Add one that runs your tests (for Python, "test": "python -m pytest"), or builder turns can't run any.`);
  warn.push(...vagueTodoText(o.def));
  warn.push(...(await checksAtStart(o.repo.cwd, o.def, o.world)));
  return { stop, warn };
}
