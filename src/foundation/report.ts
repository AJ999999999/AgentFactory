// What the owner reads: the decision brief at the converge gate, and the full record
// of a challenge, both rendered from entries.
import type { Challenge } from "./process.ts";
import type { Entry } from "./entries.ts";
import { rootOf } from "./entries.ts";

const by = (e: Entry) => e.author.angle ?? e.author.agent;

function critiquesOf(ch: Challenge, optionId: string): Entry[] {
  return ch.store.current().filter((e) => e.type === "critique" && e.refs.some((r) => rootOf(r) === rootOf(optionId)));
}

function assumptionsOf(ch: Challenge, optionId: string): Entry[] {
  return ch.store.current().filter((e) => e.type === "assumption" && e.refs.some((r) => rootOf(r) === rootOf(optionId)));
}

export function renderBrief(ch: Challenge): string {
  const frame = ch.frameEntry();
  const table = ch.scoreTable();
  const lines: string[] = [];
  lines.push(`# Decision brief: ${frame.body.title}`);
  lines.push(`Owner: ${ch.def.owner} · criteria frozen at frame confirmation (hash ${String(frame.body.criteriaHash).slice(0, 12)})`, "");
  lines.push("## Problem", frame.body.problem, "");
  lines.push("## Criteria", ...ch.def.criteria.map((c) => `- ${c.id} (weight ${c.weight}): ${c.text}`), "");
  lines.push("## Options", "Scores are other angles' means, 1-5. They inform the decision; they don't make it.", "");
  const options = ch.options().sort((a, b) => table[b.id].weighted - table[a.id].weighted);
  for (const o of options) {
    const t = table[o.id];
    lines.push(`### ${o.id} · ${o.body.title} (${by(o)})`);
    lines.push(o.body.summary);
    lines.push(`Scores: ${ch.def.criteria.map((c) => `${c.id} ${t.perCriterion[c.id]}`).join(" · ")} · weighted ${t.weighted} (${t.raters} raters)`);
    const cs = critiquesOf(ch, o.id);
    for (const c of cs.filter((c) => c.status !== "discarded")) {
      const support = c.body.evidenceRefs?.length ? `evidence ${c.body.evidenceRefs.map((r: string) => `${r} [${ch.store.get(r)?.status}]`).join(", ")}` : `test: ${c.body.test}`;
      lines.push(`- [${c.body.severity}] ${by(c)}: ${c.body.text} (${support})`);
    }
    for (const a of assumptionsOf(ch, o.id)) lines.push(`- assumes: ${a.body.text} (risk ${a.body.risk} × uncertainty ${a.body.uncertainty})`);
    lines.push("");
  }
  const discarded = ch.store.current().filter((e) => e.type === "critique" && e.status === "discarded");
  const rejections = ch.store.current().filter((e) => e.type === "rejection");
  lines.push("## Filtered out");
  lines.push(`- ${discarded.length} critique(s) discarded: no evidence and no test`);
  for (const r of rejections) lines.push(`- rejected ${r.body.angle ?? ""} ${r.body.stage}: ${r.body.reason}`);
  lines.push("", `Reply: decide --chosen <option> --reject "<option>=<reason>" for every other option.`);
  return lines.join("\n") + "\n";
}

export function renderReport(ch: Challenge): string {
  const frame = ch.frameEntry();
  const all = ch.store.all();
  const cur = ch.store.current();
  const lines: string[] = [`# Challenge record: ${frame.body.title}`, ""];
  const original = all.find((e) => e.type === "frame" && !e.supersedes);
  lines.push("## Frame", `Original problem: ${original?.body.problem}`);
  if (frame.supersedes) lines.push(`Reframed by the owner: ${frame.body.problem}`);
  for (const q of all.filter((e) => e.type === "question" && e.author.role === "angle")) lines.push(`- ${by(q)} asked: ${q.body.text}`);
  const evidence = cur.filter((e) => e.type === "evidence");
  lines.push("", "## Evidence", ...evidence.map((e) => `- ${e.id} [${e.status}] ${e.body.text} (${e.body.source})`));
  lines.push("", "## Divergence (sealed, then revealed together)");
  for (const k of cur.filter((e) => e.type === "commitment")) lines.push(`- ${k.author.angle} committed ${k.body.entries} entries, hash ${String(k.body.hash).slice(0, 12)}`);
  lines.push("", renderBrief(ch).split("\n").filter((l) => !l.startsWith("# Decision brief")).join("\n"));
  const decisions = all.filter((e) => e.type === "decision" && e.body.kind === "converge");
  const d = ch.decision() ?? decisions[decisions.length - 1];
  if (d) {
    const decider = all.find((e) => e.id === rootOf(d.id))?.author.agent ?? d.author.agent;
    lines.push("## Decision", `${decider} chose ${d.body.chosen}. ${d.body.note ?? ""}`);
    for (const r of d.body.rejected) lines.push(`- rejected ${r.option}: ${r.reason}`);
    if (d.status === "reopened") lines.push(`- **Reopened** by ${d.body.reopenedBy}`);
  }
  const plan = ch.plan();
  if (plan) {
    lines.push("", "## MVP plan: riskiest assumptions first");
    for (const a of plan.body.test) {
      const head = ch.store.head(a.id);
      lines.push(`- ${a.id} (priority ${a.priority} = risk ${a.risk} × uncertainty ${a.uncertainty}) [${head.status}] ${a.text}`);
      lines.push(`  - test: ${a.test}`);
    }
    for (const a of plan.body.deferred) lines.push(`- deferred ${a.id} (priority ${a.priority}): ${a.text}`);
  }
  const experiments = cur.filter((e) => e.type === "experiment");
  if (experiments.length) {
    lines.push("", "## Experiments");
    for (const x of experiments) lines.push(`- ${x.id} on ${x.refs[0]}: **${x.body.result}**. ${x.body.method}. ${x.body.evidence}`);
  }
  const open = cur.filter((e) => e.type === "question" && e.author.role === "runner");
  if (open.length) lines.push("", "## Open questions for the owner", ...open.map((q) => `- ${q.body.text}`));
  return lines.join("\n") + "\n";
}
