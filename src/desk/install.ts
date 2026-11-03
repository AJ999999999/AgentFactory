// Installing the desk's hook for every Copilot CLI session you start on this PC, in
// any repo: one file in your own Copilot hooks folder, nothing written into the repos.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HOOK_TIMEOUT_SEC } from "./hold.ts";
import { HOOKED } from "./log.ts";

export const HOOK_FILE = "af-desk.json";

export function copilotHooksDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.COPILOT_HOME || path.join(os.homedir(), ".copilot"), "hooks");
}

// Short timeouts: recording takes milliseconds, and a hook that hangs would hold the
// session. Only a permission request waits, for your answer on the page.
export function hooksConfig(hookScript: string): unknown {
  const cmd = (e: string) => `node --no-warnings "${hookScript}" ${e}`;
  const hooks: Record<string, unknown[]> = {};
  for (const e of HOOKED) hooks[e] = [{ type: "command", bash: cmd(e), powershell: cmd(e), timeoutSec: e === "permissionRequest" ? HOOK_TIMEOUT_SEC : 5 }];
  return { version: 1, hooks };
}

export function install(hookScript: string, dir = copilotHooksDir()): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, HOOK_FILE);
  fs.writeFileSync(file, JSON.stringify(hooksConfig(path.resolve(hookScript)), null, 2) + "\n");
  return file;
}

// The desk's MCP server, added to your Copilot MCP config next to whatever is already
// there. A config that isn't valid JSON is left alone: it's yours to fix, not ours to overwrite.
export const MCP_NAME = "af-desk";
export function mcpConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.COPILOT_HOME || path.join(os.homedir(), ".copilot"), "mcp-config.json");
}

export function installMcp(serverScript: string, file = mcpConfigFile()): void {
  let cfg: { mcpServers?: Record<string, unknown> } = {};
  if (fs.existsSync(file)) {
    try {
      cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      throw new Error(`${file} isn't valid JSON; fix it, then install again`);
    }
  }
  cfg.mcpServers = { ...(cfg.mcpServers ?? {}), [MCP_NAME]: { type: "local", command: "node", args: ["--no-warnings", path.resolve(serverScript)], tools: ["*"] } };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
}

export function uninstallMcp(file = mcpConfigFile()): boolean {
  try {
    const cfg = JSON.parse(fs.readFileSync(file, "utf8")) as { mcpServers?: Record<string, unknown> };
    if (!cfg.mcpServers?.[MCP_NAME]) return false;
    delete cfg.mcpServers[MCP_NAME];
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

export function uninstall(dir = copilotHooksDir()): boolean {
  const file = path.join(dir, HOOK_FILE);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file);
  return true;
}
