// Escalation log: one event file per step in a proposal's life, so we can later measure
// how often the policy asks when it didn't need to, and misses when it should have asked.
// Step 1 only records; nothing here changes routing.
//
// Layout: .agents/escalations/<proposal-id>/<seq>-<type>.json
// One file per event (not one shared JSONL) so concurrent agents never conflict on merge.
// The SQLite index (store.ts) rebuilds from these files.
import * as fs from "node:fs";
import * as path from "node:path";
import { AGENTS } from "./context.ts";
import type { Policy, Proposal, Triage } from "./policy.ts";
import { seededRandom, writeJson } from "./util.ts";

export const ESCALATIONS_DIR = `${AGENTS}/escalations`;

// Triggers that must escalate whatever the data says. They are kept out of calibration,
// so a quick approval of one never counts as an unnecessary escalation.
const FLOOR_PREFIXES = ["irreversible:", "boundary:", "basis_change:"];

export function isFloorTrigger(trigger: string): boolean {
  return FLOOR_PREFIXES.some((p) => trigger.startsWith(p));
}

// The triage inputs the calibration replay needs to rerun triage() under a candidate policy.
export type ProposalFeatures = Pick<
  Proposal,
  "kind" | "paths" | "diffLines" | "filesChanged" | "tags" | "ci" | "blindReview" | "reviewRounds" | "precedent" | "revertibleInOneCommit" | "monthlyCostDeltaUsd"
> & { claims: Array<{ status: string; loadBearing: boolean }>; dissent: number; replayPassed: boolean | null };

export type TriagedEvent = {
  type: "triaged";
  proposalId: string;
  at: string;
  policyVersion: number;
  route: Triage["route"];
  triggers: string[];
  unmet: string[];
  neverAuto: string | null;
  // true when the escalation has no floor trigger, i.e. it is a candidate for tuning.
  tunableOnly: boolean;
  features: ProposalFeatures;
};

export type DeliveredEvent = {
  type: "delivered";
  proposalId: string;
  at: string;
  briefId: string;
  mode: "delivered" | "interrupt" | "queued";
  // 1-based position among today's capped briefs; null for interrupts and queued briefs.
  ordinal: number | null;
  day: number;
  blind: boolean;
  blockedTasks: number;
  // Days the brief waited in the queue before this delivery (0 when delivered on submit).
  waitedDays: number;
};

// An auto-resolved proposal picked for the daily audit. Written when it is picked, so an
// audit nobody answers still shows up as a gap instead of silently dropping out.
export type SampledEvent = {
  type: "sampled";
  proposalId: string;
  at: string;
  probability: number; // chance this item was the one picked that day; weights the estimate
  nearThreshold: string[];
};

// The human's answer to an audit brief.
export type AuditedEvent = {
  type: "audited";
  proposalId: string;
  at: string;
  verdict: "same" | "would_differ" | "wanted_to_be_asked";
  probability: number;
};

// Something that happened after the decision and says it should have been escalated.
// cause decides who learns from it: policy_gap -> the policy, check_failure -> the
// evaluator, input_misreport (the agent left out a tag or misstated a fact) -> the agent.
export type OutcomeEvent = {
  type: "outcome";
  proposalId: string;
  at: string;
  kind: "reverted" | "superseded" | "incident" | "flagged";
  severity: "low" | "high";
  cause: "policy_gap" | "input_misreport" | "check_failure" | "unknown";
  agent?: string;
  note?: string;
};

export type EscalationEvent = TriagedEvent | DeliveredEvent | SampledEvent | AuditedEvent | OutcomeEvent;

export function featuresOf(p: Proposal): ProposalFeatures {
  return {
    kind: p.kind,
    paths: p.paths,
    diffLines: p.diffLines,
    filesChanged: p.filesChanged,
    tags: p.tags,
    ci: p.ci,
    blindReview: p.blindReview,
    reviewRounds: p.reviewRounds,
    precedent: p.precedent,
    revertibleInOneCommit: p.revertibleInOneCommit,
    monthlyCostDeltaUsd: p.monthlyCostDeltaUsd,
    claims: p.claims.map((c) => ({ status: c.status, loadBearing: c.loadBearing })),
    dissent: p.dissent.length,
    replayPassed: p.replay ? p.replay.passed : null,
  };
}

function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

export class EscalationLog {
  root: string;
  now: () => Date;
  constructor(root: string, now: () => Date = () => new Date()) {
    this.root = root;
    this.now = now;
  }

