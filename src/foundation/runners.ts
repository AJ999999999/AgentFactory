// Angle runners. The process only sees this interface, so a scripted runner (tests,
// demos) and a model-backed one (Copilot CLI) are interchangeable.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Draft, Entry, EntryType } from "./entries.ts";

const execFileP = promisify(execFile);

export type Stage = "challenge_frame" | "diverge" | "critique" | "score" | "assumptions";

export type AngleConfig = { id: string; title: string; objective: string; reads: string[]; model: string };
export type AnglesFile = {
  angles: Record<string, Omit<AngleConfig, "id">>;
  stages: Record<Stage, { allowed: EntryType[]; instructions: string }>;
};

export type AngleTask = {
  stage: Stage;
  angle: AngleConfig;
  challenge: { id: string; title: string };
  view: Entry[]; // everything this angle may see, already filtered
  instructions: string;
  budget?: number;
};

export interface AngleRunner {
  name: string;
  run(task: AngleTask): Promise<Draft[]>;
}

// Returns pre-written drafts: script[stage][angle]. Used for tests and fixture demos.
// Content from one author has none of the independence a real run has.
export class ScriptedAngleRunner implements AngleRunner {
  name = "scripted";
  script: Partial<Record<Stage, Record<string, Draft[]>>>;
  constructor(script: Partial<Record<Stage, Record<string, Draft[]>>>) {
    this.script = script;
  }
  async run(task: AngleTask): Promise<Draft[]> {
    // "$CRITERIA_HASH" stands for the hash in the frame the angle can see.
    const hash = task.view.find((e) => e.type === "frame")?.body.criteriaHash ?? "";
    const text = JSON.stringify(this.script[task.stage]?.[task.angle.id] ?? []).replaceAll("$CRITERIA_HASH", hash);
    return JSON.parse(text);
  }
}

// Model-backed: one headless Copilot CLI call per angle per stage, in a fresh session,
// so no angle carries another's context. Each call gets only its own view.
export class CopilotAngleRunner implements AngleRunner {
  name = "copilot-cli";
  bin: string;
  binArgs: string[];
  timeoutMs: number;
  calls: Array<{ stage: Stage; angle: string; args: string[] }> = [];
  constructor(opts: { bin?: string; binArgs?: string[]; timeoutMs?: number } = {}) {
    this.bin = opts.bin ?? "copilot";
    this.binArgs = opts.binArgs ?? [];
    this.timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  }

  prompt(task: AngleTask): string {
    const view = task.view.map((e) => ({ id: e.id, type: e.type, author: e.author.angle ?? e.author.role, refs: e.refs, status: e.status, body: e.body }));
    return [
      `You are the "${task.angle.title}" angle on challenge "${task.challenge.title}".`,
      `Your objective: ${task.angle.objective}`,
      `Stage: ${task.stage}. ${task.instructions}`,
      task.budget ? `Budget: at most ${task.budget} options.` : "",
      `You can see only these entries. Do not refer to anything else:\n${JSON.stringify(view, null, 1)}`,
      `Reply with ONLY a JSON array of drafts: [{"type": "...", "localId": "...", "refs": ["..."], "body": {...}}]. No prose outside the JSON.`,
    ].filter(Boolean).join("\n\n");
  }

  async run(task: AngleTask): Promise<Draft[]> {
    const args = [...this.binArgs, "-p", this.prompt(task), "--model", task.angle.model, "-s", "--no-ask-user", "--deny-tool", "write", "--deny-tool", "shell"];
    this.calls.push({ stage: task.stage, angle: task.angle.id, args });
    const { stdout } = await execFileP(this.bin, args, { timeout: this.timeoutMs, maxBuffer: 32 * 1024 * 1024 });
    return parseDrafts(stdout);
  }
}

export function parseDrafts(text: string): Draft[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end < start) throw new Error("angle reply has no JSON array");
  const parsed = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error("angle reply is not an array");
  return parsed.map((d, i) => {
    if (!d || typeof d.type !== "string" || typeof d.body !== "object") throw new Error(`draft ${i} is missing type or body`);
    return { type: d.type, localId: d.localId, refs: Array.isArray(d.refs) ? d.refs.map(String) : [], body: d.body, status: d.status };
  });
}
