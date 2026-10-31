// Claims and pulse: the two pieces of operational state that live in refs, not on main.
//
// Claim: refs/claims/<engagement>/<todo>, created by one atomic push that requires the
// ref not to exist, so two runners can never both hold a todo. It carries an expiry;
// a runner that dies leaves a claim that the next tick reaps (compare-and-delete) and
// records as a failed turn. Path leases (git.ts) still guard the files a turn writes;
// the claim guards the work item itself, so two wakes can't do the same todo on
// different files.
//
// Pulse: refs/pulse/<engagement>, a small JSON blob of "when did we last check this
// monitor / poll this job". Losing it costs one extra check, nothing more, so it stays
// off main where it would be thousands of noise commits.
import type { Git } from "../git.ts";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export type Claim = { todo: string; agent: string; turn: string; expiresAt: number; sha: string };

export function claimRef(engagement: string, todo: string): string {
  return `refs/claims/${engagement}/${todo}`;
}

export class Claims {
  git: Git;
  engagement: string;
  constructor(git: Git, engagement: string) {
    this.git = git;
    this.engagement = engagement;
  }

  // `refs` is a snapshot from one ls-remote; without it, the remote is asked.
  async list(refs?: Map<string, string>): Promise<Claim[]> {
    const prefix = `refs/claims/${this.engagement}/`;
    let entries: Array<[string, string]>;
    if (refs) entries = [...refs.entries()].filter(([ref]) => ref.startsWith(prefix));
    else {
      const out = await this.git.runAsync(["ls-remote", "origin", `${prefix}*`]);
      entries = out.split("\n").filter(Boolean).map((l) => {
        const [sha, ref] = l.split("\t");
        return [ref, sha] as [string, string];
      });
    }
    const claims: Claim[] = [];
    for (const [ref, sha] of entries) {
      const body = await this.read(ref, sha);
      if (body) claims.push({ ...body, sha });
    }
    return claims;
  }

  // Claim bodies never change for a given commit, so they're cached by sha.
  private bodies = new Map<string, Omit<Claim, "sha">>();
  private async read(ref: string, sha: string): Promise<Omit<Claim, "sha"> | null> {
    const hit = this.bodies.get(sha);
    if (hit) return hit;
    await this.git.tryAsync(["fetch", "-q", "--no-write-fetch-head", "origin", ref]);
    const r = await this.git.tryAsync(["log", "-1", "--format=%B", sha]);
    if (!r.ok) return null;
    try {
      const body = JSON.parse(r.out);
      this.bodies.set(sha, body);
      return body;
    } catch {
      return null;
    }
  }

  async tryClaim(todo: string, agent: string, turn: string, expiresAt: number): Promise<Claim | null> {
    const body = { todo, agent, turn, expiresAt };
    const sha = await this.git.runAsync(["commit-tree", EMPTY_TREE, "-m", JSON.stringify(body)]);
    const ref = claimRef(this.engagement, todo);
    const r = await this.git.tryAsync(["push", "-q", "--porcelain", "origin", `--force-with-lease=${ref}:`, `${sha}:${ref}`]);
    return r.ok ? { ...body, sha } : null;
  }

  // Still ours? Checked right before writeback: a turn that outlived its claim must
  // not write over the work of whoever picked the todo up after the reap.
  async holds(claim: Claim): Promise<boolean> {
    const out = await this.git.runAsync(["ls-remote", "origin", claimRef(this.engagement, claim.todo)]);
    return out.split("\t")[0] === claim.sha;
  }

  async release(claim: Claim): Promise<boolean> {
    const ref = claimRef(this.engagement, claim.todo);
    return (await this.git.tryAsync(["push", "-q", "--porcelain", "origin", `--force-with-lease=${ref}:${claim.sha}`, `:${ref}`])).ok;
  }

  // Compare-and-delete expired claims; returns the ones this caller actually removed,
  // so exactly one reaper records each failure.
  async reapExpired(now: number, refs?: Map<string, string>): Promise<Claim[]> {
    const reaped: Claim[] = [];
    for (const c of await this.list(refs)) {
      if (c.expiresAt >= now) continue;
      if (await this.release(c)) reaped.push(c);
    }
    return reaped;
  }
}

export type PulseData = {
  monitors: Record<string, { checkedAt: number }>; // "<goal>/<monitor>"
  polls: Record<string, { at: number; n: number; eta?: number }>; // todo -> last poll, poll count, expected finish
};

export class Pulse {
  git: Git;
  refName(): string {
    return this.ref;
  }
  ref: string;
  constructor(git: Git, engagement: string) {
    this.git = git;
    this.ref = `refs/pulse/${engagement}`;
  }

  private cache: { sha: string; data: PulseData } | null = null;

  async read(refs?: Map<string, string>): Promise<{ data: PulseData; sha: string | null }> {
    const sha = refs ? refs.get(this.ref) ?? null : (await this.git.runAsync(["ls-remote", "origin", this.ref])).split("\t")[0] || null;
    if (!sha) return { data: { monitors: {}, polls: {} }, sha: null };
    if (this.cache?.sha === sha) return { data: structuredClone(this.cache.data), sha };
    await this.git.tryAsync(["fetch", "-q", "--no-write-fetch-head", "origin", this.ref]);
    const r = await this.git.tryAsync(["log", "-1", "--format=%B", sha]);
    try {
      const data = JSON.parse(r.out) as PulseData;
      this.cache = { sha, data };
      return { data: structuredClone(data), sha };
    } catch {
      return { data: { monitors: {}, polls: {} }, sha };
    }
  }

  // Merge-on-conflict: keep the latest time per key from both sides.
  async update(fn: (d: PulseData) => void): Promise<void> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const { data, sha } = await this.read();
      fn(data);
      const next = await this.git.runAsync(["commit-tree", EMPTY_TREE, "-m", JSON.stringify(data)]);
      const lease = `--force-with-lease=${this.ref}:${sha ?? ""}`;
      const r = await this.git.tryAsync(["push", "-q", "--porcelain", "origin", lease, `+${next}:${this.ref}`]);
      if (r.ok) return;
    }
  }
}
