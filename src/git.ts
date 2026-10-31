// Git substrate: plain git CLI, worktrees, commit trailers, and leases as refs.
//
// Leases: a lease is a set of path units ("tools/opportunity-analyzer"). Each unit is
// a ref under refs/leases/<path> on the shared remote. Acquiring = one atomic push
// that creates every unit's ref with --force-with-lease=<ref>: (empty = "must not
// exist"), so two agents can never both win the same unit. Because the refs are
// hierarchical, git's own directory/file rule also rejects "tools" while
// "tools/opportunity-analyzer" is held, closing the race on overlapping paths.
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { Mutex, pathsOverlap } from "./util.ts";

const execFileP = promisify(execFile);
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export type Identity = { name: string; email: string };

export class Git {
  cwd: string;
  identity: Identity;
  constructor(cwd: string, identity: Identity = { name: "coordinator", email: "coordinator@agents.local" }) {
    this.cwd = cwd;
    this.identity = identity;
  }

  private args(args: string[]): string[] {
    return ["-c", `user.name=${this.identity.name}`, "-c", `user.email=${this.identity.email}`, "-c", "commit.gpgsign=false", ...args];
  }

  run(args: string[]): string {
    return execFileSync("git", this.args(args), { cwd: this.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  }

  // Plumbing commands that read stdin (hash-object --stdin, mktree).
  runInput(args: string[], input: string): string {
    return execFileSync("git", this.args(args), { cwd: this.cwd, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] }).trim();
  }

  async runAsync(args: string[]): Promise<string> {
    const { stdout } = await execFileP("git", this.args(args), { cwd: this.cwd, maxBuffer: 64 * 1024 * 1024 });
    return stdout.trim();
  }

  async tryAsync(args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
    try {
      const { stdout, stderr } = await execFileP("git", this.args(args), { cwd: this.cwd, maxBuffer: 64 * 1024 * 1024 });
      return { ok: true, out: stdout.trim(), err: stderr.trim() };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message: string };
      return { ok: false, out: (err.stdout ?? "").trim(), err: (err.stderr ?? err.message).trim() };
    }
  }

  // Changed paths in the working tree (untracked included). Parsed from -z output
  // untrimmed: porcelain lines start with a status column that may be a space.
  async changedFiles(): Promise<string[]> {
    const { stdout } = await execFileP("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: this.cwd, maxBuffer: 64 * 1024 * 1024 });
    const parts = stdout.split("\0").filter(Boolean);
    const files: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const xy = parts[i].slice(0, 2);
      files.push(parts[i].slice(3));
      if (xy[0] === "R" || xy[0] === "C") i++; // skip the rename source path
    }
    return files;
  }

  as(identity: Identity): Git {
    return new Git(this.cwd, identity);
  }

  head(): string {
    return this.run(["rev-parse", "HEAD"]);
  }

  // Commit everything staged in this worktree with structured trailers.
  async commitAll(message: string, trailers: Record<string, string | string[]>): Promise<string | null> {
    await this.runAsync(["add", "-A"]);
    if (!(await this.changedFiles()).length) return null;
    const args = ["commit", "-q", "-m", message];
    for (const [key, value] of Object.entries(trailers)) {
      for (const v of Array.isArray(value) ? value : [value]) args.push("--trailer", `${key}: ${v}`);
    }
    await this.runAsync(args);
    return this.runAsync(["rev-parse", "HEAD"]);
  }

  // Files at a revision, read from git objects (not the working tree).
  listFiles(rev = "HEAD", prefix = ""): string[] {
    const out = this.run(["ls-tree", "-r", "--name-only", rev, ...(prefix ? ["--", prefix] : [])]);
    return out ? out.split("\n") : [];
  }

  show(rev: string, file: string): string {
    return this.run(["show", `${rev}:${file}`]);
  }
}

export type CommitInfo = { sha: string; author: string; subject: string; body: string; trailers: Record<string, string[]> };

export function parseTrailers(block: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^([A-Za-z0-9-]+):\s*(.*)$/);
    if (!m) continue;
    (out[m[1]] ??= []).push(m[2].trim());
  }
  return out;
}

export function log(git: Git, rev = "HEAD"): CommitInfo[] {
  const fmt = "%H%x1f%an%x1f%s%x1f%b%x1f%(trailers:unfold=true,only=true)%x1e";
  const out = git.run(["log", `--format=${fmt}`, rev]);
  return out
    .split("\x1e")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [sha, author, subject, body, trailers] = r.split("\x1f");
      return { sha, author, subject, body: body ?? "", trailers: parseTrailers(trailers ?? "") };
    });
}

export function initBare(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", dir]);
}

export function cloneControl(remote: string, dir: string): Git {
  execFileSync("git", ["clone", "-q", remote, dir], { stdio: "ignore" });
  return new Git(dir);
}

// ---------- worktrees ----------
// Git's worktree bookkeeping (.git/worktrees/*) and remote-tracking refs are not safe
// under concurrent mutation within one repository: two `worktree add` calls can read
// each other's half-written admin dirs. Agent sessions run in parallel; these short
// admin operations are serialized per repository.

const repoLocks = new Map<string, Mutex>();
export function repoLock(git: Git): Mutex {
  // --git-common-dir may be relative to the repo's cwd (".git"), so resolve against it.
  const key = path.resolve(git.cwd, git.run(["rev-parse", "--git-common-dir"]));
  let m = repoLocks.get(key);
  if (!m) repoLocks.set(key, (m = new Mutex()));
  return m;
}

export async function addWorktree(control: Git, dir: string, branch: string, base: string): Promise<Git> {
  await repoLock(control).run(() => control.runAsync(["worktree", "add", "-q", "-b", branch, dir, base]));
  return new Git(dir, control.identity);
}

