// Decision brief: the one screen the human sees for each escalation.
import type { Triage } from "./policy.ts";

export type Brief = {
  id: string;
  question: string;
  due?: string;
  blocking: string;
  triage: Triage;
  options: Array<{ key: string; text: string; consequence: string; reversible: boolean }>;
  recommendation: { key: string; confidence: "high" | "medium" | "low"; why: string };
  claimsVerified: { verified: number; total: number };
  irreversible: string[];
  dissent: Array<{ agent: string; text: string }>;
  evidence: string[];
  unverified: string[];
  precedent: string;
};

export function renderBrief(b: Brief, opts: { blind?: boolean } = {}): string {
  const lines: string[] = [];
  // Unmet auto-resolve conditions only explain an escalation that no trigger already explains.
  const explained = b.triage.neverAuto || b.triage.triggers.length;
  const why = [...(b.triage.neverAuto ? [`never_auto(${b.triage.neverAuto})`] : []), ...b.triage.triggers, ...(explained ? [] : b.triage.unmet.map((u) => `unmet:${u}`))];
  lines.push(`## ${b.id} · ${b.question}`);
  lines.push(`Due: ${b.due ?? "next digest"} · Blocking: ${b.blocking} · Escalated because: ${why.join(", ") || "n/a"}`);
  lines.push("", "### Options");
  for (const o of b.options) lines.push(`${o.key}. ${o.text} — ${o.consequence} · reversible: ${o.reversible ? "yes" : "no"}`);
  lines.push("", "### Recommendation");
  if (opts.blind) {
    lines.push("(hidden until you rule — this is a blind brief)");
  } else {
    lines.push(`${b.recommendation.key} · confidence: ${b.recommendation.confidence} · claims verified: ${b.claimsVerified.verified} of ${b.claimsVerified.total}`);
    lines.push(b.recommendation.why);
  }
  lines.push("", "### What can't be undone");
  lines.push(...(b.irreversible.length ? b.irreversible.map((i) => `- ${i}`) : ["- nothing"]));
  lines.push("", "### Dissent");
  lines.push(...(b.dissent.length ? b.dissent.map((d) => `${d.agent}: "${d.text}"`) : ["No agent disagreed."]));
  lines.push("", "### Evidence");
  lines.push(...b.evidence.map((e) => `- ${e}`));
  lines.push(`- Unverified claims: ${b.unverified.length ? b.unverified.join("; ") : "none"}`);
  lines.push("", "### Precedent check", b.precedent);
  lines.push("", `Reply: approve ${b.recommendation.key} · choose ${b.options.map((o) => o.key).filter((k) => k !== b.recommendation.key).join(" or ")} · ask "<question>"`);
  return lines.join("\n");
}
