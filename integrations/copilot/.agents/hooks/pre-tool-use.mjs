#!/usr/bin/env node
// preToolUse hook: enforces the coordinator's lease inside a Copilot CLI session.
// Reads the hook payload from stdin and the session file the coordinator wrote to
// .agents/session.json. Prints one line of JSON: {"permissionDecision": "allow"|"deny", ...}.
//
// Must stay fast: hooks run synchronously and block the agent. No network, no git calls.
import * as fs from "node:fs";
import * as path from "node:path";

const FILE_WRITE_TOOLS = /^(edit|create|write|write_file|delete_file|str_replace.*|apply_patch|multi_edit)$/i;
const SHELL_TOOLS = /^(bash|shell|powershell|run_in_terminal)$/i;

function out(decision, reason) {
  process.stdout.write(JSON.stringify(reason ? { permissionDecision: decision, permissionDecisionReason: reason } : { permissionDecision: decision }) + "\n");
  process.exit(0);
}

function globToRe(g) {
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") { re += ".*"; i++; }
    else if (c === "*") re += "[^/]*";
    else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

let input;
try {
  input = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
} catch {
  out("deny", "raee hook: unreadable hook payload");
}

const cwd = input.cwd || process.cwd();
const sessionFile = path.join(cwd, ".agents", "session.json");
if (!fs.existsSync(sessionFile)) process.exit(0); // not a coordinated session: no opinion

const session = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
const tool = String(input.toolName ?? input.tool_name ?? "");
let args = input.toolArgs ?? input.tool_input ?? {};
if (typeof args === "string") {
  try { args = JSON.parse(args); } catch { args = { raw: args }; }
}

if (SHELL_TOOLS.test(tool)) {
  const cmd = String(args.command ?? args.raw ?? "");
  if (/\bgit\s+push\b/.test(cmd)) out("deny", "raee: agents never push; the coordinator merges through the merge queue");
  if (/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|branch\s+-D|update-ref)\b/.test(cmd)) out("deny", "raee: destructive git command blocked in agent sessions");
  if (/\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\.\.?\s*$)/.test(cmd)) out("deny", "raee: recursive delete outside the artifact blocked");
  for (const g of session.protectedPaths ?? []) {
    const literal = g.replace(/\*\*?.*$/, "");
    if (literal && cmd.includes(literal) && /(>|tee|sed\s+-i|mv|cp|rm)\b/.test(cmd)) out("deny", `raee: shell write to protected path ${g}`);
  }
  out("allow");
}

if (FILE_WRITE_TOOLS.test(tool)) {
  const p = args.path ?? args.file_path ?? args.filePath ?? args.filename;
  if (!p) out("deny", "raee: file write without a path");
  const rel = path.relative(cwd, path.resolve(cwd, String(p))).split(path.sep).join("/");
  if (rel.startsWith("..")) out("deny", `raee: ${rel} is outside the worktree`);
  if ((session.protectedPaths ?? []).some((g) => globToRe(g).test(rel))) out("deny", `raee: ${rel} is protected (human-owned)`);
  const inLease = (session.leasePaths ?? []).some((l) => rel === l || rel.startsWith(l.replace(/\/+$/, "") + "/"));
  if (!inLease) out("deny", `raee: ${rel} is outside this task's lease (${(session.leasePaths ?? []).join(", ")})`);
  out("allow");
}

process.exit(0); // read-only and MCP tools: defer to the CLI's own permission rules
