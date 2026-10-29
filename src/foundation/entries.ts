// The shared context layer: typed, append-only entries in git.
//
// Entries are claims, not chat. Each has a type, an author and the angle it speaks
// for, links to the entries it builds on or attacks, a visibility, and a status.
// Entries are never edited: a change is a new entry that supersedes the old one, so
// the history of what was believed, and when, stays intact.
//
//   .agents/challenges/<challenge>/entries/<id>.json     on the challenge's main line
//   refs/sealed/<challenge>/<angle>                      sealed submissions (seal.ts)
import * as fs from "node:fs";
import * as path from "node:path";
import { readJson, writeJson } from "../util.ts";

export type EntryType =
  | "frame" // the problem, constraints, success criteria (with hash), owner
  | "question" // an open question or a reframe, addressed to someone
  | "assumption" // something the plan depends on; carries risk and uncertainty
  | "option" // a proposed solution
  | "critique" // an attack on an option; must cite evidence or propose a test
  | "evidence" // a claim with a source; fact-checked
  | "score" // an angle's scores for one option against the frozen criteria
  | "decision" // an owner's ruling: chosen, rejected with reasons
  | "plan" // the MVP plan: assumptions to test, experiments, acceptance
  | "experiment" // a test of an assumption and its result
  | "artifact" // something built, pinned to the entries it relies on
  | "commitment" // hash of a sealed submission; proves it came before the reveal
  | "rejection" // a draft the gates refused, kept for audit
  | "stage" // a stage opened or closed
  | "lesson";

export type Role = "lead" | "angle" | "owner" | "fact-checker" | "runner" | "builder";
export type Author = { agent: string; role: Role; angle?: string; config?: string };
export type Visibility = "sealed" | "team" | "firm";

export type Entry = {
  id: string;
  challenge: string;
  type: EntryType;
  author: Author;
  refs: string[];
  visibility: Visibility;
  status: string;
  supersedes?: string;
  createdAt: string;
  body: Record<string, any>;
};

// What an angle hands back. localId lets drafts in one batch refer to each other.
export type Draft = { type: EntryType; localId?: string; refs?: string[]; body: Record<string, any>; status?: string };

const CODE: Record<EntryType, string> = {
  frame: "F", question: "Q", assumption: "A", option: "O", critique: "C", evidence: "E", score: "S",
  decision: "D", plan: "P", experiment: "X", artifact: "R", commitment: "K", rejection: "J", stage: "G", lesson: "L",
};

export function entriesDir(repo: string, challenge: string): string {
  return path.join(repo, ".agents", "challenges", challenge, "entries");
}

// Deterministic JSON (sorted keys) so a hash of the same entries is always the same.
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export class EntryStore {
  repo: string;
  challenge: string;
  constructor(repo: string, challenge: string) {
    this.repo = repo;
    this.challenge = challenge;
  }

  all(): Entry[] {
    const dir = entriesDir(this.repo, this.challenge);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => readJson<Entry>(path.join(dir, f))).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  get(id: string): Entry | undefined {
    const f = path.join(entriesDir(this.repo, this.challenge), `${id}.json`);
    return fs.existsSync(f) ? readJson<Entry>(f) : undefined;
  }

  // Ids are scoped by author: "risk.O1" for angle entries, "D1" for the rest, so
  // angles working in parallel never collide and never need to coordinate.
  nextId(type: EntryType, angle?: string, taken: Set<string> = new Set()): string {
    const prefix = `${angle ? `${angle}.` : ""}${CODE[type]}`;
    const used = new Set([...this.all().map((e) => e.id), ...taken]);
    let n = 1;
    while (used.has(`${prefix}${n}`)) n++;
    return `${prefix}${n}`;
  }

  write(e: Entry): Entry {
    if (this.get(e.id)) throw new Error(`entry ${e.id} already exists; entries are never edited, supersede instead`);
    writeJson(path.join(entriesDir(this.repo, this.challenge), `${e.id}.json`), e);
    return e;
  }

  add(e: Omit<Entry, "id" | "challenge" | "createdAt" | "visibility" | "status"> & { id?: string; visibility?: Visibility; status?: string }): Entry {
    return this.write({
      ...e,
      id: e.id ?? this.nextId(e.type, e.author.angle),
      challenge: this.challenge,
      visibility: e.visibility ?? "team",
      status: e.status ?? "active",
      createdAt: new Date().toISOString(),
    });
  }

  // A change is a new entry that names the one it replaces. Versions share the root
  // id: "risk.A1", then "risk.A1~2", "risk.A1~3".
  supersede(oldId: string, change: { author: Author; status?: string; body?: Record<string, any>; refs?: string[] }): Entry {
    const old = this.head(oldId);
    const root = rootOf(old.id);
    const version = this.all().filter((e) => rootOf(e.id) === root).length + 1;
    return this.add({
      type: old.type,
      author: change.author,
      refs: change.refs ?? old.refs,
      body: { ...old.body, ...(change.body ?? {}) },
      status: change.status ?? old.status,
      supersedes: old.id,
      id: `${root}~${version}`,
    });
  }

  // Latest version of an entry: the newest one sharing its root id.
  head(id: string): Entry {
    const versions = this.all().filter((e) => rootOf(e.id) === rootOf(id));
    if (!versions.length) throw new Error(`no entry ${id}`);
    return versions.sort((a, b) => versionOf(b.id) - versionOf(a.id))[0];
  }

  // Current entries: every chain's latest version.
  current(): Entry[] {
    const all = this.all();
    const replaced = new Set(all.map((e) => e.supersedes).filter(Boolean));
    return all.filter((e) => !replaced.has(e.id));
  }

  // What a reader may see. Sealed entries never reach the main line before reveal
  // (seal.ts); this filter is defense in depth for anything that slips through.
  view(reader: { angle?: string; role: Role; tags?: string[] }): Entry[] {
    return this.current().filter((e) => {
      if (e.visibility === "sealed" && e.author.angle !== reader.angle) return false;
      if (e.type === "evidence" && reader.role === "angle" && reader.tags?.length) {
        const tags: string[] = e.body.tags ?? [];
        return tags.length === 0 || tags.some((t) => reader.tags!.includes(t));
      }
      return true;
    });
  }

  // Everything that builds on an entry, directly or transitively (reverse refs). A
  // ref to any version of an entry counts as a ref to the entry.
  dependents(id: string): Entry[] {
    const current = this.current();
    const out = new Map<string, Entry>();
    const seen = new Set([rootOf(id)]);
    const queue = [rootOf(id)];
    while (queue.length) {
      const target = queue.shift()!;
      for (const e of current) {
        if (out.has(e.id) || !e.refs.some((r) => rootOf(r) === target)) continue;
        out.set(e.id, e);
        if (!seen.has(rootOf(e.id))) {
          seen.add(rootOf(e.id));
          queue.push(rootOf(e.id));
        }
      }
    }
    return [...out.values()];
  }
}

export function rootOf(id: string): string {
  return id.replace(/~\d+$/, "");
}

function versionOf(id: string): number {
  const m = id.match(/~(\d+)$/);
  return m ? Number(m[1]) : 1;
}
