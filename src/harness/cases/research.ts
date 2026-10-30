// Case 5 (added): "Can a small open model fine-tuned on our code beat our current
// assistant on our own tickets?"
//
// Why it's here: pure research. There's no product until the question is answered,
// a negative answer is a real result, experiments are expensive and noisy, two runs
// can disagree for reasons that have nothing to do with the hypothesis (here: train/
// eval contamination), and an agent can read papers forever without settling anything.
//
// What the harness should do: run the experiments on GPU runners; when the results
// contradict each other, hand them to an independent synthesis that finds the
// contaminated run and discounts it; count the refutation as progress (a milestone,
// not a failure); notice the literature review going nowhere and replan; then let the
// partner turn the negative result into a new hypothesis and test that.
import { ScriptedTurnAgent } from "../agents.ts";
import type { EngagementDef, GoalRevision } from "../types.ts";
import { SimJobs } from "../world.ts";
import type { CaseSetup } from "./kit.ts";
import { exists, lane, on, origin, person, write } from "./kit.ts";

const START = "2026-11-02T09:00:00Z";

export function researchDef(): EngagementDef {
  const evalJob = (id: string, ft: string) => ({
    id, kind: "job" as const, lane: "eval", text: `Evaluate ${ft} against the baseline on held-out tickets, 3 runs`, after: [ft, "baseline"], requires: ["gpu"],
    job: { spec: { model: ft }, runs: 3, gpuHours: 2, informs: [{ assumption: "H1", metric: "delta_pass" }] },
  });
  return {
    id: "research", title: "Fine-tuned small model vs. our assistant",
    principals: { partner: "you" },
    goals: [{
      id: "q", title: "Fine-tuning question", objective: "Find out whether a fine-tuned 7B model beats our current assistant on our own tickets", owner: "partner",
      scope: ["research", "data", "train", "evals"],
      budget: { turns: 120, gpuHours: 120 },
      assumptions: [{ id: "H1", text: "A 7B model fine-tuned on our repos beats the baseline pass rate on held-out tickets", category: "feasibility", risk: 5, uncertainty: 4, loadBearing: true, threshold: { metric: "delta_pass", op: ">=", value: 0 } }],
      todos: [
        { id: "data", lane: "data", text: "Build the train/eval split from closed tickets and record its hash", priority: 1, writeScope: ["data"], check: "split" },
        { id: "baseline", kind: "job", lane: "eval", text: "Measure the current assistant on held-out tickets", after: ["data"], requires: ["gpu"], job: { spec: { model: "baseline" }, runs: 3, gpuHours: 2 } },
        { id: "ft-a", kind: "job", lane: "train", text: "Fine-tune config A (LoRA r=16)", after: ["data"], requires: ["gpu"], job: { spec: { lora: 16 }, gpuHours: 20 } },
        { id: "ft-b", kind: "job", lane: "train", text: "Fine-tune config B (LoRA r=64, more data)", after: ["data"], requires: ["gpu"], job: { spec: { lora: 64 }, gpuHours: 20 } },
        evalJob("eval-a", "ft-a"),
        evalJob("eval-b", "ft-b"),
        { id: "lit", lane: "research", text: "What has been published on repo-specific fine-tuning?", tests: "H1", writeScope: ["research"] },
      ],
    }],
  };
}

