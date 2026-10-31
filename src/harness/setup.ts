// Building the agent that runs an engagement's turns, from policy/harness-agents.json:
// the CLI routing by model, and the worker and session modes. Shared by the command line
// and the eval, so both run turns the same way.
import * as fs from "node:fs";
import * as path from "node:path";
import { CopilotTurnAgent, TurnRouter, userAgentsDir, vendorOfModel } from "./agents.ts";
import type { LaneConfig, TurnAgent } from "./agents.ts";
import { SessionMode, WorkerMode, roleSkill } from "./modes.ts";
import type { ToolConfig } from "./team.ts";
import { VENDOR_DEFAULTS, vendorAgent } from "./vendors.ts";
import type { VendorConfig } from "./vendors.ts";

export type AgentsConfig = {
  fallback: LaneConfig;
  lanes: Record<string, LaneConfig>;
  agents?: Record<string, string>;
  profilePrefix?: string;
  models?: Record<string, string>;
  cli?: Record<string, VendorConfig>;
  worker?: boolean; // one worker agent with the lane's skill, instead of a role per lane
  sessions?: "none" | "todo" | "goal"; // carry the worker's CLI session across turns
} & ToolConfig;

// "model-a=pi:,model-b=codex:" overrides placeholders for one run.
export function loadAgentsConfig(root: string, models?: string): AgentsConfig {
  const c = JSON.parse(fs.readFileSync(path.join(root, "policy", "harness-agents.json"), "utf8")) as AgentsConfig;
  for (const kv of (models ?? "").split(",").filter(Boolean)) {
    const at = kv.indexOf("=");
    if (at < 1) throw new Error(`--models takes placeholder=model pairs, like model-a=pi: (got ${kv})`);
    c.models = { ...c.models, [kv.slice(0, at).trim()]: kv.slice(at + 1).trim() };
  }
  return c;
}

// The CLIs other than Copilot that some model placeholder maps to.
export const usedVendors = (c: AgentsConfig) => [...new Set(Object.values(c.models ?? {}).map(vendorOfModel))].filter((v) => v !== "copilot");

export type BuildOptions = {
  root: string; // the AgentFactory folder
  timeoutMs: number;
  bins?: Record<string, string | undefined>; // a path per CLI, for one that isn't on PATH
  judgeLanes: string[]; // lanes that judge, which keep their roles and fresh sessions
  sessionDir?: string; // where session bookkeeping (and pi's sessions) live
  salt?: string; // makes session ids unique to this engagement (and eval run)
  worker?: boolean; // overrides the policy
  sessions?: "none" | "todo" | "goal"; // overrides the policy
};

export function buildTurnAgent(c: AgentsConfig, o: BuildOptions): TurnAgent {
  // A path to a binary is resolved here; turns run with the worktree as their cwd.
  const abs = (b: string) => (b.includes("/") || b.includes("\\") ? path.resolve(b) : b);
  const profiles = [userAgentsDir(), path.join(o.root, "integrations", "copilot", "harness-agents")];
  const copilot = new CopilotTurnAgent({
    bin: abs(o.bins?.copilot ?? "copilot"), fallback: c.fallback, lanes: c.lanes, agents: c.agents, profilePrefix: c.profilePrefix, models: c.models,
    tools: { tools: c.tools, always: c.always }, timeoutMs: o.timeoutMs,
  });
  // Seats whose model maps to "<cli>:<model>" run in that CLI (claude, codex, pi, omp);
  // the rest in Copilot.
  const others = Object.fromEntries(usedVendors(c).map((v) => [v, vendorAgent(v, {
    bin: abs(o.bins?.[v] ?? c.cli?.[v]?.bin ?? VENDOR_DEFAULTS[v].bin!), models: c.models ?? {}, fallback: c.fallback, lanes: c.lanes, profilePrefix: c.profilePrefix,
    profileDirs: profiles, config: c.cli?.[v], timeoutMs: o.timeoutMs,
  })]));
  let agent: TurnAgent = new TurnRouter(copilot, others);
  const sessions = o.sessions ?? c.sessions ?? "none";
  if (sessions !== "none") {
    if (!o.sessionDir) throw new Error("sessions need a folder for their bookkeeping");
    agent = new SessionMode(agent, { scope: sessions, dir: o.sessionDir, salt: o.salt ?? "", judgeLanes: o.judgeLanes });
  }
  // The worker wraps the sessions, so a session sees the worker's prompt.
  if (o.worker ?? c.worker ?? false) {
    const repoProfiles = [path.join(o.root, "integrations", "copilot", "harness-agents"), userAgentsDir()];
    agent = new WorkerMode(agent, { judgeLanes: o.judgeLanes, skill: (role) => roleSkill(repoProfiles, role, c.profilePrefix ?? "af-") });
  }
  return agent;
}
