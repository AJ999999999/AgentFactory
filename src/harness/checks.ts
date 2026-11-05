// Checks the harness runs itself, with the service's own test command (the service map's
// `test`), for a playbook's bug fix (docs/jira-bugs.md):
//
// - tests-fail: the turn's new test shows the bug. The tests fail with its change, and pass
//   on the commit it started from, so the failure is the new test's and not one that was
//   there already. Until this holds, "it's a bug" is only the diagnosis's opinion.
// - tests-pass: the service's tests pass.
//
// The base run uses a separate checkout of the starting commit, so nothing in the turn's own
// worktree (its build output included) is moved while it's checked.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runCommand } from "../proc.ts";
import type { ServiceDef } from "./types.ts";

export const BUILTIN_CHECKS = ["tests-fail", "tests-pass"];

// "dotnet test --no-restore" or "npm test": a command and its arguments, quotes kept together.
export function splitCommand(cmd: string): string[] {
  return (cmd.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((a) => a.replace(/^(["'])(.*)\1$/, "$2"));
}

export type TestRun = { ok: boolean; tail: string };
export type RunTests = (cwd: string, cmd: string, timeoutMs: number) => Promise<TestRun>;

const tailOf = (s: string, n = 12) => s.trim().split(/\r?\n/).slice(-n).join("\n").slice(-1500);

export const runTests: RunTests = async (cwd, cmd, timeoutMs) => {
  const [bin, ...args] = splitCommand(cmd);
  if (!bin) return { ok: false, tail: "no test command" };
  try {
    const r = await runCommand(bin, args, { cwd, timeout: timeoutMs });
    return { ok: true, tail: tailOf(`${r.stdout}\n${r.stderr}`) };
  } catch (e) {
    const x = e as Error & { stdout?: string; stderr?: string; code?: unknown };
    return { ok: false, tail: tailOf(`${x.stdout ?? ""}\n${x.stderr ?? ""}`) || x.message.slice(0, 300) };
  }
};

export async function builtinCheck(
  name: string,
  wtDir: string,
  svc: ServiceDef | undefined,
  o: { timeoutMs: number; run?: RunTests; git: (args: string[], cwd: string) => Promise<string> },
): Promise<string[]> {
  if (!svc?.test) return [`${name} needs the service's test command (test in the service map)`];
  const run = o.run ?? runTests;
  const sub = svc.dir ?? "";
  const here = await run(path.join(wtDir, sub), svc.test, o.timeoutMs);
  if (name === "tests-pass") return here.ok ? [] : [`${svc.test} fails:\n${here.tail}`];
  // tests-fail
  if (here.ok) return [`${svc.test} passes with your change: the new test doesn't show the bug`];
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "af-base-"));
  try {
    await o.git(["worktree", "add", "-q", "--detach", base, "HEAD"], wtDir);
    const before = await run(path.join(base, sub), svc.test, o.timeoutMs);
    if (!before.ok) return [`${svc.test} already fails on the commit you started from, so this failure doesn't show the bug. Fix or report that first:\n${before.tail}`];
    return [];
  } finally {
    await o.git(["worktree", "remove", "--force", base], wtDir).catch(() => fs.rmSync(base, { recursive: true, force: true }));
  }
}
