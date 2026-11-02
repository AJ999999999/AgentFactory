// Handoff packet: what an agent waking up cold gets. Generated from state, never
// written by a model, so it can't drift from the truth; and bounded, so it stays
// cheap to read on every wake no matter how long the engagement has run. The full
// record is one command away.
import type { AskState, State, TodoState } from "./project.ts";
import { beliefs, openAsks } from "./project.ts";
import { activeFreezes, phase } from "./select.ts";

function cut(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

// What people said that this todo depends on: the answers to asks it waits for, and to
// the actions of todos it waits for, directly or through earlier work. Without this an
// agent never hears what the parent, the lawyer or the client told the harness.
export function answersFor(s: State, t: TodoState, max = 2): AskState[] {
  const seen = new Set<string>();
  const out: AskState[] = [];
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const a = s.asks.get(id);
    if (a) {
      if (a.status === "answered" && a.choice !== "moot" && (a.note || a.revision)) out.push(a);
      return;
    }
    const d = s.todos.get(id);
    if (!d) return;
    if (d.ask) visit(d.ask);
    for (const x of d.after ?? []) visit(x);
    if (d.because) visit(d.because);
  };
  for (const x of t.after ?? []) visit(x);
  if (t.because) visit(t.because);
  return out.sort((a, b) => (b.answeredAt ?? 0) - (a.answeredAt ?? 0)).slice(0, max);
}

export function buildPacket(s: State, t: TodoState, why: string, about: string[] = []): string {
  const g = s.goals.get(t.goal)!;
  const bs = beliefs(s, g.id);
  const count = (st: string) => bs.filter((b) => b.status === st).length;
  const ph = phase(s, g.id);
  // The partner's spot checks of the harness are not the agents' business.
  const asks = openAsks(s).filter((a) => (a.goal === g.id || a.todo === t.id) && !a.audit);
  const recent = s.turns.filter((x) => x.goal === g.id).slice(-3).reverse();
  const notes = g.notes.filter((n) => n.version === g.version).slice(-3).reverse();
  const evidence = t.tests ? [...s.findings.values()].filter((f) => f.assumption === t.tests).slice(-2).reverse() : [];
  const freezes = activeFreezes(s).filter((f) => f.todo !== t.id);
  const b = g.def.budget;
  // A retry hears what threw its last try away. Told only "validation_failed", retries
  // in a real run repeated the same mistake until the todo ran out of tries.
  const last = s.turns.findLast((x) => x.todo === t.id);
  const thrownAway = last?.result === "validation_failed" && last.reasons?.length ? [`Your last try was thrown away: ${cut(last.reasons.join(" | "), 300)}`] : [];
  // The checks see the whole worktree, so a test another todo broke fails this turn too.
  // Agents that weren't told so called such failures "not mine" and said they were done.
  const red = s.engagement?.redLines ?? [];
  const checks = t.check || red.length ? [`Checked when you finish: ${[t.check, red.length ? `red lines ${red.join(", ")}` : ""].filter(Boolean).join("; ")}. Any failure throws the whole turn away, even one in code you didn't write: fix it, or set a blocker saying why you can't.`] : [];

  // Lines in priority order; the tail is dropped first when over budget.
  const must = [
    `${cut(s.engagement?.title ?? "", 60)} · ${g.id} v${g.version}: ${cut(g.def.objective, 140)}`,
    ph ? `Phase: ${ph.category}. Riskiest open assumption ${ph.assumption}: "${cut(g.def.assumptions.find((a) => a.id === ph.assumption)?.text ?? "", 90)}"` : "Phase: no open assumptions",
    `Beliefs: ${count("supported")} supported, ${count("refuted")} refuted, ${count("contested")} contested, ${count("testing")} testing, ${count("untested")} untested`,
    `Your todo ${t.id} [P${t.priority}, ${t.lane}]: ${cut(t.text, 600)}`,
    ...thrownAway,
    ...checks,
    ...answersFor(s, t).map((a) => `From ${a.answeredBy} (${a.id}): ${cut(a.note ?? `chose ${a.choice}`, 320)}`),
    ...about.slice(0, 2),
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
