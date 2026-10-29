// Escalation policy: decides auto-resolve vs. escalate for every proposal, and caps
// how many briefs reach the one human per day (with backpressure when over budget).
import { matchGlob } from "./util.ts";

export type Policy = {
  version: number;
  attention_budget: { max_briefs_per_day: number; interrupt_immediately: string[] };
  triggers: {
    irreversible: string[];
    boundary: { contract_paths: string[]; tags: string[] };
    disagreement: { author_reviewer_unresolved_after_rounds: number };
    thresholds: { security_paths: string[]; compliance_tags: string[]; monthly_cost_delta_usd: number; diff_lines: number; files_changed: number };
  };
  auto_resolve: { require: string[] };
  evolution: {
    kinds: string[];
    require: string[];
    replay_required_when: { kinds: string[]; diff_lines_over: number };
    revise_max_rounds: number;
  };
  never_auto: { kinds: string[]; paths: string[] };
  trust: { demote_when: { revert_rate_30d: number; missed_escalations: number } };
  decision_rights?: Record<string, string>; // decision type -> owner role
  profiles?: Record<string, { coordinator: boolean; max_workers: number; combined_digest_when_client_is_partner: boolean }>;
};

// Who owns a decision. Unmapped decision types go to the partner: when the policy
// doesn't say, the human decides.
export function ownerOf(policy: Policy, decisionType: string): string {
  return policy.decision_rights?.[decisionType] ?? "partner";
}

// Owner role -> the person or agent who actually receives the brief in an engagement.
export function recipientOf(policy: Policy, decisionType: string, principals: Record<string, string>): string {
  const role = ownerOf(policy, decisionType);
  return principals[role] ?? principals.partner ?? "partner";
}

export type ClaimResult = { claimId: string; status: "verified" | "failed" | "unverified"; loadBearing: boolean; evidence: string };

export type Proposal = {
  id: string;
  kind: "code_change" | "basis_change" | "basis_propagation" | "agent_config_change" | "contract_change" | "policy_change" | "criteria_change";
  title: string;
  author: string;
  paths: string[];
  diffLines: number;
  filesChanged: number;
  tags: string[]; // e.g. "data_migration", "customer_pii", "blocks_critical_path"
  ci: "green" | "red" | "unknown";
  blindReview: "approved" | "changes_requested" | "pending" | "n/a";
  reviewRounds: number;
  claims: ClaimResult[];
  precedent: "fresh" | "stale" | "none";
  revertibleInOneCommit: boolean;
  replay?: { passed: boolean; rounds: number; summary: string };
  dissent: Array<{ agent: string; text: string }>;
  monthlyCostDeltaUsd: number;
};

export type Triage = { route: "auto" | "escalate"; triggers: string[]; unmet: string[]; neverAuto: string | null };

export function triage(policy: Policy, p: Proposal): Triage {
  const triggers: string[] = [];
  const t = policy.triggers;

  // Hard floor first: nothing (trust, replay, precedent) can auto-resolve these.
  let neverAuto: string | null = null;
  if (policy.never_auto.kinds.includes(p.kind)) neverAuto = `kind:${p.kind}`;
  const floorPath = p.paths.find((f) => policy.never_auto.paths.some((g) => matchGlob(g, f)));
  if (floorPath) neverAuto = `path:${floorPath}`;

  for (const tag of p.tags) if (t.irreversible.includes(tag)) triggers.push(`irreversible:${tag}`);
  if (p.kind === "contract_change" || p.paths.some((f) => t.boundary.contract_paths.some((g) => matchGlob(g, f)))) triggers.push("boundary:contract_change");
  for (const tag of p.tags) if (t.boundary.tags.includes(tag)) triggers.push(`boundary:${tag}`);
  if (p.kind === "basis_change") triggers.push("basis_change:scope_or_definition_change");

  if (p.reviewRounds >= t.disagreement.author_reviewer_unresolved_after_rounds && p.blindReview !== "approved") triggers.push("disagreement:author_reviewer_unresolved");
  if (p.claims.some((c) => c.loadBearing && c.status !== "verified")) triggers.push("disagreement:load_bearing_claim_not_verified");
  if (p.dissent.length) triggers.push("disagreement:dissent");

  const isEvolution = policy.evolution.kinds.includes(p.kind);
  if (!isEvolution && p.precedent === "none") triggers.push("no_precedent:no_matching_decision_record");
  if (p.precedent === "stale") triggers.push("no_precedent:matching_record_is_stale");

  const th = t.thresholds;
  const sec = p.paths.find((f) => th.security_paths.some((g) => matchGlob(g, f)));
  if (sec) triggers.push(`threshold:security_path:${sec}`);
  for (const tag of p.tags) if (th.compliance_tags.includes(tag)) triggers.push(`threshold:compliance:${tag}`);
  if (p.monthlyCostDeltaUsd > th.monthly_cost_delta_usd) triggers.push("threshold:monthly_cost_delta");
  if (p.diffLines > th.diff_lines) triggers.push("threshold:diff_lines");
  if (p.filesChanged > th.files_changed) triggers.push("threshold:files_changed");

  // Auto-resolve conditions (all must hold).
  const required = isEvolution ? policy.evolution.require : policy.auto_resolve.require;
  const replayNeeded = policy.evolution.replay_required_when.kinds.includes(p.kind) || p.diffLines > policy.evolution.replay_required_when.diff_lines_over;
  const checks: Record<string, boolean> = {
    ci_green: p.ci === "green",
    blind_review_approved: p.blindReview === "approved",
    all_load_bearing_claims_verified: p.claims.filter((c) => c.loadBearing).every((c) => c.status === "verified"),
    fresh_precedent_match: p.precedent === "fresh",
    revertible_in_one_commit: p.revertibleInOneCommit,
    replay_passed: !replayNeeded || p.replay?.passed === true,
  };
  const unmet = required.filter((r) => !checks[r]);

  const route = neverAuto || triggers.length || unmet.length ? "escalate" : "auto";
  return { route, triggers, unmet, neverAuto };
}

// ---------- attention budget ----------

export type QueuedBrief = { id: string; markdown: string; blockedTasks: number; interrupt: boolean };

export class AttentionBudget {
  maxPerDay: number;
  interruptTags: string[];
  deliveredToday: QueuedBrief[] = [];
  queue: QueuedBrief[] = [];
  constructor(policy: Policy) {
    this.maxPerDay = policy.attention_budget.max_briefs_per_day;
    this.interruptTags = policy.attention_budget.interrupt_immediately;
  }

  submit(brief: QueuedBrief): "delivered" | "interrupt" | "queued" {
    if (brief.interrupt) {
      this.deliveredToday.push(brief);
      return "interrupt";
    }
    if (this.deliveredToday.filter((b) => !b.interrupt).length < this.maxPerDay) {
      this.deliveredToday.push(brief);
      return "delivered";
    }
    this.queue.push(brief);
    this.queue.sort((a, b) => b.blockedTasks - a.blockedTasks);
    return "queued";
  }

  // When briefs are queued, agents switch to reversible prep work only.
  get backpressure(): boolean {
    return this.queue.length > 0;
  }

  // Daily digest, most-blocking first. Rolls the overflow into the next day.
  nextDay(): QueuedBrief[] {
    this.deliveredToday = [];
    const carry = this.queue.splice(0);
    for (const b of carry) this.submit(b);
    return [...this.deliveredToday].sort((a, b) => b.blockedTasks - a.blockedTasks);
  }
}
