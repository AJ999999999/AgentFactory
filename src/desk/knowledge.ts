// What your Copilot sessions have taught, kept in a git repo of its own, in the same
// typed memory AgentFactory keeps about people (src/memory/): one file per event,
// never edited, with what we believe computed when read.
//
// Two kinds of principal: `repo.<name>` for what holds in one repo (how to run its
// tests, a rule its code follows, a trap), and `you` for how you work everywhere.
// What a session analysis finds is recorded as "inferred": a guess. It reaches new
// sessions as "check before relying on this" until you confirm it on the desk, which
// records it as stated by you; "wrong" retracts it, and the analysis is told not to
// propose it again.
//
// The repo lives on this PC (default `~/.af/desk/knowledge`). Give it a remote (your
// team's private repo) and the desk pushes to it, so other people's desks can pull
// what yours learned. It holds company paths and code: it must never be this repo.
import * as fs from "node:fs";
import * as path from "node:path";
import { Git, repoLock } from "../git.ts";
import { appendMemory, type Draft, type MemoryEvent, type MemoryPolicy, loadMemoryPolicy, readMemory, record, renderProfile, retract, understand, type Item } from "../memory/memory.ts";
import { deskHome } from "./log.ts";
import { readJson } from "./hold.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
export const YOU = "you";
export const ANALYST = "desk-analyst";

export function memoryPolicy(): MemoryPolicy {
  return loadMemoryPolicy(path.join(ROOT, "policy", "memory.json"));
}

export function knowledgeDir(home = deskHome()): string {
  const cfg = readJson<{ knowledgeDir?: string }>(path.join(home, "config.json"), {});
  return cfg.knowledgeDir ? path.resolve(cfg.knowledgeDir) : path.join(home, "knowledge");
}

const memRoot = (dir: string) => path.join(dir, "memory");

// The repo a folder belongs to: the nearest folder above it with a .git; else the folder.
export function repoNameOf(cwd: string): string {
  let d = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(d, ".git"))) return path.basename(d);
    const up = path.dirname(d);
    if (up === d) return path.basename(path.resolve(cwd));
    d = up;
  }
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 60) || "repo";
export const repoPrincipal = (name: string) => `repo.${slug(name)}`;

export function principals(dir: string): string[] {
  try {
    return fs.readdirSync(memRoot(dir)).filter((p) => fs.statSync(path.join(memRoot(dir), p)).isDirectory()).sort();
  } catch {
    return [];
  }
}

export function itemsOf(dir: string, principal: string, now = Date.now(), policy = memoryPolicy()): Item[] {
  return understand(readMemory(memRoot(dir), principal), now, policy);
}

// What a new session in this folder is told, before your first prompt: this repo's
// knowledge and how you work, with guesses marked as guesses. Kept short: it costs
// context on every session.
export function contextFor(cwd: string, home = deskHome(), now = Date.now(), maxChars = 6000): string | undefined {
  const dir = knowledgeDir(home);
  if (!fs.existsSync(memRoot(dir))) return undefined;
  const policy = memoryPolicy();
  const repo = repoNameOf(cwd);
  const parts: string[] = [];
  for (const [p, title] of [[repoPrincipal(repo), `What earlier sessions learned about ${repo}`], [YOU, "How I work (from earlier sessions)"]] as const) {
    const items = itemsOf(dir, p, now, policy).filter((i) => i.status !== "expired" && i.status !== "resolved");
    if (items.length) parts.push(renderProfile(items, p === YOU ? "me" : repo, now, { title, count: items.length }));
  }
  if (!parts.length) return undefined;
  const text = parts.join("\n\n");
  return text.length > maxChars ? `${text.slice(0, maxChars - 40)}\n…(more on the desk)` : text;
}

// ---------- writing ----------

export async function ensureRepo(dir: string): Promise<Git> {
  fs.mkdirSync(dir, { recursive: true });
  const git = new Git(dir, { name: "desk", email: "desk@agents.local" });
  if (!fs.existsSync(path.join(dir, ".git"))) {
    git.run(["init", "-q", "-b", "main"]);
    git.run(["config", "core.autocrlf", "false"]);
    git.run(["config", "core.longpaths", "true"]);
    fs.writeFileSync(path.join(dir, "README.md"), "# What Copilot sessions taught\n\nWritten by AgentFactory's desk. `memory/<principal>/` holds one file per event (src/memory/ in AgentFactory); `sessions/` the session digests the knowledge came from; `analyses/` what each analysis proposed and what was kept.\n");
    // Only the README: whatever else is already here goes in the commit that wrote it.
    git.run(["add", "README.md"]);
    git.run(["commit", "-q", "-m", "start the knowledge repo"]);
  }
  return git;
}

