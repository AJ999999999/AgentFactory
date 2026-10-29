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

export type TxResult = { id: string; sha: string | null; waitedForLease: boolean; startedAt: number; endedAt: number; costTokens: number };

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
    // Return null for no change; set committed when the work made its own commit (e.g. git revert).
    work: (wtDir: string, wt: Git) => Promise<{ message: string; trailers: Record<string, string | string[]>; costTokens?: number; committed?: boolean } | null>;
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
      if (out) {
        sha = out.committed ? await wt.runAsync(["rev-parse", "HEAD"]) : await wt.commitAll(out.message, out.trailers);
        if (sha) sha = await this.merge(wt, t.id);
      }
      this.log("session_end", { task: t.id, sha });
      return { id: t.id, sha, waitedForLease: waited, startedAt, endedAt: Date.now(), costTokens: out?.costTokens ?? 0 };
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
  // Disjoint leases mean rebases never conflict on content.
  private merge(wt: Git, id: string): Promise<string> {
    return this.mergeQueue.run(async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        await fetchOrigin(wt);
        await wt.runAsync(["rebase", "-q", "origin/main"]);
        // push also rewrites the local refs/remotes/origin/main, so it shares the
        // repository lock with fetch (otherwise: "cannot lock ref ... expected ...").
        const push = await repoLock(wt).run(() => wt.tryAsync(["push", "-q", "origin", "HEAD:main"]));
        if (push.ok) {
          const sha = await wt.runAsync(["rev-parse", "HEAD"]);
          this.log("merged", { task: id, sha: sha.slice(0, 8) });
          return sha;
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
