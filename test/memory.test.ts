// Memory about a principal: remembering more must not mean misunderstanding more.
// Each test is one way accumulated memory goes wrong.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { aboutLines, appendMemory, loadMemoryPolicy, readMemory, record, renderProfile, resolve, retract, understand } from "../src/memory/memory.ts";
import type { Draft, MemoryEvent } from "../src/memory/memory.ts";
import { createWorkspace } from "../src/foundation/workspace.ts";
import { ScriptedTurnAgent } from "../src/harness/agents.ts";
import { Harness } from "../src/harness/harness.ts";
import { loadPolicy } from "../src/harness/project.ts";
import { SimClock } from "../src/harness/world.ts";

const policy = loadMemoryPolicy(path.join(import.meta.dirname, "..", "policy", "memory.json"));
const DAY = 86_400_000;
const FRI = Date.parse("2026-10-30T12:00:00Z");
const SUNDAY_NIGHT = Date.parse("2026-11-01T23:59:59Z");

function log(): { events: MemoryEvent[]; say: (d: Draft, now?: number) => string; agent: (d: Draft, now?: number) => string } {
  const events: MemoryEvent[] = [];
  const add = (d: Draft, as: "principal" | "agent", now = FRI) => {
    const r = record("partner", d, { by: as === "agent" ? "travel/research" : "partner", as, now, policy });
    events.push(r.event);
    return r.event.id;
  };
  return { events, say: (d, now) => add(d, "principal", now), agent: (d, now) => add(d, "agent", now) };
}

const redEye: Draft = { kind: "preference", subject: "travel.flight-time", value: "red-eye", text: "I like red-eye flights", source: "stated", at: FRI - 90 * DAY };
const tokyo: Draft = { kind: "intention", subject: "travel.trip", value: "tokyo", text: "Maybe Tokyo this weekend", source: "stated", at: FRI - DAY, until: SUNDAY_NIGHT };
const item = (items: ReturnType<typeof understand>, subject: string, condition?: string) => items.find((i) => i.subject === subject && (i.condition ?? "") === (condition ?? ""));

test("a preference from three months ago and a plan from yesterday: different weight, different lifetime, different use", () => {
  const m = log();
  m.say(redEye);
  m.say(tokyo);
  let items = understand(m.events, FRI, policy);
  const pref = item(items, "travel.flight-time")!;
  assert.equal(pref.use, "default", "a stated preference sets a default...");
  assert.ok(pref.weight > 0.6 && pref.weight < 0.75, `...a little faded after 90 days (${pref.weight})`);
  const plan = item(items, "travel.trip")!;
  assert.deepEqual([plan.status, plan.use], ["current", "mention"], "a plan is something to ask about when it's relevant, never a default");
  const lines = aboutLines(items, "partner");
  assert.match(lines[0], /defaults .* they permit nothing.*red-eye/);
  assert.match(lines[1], /Check with partner.*Tokyo/);
  // Monday: the weekend is over; the plan no longer exists for anyone reading memory.
  items = understand(m.events, Date.parse("2026-11-02T09:00:00Z"), policy);
  assert.equal(item(items, "travel.trip")!.status, "expired");
  assert.doesNotMatch(aboutLines(items, "partner").join("\n"), /Tokyo/);
  assert.doesNotMatch(renderProfile(items, "partner", Date.parse("2026-11-02T09:00:00Z")), /Tokyo/);
  // Or it happened: resolved, not pending.
  const m2 = log();
  const id = m2.say(tokyo);
  m2.events.push(resolve(m2.events, id, { by: "partner", outcome: "done", now: FRI }));
  assert.equal(item(understand(m2.events, FRI, policy), "travel.trip")!.status, "resolved");
});

test("our own influence isn't evidence: accepting our suggestions doesn't strengthen the preference behind them", () => {
  const m = log();
  m.say(redEye);
  const before = item(understand(m.events, FRI, policy), "travel.flight-time")!.weight;
  for (let i = 0; i < 5; i++) m.agent({ kind: "preference", subject: "travel.flight-time", value: "red-eye", text: "took the red-eye we suggested", source: "accepted", suggestion: "cheapest option: the red-eye", at: FRI - i * DAY });
  const after = item(understand(m.events, FRI, policy), "travel.flight-time")!;
  assert.equal(after.weight, before, "five acceptances later, exactly as sure as before");
  assert.equal(after.basis.accepted, 5, "they're on the record");
  // A preference resting only on acceptances is no preference: check before using it.
  const m2 = log();
  m2.agent({ kind: "preference", subject: "hotel.chain", value: "x", text: "booked the hotel we suggested", source: "accepted", suggestion: "x" });
  assert.equal(item(understand(m2.events, FRI + 1000, policy), "hotel.chain")!.use, "ask");
});

