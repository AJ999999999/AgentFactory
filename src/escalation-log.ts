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
import { writeJson } from "./util.ts";

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

export type EscalationEvent = TriagedEvent | DeliveredEvent;

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
