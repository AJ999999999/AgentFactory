// Playbooks (docs/jira-bugs.md): a ticket runs as steps with a fork in the middle; the
// harness takes the branch, asks before a reply goes out, and keeps what it learns about
// each service as facts.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { apply, loadPolicy, project } from "../src/harness/project.ts";
import type { HarnessPolicy, State } from "../src/harness/project.ts";
import { settle } from "../src/harness/rules.ts";
import { validateTurn } from "../src/harness/validate.ts";
import type { TurnOutput } from "../src/harness/validate.ts";
import { criteriaHash } from "../src/harness/validate.ts";
import { buildPacket } from "../src/harness/packet.ts";
import { ScriptedTurnAgent, turnPrompt } from "../src/harness/agents.ts";
import type { Behavior } from "../src/harness/agents.ts";
import { cannotStand } from "../src/harness/standing.ts";
import { factLines, playbookProblems } from "../src/harness/playbook.ts";
import type { Playbook } from "../src/harness/playbook.ts";
import { readLogs } from "../src/harness/logs.ts";
import { JiraWriter, adf } from "../src/harness/jira.ts";
import { receiveEvent } from "../src/harness/events.ts";
import type { OutsideEvent } from "../src/harness/events.ts";
import { Sim } from "../src/harness/sim.ts";
import { builtinCheck, splitCommand } from "../src/harness/checks.ts";
import type { RunTests } from "../src/harness/checks.ts";
import type { JobProvider } from "../src/harness/world.ts";
import type { EngagementDef, GoalDef, HEvent, ServiceDef } from "../src/harness/types.ts";

const full = loadPolicy(path.join(import.meta.dirname, "..", "policy", "harness.json"));
const policy: HarnessPolicy = { ...full, team: undefined };
const T0 = Date.parse("2026-11-04T09:00:00Z");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "af-play-"));
let seq = 0;

const services: ServiceDef[] = [
  { id: "payments", names: ["PayAPI"], dir: "payments", logs: { kind: "files", where: path.join(tmp, "logs", "pay-*.log"), notes: "UTC" }, sample: "samples/pay.log", build: "dotnet build", test: "dotnet test" },
  { id: "orders", dir: "orders" },
];
const source = { id: "jira", kind: "jira" as const, url: "https://jira.example.com", jql: "project = PAY", tokenEnv: "AF_JIRA_TOKEN", statuses: { routed: "In Progress", replied: "Waiting for customer" } };
const goalDef = (g: Partial<GoalDef> & { id: string }): GoalDef => ({ title: g.id, objective: "answer tickets", owner: "partner", scope: [g.id], assumptions: [], budget: { turnsPerWeek: 50, turns: 500 }, perpetual: true, ...g });
const goalEvent = (g: GoalDef): HEvent => ({ id: `goal-${g.id}`, at: T0, by: "partner", type: "goal_opened", goal: g, criteriaHash: criteriaHash(g) });
const engagement: HEvent = {
  id: "open", at: T0, by: "partner", type: "engagement_opened",
  engagement: { id: "e", title: "Support", principals: { partner: "you" }, services, events: { sources: [source], rules: [{ id: "bugs", match: { source: "jira", types: ["bug"] }, goal: "intake", playbook: "jira-bug" }] } },
};
const ticket = (id = "PAY-1", updated = "2026-11-04T08:00:00Z"): OutsideEvent => ({ source: "jira", id, type: "bug", updated, title: "Refund button does nothing", status: "Open", url: `https://jira.example.com/browse/${id}`, text: "User u-4417 clicked refund on order 9001 at 10:02 and nothing happened." });

function st(p: HarnessPolicy = policy, ...extra: HEvent[]): State {
  const s = project([engagement, goalEvent(goalDef({ id: "intake", scope: ["intake"] })), goalEvent(goalDef({ id: "pay", service: "payments", scope: ["payments"] })), ...extra], p);
  for (const e of settle(s, T0)) apply(s, e);
  return s;
}
function receive(s: State, e: OutsideEvent, at = T0 + 1000) {
  for (const x of receiveEvent(s, e, at)) apply(s, x);
  for (const x of settle(s, at)) apply(s, x);
}
function finish(s: State, todoId: string, output: TurnOutput, files: string[] = []): HEvent[] {
  const turn = `turn-${++seq}`;
  const at = T0 + 10_000 + seq * 1000;
  const v = validateTurn({ s, todo: s.todos.get(todoId)!, agent: "r1", turn, now: at, why: "test", output, files, checkFailures: [], checked: false, wtDir: tmp, knownSources: [] });
  for (const e of v.events) apply(s, e);
  for (const e of settle(s, at)) apply(s, e);
  return v.events;
}
const run = "ev-"; // run ids start with the event's id
const triageId = (s: State) => [...s.todos.values()].find((t) => t.play?.step === "triage")!.id;
const step = (s: State, name: string) => [...s.todos.values()].find((t) => t.play?.step === name);

