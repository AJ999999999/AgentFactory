// Sealed submissions: commit-reveal on git refs.
//
// During divergence each angle's entries are written to their own ref,
// refs/sealed/<challenge>/<angle>, never to the challenge's main line, so no other
// angle's worktree or view can contain them. Only a hash of the submission goes on
// the main line (a "commitment" entry), which proves when it was made. At reveal the
// runner reads every sealed ref, checks each against its commitment, and writes all
// of them to the main line in one commit. A submission changed after its commitment
// fails the check; a second submission from the same angle is refused by git.
import type { Git } from "../git.ts";
import { sha256 } from "../util.ts";
import type { Entry } from "./entries.ts";
import { stableStringify } from "./entries.ts";

const EMPTY_TREE_MODE = "100644 blob";

export function sealedRef(challenge: string, angle: string): string {
  for (const part of [challenge, angle]) if (!/^[a-z0-9][a-z0-9-]*$/.test(part)) throw new Error(`not ref-safe: ${part}`);
  return `refs/sealed/${challenge}/${angle}`;
}

export function commitmentHash(entries: Entry[]): string {
  return sha256(stableStringify([...entries].sort((a, b) => a.id.localeCompare(b.id))));
}

export async function submitSealed(git: Git, challenge: string, angle: string, entries: Entry[]): Promise<{ ref: string; commit: string; hash: string }> {
  const ref = sealedRef(challenge, angle);
  const lines = entries.map((e) => `${EMPTY_TREE_MODE} ${git.runInput(["hash-object", "-w", "--stdin"], JSON.stringify(e, null, 2) + "\n")}\t${e.id}.json`);
  const tree = git.runInput(["mktree"], lines.join("\n") + (lines.length ? "\n" : ""));
  const hash = commitmentHash(entries);
  const commit = git.run(["commit-tree", tree, "-m", `sealed ${challenge}/${angle} ${hash}`]);
  // Empty expected value = the ref must not exist yet: one submission per angle.
  const push = await git.tryAsync(["push", "-q", "--porcelain", "origin", `--force-with-lease=${ref}:`, `${commit}:${ref}`]);
  if (!push.ok) throw new Error(`sealed submission refused for ${angle}: already submitted`);
  return { ref, commit, hash };
}

export type RevealResult = { angle: string; entries: Entry[]; ok: boolean; reason?: string };

export async function readSealed(git: Git, challenge: string, angle: string, expectedHash: string): Promise<RevealResult> {
  const ref = sealedRef(challenge, angle);
  const fetched = await git.tryAsync(["fetch", "-q", "--no-write-fetch-head", "origin", `+${ref}:${ref}`]);
  if (!fetched.ok) return { angle, entries: [], ok: false, reason: "no sealed submission" };
  const listing = git.run(["ls-tree", ref]);
  const entries: Entry[] = listing
    ? listing.split("\n").map((l) => JSON.parse(git.run(["cat-file", "blob", l.split(/\s+/)[2]])) as Entry)
    : [];
  const hash = commitmentHash(entries);
  if (hash !== expectedHash) return { angle, entries: [], ok: false, reason: `content changed after commitment (${hash.slice(0, 12)} != ${expectedHash.slice(0, 12)})` };
  return { angle, entries, ok: true };
}
