// The eval's cases: a small project (eval/project) and, per case, the files that plant a
// problem (files/), a reference solution (solution/), the engagement to run, and the
// hidden checks (grade.mjs) that agents never see.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { EngagementDef } from "../harness/types.ts";
import type { Grade } from "./grade.ts";

export const EVAL_ROOT = path.resolve(import.meta.dirname, "..", "..", "eval");
const GRADER = path.join(import.meta.dirname, "grade.ts");

export type EvalCase = { id: string; about: string; dir: string; engagement: EngagementDef };

export function loadCases(ids?: string[]): EvalCase[] {
  const root = path.join(EVAL_ROOT, "cases");
  const all = fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, "case.json"))).sort();
  const want = ids?.length ? ids : all;
  const missing = want.filter((id) => !all.includes(id));
  if (missing.length) throw new Error(`no case ${missing.join(", ")} (there are: ${all.join(", ")})`);
  return want.map((id) => {
    const j = JSON.parse(fs.readFileSync(path.join(root, id, "case.json"), "utf8")) as { about: string; engagement: EngagementDef };
    if (j.engagement.id !== id) throw new Error(`case ${id}: its engagement id is ${j.engagement.id}`);
    return { id, about: j.about, dir: path.join(root, id), engagement: j.engagement };
  });
}

// The case's starting point: the project with the case's files over it, and its
// reference solution over that when asked.
export function buildSeed(c: EvalCase, into: string, withSolution = false): void {
  fs.cpSync(path.join(EVAL_ROOT, "project"), into, { recursive: true });
  for (const layer of ["files", ...(withSolution ? ["solution"] : [])]) {
    const from = path.join(c.dir, layer);
    if (fs.existsSync(from)) fs.cpSync(from, into, { recursive: true });
  }
}

export function grade(c: EvalCase, repoDir: string): Grade {
  // Not as part of another test run (the eval's own tests): see nodeTest in grade.ts.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ["--no-warnings", GRADER, c.dir, repoDir], { encoding: "utf8", timeout: 10 * 60_000, windowsHide: true, env });
  try {
    return JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1) ?? "") as Grade;
  } catch {
    return { score: 0, passed: 0, total: 1, checks: [{ name: "grading ran", ok: false, error: (r.stderr || r.error?.message || "no output").slice(0, 300) }] };
  }
}
