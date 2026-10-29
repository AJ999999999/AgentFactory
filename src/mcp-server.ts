// MCP server exposing the shared context layer to Copilot CLI agents over stdio.
// Hand-rolled JSON-RPC 2.0 (newline-delimited), no SDK, so it runs on bare Node 22.
//
// Register it in .github/mcp.json (see integrations/copilot/). Env:
//   RAEE_REPO  repository root (defaults to cwd)
//   RAEE_ROLE  role used for permission scoping when a call doesn't pass one
import * as path from "node:path";
import * as readline from "node:readline";
import { currentBasis, currentPins, readTask, taskContext, writeLockfile } from "./context.ts";
import { findPrecedent, listDecisions } from "./decisions.ts";
import type { DecisionKind } from "./decisions.ts";
import { Git } from "./git.ts";
import { Index } from "./store.ts";

const repo = path.resolve(process.env.RAEE_REPO ?? process.cwd());
const defaultRole = process.env.RAEE_ROLE ?? "author";

type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  roles: string[];
  call: (args: Record<string, unknown>) => unknown;
};

const str = (description: string) => ({ type: "string", description });

const tools: Tool[] = [
  {
    name: "get_task_context",
    description: "Compiled context for a task (goal, rules, pinned basis, evidence, results), filtered by role permissions.",
    inputSchema: { type: "object", properties: { task: str("task id"), role: str("role; defaults to RAEE_ROLE") }, required: ["task"] },
    roles: ["author", "reviewer", "fact-checker", "solver", "coordinator"],
    call: (a) => taskContext(repo, String(a.task), String(a.role ?? defaultRole)),
  },
  {
    name: "current_basis",
    description: "Current version and value of one basis (e.g. scope) for a task.",
    inputSchema: { type: "object", properties: { task: str("task id"), name: str("basis name") }, required: ["task", "name"] },
    roles: ["author", "reviewer", "fact-checker", "solver", "coordinator"],
    call: (a) => currentBasis(repo, String(a.task), String(a.name)),
  },
  {
    name: "list_breakpoints",
    description: "Artifacts still built on a superseded basis (from committed lockfiles at HEAD).",
    inputSchema: { type: "object", properties: {} },
    roles: ["fact-checker", "solver", "coordinator", "reviewer"],
    call: () => {
      const idx = new Index().rebuild(new Git(repo), "HEAD");
      try {
        return idx.breakpoints();
      } finally {
        idx.close();
      }
    },
  },
  {
    name: "query_precedent",
    description: "Most recent active decision record for a kind + subject, with freshness.",
    inputSchema: { type: "object", properties: { kind: str("decision kind"), subject: str("subject, e.g. task-123/scope") }, required: ["kind", "subject"] },
    roles: ["author", "reviewer", "fact-checker", "solver", "coordinator"],
    call: (a) => findPrecedent(repo, new Git(repo), String(a.kind) as DecisionKind, String(a.subject)),
  },
  {
    name: "list_decisions",
    description: "All decision records (id, kind, subject, status).",
    inputSchema: { type: "object", properties: {} },
    roles: ["reviewer", "fact-checker", "solver", "coordinator"],
    call: () => listDecisions(repo).map((d) => ({ id: d.id, kind: d.kind, subject: d.subject, status: d.status, chosen: d.chosen })),
  },
  {
    name: "pin_basis",
    description: "Write the context lockfile for an artifact, pinned to the task's current basis.",
    inputSchema: { type: "object", properties: { artifact: str("artifact directory"), task: str("task id"), agent: str("agent id"), config: str("agent config ref") }, required: ["artifact", "task", "agent"] },
    roles: ["author", "solver"],
    call: (a) => {
      const pins = currentPins(repo, String(a.task));
      readTask(repo, String(a.task));
      writeLockfile(repo, { artifact: String(a.artifact), task: String(a.task), builtBy: String(a.agent), config: String(a.config ?? "unknown"), basis: pins, inputs: [], builtAt: new Date().toISOString() });
      return { artifact: a.artifact, pins };
    },
  },
];

function reply(id: unknown, result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function fail(id: unknown, code: number, message: string): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg: { id?: unknown; method?: string; params?: Record<string, unknown> };
  try {
    msg = JSON.parse(line);
  } catch {
    return fail(null, -32700, "parse error");
  }
  const { id, method, params = {} } = msg;
  if (method === "notifications/initialized" || id === undefined) return; // notifications get no reply
  if (method === "initialize") {
    return reply(id, {
      protocolVersion: (params.protocolVersion as string) ?? "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "raee-context", version: "0.1.0" },
    });
  }
  if (method === "ping") return reply(id, {});
  if (method === "tools/list") {
    return reply(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  }
  if (method === "tools/call") {
    const tool = tools.find((t) => t.name === params.name);
    if (!tool) return fail(id, -32602, `unknown tool ${String(params.name)}`);
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const role = String(args.role ?? defaultRole);
    if (!tool.roles.includes(role)) {
      return reply(id, { content: [{ type: "text", text: `role "${role}" may not call ${tool.name}` }], isError: true });
    }
    try {
      const out = tool.call(args);
      return reply(id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: { result: out } });
    } catch (e) {
      return reply(id, { content: [{ type: "text", text: (e as Error).message }], isError: true });
    }
  }
  return fail(id, -32601, `method not found: ${method}`);
});
