// Coordinator: schedules agent sessions with a concurrency cap, takes a lease on each
// task's paths, runs the agent in its own worktree, writes the lockfile, commits with
// trailers, and merges through a serialized merge queue. Production swap: Temporal
// workflows for durability; the steps stay the same.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Git, Identity, Lease } from "./git.ts";
import { addWorktree, fetchOrigin, LeaseManager, removeWorktree, repoLock } from "./git.ts";
import { currentPins, taskContext, writeLockfile } from "./context.ts";
import type { AgentRunner, RunSpec } from "./agents/runner.ts";
import { configRef } from "./agents/runner.ts";
import type { LogFn } from "./util.ts";
import { Mutex, Semaphore } from "./util.ts";

export type TxResult = { id: string; sha: string | null; waitedForLease: boolean; startedAt: number; endedAt: number; costTokens: number; recheckFailures?: string[] };

type WorkOut = { message: string; trailers: Record<string, string | string[]>; costTokens?: number; committed?: boolean };

// Checks to run again when the merge queue rebases a change onto work that landed
// after it started. Disjoint leases keep the rebase free of text conflicts, but the
// rebased tree is a combination nobody has checked yet.
export type Recheck = {
  run: (wtDir: string, wt: Git) => Promise<string[]>;
  // The worktree has been reset to the latest main. Write what should land instead
  // (a record of the failure), or return null to land nothing.
  onFail: (wtDir: string, wt: Git, failures: string[]) => Promise<WorkOut | null>;
};

export class Coordinator {
  control: Git;
  leases: LeaseManager;
  worktreeRoot: string;
  runner: AgentRunner;
  slots: Semaphore;
  mergeQueue = new Mutex();
  log: LogFn;
  private counter = 0;

  constructor(opts: { control: Git; worktreeRoot: string; runner: AgentRunner; concurrency: number; log: LogFn }) {
    this.control = opts.control;
    this.leases = new LeaseManager(opts.control);
    this.worktreeRoot = opts.worktreeRoot;
    this.runner = opts.runner;
    this.slots = new Semaphore(opts.concurrency);
    this.log = opts.log;
  }

  // Generic lease -> worktree -> work -> commit -> merge -> release.
  async transaction(t: {
    id: string;
    identity: Identity;
    lockPaths: string[];
    leaseTtlMs?: number; // must outlast the work, or another runner may reap the lease mid-turn
    // Return null for no change; set committed when the work made its own commit (e.g. git revert).
    work: (wtDir: string, wt: Git) => Promise<WorkOut | null>;
    recheck?: Recheck;
  }): Promise<TxResult> {
    const release = await this.slots.acquire();
    const startedAt = Date.now();
    let waited = false;
    let lease: Lease | null = null;
    const n = ++this.counter;
    const branch = `task/${t.id}-${n}`;
    const wtDir = path.join(this.worktreeRoot, `${t.id}-${n}`);
    try {
      lease = await this.leases.acquire(t.id, t.identity.name, t.lockPaths, {
        ttlMs: t.leaseTtlMs,
        onWait: (conflicts) => {
          if (!waited) this.log("lease_wait", { task: t.id, conflicts });
          waited = true;
        },
      });
      this.log("lease_acquired", { task: t.id, paths: t.lockPaths });
      await fetchOrigin(this.control);
      const wt = (await addWorktree(this.control, wtDir, branch, "origin/main")).as(t.identity);
      this.log("session_start", { task: t.id, agent: t.identity.name });
      const out = await t.work(wtDir, wt);
      let sha: string | null = null;
      let recheckFailures: string[] | undefined;
      if (out) {
        sha = out.committed ? await wt.runAsync(["rev-parse", "HEAD"]) : await wt.commitAll(out.message, out.trailers);
        if (sha) ({ sha, recheckFailures } = await this.merge(wt, wtDir, t.id, t.recheck));
      }
      this.log("session_end", { task: t.id, sha });
      return { id: t.id, sha, waitedForLease: waited, startedAt, endedAt: Date.now(), costTokens: out?.costTokens ?? 0, ...(recheckFailures ? { recheckFailures } : {}) };
    } finally {
      if (lease) {
        await this.leases.release(lease);
        this.log("lease_released", { task: t.id });
      }
      await removeWorktree(this.control, wtDir, branch);
      release();
    }
  }

