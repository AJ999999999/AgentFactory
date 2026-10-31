// Real backend: runs GitHub Copilot CLI headless in the task's worktree.
//
// What it relies on (see integrations/copilot/):
//   --agent <profile>     custom agent from .github/agents/ (role + allowed tools + model)
//   --model               model pin, so replays are comparable run to run
//   --allow-tool / --deny-tool   scoped permissions; deny wins even under allow-all
//   .github/hooks/raee.json      preToolUse enforces the lease; sessionEnd writes the lockfile
//   .agents/session.json         written here before the run; the hooks read it
//
// Not executed in the MVP test (Copilot CLI is not installed in this sandbox).
// Swap in @github/copilot-sdk later for streaming events and session reuse.
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import type { ContextBundle } from "../context.ts";
import { resolveCommand, runCommand } from "../proc.ts";
import { writeJson } from "../util.ts";
import type { AgentRunner, RunResult, RunSpec } from "./runner.ts";


export type CopilotOptions = {
  bin?: string;
  protectedPaths?: string[];
  timeoutMs?: number;
  extraAllow?: string[];
};

export class CopilotCliRunner implements AgentRunner {
  name = "copilot-cli";
  opts: CopilotOptions;
  constructor(opts: CopilotOptions = {}) {
    this.opts = opts;
  }

  static available(bin = "copilot"): boolean {
    try {
      const r = resolveCommand(bin);
      execFileSync(r.file, [...r.prefix, "--version"], { stdio: "ignore", windowsHide: true });
      return true;
    } catch {
      return false;
    }
  }

  buildPrompt(spec: RunSpec, bundle: ContextBundle): string {
    // Compiled context: only what this role may see, pinned to exact basis versions.
    return [
      `Task ${spec.task}: ${bundle.goal ?? ""}`,
      `Rules:\n${(bundle.rules ?? []).map((r) => `- ${r}`).join("\n")}`,
      `Basis you must follow (pinned):\n${Object.values(bundle.state ?? {}).map((s) => `- ${s.ref}: ${JSON.stringify(s.value)}`).join("\n")}`,
      `Write your output only under ${spec.artifact}/. Do not edit anything else. Do not push.`,
      `Use the raee-context MCP tools to look up precedent before making a choice the rules don't cover.`,
    ].join("\n\n");
  }

  buildArgs(spec: RunSpec, prompt: string): string[] {
    return [
      "-p", prompt,
      "--agent", spec.config.harness,
      "--model", spec.config.model,
      "-s",
      "--no-ask-user",
      "--output-format", "json",
      "--allow-tool", "write",
      "--allow-tool", "shell(git status)",
      "--allow-tool", "shell(git diff:*)",
      "--allow-tool", "raee-context",
      ...(this.opts.extraAllow ?? []).flatMap((t) => ["--allow-tool", t]),
      "--deny-tool", "shell(git push)",
      "--deny-tool", "shell(rm:*)",
    ];
  }

  async run(spec: RunSpec, workdir: string, bundle: ContextBundle): Promise<RunResult> {
    // The hooks read this file to enforce the lease and write the lockfile.
    writeJson(path.join(workdir, ".agents", "session.json"), {
      task: spec.task,
      agent: spec.agent,
      config: `${spec.config.id}@v${spec.config.version}`,
      pins: spec.pins,
      leasePaths: [spec.artifact],
      protectedPaths: this.opts.protectedPaths ?? [".agents/escalation-policy.json", ".agents/context/tasks/*.criteria.json", ".github/**"],
    });
    const prompt = this.buildPrompt(spec, bundle);
    const transcript: string[] = [];
    try {
      const { stdout } = await runCommand(this.opts.bin ?? "copilot", this.buildArgs(spec, prompt), {
        cwd: workdir,
        timeout: this.opts.timeoutMs ?? 20 * 60_000,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, RAEE_TASK: spec.task, RAEE_AGENT: spec.agent, RAEE_ROLE: spec.config.harness === "blind-reviewer" ? "reviewer" : "author" },
      });
      let costTokens = 0;
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        transcript.push(line);
        try {
          costTokens += sumTokenFields(JSON.parse(line));
        } catch {
          /* non-JSON line */
        }
      }
      const status = execFileSync("git", ["status", "--porcelain"], { cwd: workdir, encoding: "utf8", windowsHide: true });
      const changedFiles = status.split("\n").filter(Boolean).map((l) => l.slice(3)).filter((f) => !f.startsWith(".agents/session"));
      return { ok: true, changedFiles, costTokens, transcript };
    } catch (e) {
      return { ok: false, changedFiles: [], costTokens: 0, transcript, error: (e as Error).message };
    }
  }
}

// The JSONL event schema may change between CLI versions; count any token-ish fields.
function sumTokenFields(o: unknown): number {
  if (!o || typeof o !== "object") return 0;
  let n = 0;
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (typeof v === "number" && /tokens$/i.test(k) && !/cache/i.test(k)) n += v;
    else if (typeof v === "object") n += sumTokenFields(v);
  }
  return n;
}