export const retrieval: GoalRevision = {
  title: "Retrieval instead of fine-tuning",
  objective: "Find out whether retrieval over our codebase lifts the current assistant by at least 5 points",
  assumptions: [
    { id: "H1", text: "A 7B model fine-tuned on our repos beats the baseline pass rate on held-out tickets", category: "feasibility", risk: 5, uncertainty: 4, threshold: { metric: "delta_pass", op: ">=", value: 0 } },
    { id: "H2", text: "Retrieval over our codebase lifts the assistant by 5+ points", category: "feasibility", risk: 4, uncertainty: 4, loadBearing: true, threshold: { metric: "delta_pass", op: ">=", value: 0.05 } },
  ],
  success: [{ id: "answered", assumption: "H2" }],
  todos: [
    { id: "rag", lane: "build", text: "Retrieval index and prompt assembly over our repos", writeScope: ["evals/rag"], check: "rag" },
    { id: "eval-rag", kind: "job", lane: "eval", text: "Evaluate retrieval against the baseline, 3 runs", after: ["rag"], requires: ["gpu"], job: { spec: { model: "baseline+rag" }, runs: 3, gpuHours: 2, informs: [{ assumption: "H2", metric: "delta_pass" }] } },
  ],
};

export function research(): CaseSetup {
  const agent = new ScriptedTurnAgent([
    on("data", (c) => { write(c, "data/split.json", JSON.stringify({ train: 4210, eval: 300, overlap: 0, hash: "9f2c" })); return { done: true }; }),
    // A literature review that never lands anything: notes, no sources, never done.
    on("lit", () => ({ note: "Reading more papers on repo-specific fine-tuning" })),
    lane("replan", (c) => ({
      done: true,
      supersede: [{ todo: "lit", reason: "three turns without a sourced finding; the eval jobs will settle H1 directly" }],
      note: `Replanned: ${c.todo.text.slice(0, 60)}`,
    })),
    // The independent synthesis looks at how each result was produced, not just the number.
    lane("synthesis", (c) => {
      const tainted = [...c.state.findings.values()].filter((f) => f.assumption === "H1" && (f.metrics?.overlap ?? 0) > 0);
      return tainted.length
        ? { done: true, discount: tainted.map((f) => ({ finding: f.id, reason: `train/eval contamination: ${Math.round(f.metrics!.overlap * 100)}% of eval tickets were in config B's training data` })) }
        : { done: true, note: "No methodological problems found" };
    }),
    on("rag", (c) => { write(c, "evals/rag/index.ts", "// retrieval over repos\n"); return { done: true }; }),
  ]);

  const jobs = new SimJobs((t): { minutes: number; metrics: Record<string, number>; gpuHours?: number } => {
    switch (t.id) {
      case "baseline": return { minutes: 120, metrics: { pass_rate: 0.41 }, gpuHours: 2 };
      case "ft-a": return { minutes: 18 * 60, metrics: { train_loss: 0.82 }, gpuHours: 20 };
      case "ft-b": return { minutes: 22 * 60, metrics: { train_loss: 0.61 }, gpuHours: 20 };
      case "eval-a": return { minutes: 120, metrics: { delta_pass: -0.03, overlap: 0 }, gpuHours: 2 };
      case "eval-b": return { minutes: 120, metrics: { delta_pass: 0.02, overlap: 0.12 }, gpuHours: 2 };
      case "eval-rag": return { minutes: 120, metrics: { delta_pass: 0.07, overlap: 0 }, gpuHours: 2 };
      default: return { minutes: 60, metrics: {} };
    }
  });

  const partner = person("partner", 24 * 60, [
    { match: origin("rule:load_bearing_refuted"), answer: () => ({ choice: "pivot", revision: retrieval, note: "Fine-tuning doesn't pay; try retrieval" }) },
    { match: origin("rule:success"), answer: () => ({ choice: "close" }) },
  ]);

  return {
    name: "research",
    summary: "Open research question: fine-tuning vs. our assistant",
    def: researchDef(),
    start: START,
    until: "2027-01-31T00:00:00Z",
    agent,
    runners: [{ runner: { id: "cpu-1", capabilities: ["shell"] } }, { runner: { id: "gpu-1", capabilities: ["gpu"] } }],
    people: [partner],
    world: {
      jobs,
      checkers: {
        split: (dir) => exists(dir, "data/split.json"),
        rag: (dir) => exists(dir, "evals/rag/index.ts"),
      },
    },
  };
}
