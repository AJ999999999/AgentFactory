// Asks on Slack while you're away: the desk posts each held ask to a workflow that starts
// from a webhook, and you answer when you're back. Slack is played by a function here.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { answer, hold, pageFile, pending, setAway, setMode, writeJson } from "../src/desk/hold.ts";
import type { DeskEvent } from "../src/desk/log.ts";
import { startDesk } from "../src/desk/server.ts";
import { type Mail, type ReadMail, type SlackMessage, slackReplies, slackTest, slackTick } from "../src/desk/slack.ts";

const HOOK = "https://hooks.slack.com/triggers/T0/1/abc";
const tmp = (n: string) => fs.mkdtempSync(path.join(os.tmpdir(), `af-slack-${n}-`));
const ask = (over: Partial<DeskEvent> = {}): DeskEvent => ({ at: Date.now(), event: "permissionRequest", session: "s1", cwd: "/w/billing", tool: "shell", detail: '{"command":"npm run migrate"}', ...over });

function setUp(name: string, slack: Record<string, unknown> = {}) {
  const home = tmp(name);
  writeJson(path.join(home, "config.json"), { slack: { webhook: HOOK, ...slack } });
  writeJson(pageFile(home), { at: Date.now() });
  return home;
}
const slack = () => {
  const got: Array<{ url: string; body: SlackMessage }> = [];
  return { got, send: async (url: string, body: SlackMessage) => void got.push({ url, body }) };
};
async function asked(home: string) {
  for (let i = 0; i < 400; i++) {
    const [a] = pending(home);
    if (a) return a;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("nothing was asked");
}

test("while you're away, each held ask reaches your Slack workflow once, as flat text fields", async () => {
  const home = setUp("away");
  setAway(true, home);
  const held = hold(ask(), { home, pollMs: 5 });
  const a = await asked(home);
  const s = slack();
  assert.deepEqual((await slackTick(home, Date.now(), () => ({ title: "Add a refunds table" }), s.send)).sent, [a.id]);
  assert.equal(s.got[0].url, HOOK);
  const b = s.got[0].body;
  assert.deepEqual([b.headline, b.thread, b.wants, b.folder, b.ask], ["billing wants to run a command", "Add a refunds table", "npm run migrate", "/w/billing", a.id]);
  assert.ok(Object.values(b).every((v) => typeof v === "string"), "Slack's webhook trigger takes only text");
  await slackTick(home, Date.now(), () => ({}), s.send);
  assert.equal(s.got.length, 1, "one message per ask");
  answer(a.id, "allow", undefined, home);
  assert.equal((await held).by, "page", "you answer when you're back");
});

test("a message Slack didn't take is tried again on the next pass", async () => {
  const home = setUp("retry");
  setAway(true, home);
  void hold(ask(), { home, pollMs: 5 });
  const a = await asked(home);
  const r = await slackTick(home, Date.now(), () => ({}), async () => {
    throw new Error("Slack said 500");
  });
  assert.deepEqual([r.sent, r.failed], [[], "Slack said 500"]);
  const s = slack();
  assert.deepEqual((await slackTick(home, Date.now(), () => ({}), s.send)).sent, [a.id]);
  setAway(false, home);
});

test("being away holds asks for Slack, but not when the webhook isn't a Slack address", async () => {
  const home = setUp("bad", { webhook: "https://example.com/hook" });
  setAway(true, home);
  assert.equal((await hold(ask(), { home })).by, "terminal-mode");
});

test("a terminal answered on the desk tells Slack only after its ask has waited a while", async () => {
  const home = setUp("after");
  setMode("billing", "desk", home);
  void hold(ask(), { home, pollMs: 5 });
  const a = await asked(home);
  const s = slack();
  assert.equal((await slackTick(home, a.at + 60_000, () => ({}), s.send)).sent.length, 0);
  assert.deepEqual((await slackTick(home, a.at + 301_000, () => ({}), s.send)).sent, [a.id]);
  answer(a.id, "deny", undefined, home);
});

test("the Slack test posts one message and says how to check it", async () => {
  const s = slack();
  const r = await slackTest(setUp("test"), s.send);
  assert.equal(r.ok, true);
  assert.equal(s.got.length, 1);
  assert.match((await slackTest(tmp("none"))).lines[0], /Slack isn't set up/);
});

test("on the desk, 'I'm away' with Slack set up posts held asks by itself and says Slack only tells you", async () => {
  const home = setUp("server");
  const s = slack();
  const desk = await startDesk({ home, port: 0, teamsEveryMs: 20, learnEveryMs: 3_600_000, slackPost: s.send });
  try {
    const base = desk.url.replace(/\/$/, "");
    const h = { "x-desk-token": desk.token, "content-type": "application/json" };
    assert.equal((await fetch(`${base}/api/away`, { method: "POST", headers: h, body: JSON.stringify({ on: true }) })).status, 200);
    const held = hold(ask(), { home, pollMs: 5 });
    const a = await asked(home);
    let st: { teams: { to: string; answers: boolean; sent: string[] } };
    do st = await (await fetch(`${base}/api/state?wait=0`, { headers: h })).json();
    while (!st.teams.sent.includes(a.id));
    assert.deepEqual([st.teams.to, st.teams.answers, s.got.length], ["Slack", false, 1]);
    answer(a.id, "allow", undefined, home);
    assert.equal((await held).by, "page");
  } finally {
    await desk.close();
  }
});

// Slack set up with answers by mail: the workflow's Outlook step, played by a mailbox.
function withMail(name: string) {
  const home = setUp(name, { replies: "outlook", me: "jack@corp.example" });
  const box: Mail[] = [];
  const read: ReadMail = async (only) => box.splice(0).filter((m) => !only || m.subject.includes(` ${only} `));
  return { home, box, read };
}

test("your answer on Slack comes back as a mail to yourself, and is what Copilot gets", async () => {
  const { home, box, read } = withMail("mail");
  setAway(true, home);
  const held = hold(ask(), { home, pollMs: 5 });
  const a = await asked(home);
  const s = slack();
  await slackTick(home, Date.now(), () => ({}), s.send);
  const { nonce } = s.got[0].body;
  box.push({ subject: `af-desk ${a.id} ${nonce} Deny`, body: "use the staging database\r\n", from: "Jack@Corp.example" });
  const r = await slackReplies(home, Date.now(), read);
  assert.deepEqual(r.answered.map((x) => [x.ask, x.choice]), [[a.id, "deny"]]);
  const h = await held;
  assert.deepEqual([h.output, h.by, h.who], [{ behavior: "deny", message: "Denied from the desk: use the staging database" }, "slack", "Jack@Corp.example"]);
});

test("a mail from someone else, with the wrong code, an unknown choice or after you answered changes nothing", async () => {
  const { home, box, read } = withMail("strangers");
  setAway(true, home);
  const held = hold(ask(), { home, pollMs: 5 });
  const a = await asked(home);
  const s = slack();
  await slackTick(home, Date.now(), () => ({}), s.send);
  const { nonce } = s.got[0].body;
  box.push(
    { subject: `af-desk ${a.id} ${nonce} Allow`, body: "", from: "someone@corp.example" },
    { subject: `af-desk ${a.id} guessed Allow`, body: "", from: "jack@corp.example" },
    { subject: `af-desk ${a.id} ${nonce} Maybe`, body: "", from: "jack@corp.example" },
  );
  const r = await slackReplies(home, Date.now(), read);
  assert.deepEqual(r.ignored.map((x) => x.why), ["sent by someone@corp.example, not jack@corp.example", "not a message the desk sent", "no such answer: maybe"]);
  answer(a.id, "allow", undefined, home);
  assert.equal((await held).by, "page");
  await slackTick(home, Date.now(), () => ({}), s.send);
  box.push({ subject: `af-desk ${a.id} ${nonce} Allow from now on`, body: "", from: "jack@corp.example" });
  assert.equal((await slackReplies(home, Date.now(), read)).answered.length, 0, "nothing waits for it any more, so the mailbox isn't even read");
});

test("the Slack test with answers by mail waits for your answer and checks who sent it", async () => {
  const { home, read, box } = withMail("mail-test");
  const s = slack();
  const reply = (from: string) => async () => {
    const b = s.got.at(-1)!.body;
    box.push({ subject: `af-desk ${b.ask} ${b.nonce} Allow`, body: "", from });
  };
  const ok = await slackTest(home, s.send, { read, sleep: reply("jack@corp.example"), waitMs: 60_000 });
  assert.equal(ok.ok, true, ok.lines.join("\n"));
  const wrong = await slackTest(home, s.send, { read, sleep: reply("someone@corp.example"), waitMs: 60_000 });
  assert.match(wrong.lines.join("\n"), /slack.me is jack@corp.example/);
});
