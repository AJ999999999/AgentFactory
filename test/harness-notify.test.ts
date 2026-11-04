// The harness's questions on Slack: a card each, when due; your tap back by mail counts
// only with the card's code, from you, on an option that may be answered from Slack.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { apply, loadPolicy, project, type State } from "../src/harness/project.ts";
import { answerEvents } from "../src/harness/answers.ts";
import { settle } from "../src/harness/rules.ts";
import { type Card, dueAt, type Mail, notifyTick } from "../src/harness/notify.ts";
import { criteriaHash } from "../src/harness/validate.ts";
import type { Ask, GoalDef, HEvent } from "../src/harness/types.ts";

const policy = { ...loadPolicy(path.join(import.meta.dirname, "..", "policy", "harness.json")), team: undefined };
const at = (d: number, h: number) => new Date(2026, 10, d, h, 0).getTime(); // this PC's time, as the digest hour is

function setup(cfg: object | null = { webhook: "https://hooks.slack.com/triggers/T/1", me: "me@corp.com", replies: "outlook" }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "af-notify-"));
  if (cfg) fs.writeFileSync(path.join(home, "slack.json"), JSON.stringify(cfg));
  const g: GoalDef = { id: "G", title: "Payments", objective: "o", owner: "partner", scope: ["work"], assumptions: [], budget: { turns: 50 } };
  const s: State = project([
    { id: "open", at: at(4, 8), by: "partner", type: "engagement_opened", engagement: { id: "e", title: "E", principals: { partner: "you" } } },
    { id: "goal-G", at: at(4, 8), by: "partner", type: "goal_opened", goal: g, criteriaHash: criteriaHash(g) },
    { id: "add-t1", at: at(4, 8), by: "partner", type: "todo_added", todo: { id: "t1", goal: "G", lane: "fix", kind: "task", text: "Fix PAY-7" }, provenance: "seed" },
  ], policy);
  const cards: Card[] = [];
  let mails: Mail[] = [];
  const deps = (now: number) => ({
    engagement: "e", home, now,
    state: async () => s,
    answer: async (ask: string, ans: Parameters<typeof answerEvents>[2]) => { for (const e of answerEvents(s, ask, ans, now)) apply(s, e); settle(s, now); },
    send: async (_url: string, c: Card) => { cards.push(c); },
    read: async () => { const m = mails; mails = []; return m; },
  });
  const ask = (id: string, openedAt: number, extra: Partial<Ask> = {}) => {
    const a: Ask = {
      id, goal: "G", to: "partner", kind: "decision", todo: "t1", origin: "rule:failures", question: `"Fix PAY-7" failed 3 times in a row. Retry, or drop it?`,
      options: [{ id: "retry", label: "Retry", effect: { type: "retry", todo: "t1" } }, { id: "drop", label: "Drop it", effect: { type: "supersede", todos: ["t1"] } }],
      recommend: { option: "retry", why: "the last failure was a flaky test", by: "harness" }, ...extra,
    };
    apply(s, { id, at: openedAt, by: "harness", type: "ask_opened", ask: a } as HEvent);
  };
  return { s, cards, deps, ask, mail: (m: Mail) => mails.push(m) };
}

test("an urgent question goes to Slack at once, the rest at the digest hour, each once, with its options as numbers", async () => {
  const x = setup();
  x.ask("a-urgent", at(4, 10), { urgent: true });
  x.ask("a-later", at(4, 10));
  assert.equal(dueAt(x.s.asks.get("a-later")!, 9), at(5, 9), "opened after nine: tomorrow's digest");
  await notifyTick(x.deps(at(4, 10)));
  assert.deepEqual(x.cards.map((c) => c.ask), ["a-urgent"]);
  const c = x.cards[0];
  assert.equal(c.kind, "ask");
  assert.equal(c.headline, `"Fix PAY-7" failed 3 times in a row.`);
  assert.equal(c.options, "1. Retry (recommended)\n2. Drop it (can't be undone: answer on the panel)");
  assert.match(c.why, /flaky test/);
  assert.match(c.nonce, /^[0-9a-f]{24}$/);
  await notifyTick(x.deps(at(4, 11)));
  assert.equal(x.cards.length, 1, "once");
  await notifyTick(x.deps(at(5, 9)));
  assert.deepEqual(x.cards.map((c) => c.ask), ["a-urgent", "a-later"]);
});