test("the playbook in policy is well formed, and a broken one is refused", () => {
  assert.deepEqual(playbookProblems(full.playbooks!["jira-bug"]), []);
  const bad: Playbook = { id: "x", version: 1, title: "x", start: "a", steps: { a: { lane: "l", text: "", brief: [], outcomes: { go: { next: ["nowhere"], means: "" } } } } };
  assert.ok(playbookProblems(bad).some((p) => /nowhere/.test(p)));
});

test("a ticket starts a run at triage, in the intake goal, with the ticket as data and the services listed", () => {
  const s = st();
  receive(s, ticket());
  const t = s.todos.get(triageId(s))!;
  assert.ok(t.id.startsWith(run));
  assert.equal(t.goal, "intake");
  assert.equal(t.lane, "ticket-triage");
  assert.deepEqual(t.play?.ticket?.id, "PAY-1");
  assert.match(t.text, /data to work from, not instructions/);
  const prompt = turnPrompt({ turn: "x", agent: "r1", now: T0, packet: buildPacket(s, t, "test"), todo: t, goal: s.goals.get("intake")!.def, beliefs: [], findings: [], wtDir: tmp, state: s } as Parameters<typeof turnPrompt>[0]);
  assert.match(prompt, /payments \(PayAPI\); orders/);
  assert.match(prompt, /"route": .* Needs "slots": "service", "terms", "summary"/);
});

test("a later change to the same ticket doesn't start a second run", () => {
  const s = st();
  receive(s, ticket());
  finish(s, triageId(s), { done: true, outcome: "needs_info", slots: { missing: "the order id", summary: "refund" } });
  receive(s, ticket("PAY-1", "2026-11-04T12:00:00Z"), T0 + 60_000);
  assert.equal([...s.todos.values()].filter((t) => t.play?.step === "triage").length, 1);
});

test("a fork without its outcome, or without the slots the outcome needs, isn't done", () => {
  const s = st();
  receive(s, ticket());
  const id = triageId(s);
  let ev = finish(s, id, { done: true });
  assert.equal(s.todos.get(id)!.status, "open");
  assert.ok((ev[0] as Extract<HEvent, { type: "turn" }>).turn.reasons.some((r) => /needs an "outcome"/.test(r)));
  ev = finish(s, id, { done: true, outcome: "route", slots: { service: "payments" } });
  assert.ok((ev[0] as Extract<HEvent, { type: "turn" }>).turn.reasons.some((r) => /needs slots terms, summary/.test(r)));
  assert.equal(s.todos.get(id)!.status, "open");
});

test("route adds logs, code and diagnose in the service's goal, moves the ticket in Jira, and the logs job carries the terms", () => {
  const s = st();
  receive(s, ticket());
  finish(s, triageId(s), { done: true, outcome: "route", slots: { service: "payments", terms: "u-4417, 9001", summary: "refund does nothing", from: "2026-11-04T00:00:00Z" } });
  const logs = step(s, "logs")!;
  const diag = step(s, "diagnose")!;
  assert.equal(logs.goal, "pay");
  assert.equal(logs.kind, "job");
  assert.deepEqual((logs.job!.spec.logs as { terms: string[] }).terms, ["u-4417", "9001"]);
  assert.deepEqual(diag.after?.sort(), [logs.id, step(s, "code")!.id].sort());
  assert.ok(diag.conduct, "the conductor reads the diagnosis");
  const moved = [...s.todos.values()].find((t) => t.job?.spec?.jira)!;
  assert.equal((moved.job!.spec.jira as { transition: string }).transition, "In Progress");
});

