// Turn agents: what does one bounded slice of work. The harness only sees this
// interface, so a scripted agent (tests, demos) and Copilot CLI are interchangeable.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Belief, State, TodoState } from "./project.ts";
import type { Finding, GoalDef } from "./types.ts";
import type { TurnOutput } from "./validate.ts";

const execFileP = promisify(execFile);

export type TurnContext = {
  turn: string;
  agent: string; // runner id
  now: number;
  packet: string;
  todo: TodoState;
  goal: GoalDef;
  beliefs: Belief[];
  findings: Finding[]; // evidence on what this todo tests or assumes
  wtDir: string; // write files here, inside the todo's write scope
  state: State; // read-only view, for scripted agents and debugging
};

export interface TurnAgent {
  name: string;
  run(ctx: TurnContext): Promise<TurnOutput>;
}

export type Behavior = { name: string; when: (ctx: TurnContext) => boolean; run: (ctx: TurnContext) => TurnOutput | Promise<TurnOutput> };

// Behaviors are tried in order; the first match handles the turn.
export class ScriptedTurnAgent implements TurnAgent {
  name = "scripted";
  behaviors: Behavior[];
  calls: Array<{ todo: string; lane: string; behavior: string; at: number; packet: string }> = [];
  constructor(behaviors: Behavior[]) {
    this.behaviors = behaviors;
  }
  async run(ctx: TurnContext): Promise<TurnOutput> {
    const b = this.behaviors.find((x) => x.when(ctx));
    this.calls.push({ todo: ctx.todo.id, lane: ctx.todo.lane, behavior: b?.name ?? "none", at: ctx.now, packet: ctx.packet });
    if (!b) return { note: `no scripted behavior for ${ctx.todo.id}` };
    return b.run(ctx);
  }
}

// Copilot CLI, headless, one fresh session per turn in the turn's worktree. Each lane
// maps to a custom agent and a model; synthesis and replan should use a different
// model family from the lanes whose work they judge.
//
// Written against the CLI's documented flags; not run here (no Copilot CLI in the
// build sandbox).
export type LaneConfig = { agent: string; model: string };

export class CopilotTurnAgent implements TurnAgent {
  name = "copilot-cli";
  bin: string;
  lanes: Record<string, LaneConfig>;
  fallback: LaneConfig;
  timeoutMs: number;
  constructor(opts: { bin?: string; lanes?: Record<string, LaneConfig>; fallback: LaneConfig; timeoutMs: number }) {
    this.bin = opts.bin ?? "copilot";
    this.lanes = opts.lanes ?? {};
    this.fallback = opts.fallback;
    this.timeoutMs = opts.timeoutMs;
  }

  prompt(ctx: TurnContext): string {
    return [
      ctx.packet,
      "",
      "Do one bounded piece of this todo now, then stop. Write files only inside the scope above.",
      "Finish with ONE JSON object on the last lines, nothing after it:",
      `{"done": bool, "blocker": "why you can't continue" | null, "note": "<= 280 chars for whoever picks this up next",`,
      ` "findings": [{"assumption": "id", "direction": "supports|refutes|neutral", "grade": "opinion|reported", "source": "url or repo:path", "text": "...", "metrics": {}}],`,
      ` "todos": [{"lane": "...", "text": "...", "tests": "assumption id", "because": "finding/ask/todo id", "kind": "task|job|wait|action", "writeScope": []}],`,
      ` "asks": [{"question": "...", "options": [{"id": "...", "label": "..."}]}],`,
      ` "supersede": [{"todo": "id", "reason": "..."}], "discount": [{"finding": "id", "reason": "..."}]}`,
      "Rules: every todo needs a reason to exist (tests or because). You can't record measured, behavioral, stated or expert evidence; propose a job, wait or action that produces it.",
    ].join("\n");
  }

  async run(ctx: TurnContext): Promise<TurnOutput> {
    const lane = this.lanes[ctx.todo.lane] ?? this.fallback;
    const args = [
      "-p", this.prompt(ctx), "--agent", lane.agent, "--model", lane.model, "-s", "--no-ask-user",
      "--allow-tool", "write", "--allow-tool", "shell(git status)", "--allow-tool", "shell(git diff:*)",
      "--deny-tool", "shell(git push)", "--deny-tool", "shell(git commit:*)", "--deny-tool", "shell(rm:*)",
    ];
    const { stdout } = await execFileP(this.bin, args, { cwd: ctx.wtDir, timeout: this.timeoutMs, maxBuffer: 32 * 1024 * 1024 });
    return parseTurnOutput(stdout);
  }
}

// The last top-level JSON object in the reply: the earliest "{" from which the text
// up to the final "}" parses (braces inside strings make counting unreliable).
export function parseTurnOutput(text: string): TurnOutput {
  const end = text.lastIndexOf("}");
  if (end < 0) throw new Error("agent reply has no JSON object");
  for (let i = text.indexOf("{"); i >= 0 && i < end; i = text.indexOf("{", i + 1)) {
    try {
      const v = JSON.parse(text.slice(i, end + 1));
      if (v && typeof v === "object" && !Array.isArray(v)) return v as TurnOutput;
    } catch {
      /* not this one */
    }
  }
  throw new Error("no parseable JSON object at the end of the agent reply");
}