test("your tap answers as you, only with the card's code, from your address, on an option Slack may answer", async () => {
  const x = setup();
  x.ask("a1", at(4, 10), { urgent: true });
  await notifyTick(x.deps(at(4, 10)));
  const nonce = x.cards[0].nonce;
  x.mail({ subject: `af-harness a1 ${nonce} 1`, body: "", from: "someone@corp.com" });
  x.mail({ subject: `af-harness a1 0000 1`, body: "", from: "me@corp.com" });
  x.mail({ subject: `af-harness a1 ${nonce} 2`, body: "", from: "me@corp.com" });
  let r = await notifyTick(x.deps(at(4, 10) + 60_000));
  assert.deepEqual(r.ignored.map((i) => i.why), ["sent by someone@corp.com, not me@corp.com", "not a card this engagement sent", "option 2 can't be undone: answer it on the panel"]);
  assert.equal(x.s.asks.get("a1")!.status, "open");
  x.mail({ subject: `af-harness a1 ${nonce} 1`, body: "flaky, go again", from: "Me@Corp.com" });
  r = await notifyTick(x.deps(at(4, 10) + 120_000));
  assert.deepEqual(r.answered, [{ ask: "a1", choice: "retry" }]);
  const a = x.s.asks.get("a1")!;
  assert.equal(a.answeredBy, "partner", "your answer, graded as yours");
  assert.equal(a.note, "flaky, go again");
  // With no card left waiting, your mailbox isn't read: a late tap waits there and is
  // ignored the next time a card is out.
  x.mail({ subject: `af-harness a1 ${nonce} 1`, body: "", from: "me@corp.com" });
  r = await notifyTick(x.deps(at(4, 10) + 180_000));
  assert.deepEqual(r.ignored, []);
  x.ask("a2", at(4, 10) + 200_000, { urgent: true });
  await notifyTick(x.deps(at(4, 10) + 200_000));
  r = await notifyTick(x.deps(at(4, 10) + 240_000));
  assert.deepEqual(r.ignored.map((i) => i.why), ["already answered, or no longer open"]);
});

test("after your answer, a result card says what it led to once its work has run", async () => {
  const x = setup();
  x.ask("a1", at(4, 10), { urgent: true });
  await notifyTick(x.deps(at(4, 10)));
  await x.deps(at(4, 11)).answer("a1", { by: "partner", choice: "retry" });
  await notifyTick(x.deps(at(4, 11)));
  assert.equal(x.cards.filter((c) => c.kind === "result").length, 0, "its work hasn't run yet");
  apply(x.s, { id: "turn-x", at: at(4, 12), by: "r1", type: "turn", turn: { id: "x", todo: "t1", goal: "G", agent: "r1", result: "completed", granularity: "substantive", reasons: [], files: [] } });
  await notifyTick(x.deps(at(4, 12)));
  await notifyTick(x.deps(at(4, 13)));
  const results = x.cards.filter((c) => c.kind === "result");
  assert.equal(results.length, 1);
  assert.match(results[0].what, /You chose: Retry\. Then its work ran: completed/);
});

test("notices need no answer: a model service holding its seats for hours, once", async () => {
  const x = setup();
  x.s.capacity.set("claude", { vendor: "claude", until: at(4, 16), reason: "usage limit", streak: 1, kind: "limit" });
  await notifyTick(x.deps(at(4, 10)));
  await notifyTick(x.deps(at(4, 11)));
  assert.deepEqual(x.cards.map((c) => [c.kind, c.headline.split(" ")[0]]), [["notice", "claude"]]);
});

test("without ~/.af/harness/slack.json nothing is posted or read", async () => {
  const x = setup(null);
  x.ask("a1", at(4, 10), { urgent: true });
  const r = await notifyTick(x.deps(at(4, 10)));
  assert.deepEqual([x.cards.length, r.sent.length], [0, 0]);
});

test("'from now on' from Slack makes a standing answer where the panel would allow one, and is refused where it wouldn't", async () => {
  const x = setup();
  x.ask("a1", at(4, 10), { urgent: false, options: [{ id: "retry", label: "Retry", effect: { type: "retry", todo: "t1" } }, { id: "drop", label: "Drop it", effect: { type: "supersede", todos: ["t1"] } }] });
  await notifyTick(x.deps(at(5, 9)));
  const card = x.cards.find((c) => c.ask === "a1")!;
  assert.match(card.options, /1\. Retry \(recommended\) \(can be kept from now on\)/);
  x.mail({ subject: `af-harness a1 ${card.nonce} 1 from now on`, body: "", from: "me@corp.com" });
  const r = await notifyTick(x.deps(at(5, 9) + 60_000));
  assert.deepEqual(r.answered, [{ ask: "a1", choice: "retry", standing: true }]);
  assert.equal(x.s.standing.size, 1, "a standing answer, as if given on the panel");

  // An urgent question can't stand: the tap is refused with why, and the question stays open.
  x.ask("a2", at(5, 10), { urgent: true });
  await notifyTick(x.deps(at(5, 10)));
  const c2 = x.cards.find((c) => c.ask === "a2")!;
  x.mail({ subject: `af-harness a2 ${c2.nonce} 1 from now on`, body: "", from: "me@corp.com" });
  const r2 = await notifyTick(x.deps(at(5, 10) + 60_000));
  assert.match(r2.ignored[0].why, /"from now on" can't apply to option 1 \(urgent questions are always yours\)/);
  assert.equal(x.s.asks.get("a2")!.status, "open");
});

test("events nobody handles: a notice once a week when one source and type keep matching no rule", async () => {
  const x = setup();
  for (let i = 0; i < 6; i++) apply(x.s, { id: `evt-${i}`, at: at(4, 9) + i, by: "harness", type: "event_received", event: { source: "jira-pay", id: `PAY-${i}`, type: "story", updated: `u${i}`, title: "t" }, rule: null });
  apply(x.s, { id: "evt-b", at: at(4, 9), by: "harness", type: "event_received", event: { source: "jira-pay", id: "PAY-b", type: "bug", updated: "u", title: "t" }, rule: null });
  await notifyTick(x.deps(at(4, 10)));
  await notifyTick(x.deps(at(4, 11)));
  const n = x.cards.filter((c) => c.kind === "notice");
  assert.deepEqual(n.map((c) => c.headline), ["6 story events from jira-pay matched no rule this week"], "once, and not for one stray bug");
});
