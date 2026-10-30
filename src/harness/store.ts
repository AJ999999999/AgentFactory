// Event store: one JSON file per event under .agents/harness/<engagement>/events/,
// committed to main. Files are never edited. Writers that race produce different file
// names, so rebases never conflict; the projection de-duplicates by event id, and
// rule-generated events use ids derived from their cause, so two runners that notice
// the same thing write the same event once.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Git } from "../git.ts";
import { repoLock } from "../git.ts";
import { sha256, writeJson } from "../util.ts";
import type { HEvent } from "./types.ts";

export const HARNESS_DIR = ".agents/harness";

export function eventsDir(engagement: string): string {
  return `${HARNESS_DIR}/${engagement}/events`;
}

// Ids end up in file names and ref names: keep them to a safe alphabet.
export function eid(...parts: Array<string | number>): string {
  const raw = parts.join("-").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._-]+/, "");
  return raw.length <= 96 ? raw : `${raw.slice(0, 72)}-${sha256(raw).slice(0, 16)}`;
}

export function safeId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(id) && !id.includes("..") && !id.endsWith(".lock");
}

export function readEvents(repo: string, engagement: string): HEvent[] {
  const dir = path.join(repo, eventsDir(engagement));
  if (!fs.existsSync(dir)) return [];
  const seen = new Set<string>();
  const out: HEvent[] = [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  for (const f of files) {
    const e = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as HEvent;
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  // File names sort by time then id; re-sort explicitly so the order never depends
  // on directory listing behavior.
  return out.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

// The log is ordered by time, so time has to respect cause and effect: a writer never
// stamps an event earlier than (or level with) the latest event it has already seen.
// Without this, a review written in the same millisecond as the turn it reviews, or by
// a runner whose clock is a few seconds behind, sorts before it and is replayed first.
// (A hybrid logical clock: the stamp is the wall clock, nudged forward only when the
// clock would contradict what the writer read.)
export function latestAt(repo: string, engagement: string): number {
  const dir = path.join(repo, eventsDir(engagement));
  if (!fs.existsSync(dir)) return -Infinity;
  let max = -Infinity;
  for (const f of fs.readdirSync(dir)) {
    const at = Number(f.slice(0, 15));
    if (f.endsWith(".json") && Number.isFinite(at) && at > max) max = at;
  }
  return max;
}

export function writeEventFiles(repo: string, engagement: string, events: HEvent[]): string[] {
  const written: string[] = [];
  const floor = latestAt(repo, engagement) + 1;
  for (const e0 of events) {
    if (!safeId(e0.id)) throw new Error(`unsafe event id: ${e0.id}`);
    const e = e0.at < floor ? { ...e0, at: floor } : e0;
    const rel = `${eventsDir(engagement)}/${String(e.at).padStart(15, "0")}-${e.id}.json`;
    writeJson(path.join(repo, rel), e);
    written.push(rel);
  }
  return written;
}

// Bring the harness's own checkout to origin/main. It never holds local work outside
// appendEvents, which runs under the same lock.
export async function syncControl(control: Git): Promise<void> {
  await repoLock(control).run(async () => {
    await control.runAsync(["fetch", "-q", "origin"]);
    await control.runAsync(["reset", "-q", "--hard", "origin/main"]);
    await control.runAsync(["clean", "-q", "-fd"]);
  });
}

// Sync and read in one locked step, so a concurrent writer in the same process never
// sees a half-reset checkout.
// Cached by origin/main's commit: an unchanged main means unchanged events, so quiet
// wakes skip the checkout and the file reads.
const readCache = new Map<string, { sha: string; events: HEvent[] }>();

export async function readSynced(control: Git, engagement: string, knownMain?: string): Promise<HEvent[]> {
  return repoLock(control).run(async () => {
    const key0 = `${control.cwd}::${engagement}`;
    const cached = readCache.get(key0);
    // The caller just saw main's sha on the remote: if we've read that commit, done.
    if (knownMain && cached?.sha === knownMain) return cached.events;
    await control.runAsync(["fetch", "-q", "origin"]);
    const sha = await control.runAsync(["rev-parse", "origin/main"]);
    const key = `${control.cwd}::${engagement}`;
    const hit = readCache.get(key);
    const head = await control.runAsync(["rev-parse", "HEAD"]);
    if (hit && hit.sha === sha && head === sha) return hit.events;
    await control.runAsync(["reset", "-q", "--hard", "origin/main"]);
    await control.runAsync(["clean", "-q", "-fd"]);
    const events = readEvents(control.cwd, engagement);
    readCache.set(key, { sha, events });
    return events;
  });
}

// Commit events (and nothing else) to main, rebasing over whatever landed meanwhile.
export async function appendEvents(
  control: Git,
  engagement: string,
  events: HEvent[],
  message: string,
  trailers: Record<string, string> = {},
  extra?: (repo: string) => void, // other files in the same commit (basis records)
): Promise<boolean> {
  if (!events.length) return false;
  return repoLock(control).run(async () => {
    await control.runAsync(["fetch", "-q", "origin"]);
    await control.runAsync(["reset", "-q", "--hard", "origin/main"]);
    writeEventFiles(control.cwd, engagement, events);
    extra?.(control.cwd);
    const sha = await control.commitAll(message, { Engagement: engagement, ...trailers });
    if (!sha) return false;
    for (let attempt = 0; attempt < 8; attempt++) {
      const push = await control.tryAsync(["push", "-q", "origin", "HEAD:main"]);
      if (push.ok) return true;
      await control.runAsync(["fetch", "-q", "origin"]);
      // Event files never collide; basis records can (two runners bumping the same
      // record): then redo the whole write on top of the new main.
      const rb = await control.tryAsync(["rebase", "-q", "origin/main"]);
      if (!rb.ok) {
        await control.tryAsync(["rebase", "--abort"]);
        await control.runAsync(["reset", "-q", "--hard", "origin/main"]);
        writeEventFiles(control.cwd, engagement, events);
        extra?.(control.cwd);
        if (!(await control.commitAll(message, { Engagement: engagement, ...trailers }))) return false;
      }
    }
    throw new Error(`could not append events for ${engagement}`);
  });
}
