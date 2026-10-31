// Runs one case's hidden checks against a finished repo and prints the result as JSON:
//   node src/eval/grade.ts <case folder> <repo folder>
// It's its own process because the code it imports and runs is the agents' code: a
// check that hangs, throws or calls process.exit can't take the eval down with it.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

export type Check = [string, () => Promise<void>];
export type Grade = { score: number; passed: number; total: number; checks: Array<{ name: string; ok: boolean; error?: string }> };

const [caseDir, repo] = process.argv.slice(2).map((p) => path.resolve(p));
let n = 0;
const show = (v: unknown) => JSON.stringify(v);
const realExit = process.exit.bind(process);
// The code under test must not end the grader.
process.exit = ((code?: number) => {
  throw new Error(`the code under test called process.exit(${code ?? ""})`);
}) as typeof process.exit;

function plainEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function copyRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-grade-"));
  fs.cpSync(repo, dir, { recursive: true, filter: (s) => !s.split(path.sep).includes(".git") });
  return dir;
}

const h = {
  repo,
  // A fresh copy of a module each time: the code may have module-level state.
  imp: async (rel: string) => import(`${pathToFileURL(path.join(repo, rel)).href}?v=${++n}`),
  read: (rel: string) => fs.readFileSync(path.join(repo, rel), "utf8"),
  exists: (rel: string) => fs.existsSync(path.join(repo, rel)),
  cli: (...args: string[]) => {
    const r = spawnSync(process.execPath, [path.join(repo, "src", "cli.js"), ...args], { cwd: repo, encoding: "utf8", timeout: 20_000, windowsHide: true });
    return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
  },
  // node --test in a folder, on the given files (all of them when none are given). Not
  // as a child of another test run: NODE_TEST_CONTEXT would make it exit 0 whatever fails.
  nodeTest: (dir: string, files: string[]) => spawnSync(process.execPath, ["--test", ...files], { cwd: dir, encoding: "utf8", timeout: 60_000, windowsHide: true, env: plainEnv() }).status === 0,
  // Test files (relative paths) under test/ whose text matches.
  testFiles: (pred: (text: string) => boolean) => {
    const out: string[] = [];
    const walk = (d: string) => {
      if (!fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(m|c)?js$/.test(e.name) && pred(fs.readFileSync(p, "utf8"))) out.push(path.relative(repo, p).split(path.sep).join("/"));
      }
    };
    walk(path.join(repo, "test"));
    return out.sort();
  },
  // Runs fn on a copy of the repo with one file replaced (a mutant).
  withFile: <T>(rel: string, content: string, fn: (dir: string) => T): T => {
    const dir = copyRepo();
    try {
      fs.writeFileSync(path.join(dir, rel), content);
      return fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
  eq(actual: unknown, expected: unknown, what = "") {
    if (actual !== expected && show(actual) !== show(expected)) throw new Error(`${what ? `${what}: ` : ""}expected ${show(expected)}, got ${show(actual)}`);
  },
  ok(v: unknown, what = "not true") {
    if (!v) throw new Error(what);
  },
  throws(fn: () => unknown, re?: RegExp | null, what = "") {
    try {
      fn();
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (/called process\.exit/.test(msg)) throw new Error(`${what}it ran the code (it called process.exit)`);
      if (re && !re.test(msg)) throw new Error(`${what}threw the wrong error: ${msg}`);
      return;
    }
    throw new Error(`${what}didn't throw`);
  },
};
export type Helpers = typeof h;

const results: Grade["checks"] = [];
try {
  const mod = (await import(pathToFileURL(path.join(caseDir, "grade.mjs")).href)) as { default: (h: Helpers) => Check[] };
  for (const [name, fn] of mod.default(h)) {
    try {
      await Promise.race([fn(), new Promise((_, reject) => setTimeout(() => reject(new Error("timed out after 60s")), 60_000).unref())]);
      results.push({ name, ok: true });
    } catch (e) {
      results.push({ name, ok: false, error: String((e as Error)?.message ?? e).replace(/\s+/g, " ").slice(0, 300) });
    }
  }
} catch (e) {
  results.push({ name: "the checks could be loaded", ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) });
}
const passed = results.filter((r) => r.ok).length;
process.stdout.write(`${JSON.stringify({ score: results.length ? passed / results.length : 0, passed, total: results.length, checks: results } satisfies Grade)}\n`);
realExit(0);
