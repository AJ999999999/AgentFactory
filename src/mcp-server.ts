// MCP server exposing the shared context layer to Copilot CLI agents over stdio.
// Hand-rolled JSON-RPC 2.0 (newline-delimited), no SDK, so it runs on bare Node 22.
//
// Register it in .github/mcp.json (see integrations/copilot/). Env:
//   RAEE_REPO  repository root (defaults to cwd)
//   RAEE_ROLE  role used for permission scoping when a call doesn't pass one
import * as path from "node:path";
import { currentBasis, currentPins, readTask, taskContext, writeLockfile } from "./context.ts";
import { findPrecedent, listDecisions } from "./decisions.ts";
import type { DecisionKind } from "./decisions.ts";
import { Git } from "./git.ts";
import { serveMcp } from "./mcp-rpc.ts";
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

serveMcp({ name: "raee-context", version: "0.1.0" }, tools.map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema,
  call: t.call,
  refuse: (args) => {
    const role = String(args.role ?? defaultRole);
    return t.roles.includes(role) ? null : `role "${role}" may not call ${t.name}`;
  },
})));