// Commit what was written, and share it if the repo has a remote. A push that fails
// (offline, someone pushed first and the rebase didn't go through) is left for the
// next write: every file is new, so it merges without conflicts.
export async function commit(dir: string, message: string, trailers: Record<string, string | string[]> = {}, log: (l: string) => void = () => {}): Promise<string | null> {
  const git = await ensureRepo(dir);
  return repoLock(git).run(async () => {
    const sha = await git.commitAll(message, trailers);
    const remote = (await git.tryAsync(["remote"])).out.split("\n").includes("origin");
    if (remote) {
      // A new team repo has no main yet: then there's nothing to rebase onto.
      const fetched = await git.tryAsync(["fetch", "-q", "origin"]);
      const theirs = fetched.ok && (await git.tryAsync(["rev-parse", "--verify", "-q", "origin/main"])).ok;
      const rebased = theirs ? await git.tryAsync(["rebase", "-q", "origin/main"]) : fetched;
      if (theirs && !rebased.ok) await git.tryAsync(["rebase", "--abort"]);
      const push = rebased.ok ? await git.tryAsync(["push", "-q", "origin", "HEAD:main"]) : rebased;
      if (!push.ok) log(`knowledge not shared yet: ${push.err.split("\n")[0]}`);
    }
    return sha;
  });
}

export type Proposal = { scope: "repo" | "you"; kind: "fact" | "constraint" | "preference"; subject: string; value?: string; text: string; condition?: string; because?: string; evidence?: string };

// Secrets never go into knowledge, however they got into a session.
const SECRET = /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|xox[abpr]-[\w-]{10,}|eyJ[\w-]{10,}\.[\w-]{10,}\.|(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S{6,})/i;

const norm = (s?: string) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

// What was retracted ("wrong" on the desk), so the same guess isn't recorded again.
export function rejected(dir: string, principal: string): Array<{ subject: string; key: string; text: string }> {
  const events = readMemory(memRoot(dir), principal);
  const gone = new Set(events.flatMap((e) => (e.type === "retracted" ? [e.entry] : [])));
  return events.flatMap((e) => (e.type === "remembered" && gone.has(e.id) ? [{ subject: e.entry.subject, key: norm(e.entry.value ?? e.entry.text), text: e.entry.text }] : []));
}

// Record an analysis's proposals as guesses. Returns what was kept and why the rest wasn't.
export function recordProposals(dir: string, repo: string, proposals: unknown[], opts: { session: string; now: number; policy?: MemoryPolicy }): { kept: MemoryEvent[]; dropped: Array<{ proposal: unknown; why: string }> } {
  const policy = opts.policy ?? memoryPolicy();
  const kept: MemoryEvent[] = [];
  const dropped: Array<{ proposal: unknown; why: string }> = [];
  const seen = new Set<string>();
  for (const raw of proposals) {
    const p = raw as Partial<Proposal>;
    try {
      if (!p || typeof p !== "object") throw new Error("not an object");
      if (p.scope !== "repo" && p.scope !== "you") throw new Error(`scope is repo or you`);
      if (!["fact", "constraint", "preference"].includes(p.kind as string)) throw new Error("kind is fact, constraint or preference");
      const text = String(p.text ?? "").trim();
      const all = [text, p.value, p.condition, p.because, p.evidence].filter(Boolean).join(" ");
      if (SECRET.test(all)) throw new Error("looks like it holds a secret");
      const principal = p.scope === "repo" ? repoPrincipal(repo) : YOU;
      const subject = String(p.subject ?? "").trim().toLowerCase();
      const key = `${principal}|${subject}|${norm(p.value ?? text)}`;
      if (seen.has(key)) throw new Error("said twice in one analysis");
      if (rejected(dir, principal).some((r) => r.subject === subject && r.key === norm(p.value ?? text))) throw new Error("you marked this wrong before");
      const draft: Draft = {
        kind: p.kind as Draft["kind"],
        subject,
        text: text.slice(0, 500),
        source: "inferred",
        at: opts.now,
        ...(p.value ? { value: String(p.value).slice(0, 200) } : {}),
        ...(p.condition ? { condition: String(p.condition).slice(0, 200) } : {}),
        ...(p.because || p.evidence ? { because: String(p.because ?? `seen in session ${opts.session}: ${p.evidence}`).slice(0, 400) } : {}),
      };
      const { event } = record(principal, draft, { by: `${ANALYST}:${opts.session}`, as: "agent", now: opts.now, policy });
      seen.add(key);
      kept.push(event);
    } catch (e) {
      dropped.push({ proposal: raw, why: (e as Error).message });
    }
  }
  for (const e of kept) if (e.type === "remembered") appendMemory(memRoot(dir), e.entry.principal, [e]);
  return { kept, dropped };
}

