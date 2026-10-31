// Handoff packet: what an agent waking up cold gets. Generated from state, never
// written by a model, so it can't drift from the truth; and bounded, so it stays
// cheap to read on every wake no matter how long the engagement has run. The full
// record is one command away.
import type { State, TodoState } from "./project.ts";
import { beliefs, openAsks } from "./project.ts";
import { activeFreezes, phase } from "./select.ts";

function cut(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

export function buildPacket(s: State, t: TodoState, why: string): string {
  const g = s.goals.get(t.goal)!;
  const bs = beliefs(s, g.id);
  const count = (st: string) => bs.filter((b) => b.status === st).length;
  const ph = phase(s, g.id);
  const asks = openAsks(s).filter((a) => a.goal === g.id || a.todo === t.id);
  const recent = s.turns.filter((x) => x.goal === g.id).slice(-3).reverse();
  const notes = g.notes.filter((n) => n.version === g.version).slice(-3).reverse();
  const evidence = t.tests ? [...s.findings.values()].filter((f) => f.assumption === t.tests).slice(-2).reverse() : [];
  const freezes = activeFreezes(s).filter((f) => f.todo !== t.id);
  const b = g.def.budget;

  // Lines in priority order; the tail is dropped first when over budget.
  const must = [
    `${cut(s.engagement?.title ?? "", 60)} · ${g.id} v${g.version}: ${cut(g.def.objective, 140)}`,
    ph ? `Phase: ${ph.category}. Riskiest open assumption ${ph.assumption}: "${cut(g.def.assumptions.find((a) => a.id === ph.assumption)?.text ?? "", 90)}"` : "Phase: no open assumptions",
    `Beliefs: ${count("supported")} supported, ${count("refuted")} refuted, ${count("contested")} contested, ${count("testing")} testing, ${count("untested")} untested`,
    `Your todo ${t.id} [P${t.priority}, ${t.lane}]: ${cut(t.text, 200)}`,
    `Why this one: ${cut(why, 160)}`,
    `Write only: ${(t.writeScope ?? []).join(", ") || "nothing (findings, todos and asks only)"}${freezes.length ? ` · frozen: ${freezes.map((f) => f.paths.join(",")).join("; ")}` : ""}`,
  ];
  const nice = [
    t.tests || t.assumes?.length ? `Tests: ${t.tests ?? "-"} · assumes: ${(t.assumes ?? []).join(", ") || "-"}` : "",
    `Budget: ${g.spent.turns}/${b.turns ?? "∞"} turns${b.usd !== undefined ? `, $${g.spent.usd}/$${b.usd}` : ""}${b.gpuHours !== undefined ? `, ${g.spent.gpuHours}/${b.gpuHours} GPU h` : ""}`,
    asks.length ? `Waiting on people: ${asks.map((a) => `${a.id} (${a.to})`).join(", ")}` : "",
    recent.length ? `Recent: ${recent.map((r) => `${r.todo} ${r.result}/${r.granularity}`).join(" · ")}` : "",
    ...notes.map((n) => `Note: ${cut(n.text, 160)}`),
    ...evidence.map((f) => `Evidence ${f.id} (${f.grade}, ${f.direction}): ${cut(f.text, 120)}`),
    "You can record opinion or reported findings (cite sources); strong evidence comes from jobs, metrics and people.",
    `Full record: npm run harness -- status --goal ${g.id}`,
  ].filter(Boolean);

  const { maxLines, maxChars } = s.policy.packet;
  const lines = [...must];
  for (const l of nice) {
    if (lines.length >= maxLines) break;
    if ([...lines, l].join("\n").length > maxChars) continue;
    lines.push(l);
  }
  let out = lines.join("\n");
  if (out.length > maxChars) out = out.slice(0, maxChars - 1) + "…";
  return out;
}