test("a preference holds under a condition: an exception narrows it instead of overwriting it", () => {
  const m = log();
  m.say({ ...redEye, condition: "short business trips", because: "it saves a hotel night" });
  m.say({ kind: "preference", subject: "travel.flight-time", value: "daytime", text: "Daytime flights when the kids come", condition: "traveling with the kids", source: "stated", at: FRI - 10 * DAY });
  const items = understand(m.events, FRI, policy);
  assert.equal(item(items, "travel.flight-time", "short business trips")!.use, "default");
  assert.equal(item(items, "travel.flight-time", "traveling with the kids")!.use, "default");
  assert.ok(items.every((i) => i.status !== "contested"), "two answers to two questions, not a conflict");
  assert.match(renderProfile(items, "partner", FRI), /when: short business trips\), because it saves a hotel night/);
});

test("two things said that disagree are a question, not an average; saying one replaces the other is an answer", () => {
  const m = log();
  const old = m.say(redEye);
  const changed = m.say({ kind: "preference", subject: "travel.flight-time", value: "daytime", text: "I'm done with red-eyes", source: "stated", at: FRI - 5 * DAY });
  let i = item(understand(m.events, FRI, policy), "travel.flight-time")!;
  assert.deepEqual([i.status, i.use], ["contested", "ask"]);
  assert.match(renderProfile(understand(m.events, FRI, policy), "partner", FRI), /said different things/);
  // Superseding the old one settles it...
  const m2 = log();
  const o2 = m2.say(redEye);
  const n2 = m2.say({ kind: "preference", subject: "travel.flight-time", value: "daytime", text: "I'm done with red-eyes", source: "stated", at: FRI - 5 * DAY, supersedes: [o2] });
  i = item(understand(m2.events, FRI, policy), "travel.flight-time")!;
  assert.deepEqual([i.value, i.use], ["daytime", "default"]);
  // ...and forgetting the replacement brings the old one back.
  m2.events.push(retract(m2.events, n2, { by: "partner", reason: "I misspoke", now: FRI }));
  assert.equal(item(understand(m2.events, FRI, policy), "travel.flight-time")!.value, "red-eye");
  assert.ok(old && changed);
});

test("preferences fade unless repeated: one said 14 months ago is checked before it's used", () => {
  const m = log();
  m.say({ ...redEye, at: FRI - 420 * DAY });
  assert.deepEqual(((i) => [i.status, i.use])(item(understand(m.events, FRI, policy), "travel.flight-time")!), ["stale", "ask"]);
  m.say({ ...redEye, text: "still love a red-eye", at: FRI - 2 * DAY });
  assert.equal(item(understand(m.events, FRI, policy), "travel.flight-time")!.use, "default", "said again, it's fresh");
});

test("memory never grants permission: text that reads like one is kept as a default and flagged", () => {
  const r = record("partner", { kind: "preference", subject: "travel.booking", text: "Always book the cheapest red-eye without asking", source: "stated" }, { by: "partner", as: "principal", now: FRI, policy });
  assert.ok(r.warnings.some((w) => w.includes("reads like a permission")));
  const items = understand([r.event], FRI, policy);
  assert.equal(items[0].use, "default", "it can rank options when you ask for flights");
  assert.match(items[0].note!, /only a default/);
  assert.ok(items.every((i) => !["act", "book", "allow"].includes(i.use as string)), "there's no use that licenses acting");
  assert.match(renderProfile(items, "partner", FRI), /grants no permission/);
});

