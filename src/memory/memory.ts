// Memory about a principal (you, a client): what they've told us and what we've seen,
// kept as a log of evidence, never as conclusions. Remembering more isn't
// understanding more: "I like red-eye flights" (said three months ago) and "maybe
// Tokyo this weekend" (said yesterday) differ in how long they hold, how sure we are,
// and what they let an agent do. So every entry records what kind of thing it is, how
// we know it, under what condition it holds and until when; what we currently believe
// is computed when it's read, the same way the harness computes beliefs from graded
// evidence.
//
// Four rules carry most of the weight:
// - Nothing in memory grants permission. It can set a default for what you asked for,
//   or prompt a question; what an agent may do comes from the request and the tool
//   settings. Text that reads like a permission is recorded and flagged as not one.
// - Agents can't make things true about you. They can record a guess ("inferred") or
//   that you accepted their suggestion ("accepted"); only you state or choose.
// - Our own influence isn't evidence. Accepting a suggestion we made doesn't
//   strengthen the preference the suggestion came from.
// - Things expire. Intentions lapse at their date; preferences fade unless repeated;
//   two that disagree are a question, not an average.
import * as fs from "node:fs";
import * as path from "node:path";
import { sha256 } from "../util.ts";

export type MemoryKind = "preference" | "intention" | "fact" | "constraint";
export type MemorySource = "stated" | "chosen" | "inferred" | "accepted";
export const PRINCIPAL_SOURCES: MemorySource[] = ["stated", "chosen"];
export const AGENT_SOURCES: MemorySource[] = ["inferred", "accepted"];
const KINDS: MemoryKind[] = ["preference", "intention", "fact", "constraint"];

export type MemoryEntry = {
  id: string;
  principal: string;
  kind: MemoryKind;
  subject: string; // "travel.flight-time"
  value?: string; // "red-eye": what's compared when two entries disagree
  text: string; // what was said or seen, in their words
  condition?: string; // "short business trips": when it holds
  because?: string; // why, when known
  source: MemorySource;
  by: string; // who recorded it: the principal, or an agent's seat
  at: number; // when it was said or seen
  until?: number; // when it stops mattering (intentions always have one)
  supersedes?: string[];
  suggestion?: string; // for "accepted": what we suggested
};

export type MemoryEvent =
  | { type: "remembered"; id: string; at: number; entry: MemoryEntry }
  | { type: "retracted"; id: string; at: number; by: string; entry: string; reason: string }
  | { type: "resolved"; id: string; at: number; by: string; entry: string; outcome: "done" | "dropped" };

export type MemoryPolicy = {
  sourceWeights: Record<MemorySource, number>;
  halfLifeDays: { preference: number };
  intentionDays: number;
  defaultAbove: number;
  staleBelow: number;
  contestedRatio: number;
};

export function loadMemoryPolicy(file: string): MemoryPolicy {
  return JSON.parse(fs.readFileSync(file, "utf8")) as MemoryPolicy;
}

const DAY = 86_400_000;

// Text that reads like permission: it's remembered, and flagged as not being one.
const PERMISSION_TALK = /\b(always|automatically|without asking|don'?t ask|go ahead|you may|feel free|auto)\b[^.]*\b(book|buy|pay|send|reply|delete|approve|merge|deploy|sign|order|accept|transfer|post|publish)\b/i;

// ---------- recording ----------

export type Draft = Omit<MemoryEntry, "id" | "principal" | "by" | "at"> & { at?: number };

export function record(principal: string, d: Draft, opts: { by: string; as: "principal" | "agent"; now: number; policy: MemoryPolicy }): { event: MemoryEvent; warnings: string[] } {
  const warnings: string[] = [];
  if (!KINDS.includes(d.kind)) throw new Error(`kind is one of ${KINDS.join(", ")}`);
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(d.subject)) throw new Error(`subject "${d.subject}" should look like travel.flight-time`);
  if (!d.text?.trim()) throw new Error("text is what was said or seen; it can't be empty");
  const allowed = opts.as === "agent" ? AGENT_SOURCES : PRINCIPAL_SOURCES;
  if (!allowed.includes(d.source)) {
    throw new Error(opts.as === "agent" ? `an agent can record "inferred" or "accepted", not "${d.source}": only ${principal} states or chooses` : `${principal} records "stated" or "chosen"; "${d.source}" is for agents`);
  }
  if (d.source === "accepted" && !d.suggestion) throw new Error(`"accepted" needs the suggestion that was accepted (--suggestion)`);
  const at = d.at ?? opts.now;
  const until = d.until ?? (d.kind === "intention" ? at + opts.policy.intentionDays * DAY : undefined);
  if (d.kind === "intention" && !d.until) warnings.push(`no end date given: this intention lapses after ${opts.policy.intentionDays} days`);
  if (PERMISSION_TALK.test(d.text)) warnings.push("this reads like a permission; memory grants none. If you mean it as a standing rule, put it in the tool settings or the escalation policy");
  const id = `m-${d.subject.replace(/[^a-z0-9]+/gi, "-")}-${sha256(`${principal}|${d.subject}|${d.text}|${at}`).slice(0, 10)}`;
  const entry: MemoryEntry = { ...d, id, principal, by: opts.by, at, until };
  return { event: { type: "remembered", id, at: opts.now, entry }, warnings };
}