  // Merge queue: one merge at a time; rebase onto the latest main, then push.
  // Disjoint leases mean rebases never conflict on text, but not that the result
  // works: when main moved since the work started, the checks run again on the
  // rebased tree, and a change that fails them is replaced by its onFail record.
  private merge(wt: Git, wtDir: string, id: string, recheck?: Recheck): Promise<{ sha: string | null; recheckFailures?: string[] }> {
    return this.mergeQueue.run(async () => {
      let recheckFailures: string[] | undefined;
      for (let attempt = 0; attempt < 5; attempt++) {
        await fetchOrigin(wt);
        const tip = await wt.runAsync(["rev-parse", "origin/main"]);
        const moved = (await wt.runAsync(["merge-base", "HEAD", "origin/main"])) !== tip;
        await wt.runAsync(["rebase", "-q", "origin/main"]);
        if (moved && recheck && !recheckFailures) {
          const failures = await recheck.run(wtDir, wt);
          if (failures.length) {
            recheckFailures = failures;
            this.log("recheck_failed", { task: id, failures });
            await wt.runAsync(["reset", "-q", "--hard", "origin/main"]);
            const out = await recheck.onFail(wtDir, wt, failures);
            if (!out || !(await wt.commitAll(out.message, out.trailers))) return { sha: null, recheckFailures };
          }
        }
        // push also rewrites the local refs/remotes/origin/main, so it shares the
        // repository lock with fetch (otherwise: "cannot lock ref ... expected ...").
        const push = await repoLock(wt).run(() => wt.tryAsync(["push", "-q", "origin", "HEAD:main"]));
        if (push.ok) {
          const sha = await wt.runAsync(["rev-parse", "HEAD"]);
          this.log("merged", { task: id, sha: sha.slice(0, 8) });
          return { sha, ...(recheckFailures ? { recheckFailures } : {}) };
        }
      }
      throw new Error(`merge failed for ${id}`);
    });
  }

  // Run one agent on one task. Pins default to the task's current basis.
  runAgent(
    id: string,
    spec: Omit<RunSpec, "pins"> & { pins?: string[] },
    extraTrailers: Record<string, string | string[]> = {},
    after?: (wtDir: string, wt: Git) => void | Promise<void>,
  ): Promise<TxResult> {
    const identity = { name: spec.agent, email: `${spec.agent}@agents.local` };
    return this.transaction({
      id,
      identity,
      lockPaths: [spec.artifact],
      work: async (wtDir, wt) => {
        const pins = spec.pins ?? currentPins(wtDir, spec.task);
        const full: RunSpec = { ...spec, pins };
        const bundle = taskContext(wtDir, spec.task, "author", pins);
        const res = await this.runner.run(full, wtDir, bundle);
        if (!res.ok) throw new Error(`${spec.agent} failed: ${res.error}`);
        const sources = bundle.state?.sources?.value as { snapshot?: string } | undefined;
        // Same thing the sessionEnd hook does for Copilot CLI sessions.
        writeLockfile(wtDir, {
          artifact: spec.artifact,
          task: spec.task,
          builtBy: spec.agent,
          config: configRef(spec.config),
          basis: pins,
          inputs: sources?.snapshot ? [sources.snapshot] : [],
          builtAt: new Date().toISOString(),
        });
        if (after) await after(wtDir, wt);
        // Session scratch (hook input, hook logs) never lands in history.
        fs.rmSync(path.join(wtDir, ".agents", "session.json"), { force: true });
        fs.rmSync(path.join(wtDir, ".agents", "logs"), { recursive: true, force: true });
        return {
          message: `build ${spec.artifact}`,
          trailers: { Agent: spec.agent, Task: spec.task, Config: configRef(spec.config), Basis: pins, ...extraTrailers },
          costTokens: res.costTokens,
        };
      },
    });
  }
}