export async function addDetachedWorktree(control: Git, dir: string, rev: string): Promise<Git> {
  await repoLock(control).run(() => control.runAsync(["worktree", "add", "-q", "--detach", dir, rev]));
  return new Git(dir, control.identity);
}

export async function removeWorktree(control: Git, dir: string, branch?: string): Promise<void> {
  await repoLock(control).run(async () => {
    await control.tryAsync(["worktree", "remove", "--force", dir]);
    if (branch) await control.tryAsync(["branch", "-D", branch]);
  });
}

export async function fetchOrigin(git: Git): Promise<void> {
  await repoLock(git).run(() => git.runAsync(["fetch", "-q", "origin"]));
}

// ---------- leases ----------

export type Lease = { id: string; task: string; agent: string; paths: string[]; expiresAt: number; sha: string };

// Path unit -> ref name. Ref components can't start with "." (".agents"), so a
// leading dot is encoded as "%2E"; decodeUnit reverses it.
export function leaseRef(unit: string): string {
  const clean = unit.replace(/^\/+|\/+$/g, "");
  const parts = clean.split("/");
  if (!/^[A-Za-z0-9._\-/]+$/.test(clean) || parts.some((s) => s === "" || s === "." || s === ".." || s.endsWith(".lock") || s.includes(".."))) {
    throw new Error(`invalid lease path unit: ${unit}`);
  }
  return `refs/leases/${parts.map((s) => (s.startsWith(".") ? "%2E" + s.slice(1) : s)).join("/")}`;
}

export function decodeUnit(refTail: string): string {
  return refTail.split("/").map((s) => (s.startsWith("%2E") ? "." + s.slice(3) : s)).join("/");
}

export class LeaseManager {
  control: Git;
  remote: string;
  constructor(control: Git, remote = "origin") {
    this.control = control;
    this.remote = remote;
  }

  async held(): Promise<Array<{ unit: string; sha: string }>> {
    const out = await this.control.runAsync(["ls-remote", this.remote, "refs/leases/*"]);
    return out
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [sha, ref] = l.split("\t");
        return { unit: decodeUnit(ref.replace(/^refs\/leases\//, "")), sha };
      });
  }

  async describe(unit: string, sha: string): Promise<Omit<Lease, "sha"> | null> {
    // Fetch by ref name (works on any server config), without touching FETCH_HEAD.
    await this.control.tryAsync(["fetch", "-q", "--no-write-fetch-head", this.remote, leaseRef(unit)]);
    const r = await this.control.tryAsync(["log", "-1", "--format=%B", sha]);
    if (!r.ok) return null;
    try { return JSON.parse(r.out); } catch { return null; }
  }

  // Returns the lease on success, or the conflicting units on failure. Never blocks.
  async tryAcquire(task: string, agent: string, paths: string[], ttlMs = 15 * 60_000): Promise<{ lease?: Lease; conflicts: string[] }> {
    // Fast pre-check gives a readable conflict list; the atomic push below is the real guard.
    const held = await this.held();
    const conflicts = held.filter((h) => paths.some((p) => pathsOverlap(p, h.unit))).map((h) => h.unit);
    if (conflicts.length) return { conflicts };

    const body = { id: `L-${task}-${Date.now()}`, task, agent, paths, expiresAt: Date.now() + ttlMs };
    const sha = await this.control.runAsync(["commit-tree", EMPTY_TREE, "-m", JSON.stringify(body)]);
    const args = ["push", "-q", "--atomic", "--porcelain", this.remote];
    for (const p of paths) {
      const ref = leaseRef(p);
      args.push(`--force-with-lease=${ref}:`, `${sha}:${ref}`);
    }
    const res = await this.control.tryAsync(args);
    if (!res.ok) {
      const reason = (res.err.split("\n").find((l) => /rejected|error|cannot/i.test(l)) ?? res.err).slice(0, 160);
      return { conflicts: paths.map((p) => `${p} (atomic push rejected: ${reason})`) };
    }
    return { lease: { ...body, sha }, conflicts: [] };
  }

  async acquire(task: string, agent: string, paths: string[], opts: { timeoutMs?: number; onWait?: (c: string[]) => void } = {}): Promise<Lease> {
    const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
    let delay = 25;
    for (;;) {
      const { lease, conflicts } = await this.tryAcquire(task, agent, paths);
      if (lease) return lease;
      opts.onWait?.(conflicts);
      if (Date.now() > deadline) throw new Error(`lease timeout for ${paths.join(",")}: held by ${conflicts.join(",")}`);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 400);
    }
  }

  // Release only if the refs still point at our lease (compare-and-delete).
  async release(lease: Lease): Promise<boolean> {
    const args = ["push", "-q", "--atomic", "--porcelain", this.remote];
    for (const p of lease.paths) {
      const ref = leaseRef(p);
      args.push(`--force-with-lease=${ref}:${lease.sha}`, `:${ref}`);
    }
    return (await this.control.tryAsync(args)).ok;
  }

  // Break leases whose holder died (expired TTL), again with compare-and-delete.
  async reapExpired(now = Date.now()): Promise<string[]> {
    const reaped: string[] = [];
    for (const h of await this.held()) {
      const d = await this.describe(h.unit, h.sha);
      if (d && d.expiresAt < now) {
        const ref = leaseRef(h.unit);
        const r = await this.control.tryAsync(["push", "-q", "--porcelain", this.remote, `--force-with-lease=${ref}:${h.sha}`, `:${ref}`]);
        if (r.ok) reaped.push(h.unit);
      }
    }
    return reaped;
  }
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function rel(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}
