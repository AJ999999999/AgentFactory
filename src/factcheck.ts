// Fact-checker: settles claims against artifacts by lookup, never by asking a model
// whether a claim "sounds right". Unknown claim kinds stay unverified.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Git } from "./git.ts";
import { CTX, currentBasis, parseBasisRef } from "./context.ts";
import { isStale, readDecision } from "./decisions.ts";
import type { ClaimResult } from "./policy.ts";
import { readJson } from "./util.ts";

export type Claim =
  | { id: string; text: string; loadBearing: boolean; kind: "ci_green"; args: { results: Record<string, boolean>; check: string } }
  | { id: string; text: string; loadBearing: boolean; kind: "basis_current"; args: { ref: string } }
  | { id: string; text: string; loadBearing: boolean; kind: "decision_valid"; args: { id: string } }
  | { id: string; text: string; loadBearing: boolean; kind: "no_other_consumers"; args: { contract: string; claimed: string[] } }
  | { id: string; text: string; loadBearing: boolean; kind: "file_exists"; args: { path: string } }
  | { id: string; text: string; loadBearing: boolean; kind: "other"; args: Record<string, unknown> };

type Registry = Record<string, { consumers: string[]; unregistered: string[] }>;

export function checkClaim(repo: string, git: Git, c: Claim): ClaimResult {
  const r = (status: ClaimResult["status"], evidence: string): ClaimResult => ({ claimId: c.id, status, loadBearing: c.loadBearing, evidence });
  switch (c.kind) {
    case "ci_green": {
      const v = c.args.results[c.args.check];
      if (v === undefined) return r("unverified", `no CI result for ${c.args.check}`);
      return v ? r("verified", `CI ${c.args.check} passed`) : r("failed", `CI ${c.args.check} failed`);
    }
    case "basis_current": {
      const p = parseBasisRef(c.args.ref);
      const cur = currentBasis(repo, p.task, p.name);
      if (!cur) return r("failed", `no basis ${p.task}/${p.name}`);
      return cur.version === p.version ? r("verified", `${c.args.ref} is current`) : r("failed", `${c.args.ref} superseded by v${cur.version}`);
    }
    case "decision_valid": {
      const d = readDecision(repo, c.args.id);
      if (!d) return r("failed", `${c.args.id} not found`);
      if (d.status !== "active") return r("failed", `${c.args.id} is ${d.status}`);
      const s = isStale(git, d);
      return s.stale ? r("failed", `${c.args.id} stale: ${s.changed.join(", ")} changed`) : r("verified", `${c.args.id} active and fresh`);
    }
    case "no_other_consumers": {
      const file = path.join(repo, CTX, "registry", "consumers.json");
      if (!fs.existsSync(file)) return r("unverified", "no contract registry");
      const reg = readJson<Registry>(file)[c.args.contract];
      if (!reg) return r("unverified", `${c.args.contract} not in registry`);
      const extra = reg.consumers.filter((x) => !c.args.claimed.includes(x));
      if (extra.length) return r("failed", `registry lists more consumers: ${extra.join(", ")}`);
      if (reg.unregistered.length) return r("unverified", `registry lists ${reg.consumers.length}; ${reg.unregistered.join(", ")} has no contract on file`);
      return r("verified", `registry lists exactly ${reg.consumers.join(", ")}`);
    }
    case "file_exists": {
      const p = path.join(repo, c.args.path);
      return fs.existsSync(p) ? r("verified", `${c.args.path} present`) : r("failed", `${c.args.path} not found in the repo`);
    }
    default:
      return r("unverified", "no verifier for this claim kind");
  }
}

export function checkAll(repo: string, git: Git, claims: Claim[]): ClaimResult[] {
  return claims.map((c) => checkClaim(repo, git, c));
}
