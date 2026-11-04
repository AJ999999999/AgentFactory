// Asks on Teams while you're away: the desk writes a card to a OneDrive folder, a flow in
// Teams posts it and writes your tap back, and the desk answers with it. The flow is
// played here by writing the file it would write.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { answer, hold, modesFile, pageFile, pending, readJson, setAway, setMode, writeJson } from "../src/desk/hold.ts";
import type { DeskEvent } from "../src/desk/log.ts";
import { startDesk } from "../src/desk/server.ts";
import { teamsTest, teamsTick } from "../src/desk/teams.ts";

const ME = "jack@corp.example";
const tmp = (n: string) => fs.mkdtempSync(path.join(os.tmpdir(), `af-teams-${n}-`));
const ask = (over: Partial<DeskEvent> = {}): DeskEvent => ({ at: Date.now(), event: "permissionRequest", session: "s1", cwd: "/w/billing", tool: "shell", detail: '{"command":"npm run migrate"}', ...over });

// A desk that's running, with Teams set up to a OneDrive folder of its own.
function setUp(name: string, teams: Record<string, unknown> = {}) {
  const home = tmp(name);
  const folder = path.join(tmp(`${name}-onedrive`), "af-desk");
  writeJson(path.join(home, "config.json"), { teams: { folder, me: ME, ...teams } });
  writeJson(pageFile(home), { at: Date.now() });
  return { home, folder };
}

