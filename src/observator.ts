// Observator: finds handoff breakpoints, i.e. artifacts still built on a superseded
// basis. A plain query over lockfiles; no model call. A model is only needed for
// artifacts that were never pinned (listed here as `unpinned`).
import type { Git } from "./git.ts";
import { fetchOrigin } from "./git.ts";
import type { Breakpoint } from "./store.ts";
import { Index } from "./store.ts";

export type Observation = { rev: string; breakpoints: Breakpoint[]; staleCommits: Array<{ sha: string; ref: string }>; unpinned: string[] };

export async function observe(control: Git, opts: { artifactRoots?: string[] } = {}): Promise<Observation> {
  await fetchOrigin(control);
  const index = new Index().rebuild(control, "origin/main");
  try {
    const roots = opts.artifactRoots ?? ["reports", "tools"];
    const files = control.listFiles("origin/main");
    const lockDirs = new Set(files.filter((f) => f.endsWith("/context.lock.json")).map((f) => f.slice(0, f.lastIndexOf("/"))));
    const artifactDirs = new Set(
      files
        .filter((f) => roots.some((r) => f.startsWith(r + "/")) && !f.endsWith("context.lock.json"))
        .map((f) => f.slice(0, f.lastIndexOf("/"))),
    );
    // A directory with files is pinned if it, or an ancestor, holds a lockfile.
    const unpinned = [...artifactDirs].filter((d) => ![...lockDirs].some((l) => d === l || d.startsWith(l + "/")));
    return { rev: index.rev, breakpoints: index.breakpoints(), staleCommits: index.commitsOnStaleBasis(), unpinned };
  } finally {
    index.close();
  }
}
