// Installing the desk's hook for every Copilot CLI session you start on this PC, in
// any repo: one file in your own Copilot hooks folder, nothing written into the repos.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EVENTS } from "./log.ts";

export const HOOK_FILE = "af-desk.json";

export function copilotHooksDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.COPILOT_HOME || path.join(os.homedir(), ".copilot"), "hooks");
}

// Short timeouts: recording takes milliseconds, and a hook that hangs would hold the session.
export function hooksConfig(hookScript: string): unknown {
  const cmd = (e: string) => `node --no-warnings "${hookScript}" ${e}`;
  const hooks: Record<string, unknown[]> = {};
  for (const e of EVENTS) hooks[e] = [{ type: "command", bash: cmd(e), powershell: cmd(e), timeoutSec: 5 }];
  return { version: 1, hooks };
}

export function install(hookScript: string, dir = copilotHooksDir()): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, HOOK_FILE);
  fs.writeFileSync(file, JSON.stringify(hooksConfig(path.resolve(hookScript)), null, 2) + "\n");
  return file;
}

export function uninstall(dir = copilotHooksDir()): boolean {
  const file = path.join(dir, HOOK_FILE);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file);
  return true;
}