async function asked(home: string) {
  for (let i = 0; i < 400; i++) {
    const [a] = pending(home);
    if (a) return a;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("nothing was asked");
}

type Card = { body: Array<{ text?: string; fontType?: string }>; actions: Array<{ title: string; data?: Record<string, string>; card?: { actions: Array<{ data: Record<string, string> }> } }> };
const cardOf = (folder: string, id: string): Card => JSON.parse(fs.readFileSync(path.join(folder, "out", `${id}.json`), "utf8"));
const button = (c: Card, title: string) => {
  const a = c.actions.find((x) => x.title === title);
  return a?.data ?? a?.card?.actions[0].data ?? {};
};
// What the flow writes to `in` once you tap: the card's whole response.
const tap = (folder: string, id: string, who: string, data: Record<string, string>) =>
  writeJson(path.join(folder, "in", `${id}.json`), { responseTime: new Date().toISOString(), responder: { userPrincipalName: who, displayName: "Jack" }, submitActionId: "", data });

test("while you're away, any terminal's ask goes to Teams as a card, and your tap there is what Copilot gets", async () => {
  const { home, folder } = setUp("away");
  setAway(true, home);
  const held = hold(ask(), { home, pollMs: 5 }, "npm run migrate");
  const a = await asked(home);

  const sent = teamsTick(home, Date.now(), () => ({ title: "Add a refunds table", doing: "Running the migration" }));
  assert.deepEqual(sent.sent, [a.id]);
  const c = cardOf(folder, a.id);
  assert.match(c.body[0].text ?? "", /billing wants to run a command/);
  assert.ok(c.body.some((b) => b.fontType === "Monospace" && b.text === "npm run migrate"), "the command as it would run");
  assert.ok(c.body.some((b) => b.text === "Add a refunds table"), "which thread it is");
  assert.deepEqual(c.actions.map((x) => x.title), ["Allow", 'Allow "npm run …" in billing from now on', "Deny…", "Answer in the terminal"]);
  assert.equal(teamsTick(home).sent.length, 0, "one card per ask");

  tap(folder, a.id, "Jack@Corp.example", button(c, "Allow"));
  const back = teamsTick(home);
  assert.deepEqual(back.answered.map((x) => [x.ask, x.choice]), [[a.id, "allow"]]);
  const r = await held;
  assert.deepEqual([r.output, r.by, r.who], [{ behavior: "allow" }, "teams", "Jack@Corp.example"]);

  teamsTick(home);
  assert.deepEqual(fs.readdirSync(path.join(folder, "out")), [], "the card's file goes once the ask is settled");
  assert.deepEqual(fs.readdirSync(path.join(folder, "in")), [], "and so does the tap");
});

test("a Deny on Teams carries what you typed back to Copilot", async () => {
  const { home, folder } = setUp("deny");
  setAway(true, home);
  const held = hold(ask(), { home, pollMs: 5 });
  const a = await asked(home);
  teamsTick(home);
  tap(folder, a.id, ME, { ...button(cardOf(folder, a.id), "Deny…"), reason: "use the staging database" });
  teamsTick(home);
  assert.deepEqual((await held).output, { behavior: "deny", message: "Denied from the desk: use the staging database" });
});

test("a tap from another account, with the wrong code, or after the ask was answered on the page changes nothing", async () => {
  const { home, folder } = setUp("strangers");
  setAway(true, home);
  const held = hold(ask(), { home, pollMs: 5 });
  const a = await asked(home);
  teamsTick(home);
  const allow = button(cardOf(folder, a.id), "Allow");

  tap(folder, a.id, "someone@corp.example", allow);
  assert.match(teamsTick(home).ignored[0].why, /tapped by someone@corp.example/);
  tap(folder, a.id, ME, { ...allow, nonce: "guessed" });
  assert.match(teamsTick(home).ignored[0].why, /not a card the desk sent/);
  writeJson(path.join(folder, "in", `${a.id}.json`), { data: allow });
  assert.match(teamsTick(home).ignored[0].why, /didn't say who tapped/);
  assert.equal(pending(home).length, 1, "still waiting for you");

  answer(a.id, "deny", "not now", home);
  assert.equal((await held).by, "page");
  tap(folder, a.id, ME, allow);
  const late = teamsTick(home);
  assert.deepEqual([late.answered.length, late.ignored[0].why], [0, "already answered, or no longer waiting"]);
  assert.deepEqual(fs.readdirSync(path.join(folder, "out")), [], "the card for an ask settled elsewhere is taken back");
});

test("coming back hands an ask held only because you were away back to its terminal", async () => {
  const { home } = setUp("back");
  setAway(true, home);
  const held = hold(ask(), { home, pollMs: 5 });
  await asked(home);
  setAway(false, home);
  const r = await held;
  assert.deepEqual([r.output, r.by], [{}, "back"]);
});

test("a terminal you answer on the desk sends its ask to Teams only after it has waited there a while", async () => {
  const { home, folder } = setUp("after", { afterSec: 300 });
  setMode("billing", "desk", home);
  const held = hold(ask(), { home, pollMs: 5 });
  const a = await asked(home);
  assert.equal(teamsTick(home, a.at + 60_000).sent.length, 0, "you may still be at the desk");
  assert.deepEqual(teamsTick(home, a.at + 301_000).sent, [a.id]);
  tap(folder, a.id, ME, button(cardOf(folder, a.id), "Answer in the terminal"));
  teamsTick(home);
  assert.deepEqual([(await held).by, (await held).who], ["terminal", ME]);
});

test("being away holds nothing until Teams is set up", async () => {
  const home = tmp("no-teams");
  writeJson(pageFile(home), { at: Date.now() });
  setAway(true, home);
  assert.equal((await hold(ask(), { home })).by, "terminal-mode");
  assert.deepEqual(teamsTick(home), { sent: [], answered: [], ignored: [] });
});

test("choosing 'here' for one terminal holds its asks even though asks go to the terminal by default", async () => {
  const home = tmp("mode");
  writeJson(pageFile(home), { at: Date.now() });
  setMode("billing", "desk", home);
  assert.deepEqual(readJson(modesFile(home), {}), { billing: "desk" });
  const held = hold(ask(), { home, pollMs: 5 });
  answer((await asked(home)).id, "allow", undefined, home);
  assert.equal((await held).by, "page");
  setMode("billing", "terminal", home);
  assert.deepEqual(readJson(modesFile(home), {}), {}, "back to the default, nothing kept");
  assert.equal((await hold(ask(), { home })).by, "terminal-mode");
});

test("the test card checks the flow end to end: who tapped, and that the tap carries what the button did", async () => {
  const { home, folder } = setUp("test-card");
  // The flow, played by the first wait: tap Allow on whatever card it finds.
  const flow = (who: string) => async () => {
    const out = path.join(folder, "out");
    for (const f of fs.readdirSync(out)) tap(folder, f.replace(/\.json$/, ""), who, button(JSON.parse(fs.readFileSync(path.join(out, f), "utf8")), "Allow"));
  };
  const ok = await teamsTest(home, { sleep: flow(ME), waitMs: 60_000 });
  assert.equal(ok.ok, true, ok.lines.join("\n"));
  assert.match(ok.lines.at(-1) ?? "", /It works/);
  const wrong = await teamsTest(home, { sleep: flow("someone@corp.example"), waitMs: 60_000 });
  assert.equal(wrong.ok, false);
  assert.match(wrong.lines.join("\n"), /teams.me is jack@corp.example/);
  assert.deepEqual([fs.readdirSync(path.join(folder, "out")), fs.readdirSync(path.join(folder, "in"))], [[], []]);
});

test("on the desk, 'I'm away' sends asks to Teams by itself and a tap there settles them", async () => {
  const { home, folder } = setUp("server");
  const desk = await startDesk({ home, port: 0, teamsEveryMs: 20, learnEveryMs: 3_600_000 });
  try {
    const base = desk.url.replace(/\/$/, "");
    const h = { "x-desk-token": desk.token, "content-type": "application/json" };
    assert.equal((await fetch(`${base}/api/away`, { method: "POST", headers: h, body: JSON.stringify({ on: true }) })).status, 200);
    const held = hold(ask(), { home, pollMs: 5 });
    const a = await asked(home);
    let st: { teams: { away: number | null; sent: string[] } };
    do st = await (await fetch(`${base}/api/state?wait=0`, { headers: h })).json();
    while (!st.teams.sent.includes(a.id));
    assert.ok(st.teams.away, "the page shows you're away");
    tap(folder, a.id, ME, button(cardOf(folder, a.id), "Allow"));
    assert.equal((await held).by, "teams");
  } finally {
    await desk.close();
  }
});
