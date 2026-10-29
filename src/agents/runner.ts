// One interface for every agent backend. The coordinator, Solver and Evaluator only
// see this, so the mock (tests) and Copilot CLI (real work) are interchangeable.
import type { ContextBundle } from "../context.ts";

// M·H·C: model, harness (agent profile / skills / hooks), context version.
export type AgentConfig = {
  id: string; // e.g. "agent-03"
  version: number;
  model: string;
  harness: string; // custom agent profile name, e.g. "author"
  params: Record<string, unknown>; // knobs the evolution loop may tune
};

export function configRef(c: AgentConfig): string {
  return `${c.id}@v${c.version}`;
}

export type RunSpec = {
  agent: string;
  task: string;
  artifact: string; // directory the agent may write
  kind: "report" | "analyzer" | "docs";
  config: AgentConfig;
  pins: string[]; // basis refs this run is built on
  seed?: string; // replay index, so repeated runs differ like real model runs do
};

export type RunResult = {
  ok: boolean;
  changedFiles: string[];
  costTokens: number;
  transcript: string[];
  error?: string;
};

export interface AgentRunner {
  name: string;
  run(spec: RunSpec, workdir: string, bundle: ContextBundle): Promise<RunResult>;
}
