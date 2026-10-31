// A challenge workspace: a bare "origin" plus the runner's checkout, seeded with the
// code the challenge is about. Real deployments point at the firm's control repo.
import * as fs from "node:fs";
import * as path from "node:path";
import { cloneControl, initBare } from "../git.ts";
import type { Git } from "../git.ts";

export async function createWorkspace(opts: { dir: string; seedFrom?: string; seedPaths?: string[] }): Promise<Git> {
  fs.rmSync(opts.dir, { recursive: true, force: true });
  const origin = path.join(opts.dir, "origin.git");
  initBare(origin);
  const seed = cloneControl(origin, path.join(opts.dir, "seed")).as({ name: "seed", email: "seed@agents.local" });
  fs.writeFileSync(path.join(seed.cwd, "README.md"), "# challenge workspace\n");
  if (opts.seedFrom) {
    for (const p of opts.seedPaths ?? []) {
      const src = path.join(opts.seedFrom, p);
      if (fs.existsSync(src)) fs.cpSync(src, path.join(seed.cwd, p), { recursive: true });
    }
  }
  await seed.commitAll("seed the challenge workspace", {});
  seed.run(["push", "-q", "origin", "HEAD:main"]);
  fs.rmSync(seed.cwd, { recursive: true, force: true });
  return cloneControl(origin, path.join(opts.dir, "control"));
}
