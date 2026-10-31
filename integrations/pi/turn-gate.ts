// The harness's permission gate for pi and omp turns. Neither CLI has a permission
// system of its own beyond which tools are on, so every pi or omp turn loads this with
// `-e`, and it holds the turn to what the permission catalog granted the seat:
//
//   - only the turn's tools
//   - shell commands only from the seat's list, one command at a time (no chaining,
//     pipes or redirection)
//   - writes only inside the todo's write scope
//   - no paths outside the turn's worktree
//
// The harness passes the grant in AF_GATE (JSON). A handler that throws blocks the call
// in both CLIs, so a missing or broken grant fails closed. Node built-ins only: pi loads
// this with jiti, omp with bun.
import * as path from "node:path";

export type GateConfig = { root: string; write: string[]; commands: string[]; tools: string[] };

// Chaining, pipes, redirection, subshells and new lines turn one allowed command into
// any command.
const META = /[;&|<>`\r\n]|\$\(|\$\{/;

export function allowedCommand(cmd: string, allowed: string[]): boolean {
  const c = cmd.trim().replace(/\s+/g, " ");
  if (!c || META.test(c)) return false;
  return allowed.some((p) => (p.endsWith(" *") ? c === p.slice(0, -2) || c.startsWith(p.slice(0, -1)) : c === p));
}

const rel = (root: string, p: string) => path.relative(root, path.resolve(root, p));
const inside = (root: string, p: string) => {
  const r = rel(root, p);
  return r === "" || (!r.startsWith("..") && !path.isAbsolute(r));
};
const inScope = (root: string, p: string, scopes: string[]) => {
  const r = rel(root, p).split(path.sep).join("/");
  return inside(root, p) && scopes.some((s) => {
    const sc = s.replace(/\/+$/, "");
    return r === sc || r.startsWith(`${sc}/`);
  });
};

const PATHS = ["path", "file_path", "filePath", "file", "dir", "directory", "cwd", "workdir", "notebook_path"];
const SHELLS = new Set(["bash", "powershell", "shell", "sh", "pwsh"]);
const WRITES = new Set(["write", "edit", "multiedit", "multi_edit", "notebook", "notebook_edit", "apply_patch", "patch"]);

// Why this call isn't allowed, or null.
export function decide(cfg: GateConfig, tool: string, input: Record<string, unknown>): string | null {
  if (!cfg.tools.includes(tool)) return `${tool} isn't one of this turn's tools (${cfg.tools.join(", ")})`;
  for (const k of PATHS) {
    const v = input[k];
    if (typeof v === "string" && v && !inside(cfg.root, v)) return `${v} is outside this turn's worktree`;
  }
  if (WRITES.has(tool)) {
    const p = PATHS.map((k) => input[k]).find((v) => typeof v === "string" && v);
    if (typeof p !== "string") return `${tool} must name the one file it changes`;
    if (!inScope(cfg.root, p, cfg.write)) return cfg.write.length ? `this turn may write only in ${cfg.write.join(", ")}` : "this turn may not write files";
  }
  if (SHELLS.has(tool)) {
    const cmd = input.command;
    if (typeof cmd !== "string" || !allowedCommand(cmd, cfg.commands)) return `only these commands, one at a time: ${cfg.commands.join(", ") || "none"}`;
  }
  return null;
}

type Api = { on: (event: string, handler: (e: { toolName: string; input?: Record<string, unknown> }) => unknown) => void };

export default function turnGate(pi: Api): void {
  let cfg: GateConfig | null = null;
  try {
    cfg = JSON.parse(process.env.AF_GATE ?? "null") as GateConfig | null;
  } catch {
    cfg = null;
  }
  pi.on("tool_call", async (event) => {
    if (!cfg) return { block: true, reason: "this turn has no permissions (AF_GATE is missing or unreadable)" };
    const no = decide(cfg, event.toolName, event.input ?? {});
    return no ? { block: true, reason: no } : undefined;
  });
}