test("agents can't make things true about you: they record guesses and acceptances, and a guess is only something to ask about", () => {
  const m = log();
  assert.throws(() => m.agent({ kind: "preference", subject: "work.review-style", text: "likes terse reviews", source: "stated" }), /only partner states or chooses/);
  assert.throws(() => m.say({ kind: "preference", subject: "work.review-style", text: "x", source: "inferred" }), /for agents/);
  assert.throws(() => m.agent({ kind: "preference", subject: "work.review-style", text: "x", source: "accepted" }), /needs the suggestion/);
  m.agent({ kind: "preference", subject: "work.review-style", value: "terse", text: "seems to prefer terse reviews", source: "inferred" });
  assert.equal(item(understand(m.events, FRI + 60_000, policy), "work.review-style")!.use, "mention", "a fresh guess is something to ask about");
  assert.match(renderProfile(understand(m.events, FRI + 60_000, policy), "partner", FRI + 60_000), /our guess, not something I've said/);
  assert.equal(item(understand(m.events, FRI + 400 * DAY, policy), "work.review-style")!.status, "stale", "an old guess goes stale");
  const plan = record("partner", { kind: "intention", subject: "travel.trip", text: "might go to Tokyo", source: "stated" }, { by: "partner", as: "principal", now: FRI, policy });
  assert.ok(plan.warnings.some((w) => w.includes("lapses after 14 days")), "a plan without a date gets one");
});

test("stored as files, read back the same; subjects scope what an engagement sees", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-mem-"));
  const m = log();
  m.say(redEye);
  m.say({ kind: "preference", subject: "work.review-style", value: "full-report", text: "Give agents the whole bug report, no hints", because: "hints anchor them", source: "stated", at: FRI - 3 * DAY });
  appendMemory(dir, "partner", m.events);
  const back = readMemory(dir, "partner");
  assert.deepEqual(back.map((e) => e.id).sort(), m.events.map((e) => e.id).sort());
  const work = understand(back, FRI, policy, { subjects: ["work.*"] });
  assert.deepEqual(work.map((i) => i.subject), ["work.review-style"], "a coding engagement doesn't need your flight preferences");
});

test("the harness: an engagement's agents get the defaults that apply in their packet, and nothing that has lapsed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-memh-"));
  const memDir = path.join(dir, "memory");
  const m = log();
  m.say({ kind: "preference", subject: "work.review-style", value: "full-report", text: "Give agents the whole bug report, no hints", because: "hints anchor them", source: "stated", at: FRI - 3 * DAY });
  m.say({ kind: "intention", subject: "work.focus", text: "Demo for the team on Thursday", source: "stated", at: FRI - 9 * DAY, until: FRI - 2 * DAY });
  m.say(redEye);
  appendMemory(memDir, "partner", m.events);
  const control = await createWorkspace({ dir: path.join(dir, "ws") });
  const agent = new ScriptedTurnAgent([{ name: "ok", when: () => true, run: () => ({ done: true }) }]);
  const hp = loadPolicy(path.join(import.meta.dirname, "..", "policy", "harness.json"));
  const clock = new SimClock(FRI);
  const about = (s: { engagement: { memory?: { principal: string; subjects: string[] } } | null }) =>
    s.engagement?.memory ? aboutLines(understand(readMemory(memDir, s.engagement.memory.principal), clock.now(), policy, { subjects: s.engagement.memory.subjects }), s.engagement.memory.principal) : [];
  const h = new Harness({ control, engagement: "e", policy: hp, clock, world: {}, agent, worktreeRoot: path.join(dir, "wt"), about });
  await h.open({
    id: "e", title: "E", principals: { partner: "you" }, memory: { principal: "partner", subjects: ["work.*"] },
    goals: [{ id: "G", title: "G", objective: "o", owner: "partner", scope: ["work"], assumptions: [], budget: { turns: 5 }, todos: [{ id: "t", lane: "build", text: "fix the bug", writeScope: ["work"] }] }],
  });
  await h.tick({ id: "r1", capabilities: [] });
  const packet = agent.calls[0].packet;
  assert.match(packet, /About partner \(defaults .* permit nothing\): work.review-style: Give agents the whole bug report, no hints, because hints anchor them/);
  assert.doesNotMatch(packet, /Demo for the team/, "a lapsed plan is gone");
  assert.doesNotMatch(packet, /red-eye/, "outside the engagement's subjects");
});

test("the command line speaks for the person only when told to: without --as, an entry is an agent's guess", async () => {
  const { execFileSync } = await import("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-mem-cli-"));
  const cli = path.join(import.meta.dirname, "..", "src", "memory", "cli.ts");
  const run = (...a: string[]) => execFileSync(process.execPath, ["--no-warnings", cli, ...a, "--dir", dir], { encoding: "utf8" });
  assert.throws(() => run("add", "--kind", "preference", "--subject", "travel.seat", "--text", "Aisle seats", "--source", "stated"), /an agent can record/);
  run("add", "--kind", "preference", "--subject", "travel.seat", "--text", "Aisle seats");
  run("add", "--as", "principal", "--kind", "preference", "--subject", "travel.meal", "--text", "Vegetarian");
  const sources = Object.fromEntries(readMemory(dir, "partner").flatMap((e) => (e.type === "remembered" ? [[e.entry.subject, e.entry.source]] : [])));
  assert.deepEqual(sources, { "travel.seat": "inferred", "travel.meal": "stated" });
  fs.rmSync(dir, { recursive: true, force: true });
});