// ---------- the desk's "right" and "wrong" ----------

export type Guess = { principal: string; entry: string; subject: string; kind: string; text: string; value?: string; condition?: string; because?: string; at: number; session?: string };

// Guesses no one has confirmed or retracted yet, newest first.
export function guesses(dir: string, now = Date.now(), policy = memoryPolicy()): Guess[] {
  const out: Guess[] = [];
  for (const p of principals(dir)) {
    const events = readMemory(memRoot(dir), p);
    for (const i of understand(events, now, policy)) {
      if (i.basis.stated + i.basis.chosen > 0 || i.status === "expired" || i.status === "resolved") continue;
      const id = i.entries[i.entries.length - 1];
      const e = events.find((x) => x.type === "remembered" && x.id === id);
      const by = e?.type === "remembered" ? e.entry.by : "";
      out.push({ principal: p, entry: id, subject: i.subject, kind: i.kind, text: i.text, value: i.value, condition: i.condition, because: i.because, at: i.latest, ...(by.startsWith(`${ANALYST}:`) ? { session: by.slice(ANALYST.length + 1) } : {}) });
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

function entryOf(dir: string, principal: string, id: string) {
  const e = readMemory(memRoot(dir), principal).find((x) => x.type === "remembered" && x.id === id);
  if (!e || e.type !== "remembered") throw new Error(`no knowledge ${id}`);
  return e.entry;
}

// You confirm a guess, as it is or in your own words: stated by you, replacing it.
export function confirm(dir: string, principal: string, id: string, now: number, text?: string): MemoryEvent {
  const g = entryOf(dir, principal, id);
  const t = text?.trim() || g.text;
  const { event } = record(principal, { kind: g.kind, subject: g.subject, text: t, source: "stated", at: now, supersedes: [id], ...(text?.trim() ? {} : g.value ? { value: g.value } : {}), ...(g.condition ? { condition: g.condition } : {}), ...(g.because ? { because: g.because } : {}) }, { by: YOU, as: "principal", now, policy: memoryPolicy() });
  appendMemory(memRoot(dir), principal, [event]);
  return event;
}

export function reject(dir: string, principal: string, id: string, now: number, reason = "marked wrong on the desk"): MemoryEvent {
  const events = readMemory(memRoot(dir), principal);
  const event = retract(events, id, { by: YOU, reason, now });
  appendMemory(memRoot(dir), principal, [event]);
  return event;
}

// What the desk shows per repo: how much is known, and how much of it you confirmed.
export function summary(dir: string, repo: string, now = Date.now(), policy = memoryPolicy()): { confirmed: number; guesses: number; items: Array<{ subject: string; text: string; use: string; confirmed: boolean }> } {
  const items = itemsOf(dir, repoPrincipal(repo), now, policy).filter((i) => i.status !== "expired" && i.status !== "resolved");
  const confirmed = items.filter((i) => i.basis.stated + i.basis.chosen > 0);
  return {
    confirmed: confirmed.length,
    guesses: items.length - confirmed.length,
    items: [...confirmed, ...items.filter((i) => i.basis.stated + i.basis.chosen === 0)].slice(0, 12).map((i) => ({ subject: i.subject, text: i.text, use: i.use, confirmed: i.basis.stated + i.basis.chosen > 0 })),
  };
}
