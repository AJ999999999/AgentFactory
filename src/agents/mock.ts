// Deterministic stand-in for a model-backed agent, used by tests and the demo.
// It builds artifacts strictly from the context bundle it is handed, so stale pins
// produce stale output: exactly the failure the Observator exists to catch.
//
// Tunable params (what the evolution loop can change):
//   leakPii:  copy the customer email field (a red-line violation)
//   wasteful: burn ~2.5x the tokens (cost regression)
//   flaky:    probability a run ignores the scope basis (models are not deterministic)
import * as fs from "node:fs";
import * as path from "node:path";
import type { ContextBundle } from "../context.ts";
import { readSnapshot } from "../context.ts";
import { seededRandom, sleep, writeJson } from "../util.ts";
import type { AgentRunner, RunResult, RunSpec } from "./runner.ts";

type CustomerRecord = { id: string; segment: string; revenue: number; sourceId: string; email?: string };

const MODEL_COST: Record<string, number> = { "large-model": 1.0, "small-model": 0.4 };

export class MockAgent implements AgentRunner {
  name = "mock";
  latencyMs: [number, number];
  constructor(latencyMs: [number, number] = [60, 140]) {
    this.latencyMs = latencyMs;
  }

  async run(spec: RunSpec, workdir: string, bundle: ContextBundle): Promise<RunResult> {
    const rnd = seededRandom(`${spec.agent}|${spec.config.id}@${spec.config.version}|${spec.pins.join(",")}|${spec.seed ?? ""}`);
    await sleep(this.latencyMs[0] + rnd() * (this.latencyMs[1] - this.latencyMs[0]));
    const transcript: string[] = [`agent ${spec.agent} (${spec.config.model}/${spec.config.harness}) pins=${spec.pins.join(",")}`];
    const p = spec.config.params;
    const costFactor = (MODEL_COST[spec.config.model] ?? 1) * (p.wasteful ? 2.5 : 1);
    const outDir = path.join(workdir, spec.artifact);
    fs.mkdirSync(outDir, { recursive: true });

    if (spec.kind === "docs") {
      fs.writeFileSync(path.join(outDir, "README.md"), `# Tools\n\nAnalysis tools for ${bundle.goal ?? spec.task}.\n`);
      return { ok: true, changedFiles: [`${spec.artifact}/README.md`], costTokens: Math.round(400 * costFactor), transcript };
    }

    const scope = bundle.state?.scope?.value as { segments: string[] } | undefined;
    const sources = bundle.state?.sources?.value as { snapshot: string } | undefined;
    if (!scope || !sources) return { ok: false, changedFiles: [], costTokens: 50, transcript, error: "context bundle missing scope/sources" };
    const records = readSnapshot(workdir, sources.snapshot).content as CustomerRecord[];

    const ignoreScope = typeof p.flaky === "number" && rnd() < (p.flaky as number);
    if (ignoreScope) transcript.push("model drifted: ignored scope basis this run");
    const kept = records.filter((r) => ignoreScope || scope.segments.includes(r.segment));

    if (spec.kind === "report") {
      const total = kept.reduce((s, r) => s + r.revenue, 0);
      writeJson(path.join(outDir, "report.json"), { segments: scope.segments, records: kept.length, totalRevenue: total, sources: [sources.snapshot] });
      return { ok: true, changedFiles: [`${spec.artifact}/report.json`], costTokens: Math.round((600 + kept.length * 40) * costFactor), transcript };
    }

    // analyzer: the "analysis tool" output sample
    const sample = kept.map((r) => {
      const row: Record<string, unknown> = { id: r.id, segment: r.segment, revenue: r.revenue, sourceId: r.sourceId };
      if (p.leakPii && r.email) row.email = r.email;
      return row;
    });
    const bySegment: Record<string, number> = {};
    for (const r of kept) bySegment[r.segment] = (bySegment[r.segment] ?? 0) + 1;
    writeJson(path.join(outDir, "sample.json"), { pins: spec.pins, records: sample, summary: { count: kept.length, bySegment } });
    return { ok: true, changedFiles: [`${spec.artifact}/sample.json`], costTokens: Math.round((500 + kept.length * 60) * costFactor), transcript };
  }
}
