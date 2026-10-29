// Decision records: what was chosen, what was rejected and why, and which paths the
// decision binds to. A record goes stale when its bound paths change after it was made.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Git } from "./git.ts";
import { AGENTS } from "./context.ts";
import { readJson, writeJson } from "./util.ts";

export type DecisionKind = "basis_change" | "basis_propagation" | "agent_config_change" | "contract_change" | "code_change" | "policy_change";

export type DecisionRecord = {
  id: string;
  kind: DecisionKind;
  subject: string; // what it's about, e.g. "task-123/scope" or "contracts/billing-events"
  question: string;
  chosen: string;
  rejected: Array<{ option: string; reason: string }>;
  boundPaths: string[];
  boundCommit: string;
  decidedBy: string; // "human" | "auto:<policy>" | agent id
  status: "active" | "superseded" | "retired";
  createdAt: string;
  evidence?: string[];
};

const DIR = `${AGENTS}/decisions`;

export function listDecisions(repo: string): DecisionRecord[] {
  const dir = path.join(repo, DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson<DecisionRecord>(path.join(dir, f)))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function nextDecisionId(repo: string): string {
  const n = listDecisions(repo).length + 1;
  return `D-${String(n).padStart(4, "0")}`;
}

export function recordDecision(repo: string, git: Git, d: Omit<DecisionRecord, "id" | "boundCommit" | "createdAt" | "status"> & { id?: string }): DecisionRecord {
  const rec: DecisionRecord = {
    ...d,
    id: d.id ?? nextDecisionId(repo),
    boundCommit: git.head(),
    status: "active",
    createdAt: new Date().toISOString(),
  };
  writeJson(path.join(repo, DIR, `${rec.id}.json`), rec);
  return rec;
}

export function readDecision(repo: string, id: string): DecisionRecord | null {
  const f = path.join(repo, DIR, `${id}.json`);
  return fs.existsSync(f) ? readJson<DecisionRecord>(f) : null;
}

// Stale = any bound path changed after the commit that introduced this record.
// (The record usually lands in the same commit as the change it decides, so the
// anchor is that commit, not the parent recorded in boundCommit.)
export function isStale(git: Git, d: DecisionRecord, head = "HEAD"): { stale: boolean; changed: string[] } {
  if (!d.boundPaths.length) return { stale: false, changed: [] };
  let anchor = d.boundCommit;
  try {
    const added = git.run(["log", "-1", "--format=%H", "--diff-filter=A", head, "--", `${DIR}/${d.id}.json`]);
    if (added) anchor = added;
  } catch {
    /* not committed yet: fall back to boundCommit */
  }
  const out = git.run(["diff", "--name-only", anchor, head, "--", ...d.boundPaths]);
  const changed = out ? out.split("\n") : [];
  return { stale: changed.length > 0, changed };
}

export function findPrecedent(repo: string, git: Git, kind: DecisionKind, subject: string): { record: DecisionRecord | null; status: "fresh" | "stale" | "none" } {
  const matches = listDecisions(repo).filter((d) => d.kind === kind && d.subject === subject && d.status === "active");
  const record = matches.length ? matches[matches.length - 1] : null;
  if (!record) return { record: null, status: "none" };
  return { record, status: isStale(git, record).stale ? "stale" : "fresh" };
}

export function supersede(repo: string, id: string): void {
  const d = readDecision(repo, id);
  if (!d) return;
  d.status = "superseded";
  writeJson(path.join(repo, DIR, `${id}.json`), d);
}