test("a service triage can't place becomes a question; the partner's choice routes it", () => {
  const s = st();
  receive(s, ticket());
  finish(s, triageId(s), { done: true, outcome: "route", slots: { service: "billing", terms: "x", summary: "s" } });
  const a = [...s.asks.values()].find((x) => x.origin === "rule:play_service")!;
  assert.ok(a.options.some((o) => o.id === "payments"));
  assert.equal(step(s, "logs"), undefined);
  apply(s, { id: "ans", at: T0 + 90_000, by: "partner", type: "ask_answered", ask: a.id, answeredBy: "partner", choice: "payments" });
  for (const e of settle(s, T0 + 90_000)) apply(s, e);
  assert.equal(step(s, "logs")!.goal, "pay");
});

test("the diagnosis's branch waits for the conductor; a user_error reply is always the partner's, and is sent once they say so", () => {
  const s = st();
  receive(s, ticket());
  finish(s, triageId(s), { done: true, outcome: "route", slots: { service: "payments", terms: "u-4417", summary: "refund does nothing" } });
  const diag = step(s, "diagnose")!;
  finish(s, diag.id, { done: true, outcome: "user_error", slots: { summary: "the order was already refunded", how: "check the order's history first" } });
  assert.equal(s.todos.get(diag.id)!.status, "review");
  assert.equal(step(s, "reply"), undefined, "no branch before the conductor accepts");
  const c = [...s.todos.values()].find((t) => t.conducts === diag.id)!;
  finish(s, c.id, { done: true, verdict: "accept" });
  const reply = step(s, "reply")!;
  assert.match(turnPrompt({ turn: "x", agent: "r1", now: T0, packet: "", todo: reply, goal: s.goals.get("pay")!.def, beliefs: [], findings: [], wtDir: tmp, state: s } as Parameters<typeof turnPrompt>[0]), /already refunded.*check the order's history/s);
  finish(s, reply.id, { done: true, reply: { text: "Hi! That order was refunded on the 2nd; you'll find it under History." } });
  const ask = [...s.asks.values()].find((x) => x.origin === "rule:jira_reply_user_error")!;
  assert.match(ask.question, /refunded on the 2nd/);
  assert.match(cannotStand(s, ask, "send") ?? "", /always yours/);
  assert.equal([...s.todos.values()].filter((t) => t.job?.spec?.jira && (t.job.spec.jira as { comment?: string }).comment).length, 0);
  apply(s, { id: "ans-send", at: T0 + 200_000, by: "partner", type: "ask_answered", ask: ask.id, answeredBy: "partner", choice: "edit", note: "Hi! Your refund went through on the 2nd: see History." });
  for (const e of settle(s, T0 + 200_000)) apply(s, e);
  const send = [...s.todos.values()].find((t) => (t.job?.spec?.jira as { comment?: string } | undefined)?.comment)!;
  assert.deepEqual(send.job!.spec.jira, { source: "jira", url: source.url, tokenEnv: "AF_JIRA_TOKEN", ticket: "PAY-1", comment: "Hi! Your refund went through on the 2nd: see History.", transition: "Waiting for customer" });
});

test("a duplicate's reply may go out by a standing answer; facts are kept by subject, newest first, and rechecked after the playbook changes", () => {
  const s = st();
  receive(s, ticket());
  finish(s, triageId(s), { done: true, outcome: "duplicate", slots: { duplicate_of: "PAY-0", summary: "same" } });
  finish(s, step(s, "reply")!.id, { done: true, reply: { text: "Same as PAY-0." } });
  const ask = [...s.asks.values()].find((x) => x.origin === "rule:jira_reply")!;
  assert.equal(cannotStand(s, ask, "send"), undefined);

  const pay = st();
  receive(pay, ticket());
  finish(pay, triageId(pay), { done: true, outcome: "route", slots: { service: "payments", terms: "u", summary: "s" } });
  const code = step(pay, "code")!;
  finish(pay, code.id, { done: false, facts: [{ subject: "code.refunds", text: "RefundService.cs" }] });
  finish(pay, code.id, { done: true, facts: [{ subject: "code.refunds", text: "Refunds/RefundService.cs, method Issue" }] });
  assert.deepEqual(factLines(pay, "payments"), ["Known about payments (unconfirmed): code.refunds: Refunds/RefundService.cs, method Issue"]);
  assert.match(buildPacket(pay, step(pay, "diagnose")!, "test"), /Known about payments/);
  const bumped = { ...pay, policy: { ...pay.policy, playbooks: { "jira-bug": { ...pay.policy.playbooks!["jira-bug"], version: pay.policy.playbooks!["jira-bug"].version + 1 } } } };
  assert.match(factLines(bumped, "payments")[0], /older playbook: recheck/);
  // Facts are about a service: a turn in a goal with none can't record one.
  const ev = finish(pay, triageId(pay), { done: false, facts: [{ subject: "x.y", text: "z" }] });
  assert.ok((ev[0] as Extract<HEvent, { type: "turn" }>).turn.reasons.some((r) => /facts are about a service/.test(r)));
});

test("each service goal gets one first look, and none once it has facts", () => {
  const s = st();
  const onboard = [...s.todos.values()].filter((t) => t.play?.step === "onboard");
  assert.deepEqual(onboard.map((t) => t.goal), ["pay"]);
  assert.match(onboard[0].text, /First look at payments/);
});

test("the log excerpt is the lines around the ticket's terms, cut to fit; without terms, the newest file's end", () => {
  const dir = path.join(tmp, "logs-read");
  fs.mkdirSync(dir, { recursive: true });
  const lines = Array.from({ length: 400 }, (_, i) => (i === 200 ? "2026-11-04 10:02:11Z ERROR refund failed user=u-4417 order=9001" : i > 200 && i < 204 ? `   at Refunds.Issue() line ${i}` : `2026-11-04 info line ${i}`));
  fs.writeFileSync(path.join(dir, "pay-2026-11-04.log"), lines.join("\n"));
  fs.writeFileSync(path.join(dir, "other.txt"), "u-4417 not a log");
  const r = readLogs({ service: "payments", where: path.join(dir, "pay-*.log"), terms: ["U-4417"] });
  assert.equal(r.matches, 1);
  assert.match(r.text, /201: 2026-11-04 10:02:11Z ERROR refund failed/);
  assert.match(r.text, /at Refunds\.Issue\(\) line 203/, "the stack trace after it");
  assert.doesNotMatch(r.text, /not a log/);
  const tail = readLogs({ service: "payments", where: path.join(dir, "pay-*.log") }, { maxLines: 20 });
  assert.equal(tail.lines, 20);
  assert.throws(() => readLogs({ service: "x", where: path.join(tmp, "nope", "*.log") }), /no folder/);
});

test("Jira write-back: a comment then a move; a status Jira doesn't offer is noted, and the comment isn't sent twice", async () => {
  const calls: Array<{ url: string; method?: string; body?: string; auth: string }> = [];
  const offers = [{ id: "21", name: "Wait", to: { name: "Waiting for customer" } }];
  const fake = async (url: string, init: { method?: string; headers: Record<string, string>; body?: string }) => {
    calls.push({ url, method: init.method, body: init.body, auth: init.headers.Authorization });
    const json = url.endsWith("/transitions") && init.method === "GET" ? { transitions: offers } : {};
    return { ok: true, status: 200, json: async () => json, text: async () => "" };
  };
  const w = new JiraWriter({ env: { AF_JIRA_TOKEN: "tok" }, fetch: fake });
  const todo = (jira: Record<string, unknown>) => ({ id: "j", job: { spec: { jira: { source: "jira", url: "https://jira.example.com", tokenEnv: "AF_JIRA_TOKEN", ticket: "PAY-1", ...jira } } } }) as never;
  let out = await w.poll(await w.start(todo({ comment: "Hi", transition: "Waiting for customer" }), T0), T0);
  assert.equal(out.status, "succeeded");
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url.replace("https://jira.example.com", "")}`), ["POST /rest/api/2/issue/PAY-1/comment", "GET /rest/api/2/issue/PAY-1/transitions", "POST /rest/api/2/issue/PAY-1/transitions"]);
  assert.equal(calls[0].auth, "Bearer tok");
  assert.deepEqual(JSON.parse(calls[2].body!), { transition: { id: "21" } });
  calls.length = 0;
  out = await w.poll(await w.start(todo({ comment: "Hi", transition: "Resolved" }), T0), T0);
  assert.equal(out.status, "succeeded", "the comment went out: never send it twice");
  assert.match((out as { note: string }).note, /no transition to "Resolved" \(Jira offers: Waiting for customer\)/);
  calls.length = 0;
  const cloud = new JiraWriter({ env: { AF_JIRA_TOKEN: "tok" }, fetch: fake });
  await cloud.poll(await cloud.start(todo({ cloud: { email: "bot@x.com" }, comment: "One.\n\nTwo." }), T0), T0);
  assert.match(calls[0].url, /\/rest\/api\/3\/issue\/PAY-1\/comment$/);
  assert.match(calls[0].auth, /^Basic /);
  assert.deepEqual(JSON.parse(calls[0].body!).body, adf("One.\n\nTwo."));
  const none = new JiraWriter({ env: {}, fetch: fake });
  assert.equal((await none.poll(await none.start(todo({ comment: "Hi" }), T0), T0)).status, "failed");
});

// ---------- through real git and real ticks ----------

test("end to end: a ticket is triaged, its logs fetched and read, diagnosed as the user's mistake, and the reply you approve is posted on it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-play-e2e-"));
  // Apart from the sim's own folder, which it clears when it starts.
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "af-play-logs-"));
  fs.writeFileSync(path.join(logDir, "pay-2026-11-04.log"), ["10:01 info start", "10:02 WARN refund skipped: already refunded order=9001 user=u-4417", "10:03 info done"].join("\n"));
  const posted: Array<{ url: string; method?: string; body?: string }> = [];
  const jira = new JiraWriter({ env: { AF_JIRA_TOKEN: "tok" }, fetch: async (url, init) => {
    posted.push({ url, method: init.method, body: init.body });
    return { ok: true, status: 200, json: async () => ({ transitions: [{ id: "5", name: "Start", to: { name: "In Progress" } }, { id: "7", name: "Wait", to: { name: "Waiting for customer" } }] }), text: async () => "" };
  } });
  let delivered = false;
  const def: EngagementDef = {
    id: "support", title: "Support", principals: { partner: "you" },
    services: [{ id: "payments", names: ["PayAPI"], dir: "payments", logs: { kind: "files", where: path.join(logDir, "pay-*.log"), notes: "times are UTC" }, sample: "samples/pay.log" }],
    events: { sources: [source], rules: [{ id: "bugs", match: { source: "jira", types: ["bug"] }, goal: "intake", playbook: "jira-bug" }] },
    goals: [goalDef({ id: "intake", scope: ["intake"] }), goalDef({ id: "pay", service: "payments", scope: ["payments"] })],
  };
  const read: Record<string, string> = {};
  const lane = (l: string, run: Behavior["run"]): Behavior => ({ name: l, when: (c) => c.todo.lane === l, run });
  const agent = new ScriptedTurnAgent([
    { name: "onboard", when: (c) => c.todo.play?.step === "onboard", run: () => ({ done: true, facts: [{ subject: "logs.format", text: "HH:MM LEVEL message key=value", source: "repo:samples/pay.log" }] }) },
    lane("ticket-triage", () => ({ done: true, outcome: "route", slots: { service: "payments", terms: "u-4417,9001", summary: "refund button does nothing" } })),
    lane("research", () => ({ done: true, note: "Refunds are issued in payments/Refunds.cs; a second refund is skipped on purpose." })),
    lane("diagnose", (c) => {
      read.logs = fs.readFileSync(path.join(c.wtDir, ".agents", "harness", "support", "logs", `${c.todo.play!.run}.log`), "utf8");
      read.packet = c.packet;
      return { done: true, outcome: "user_error", slots: { summary: "order 9001 was already refunded", how: "look under History: the refund is there" } };
    }),
    lane("conduct", () => ({ done: true, verdict: "accept" })),
    lane("support", () => ({ done: true, reply: { text: "Hi! Order 9001 was already refunded; you'll see it under History." } })),
  ]);
  const sim = await Sim.create({
    dir, def, policy: full, start: "2026-11-04T09:00:00Z", agent, runners: [{ runner: { id: "r1", capabilities: ["shell"] } }], jira,
    people: [{ role: "partner", answer: (a) => (a.origin === "rule:jira_reply_user_error" ? { by: "partner", choice: "send" } : a.origin === "rule:staffing" ? { by: "partner", choice: "without" } : null) }],
    world: { events: { jira: { id: "jira", fetch: async () => (delivered ? [] : ((delivered = true), [ticket()])) } } },
  });
  await sim.run({ until: "2026-11-05T09:00:00Z" });
  const s = await sim.harness.state();
  const steps = agent.calls.map((c) => s.todos.get(c.todo)?.play?.step ?? c.lane);
  assert.deepEqual(steps.filter((x) => x !== "onboard"), ["triage", "code", "diagnose", "conduct", "reply"]);
  assert.match(read.logs, /2: 10:02 WARN refund skipped: already refunded order=9001/, "the diagnosis read the fetched lines");
  assert.match(read.packet, /Known about payments \(unconfirmed\): logs.format/);
  const comment = posted.find((p) => p.method === "POST" && p.url.endsWith("/comment"))!;
  assert.deepEqual(JSON.parse(comment.body!), { body: "Hi! Order 9001 was already refunded; you'll see it under History." });
  const moves = posted.filter((p) => p.method === "POST" && p.url.endsWith("/transitions")).map((p) => JSON.parse(p.body!).transition.id);
  assert.deepEqual(moves, ["5", "7"], "In Progress when routed, Waiting for customer after the reply");
  assert.equal(s.conducted.length, 1);
  assert.ok([...s.todos.values()].filter((t) => t.play).every((t) => t.status === "done"));
});

// ---------- the bug branch: a failing test, the fix, its pull request, the reply ----------

const shipping = (p: HarnessPolicy = policy) => {
  const s = project([engagement, goalEvent(goalDef({ id: "intake", scope: ["intake"] })), goalEvent(goalDef({ id: "pay", service: "payments", scope: ["payments"], ship: { repo: "o/pay", dir: "payments", syncMinutes: 0 } }))], p);
  for (const e of settle(s, T0)) apply(s, e);
  return s;
};
const toBug = (s: State) => {
  receive(s, ticket());
  finish(s, triageId(s), { done: true, outcome: "route", slots: { service: "payments", terms: "u-4417", summary: "refund does nothing" } });
  const diag = step(s, "diagnose")!;
  finish(s, diag.id, { done: true, outcome: "bug", slots: { summary: "refunds over 100 are dropped", where: "Refunds.cs Issue()" } });
  finish(s, [...s.todos.values()].find((t) => t.conducts === diag.id)!.id, { done: true, verdict: "accept" });
};

test("a bug, where the service ships, gets a failing test then the fix, in the service's code; where it can't ship, only the reply", () => {
  const s = shipping();
  toBug(s);
  const repro = step(s, "repro")!;
  const fix = step(s, "fix")!;
  assert.ok(step(s, "reply"), "the reporter hears it's confirmed");
  assert.deepEqual(repro.writeScope, ["payments"]);
  assert.equal(repro.check, "tests-fail");
  assert.ok(repro.conduct, "the conductor reads the test before the fix starts");
  assert.deepEqual(fix.after, [repro.id]);
  assert.equal(fix.check, "tests-pass");

  const plain = st();
  toBug(plain);
  assert.ok(step(plain, "reply"));
  assert.equal(step(plain, "repro"), undefined);
  assert.ok(plain.goals.get("pay")!.notes.some((n) => /no repository to ship to/.test(n.text)));
});

test("the failing test ships only with its fix: one question, one pull request carrying both, linked to the ticket", () => {
  const s = shipping();
  toBug(s);
  const repro = step(s, "repro")!;
  finish(s, repro.id, { done: true }, ["payments/tests/refund.test"]);
  finish(s, [...s.todos.values()].find((t) => t.conducts === repro.id)!.id, { done: true, verdict: "accept" });
  assert.equal([...s.asks.values()].filter((a) => a.origin === "rule:ship").length, 0, "the test alone isn't shipped");
  const fix = step(s, "fix")!;
  finish(s, fix.id, { done: true }, ["payments/Refunds.cs"]);
  const ask = [...s.asks.values()].find((a) => a.origin === "rule:ship")!;
  assert.equal(ask.todo, fix.id);
  apply(s, { id: "ship-yes", at: T0 + 300_000, by: "partner", type: "ask_answered", ask: ask.id, answeredBy: "partner", choice: "approve" });
  for (const e of settle(s, T0 + 300_000)) apply(s, e);
  const job = [...s.todos.values()].find((t) => t.job?.spec?.ship === fix.id)!;
  assert.deepEqual(job.job!.spec.with, [repro.id]);
  assert.match(job.job!.spec.body as string, /For PAY-1 \(https:\/\/jira.example.com\/browse\/PAY-1\): refunds over 100 are dropped/);
});

test("tests-fail holds only when the new test fails and the starting commit passes; tests-pass runs the service's tests", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "af-check-"));
  const g = (args: string[], cwd = repo) => execFileSync("git", args, { cwd, encoding: "utf8" });
  g(["init", "-q"]);
  fs.mkdirSync(path.join(repo, "svc"));
  fs.writeFileSync(path.join(repo, "svc", "a.txt"), "base");
  g(["add", "-A"]);
  g(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base"]);
  fs.writeFileSync(path.join(repo, "svc", "new.test"), "shows the bug");
  const svc: ServiceDef = { id: "x", dir: "svc", test: "run tests" };
  const git = async (args: string[], cwd: string) => g(args, cwd);
  // Fails wherever the new test is, unless the base is broken too.
  const runner = (baseBroken: boolean): RunTests => async (cwd) => ({ ok: !fs.existsSync(path.join(cwd, "new.test")) && !baseBroken, tail: "1 failed" });
  assert.deepEqual(await builtinCheck("tests-fail", repo, svc, { timeoutMs: 1000, run: runner(false), git }), []);
  assert.match((await builtinCheck("tests-fail", repo, svc, { timeoutMs: 1000, run: runner(true), git }))[0], /already fails on the commit you started from/);
  assert.match((await builtinCheck("tests-fail", repo, svc, { timeoutMs: 1000, run: async () => ({ ok: true, tail: "" }), git }))[0], /doesn't show the bug/);
  assert.match((await builtinCheck("tests-pass", repo, svc, { timeoutMs: 1000, run: runner(false), git }))[0], /run tests fails:\n1 failed/);
  assert.match((await builtinCheck("tests-pass", repo, { id: "y" }, { timeoutMs: 1000, git }))[0], /needs the service's test command/);
  assert.equal(g(["worktree", "list"]).trim().split("\n").length, 1, "the base checkout is gone again");
  assert.deepEqual(splitCommand(`dotnet test "My Tests.csproj" --no-restore`), ["dotnet", "test", "My Tests.csproj", "--no-restore"]);
});

test("end to end: a bug gets its failing test, its fix and a pull request you approve; once merged, the reporter hears it's fixed and the ticket is resolved", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "af-play-fix-"));
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "af-play-fixlogs-"));
  fs.writeFileSync(path.join(logDir, "pay-1.log"), "10:02 ERROR refund dropped amount=150 user=u-4417\n");
  const posted: Array<{ url: string; method?: string; body?: string }> = [];
  const jira = new JiraWriter({ env: { AF_JIRA_TOKEN: "tok" }, fetch: async (url, init) => {
    posted.push({ url, method: init.method, body: init.body });
    return { ok: true, status: 200, json: async () => ({ transitions: [{ id: "5", to: { name: "In Progress" } }, { id: "7", to: { name: "Waiting for customer" } }, { id: "9", to: { name: "Resolved" } }] }), text: async () => "" };
  } });
  // GitHub, played: each pull request opens, its checks pass, and it's merged.
  const shipped: Array<Record<string, unknown>> = [];
  const ship: JobProvider = {
    async start(t) { shipped.push(t.job!.spec); return t.job!.spec.watch ? "watch|x" : "gh|https://api.github.com|o/pay|7|abc|0|AF_GITHUB_TOKEN"; },
    async poll() { return { status: "succeeded", metrics: {}, note: "pull request https://github.com/o/pay/pull/7" }; },
  };
  // The service's tests: they fail while the new test is there without the fix.
  const runTests: RunTests = async (cwd) => ({ ok: !fs.existsSync(path.join(cwd, "tests", "refund.test")) || fs.existsSync(path.join(cwd, "Refunds.fixed")), tail: "Refund_over_100 failed" });
  let delivered = false;
  const src = { ...source, statuses: { ...source.statuses, resolved: "Resolved" } };
  const def: EngagementDef = {
    id: "support", title: "Support", principals: { partner: "you" },
    services: [{ id: "payments", dir: "payments", test: "dotnet test", logs: { kind: "files", where: path.join(logDir, "pay-*.log") } }],
    events: { sources: [src], rules: [{ id: "bugs", match: { source: "jira", types: ["bug"] }, goal: "intake", playbook: "jira-bug" }] },
    goals: [goalDef({ id: "intake", scope: ["intake"] }), goalDef({ id: "pay", service: "payments", scope: ["payments"], ship: { repo: "o/pay", dir: "payments", syncMinutes: 0 } })],
  };
  const lane = (l: string, run: Behavior["run"]): Behavior => ({ name: l, when: (c) => c.todo.lane === l, run });
  const write = (wt: string, rel: string) => { fs.mkdirSync(path.dirname(path.join(wt, rel)), { recursive: true }); fs.writeFileSync(path.join(wt, rel), "x"); };
  const agent = new ScriptedTurnAgent([
    { name: "onboard", when: (c) => c.todo.play?.step === "onboard", run: () => ({ done: true }) },
    lane("ticket-triage", () => ({ done: true, outcome: "route", slots: { service: "payments", terms: "u-4417", summary: "refund does nothing" } })),
    lane("research", () => ({ done: true, note: "Refunds.cs Issue() drops amounts over 100." })),
    lane("diagnose", () => ({ done: true, outcome: "bug", slots: { summary: "refunds over 100 are dropped", where: "Refunds.cs Issue()" } })),
    lane("conduct", () => ({ done: true, verdict: "accept" })),
    lane("test-design", (c) => { write(c.wtDir, "payments/tests/refund.test"); return { done: true }; }),
    lane("build", (c) => { write(c.wtDir, "payments/Refunds.fixed"); return { done: true }; }),
    lane("probation-review", () => ({ done: true, verdict: "accept", note: "the fix and its test match the diagnosis" })),
    lane("support", (c) => ({ done: true, reply: { text: c.todo.id.endsWith("fixed-reply") ? "It's fixed: refunds over 100 go through now." : "Confirmed: refunds over 100 are dropped. We're fixing it." } })),
  ]);
  const sim = await Sim.create({
    dir, def, policy: full, start: "2026-11-04T09:00:00Z", agent, runners: [{ runner: { id: "r1", capabilities: ["shell"] } }], jira, ship, runTests,
    seed: async (repo) => {
      fs.mkdirSync(path.join(repo.cwd, "payments"), { recursive: true });
      fs.writeFileSync(path.join(repo.cwd, "payments", "Refunds.cs"), "// refunds");
      await repo.runAsync(["add", "-A"]);
      await repo.commitAll("the service's code", {});
      await repo.runAsync(["push", "-q", "origin", "HEAD:main"]);
    },
    people: [{ role: "partner", answer: (a) => (["rule:jira_reply", "rule:ship"].includes(a.origin) ? { by: "partner", choice: a.origin === "rule:ship" ? "approve" : "send" } : a.origin === "rule:staffing" ? { by: "partner", choice: "without" } : null) }],
    world: { events: { jira: { id: "jira", fetch: async () => (delivered ? [] : ((delivered = true), [ticket()])) } } },
  });
  await sim.run({ until: "2026-11-06T09:00:00Z" });
  const s = await sim.harness.state();
  const steps = agent.calls.map((c) => s.todos.get(c.todo)?.play?.step ?? c.lane).filter((x) => x !== "onboard");
  assert.deepEqual(steps, ["triage", "code", "diagnose", "conduct", "reply", "repro", "conduct", "fix", "probation-review", "fixed-reply"]);
  const pr = shipped.find((x) => x.ship)!;
  assert.deepEqual(pr.with, [`${triageId(s)}-repro`], "the pull request carries the failing test");
  const comments = posted.filter((p) => p.method === "POST" && p.url.endsWith("/comment")).map((p) => JSON.parse(p.body!).body);
  assert.deepEqual(comments, ["Confirmed: refunds over 100 are dropped. We're fixing it.", "It's fixed: refunds over 100 go through now."]);
  const moves = posted.filter((p) => p.method === "POST" && p.url.endsWith("/transitions")).map((p) => JSON.parse(p.body!).transition.id);
  assert.deepEqual(moves, ["5", "7", "9"], "In Progress, Waiting for customer, then Resolved after the fix merged");
});