// ---------- storage: one JSON file per event, never edited ----------

export function memoryDir(root: string, principal: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(principal)) throw new Error(`bad principal ${principal}`);
  return path.join(root, principal);
}

export function readMemory(root: string, principal: string): MemoryEvent[] {
  const dir = memoryDir(root, principal);
  if (!fs.existsSync(dir)) return [];
  const seen = new Set<string>();
  const out: MemoryEvent[] = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    const e = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as MemoryEvent;
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

export function appendMemory(root: string, principal: string, events: MemoryEvent[]): void {
  const dir = memoryDir(root, principal);
  fs.mkdirSync(dir, { recursive: true });
  for (const e of events) fs.writeFileSync(path.join(dir, `${String(e.at).padStart(15, "0")}-${e.id}.json`), JSON.stringify(e, null, 2) + "\n");
}

export function find(events: MemoryEvent[], id: string): MemoryEntry | undefined {
  for (const e of events) if (e.type === "remembered" && e.id === id) return e.entry;
  return undefined;
}

export function retract(events: MemoryEvent[], id: string, opts: { by: string; reason: string; now: number }): MemoryEvent {
  if (!find(events, id)) throw new Error(`no memory ${id}`);
  return { type: "retracted", id: `forget-${id}-${opts.now}`, at: opts.now, by: opts.by, entry: id, reason: opts.reason };
}

export function resolve(events: MemoryEvent[], id: string, opts: { by: string; outcome: "done" | "dropped"; now: number }): MemoryEvent {
  const e = find(events, id);
  if (!e) throw new Error(`no memory ${id}`);
  if (e.kind !== "intention") throw new Error(`${id} is a ${e.kind}; only intentions are resolved`);
  return { type: "resolved", id: `resolve-${id}`, at: opts.now, by: opts.by, entry: id, outcome: opts.outcome };
}

// ---------- understanding: computed when read ----------

// default: use it to fill in or rank what was asked for. mention: it may matter; bring
// it up as a question when it's relevant. ask: don't rely on it without checking.
// There's no "act": memory never licenses doing something nobody asked for.
export type Use = "default" | "mention" | "ask";
export type Status = "current" | "stale" | "contested" | "expired" | "resolved";

export type Item = {
  principal: string;
  subject: string;
  kind: MemoryKind;
  value?: string;
  condition?: string;
  text: string;
  because?: string;
  status: Status;
  use: Use;
  weight: number;
  basis: Record<MemorySource, number>; // how many entries of each source back it
  entries: string[];
  latest: number;
  until?: number;
  alternatives?: Array<{ value?: string; text: string; weight: number }>;
  note?: string;
};

const norm = (s?: string) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

export function matches(subject: string, patterns?: string[]): boolean {
  if (!patterns?.length) return true;
  return patterns.some((p) => (p.endsWith(".*") ? subject === p.slice(0, -2) || subject.startsWith(p.slice(0, -1)) : subject === p));
}

export function understand(events: MemoryEvent[], now: number, policy: MemoryPolicy, opts: { subjects?: string[] } = {}): Item[] {
  const entries: MemoryEntry[] = [];
  const retracted = new Set<string>();
  const resolved = new Map<string, "done" | "dropped">();
  for (const e of events) {
    if (e.type === "remembered") entries.push(e.entry);
    else if (e.type === "retracted") retracted.add(e.entry);
    else resolved.set(e.entry, e.outcome);
  }
  const alive = entries.filter((e) => !retracted.has(e.id) && e.at <= now);
  // A later entry that supersedes an earlier one replaces it; if the later one is
  // retracted, the earlier one stands again.
  const superseded = new Set(alive.flatMap((e) => e.supersedes ?? []));
  const live = alive.filter((e) => !superseded.has(e.id) && matches(e.subject, opts.subjects));
  const sw = policy.sourceWeights;
  const fade = (e: MemoryEntry) => (e.kind === "preference" ? 0.5 ** ((now - e.at) / (policy.halfLifeDays.preference * DAY)) : 1);
  const basisOf = (es: MemoryEntry[]) => {
    const b: Record<MemorySource, number> = { stated: 0, chosen: 0, inferred: 0, accepted: 0 };
    for (const e of es) b[e.source]++;
    return b;
  };
  const noteOf = (es: MemoryEntry[]) => (es.some((e) => PERMISSION_TALK.test(e.text)) ? "reads like a permission; it's only a default" : undefined);
  const items: Item[] = [];

  // Intentions stand alone: each has its own date and its own outcome.
  for (const e of live.filter((x) => x.kind === "intention")) {
    const out = resolved.get(e.id);
    const status: Status = out ? "resolved" : e.until !== undefined && now > e.until ? "expired" : "current";
    items.push({
      principal: e.principal, subject: e.subject, kind: e.kind, value: e.value, condition: e.condition, text: e.text, because: e.because,
      status, use: "mention", weight: status === "current" ? sw[e.source] : 0, basis: basisOf([e]), entries: [e.id], latest: e.at, until: e.until, note: noteOf([e]),
    });
  }

  // Everything else is grouped by subject and condition: "red-eye" in general and
  // "daytime when the kids come" are two answers to two questions, not a conflict.
  const groups = new Map<string, MemoryEntry[]>();
  for (const e of live.filter((x) => x.kind !== "intention")) {
    const k = `${e.kind}|${e.subject}|${norm(e.condition)}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(e);
  }
  for (const es of groups.values()) {
    const kind = es[0].kind;
    const byValue = new Map<string, MemoryEntry[]>();
    for (const e of es) {
      const k = norm(e.value ?? e.text);
      (byValue.get(k) ?? byValue.set(k, []).get(k)!).push(e);
    }
    const scored = [...byValue.values()].map((v) => {
      const latest = v.reduce((a, b) => (b.at > a.at ? b : a));
      return { entries: v, latest, weight: v.reduce((n, e) => n + sw[e.source] * fade(e), 0) };
    }).sort((a, b) => b.weight - a.weight || b.latest.at - a.latest.at);
    const best = scored[0];
    const rivals = scored.slice(1).filter((x) => x.weight >= policy.staleBelow && x.weight >= best.weight * policy.contestedRatio);
    const own = best.entries.some((e) => PRINCIPAL_SOURCES.includes(e.source));
    const guessed = best.entries.some((e) => e.source === "inferred");
    const fresh = fade(best.latest) >= 0.5;
    let status: Status;
    let use: Use;
    if (rivals.length) [status, use] = ["contested", "ask"];
    // Nothing they said or chose backs it: a recent guess may be raised as a question;
    // acceptances of our own suggestions, or an old guess, only with a check first.
    else if (!own) [status, use] = [fresh ? "current" : "stale", guessed && fresh ? "mention" : "ask"];
    else if (kind === "preference" && best.weight < policy.staleBelow) [status, use] = ["stale", "ask"];
    else if (kind === "preference" && best.weight < policy.defaultAbove) [status, use] = ["current", "mention"];
    else [status, use] = ["current", "default"];
    const l = best.latest;
    items.push({
      principal: l.principal, subject: l.subject, kind, value: l.value, condition: l.condition, text: l.text, because: best.entries.find((e) => e.because)?.because,
      status, use, weight: Math.round(best.weight * 100) / 100, basis: basisOf(best.entries), entries: best.entries.map((e) => e.id), latest: l.at,
      alternatives: rivals.length ? rivals.map((r) => ({ value: r.latest.value, text: r.latest.text, weight: Math.round(r.weight * 100) / 100 })) : undefined,
      note: noteOf(best.entries),
    });
  }
  return items.sort((a, b) => a.subject.localeCompare(b.subject) || norm(a.condition).localeCompare(norm(b.condition)));
}

// ---------- what agents read ----------

const ago = (now: number, t: number) => {
  const d = Math.round((now - t) / DAY);
  return d < 1 ? "today" : d < 45 ? `${d} days ago` : d < 540 ? `${Math.round(d / 30)} months ago` : `${Math.round(d / 365)} years ago`;
};
// Dates as the reader's calendar shows them ("until Sunday" must not read as Monday).
const day = (t: number) => new Date(t).toLocaleDateString("sv-SE");
const said = (i: Item) => `${i.text}${i.condition ? ` (when: ${i.condition})` : ""}${i.because ? `, because ${i.because}` : ""}`;
const how = (i: Item, now: number) => {
  const parts = (["stated", "chosen", "inferred", "accepted"] as MemorySource[]).filter((s) => i.basis[s]).map((s) => `${s}${i.basis[s] > 1 ? ` x${i.basis[s]}` : ""}`);
  return `${parts.join(", ")}, last ${ago(now, i.latest)}`;
};

// Two lines at most for a handoff packet: the defaults that apply, and what to check.
export function aboutLines(items: Item[], principal: string, maxChars = 300): string[] {
  const cut = (s: string) => (s.length <= maxChars ? s : s.slice(0, maxChars - 1) + "…");
  const live = items.filter((i) => i.status === "current" || i.status === "contested" || i.status === "stale");
  const defaults = live.filter((i) => i.use === "default").map((i) => `${i.subject}: ${said(i)}`);
  const check = live.filter((i) => i.use !== "default").map((i) => `${i.subject}: ${i.status === "contested" ? "they've said different things" : i.status === "stale" ? `said long ago` : i.kind === "intention" ? `${i.text} (until ${day(i.until!)})` : `our guess: ${i.text}`}`);
  const out: string[] = [];
  if (defaults.length) out.push(cut(`About ${principal} (defaults for what you're asked to do; they permit nothing): ${defaults.join("; ")}`));
  if (check.length) out.push(cut(`Check with ${principal} before relying on: ${check.join("; ")}`));
  return out;
}

// A profile a coding agent can read (Copilot custom instructions, a self-profile .md):
// regenerated from the log, so it never holds what has lapsed.
export function renderProfile(items: Item[], principal: string, now: number, opts: { title?: string; count?: number } = {}): string {
  const live = items.filter((i) => i.status !== "expired" && i.status !== "resolved");
  const section = (title: string, rows: Item[], line: (i: Item) => string) => (rows.length ? [`## ${title}`, "", ...rows.map((i) => `- ${line(i)}`), ""] : []);
  const stable = live.filter((i) => i.use === "default" && i.kind !== "intention");
  const now_ = live.filter((i) => i.kind === "intention" && i.status === "current");
  const check = live.filter((i) => i.kind !== "intention" && i.use !== "default");
  return [
    `# ${opts.title ?? `Working with ${principal}`}`,
    "",
    `_Generated ${day(now)} from ${opts.count ?? items.length} memory entries. It sets defaults for what you're asked to do. It grants no permission: what you may do comes from the request in front of you and your tool settings. Lapsed plans and retracted entries are left out._`,
    "",
    ...section("How I work", stable, (i) => `**${i.subject}**: ${said(i)} _(${how(i, now)})_${i.note ? ` _(note: ${i.note})_` : ""}`),
    ...section("Right now (lapses on its own)", now_, (i) => `${said(i)}, until ${day(i.until!)}. Ask before acting on it.`),
    ...section("Ask me before relying on these", check, (i) =>
      i.status === "contested"
        ? `**${i.subject}**: I've said different things: "${i.text}" and ${i.alternatives!.map((a) => `"${a.text}"`).join(", ")}.`
        : i.status === "stale"
          ? `**${i.subject}**: ${said(i)}, but that was ${ago(now, i.latest)}.`
          : i.basis.stated + i.basis.chosen === 0
            ? `**${i.subject}**: ${said(i)} _(our guess, not something I've said: ${how(i, now)})_`
            : `**${i.subject}**: ${said(i)} _(said once, a while ago: ${how(i, now)})_`),
  ].join("\n");
}
