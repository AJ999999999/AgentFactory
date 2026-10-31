// Turn agents: what does one bounded slice of work. The harness only sees this
// interface, so a scripted agent (tests, demos) and Copilot CLI are interchangeable.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Belief, State, TodoState } from "./project.ts";
import type { SeatView, ToolConfig } from "./team.ts";
import { REVIEW_LANE, toolFlags } from "./team.ts";
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
  seat?: SeatView; // who does this lane: role, model, skills, effective permissions
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
  calls: Array<{ todo: string; lane: string; behavior: string; at: number; packet: string; seat?: string; role?: string; probation?: boolean }> = [];
  constructor(behaviors: Behavior[]) {
    this.behaviors = behaviors;
  }
  async run(ctx: TurnContext): Promise<TurnOutput> {
    const b = this.behaviors.find((x) => x.when(ctx));
    this.calls.push({ todo: ctx.todo.id, lane: ctx.todo.lane, behavior: b?.name ?? "none", at: ctx.now, packet: ctx.packet, seat: ctx.seat?.key, role: ctx.seat?.role, probation: ctx.seat?.probation });
    if (!b) return { note: `no scripted behavior for ${ctx.todo.id}` };
    return b.run(ctx);
  }
}

// Copilot CLI, headless, one fresh session per turn in the turn's worktree. The seat
// decides who runs it: the role's custom agent (a generated role uses the fallback
// agent with its charter in the prompt), the role's model, and tool flags from the
// seat's catalog permissions. Without a team, each lane maps to a custom agent and a
// model as before.
//
// Written against the CLI's documented flags; not run here (no Copilot CLI in the
// build sandbox).
export type LaneConfig = { agent: string; model: string };

export class CopilotTurnAgent implements TurnAgent {
  name = "copilot-cli";
  bin: string;
  lanes: Record<string, LaneConfig>;
  fallback: LaneConfig;
  agents: Record<string, string>; // role -> custom agent file name, when they differ
  tools: ToolConfig;
  timeoutMs: number;
  constructor(opts: { bin?: string; lanes?: Record<string, LaneConfig>; fallback: LaneConfig; agents?: Record<string, string>; tools?: ToolConfig; timeoutMs: number }) {
    this.bin = opts.bin ?? "copilot";
    this.lanes = opts.lanes ?? {};
    this.fallback = opts.fallback;
    this.agents = opts.agents ?? {};
    this.tools = opts.tools ?? { always: DEFAULT_ALWAYS };
    this.timeoutMs = opts.timeoutMs;
  }

  prompt(ctx: TurnContext): string {
    const seat = ctx.seat;
    const role = !seat ? [] : [
      `Your role: ${seat.role} (${seat.skills.join(", ")}).${seat.charter ? ` ${seat.charter}` : ""}`,
      ...(seat.probation ? ["You're on probation: an independent reviewer checks your finished work before it counts."] : []),
    ];
    const review = ctx.todo.lane === REVIEW_LANE ? [`This is a review: include "verdict": "accept" or "reject" in the JSON, and say why in "note".`] : [];
    return [
      ctx.packet,
      ...role,
      "",
      ...review,
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

  // Which custom agent, model and tools this turn gets.
  launch(ctx: TurnContext): { agent: string; model: string; flags: string[] } {
    const seat = ctx.seat;
    if (seat) {
      const agent = this.agents[seat.role] ?? (seat.generated ? this.fallback.agent : seat.agent);
      return { agent, model: seat.model, flags: toolFlags(seat.effective, this.tools) };
    }
    const lane = this.lanes[ctx.todo.lane] ?? this.fallback;
    return { agent: lane.agent, model: lane.model, flags: ["--allow-tool", "write", ...(this.tools.always ?? DEFAULT_ALWAYS)] };
  }

  async run(ctx: TurnContext): Promise<TurnOutput> {
    const l = this.launch(ctx);
    const args = ["-p", this.prompt(ctx), "--agent", l.agent, "--model", l.model, "-s", "--no-ask-user", ...l.flags];
    const { stdout } = await execFileP(this.bin, args, { cwd: ctx.wtDir, timeout: this.timeoutMs, maxBuffer: 32 * 1024 * 1024 });
    return parseTurnOutput(stdout);
  }
}

// Every turn may look at its own changes and may not commit, push or delete.
export const DEFAULT_ALWAYS = [
  "--allow-tool", "shell(git status)", "--allow-tool", "shell(git diff:*)",
  "--deny-tool", "shell(git push)", "--deny-tool", "shell(git commit:*)", "--deny-tool", "shell(rm:*)",
];

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