  private write(event: EscalationEvent): string {
    const dir = path.join(this.root, ESCALATIONS_DIR, safeId(event.proposalId));
    const seq = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).length + 1 : 1;
    const file = path.join(dir, `${String(seq).padStart(3, "0")}-${event.type}.json`);
    writeJson(file, event);
    return file;
  }

  triaged(policy: Policy, p: Proposal, t: Triage): TriagedEvent {
    const ev: TriagedEvent = {
      type: "triaged",
      proposalId: p.id,
      at: this.now().toISOString(),
      policyVersion: policy.version,
      route: t.route,
      triggers: t.triggers,
      unmet: t.unmet,
      neverAuto: t.neverAuto,
      tunableOnly: t.route === "escalate" && !t.neverAuto && !t.triggers.some(isFloorTrigger),
      features: featuresOf(p),
    };
    this.write(ev);
    return ev;
  }

  sampled(ev: Omit<SampledEvent, "type" | "at">): SampledEvent {
    const full: SampledEvent = { type: "sampled", at: this.now().toISOString(), ...ev };
    this.write(full);
    return full;
  }

  audited(ev: Omit<AuditedEvent, "type" | "at">): AuditedEvent {
    const full: AuditedEvent = { type: "audited", at: this.now().toISOString(), ...ev };
    this.write(full);
    return full;
  }

  outcome(ev: Omit<OutcomeEvent, "type" | "at">): OutcomeEvent {
    const full: OutcomeEvent = { type: "outcome", at: this.now().toISOString(), ...ev };
    this.write(full);
    return full;
  }

  delivered(ev: Omit<DeliveredEvent, "type" | "at">): DeliveredEvent {
    const full: DeliveredEvent = { type: "delivered", at: this.now().toISOString(), ...ev };
    this.write(full);
    return full;
  }

  list(proposalId?: string): EscalationEvent[] {
    const base = path.join(this.root, ESCALATIONS_DIR);
    if (!fs.existsSync(base)) return [];
    const dirs = proposalId ? [safeId(proposalId)] : fs.readdirSync(base).sort();
    const out: EscalationEvent[] = [];
    for (const d of dirs) {
      const dir = path.join(base, d);
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
        out.push(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as EscalationEvent);
      }
    }
    return out;
  }
}

// ---------- blind briefs ----------

// A share of briefs go out without the recommendation, so we can tell "I agree" from
// "I went along with what was suggested". Interrupts are urgent and never blind.
// Seeded by the brief id so the same brief always gets the same answer.
export function pickBlind(policy: Policy, briefId: string, interrupt = false): boolean {
  const share = policy.escalation_quality?.blind_share ?? 0;
  if (interrupt || share <= 0) return false;
  return seededRandom(`blind:${briefId}`)() < share;
}

// ---------- daily audit ----------

// Which thresholds an auto-resolved proposal came close to. These items carry the most
// information for tuning, so the audit draws them more often.
export function nearThresholds(policy: Policy, f: ProposalFeatures): string[] {
  const th = policy.triggers.thresholds;
  const near = policy.escalation_quality?.near_threshold_share ?? 0.75;
  const out: string[] = [];
  if (f.diffLines >= th.diff_lines * near) out.push("diff_lines");
  if (f.filesChanged >= th.files_changed * near) out.push("files_changed");
  if (f.monthlyCostDeltaUsd >= th.monthly_cost_delta_usd * near) out.push("monthly_cost_delta");
  if (f.reviewRounds >= policy.triggers.disagreement.author_reviewer_unresolved_after_rounds - 1 && f.reviewRounds > 0) out.push("review_rounds");
  return out;
}

// Picks one of the day's auto-resolved proposals for the audit, weighting near-threshold
// items up, and returns the chance it had of being picked. Returns null on a day with
// nothing auto-resolved.
export function pickAudit(policy: Policy, autoResolved: TriagedEvent[], seed: string): { event: TriagedEvent; probability: number; nearThreshold: string[] } | null {
  const pool = autoResolved.filter((e) => e.route === "auto");
  if (!pool.length) return null;
  const weight = policy.escalation_quality?.near_threshold_weight ?? 4;
  const items = pool.map((e) => {
    const near = nearThresholds(policy, e.features);
    return { event: e, near, w: near.length ? weight : 1 };
  });
  const total = items.reduce((a, b) => a + b.w, 0);
  let r = seededRandom(`audit:${seed}`)() * total;
  for (const it of items) {
    r -= it.w;
    if (r < 0) return { event: it.event, probability: it.w / total, nearThreshold: it.near };
  }
  const last = items[items.length - 1];
  return { event: last.event, probability: last.w / total, nearThreshold: last.near };
}

// The audit brief: the decision as it stood, without the system's answer.
export function renderAuditBrief(e: TriagedEvent): string {
  const f = e.features;
  return [
    `## Audit · ${e.proposalId}`,
    "This went through without asking you. If we had asked, what would you have done?",
    "",
    `- Kind: ${f.kind} · ${f.filesChanged} files · ${f.diffLines} lines · cost change $${f.monthlyCostDeltaUsd}/month`,
    `- Paths: ${f.paths.join(", ") || "none"}`,
    `- Tags: ${f.tags.join(", ") || "none"}`,
    `- Review rounds: ${f.reviewRounds} · precedent: ${f.precedent}`,
    "",
    "Reply: same · would differ · wanted to be asked",
  ].join("\n");
}
