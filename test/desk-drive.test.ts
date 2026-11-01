// Sessions the desk drives: Copilot CLI over ACP, started, prompted, stopped and answered
// from the desk or from a window attached to it. Copilot here is the demo's stand-in,
// which speaks ACP the same way (src/desk/demo-copilot.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { attach } from "../src/desk/attach.ts";
import { choicesIn, Driver, readDriven } from "../src/desk/driven.ts";
import { pageFile, readJson, rulesFile, writeJson, type Rule } from "../src/desk/hold.ts";
import { ensureRepo, recordProposals } from "../src/desk/knowledge.ts";
import { toLearn } from "../src/desk/learn.ts";
import { readLog } from "../src/desk/log.ts";
import { terminals } from "../src/desk/mcp.ts";
import { send, waiting } from "../src/desk/notes.ts";
import { startDesk } from "../src/desk/server.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const FAKE = path.join(ROOT, "src", "desk", "demo-copilot.mjs");
const HOOK = path.join(ROOT, "src", "desk", "hook.ts");
const tmp = (n: string) => fs.mkdtempSync(path.join(os.tmpdir(), `af-drive-${n}-`));

type Sent = { method?: string; id?: number; params?: Record<string, unknown>; result?: Record<string, unknown> };

function setup(name: string, env: Record<string, string> = {}) {
  const home = tmp(name);
  const work = path.join(home, "work", "billing");
  fs.mkdirSync(path.join(work, ".git"), { recursive: true });
  const fakeLog = path.join(home, "fake.log");
  delete process.env.FAKE_STUCK;
  Object.assign(process.env, { FAKE_LOG: fakeLog }, env);
  writeJson(path.join(home, "config.json"), { knowledgeDir: path.join(home, "knowledge"), learn: "off" });
  const d = new Driver({ home, copilot: FAKE, stopGraceMs: 400 });
  const until = async (ok: () => boolean, what: string, ms = 8000) => {
    const t = Date.now();
    while (!ok()) {
      if (Date.now() - t > ms) assert.fail(`waited for ${what}: ${JSON.stringify(d.list().map((v) => ({ ...v, items: v.items.map((i) => `${i.type}:${i.status ?? ""}:${i.text}`) })), null, 1)}`);
      await d.next(100);
    }
  };
  const got = (): Sent[] => {
    try {
      return fs.readFileSync(fakeLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Sent);
    } catch {
      return [];
    }
  };
  const prompts = () => got().filter((m) => m.method === "session/prompt").map((m) => m.params!.prompt as Array<{ type: string; text?: string; resource?: { text: string } }>);
  const state = (n = "b") => d.get(n)!.state;
  const items = (n = "b") => d.get(n)!.items.map((i) => `${i.type}:${i.status ?? ""}:${i.text}`);
  return { home, work, d, until, got, prompts, state, items };
}

test("a session the desk starts streams its answer, and is done until you've seen it", async (t) => {
  const { home, work, d, until, state, items } = setup("start");
  t.after(() => d.shutdown());
  await d.start("b", work, "hello");
  await until(() => state() === "done", "done");
  assert.deepEqual(items(), ["you::hello", "plan::✓ say hello", "agent::Hello from fake", "end::end_turn"], "chunks of one message join; a plan updates in place");
  d.seen("b");
  assert.equal(state(), "idle");
  const log = readLog(home);
  assert.deepEqual(log.map((e) => [e.event, e.terminal, e.kind]), [["sessionStart", "b", undefined], ["notification", "b", "agent_idle"]]);
  assert.equal(log[0].session, d.get("b")!.session);
  await assert.rejects(d.start("b", work), /already a session named b/);
  await assert.rejects(d.start("bad name", work), /a name is letters/);
});

test("Copilot's permission ask waits for you, and the option you pick is what Copilot gets", async (t) => {
  const { home, work, d, until, got, state, items } = setup("ask");
  t.after(() => d.shutdown());
  await d.start("b", work);
  d.prompt("b", "run npm test");
  await until(() => d.get("b")!.asks.length === 1, "an ask");
  const [ask] = d.get("b")!.asks;
  assert.equal(state(), "waiting on you");
  assert.equal(ask.kind, "permission");
  assert.ok(ask.kind === "permission" && ask.command === "npm test" && ask.tool === "execute");
  assert.deepEqual(ask.kind === "permission" && ask.options.map((o) => o.name), ["Allow once", "Always allow", "Reject"]);
  d.answer("b", ask.id, { option: "once" });
  await until(() => state() === "done", "done");
  assert.ok(items().includes("agent::ran npm test"));
  assert.ok(items().includes("ask:Allow once:npm test"));
  const reply = got().find((m) => m.id !== undefined && !m.method && (m.result as { outcome?: unknown })?.outcome);
  assert.deepEqual(reply?.result, { outcome: { outcome: "selected", optionId: "once" } });
  const decision = readLog(home).find((e) => e.event === "decision");
  assert.equal(decision?.by, "page");
  assert.equal(decision?.choice, "allow");
  assert.throws(() => d.answer("b", ask.id, { option: "once" }), /that ask is gone/);
});

test("a standing answer lets the same command through without asking, and never a chained one", async (t) => {
  const { home, work, d, until, state, items } = setup("always");
  t.after(() => d.shutdown());
  await d.start("b", work);
  d.prompt("b", "run npm test");
  await until(() => d.get("b")!.asks.length === 1, "an ask");
  d.answer("b", d.get("b")!.asks[0].id, { always: true });
  await until(() => state() === "done", "done");
  assert.deepEqual(readJson<Rule[]>(rulesFile(home), []).map(({ at: _at, ...r }) => r), [{ terminal: "b", tool: "execute", prefix: "npm test" }]);
  d.prompt("b", "run npm test -w api");
  await until(() => state() === "done" && items().includes("agent::ran npm test -w api"), "allowed by the rule");
  assert.ok(items().includes("ask:allowed by your standing answer:npm test -w api"));
  d.prompt("b", "run npm test; rm -rf ~");
  await until(() => d.get("b")!.asks.length === 1, "the chained command asks");
  assert.equal(d.get("b")!.asks[0].kind === "permission" && d.get("b")!.asks[0].always, undefined, "no 'from now on' for a line that chains");
});

test("deny with a note rejects, stops the turn, and sends the note as your next prompt", async (t) => {
  const { work, d, until, state, prompts } = setup("deny");
  t.after(() => d.shutdown());
  await d.start("b", work);
  d.prompt("b", "run rm -rf build");
  await until(() => d.get("b")!.asks.length === 1, "an ask");
  d.answer("b", d.get("b")!.asks[0].id, { deny: true, note: "use npm run clean" });
  await until(() => prompts().length === 2 && state() === "done", "the note sent");
  assert.equal(prompts()[1].at(-1)!.text, "About `rm -rf build`, which I didn't allow: use npm run clean");
});

test("Stop cancels the turn and every open ask, and drops the prompts waiting in line", async (t) => {
  const { work, d, until, got, state, items, prompts } = setup("stop");
  t.after(() => d.shutdown());
  await d.start("b", work);
  d.prompt("b", "slow");
  assert.deepEqual(d.prompt("b", "later"), { queued: true });
  await until(() => got().some((m) => m.method === "session/prompt"), "the turn running");
  d.stop("b");
  await until(() => state() === "idle", "stopped");
  assert.ok(got().some((m) => m.method === "session/cancel"));
  assert.ok(items().includes("you:not sent:later"));
  assert.ok(items().includes("end::cancelled"));
  d.prompt("b", "run make");
  await until(() => d.get("b")!.asks.length === 1, "an ask");
  d.stop("b");
  await until(() => state() === "idle" && d.get("b")!.asks.length === 0, "the ask cancelled");
  assert.ok(items().includes("ask:cancelled:make"));
  assert.equal(prompts().length, 2);
});

test("a prompt sent while a turn runs waits in line and goes when the turn ends", async (t) => {
  const { work, d, until, state, prompts } = setup("queue");
  t.after(() => d.shutdown());
  await d.start("b", work);
  d.prompt("b", "run npm test");
  await until(() => d.get("b")!.asks.length === 1, "an ask");
  assert.deepEqual(d.prompt("b", "hello"), { queued: true });
  assert.equal(prompts().length, 1);
  d.answer("b", d.get("b")!.asks[0].id, { option: "once" });
  await until(() => prompts().length === 2 && state() === "done", "the queued prompt");
  assert.deepEqual(prompts().map((p) => p.at(-1)!.text), ["run npm test", "hello"]);
});

test("a turn that won't stop is killed; the session sleeps, and the next prompt reloads it without repeating its history", async (t) => {
  const { work, d, until, got, state, items } = setup("stuck", { FAKE_STUCK: "1" });
  t.after(() => d.shutdown());
  await d.start("b", work);
  const session = d.get("b")!.session;
  d.prompt("b", "slow");
  await until(() => got().some((m) => m.method === "session/prompt"), "the turn running");
  d.stop("b");
  await until(() => state() === "asleep", "asleep");
  delete process.env.FAKE_STUCK;
  d.prompt("b", "hello");
  await until(() => state() === "done", "done");
  const load = got().find((m) => m.method === "session/load");
  assert.equal(load?.params?.sessionId, session);
  assert.equal(d.get("b")!.session, session);
  assert.ok(!items().some((i) => i.includes("REPLAYED")), "the history Copilot replays on load isn't shown twice");
});

test("the first prompt carries what's known about the repo and the notes that waited; later ones only new notes", async (t) => {
  const { home, work, d, until, state, prompts, items } = setup("context");
  t.after(() => d.shutdown());
  const dir = path.join(home, "knowledge");
  await ensureRepo(dir);
  recordProposals(dir, "billing", [{ scope: "repo", kind: "fact", subject: "test.command", text: "Run npm test -w api" }], { session: "s0", now: Date.now() });
  send("you", "b", "use the finance schema", { home });
  await d.start("b", work, "hello");
  await until(() => state() === "done", "done");
  send("web", "b", "renamed totalCents", { home });
  d.prompt("b", "again");
  await until(() => prompts().length === 2 && state() === "done", "done again");
  const [first, second] = prompts();
  assert.equal(first[0].type, "resource");
  assert.match(first[0].resource!.text, /Context from the user's desk[\s\S]*What earlier sessions learned about billing[\s\S]*npm test -w api[\s\S]*From the user \(sent from their desk\): use the finance schema/);
  assert.equal(first[1].text, "hello");
  assert.doesNotMatch(second[0].resource!.text, /What earlier sessions learned/);
  assert.match(second[0].resource!.text, /"web" terminal \(another agent, not the user/);
  assert.deepEqual(waiting(home), []);
  assert.ok(items().includes("note::your note: use the finance schema"));
});

test("a form Copilot sends is answered from the desk", async (t) => {
  const { work, d, until, state, items } = setup("form");
  t.after(() => d.shutdown());
  await d.start("b", work, "ask");
  await until(() => d.get("b")!.asks.length === 1, "the form");
  const [q] = d.get("b")!.asks;
  assert.ok(q.kind === "question" && q.message === "Which schema?" && q.required[0] === "schema");
  assert.throws(() => d.answer("b", q.id, { option: "x" }), /gone/);
  d.reply("b", q.id, "accept", { schema: "finance" });
  await until(() => state() === "done", "done");
  assert.ok(items().includes("agent::schema=finance"));
});

test("a reply that ends on a numbered list with a question offers its options as answers", async (t) => {
  assert.deepEqual(choicesIn("Which one?\n\n1. Billing\n2. **Finance**\n"), ["Billing", "Finance"]);
  assert.deepEqual(choicesIn("Would you like me to:\n1. add tests\n2. stop here\n\nLet me know."), ["add tests", "stop here"]);
  assert.deepEqual(choicesIn("I changed:\n1. the form\n2. the tests\nAll green."), [], "a list followed by a statement isn't a question");
  assert.deepEqual(choicesIn("Done.\n1. a\n3. b?"), [], "numbers out of order");
  assert.deepEqual(choicesIn("1. only one?"), []);
  const { work, d, until, state } = setup("choices");
  t.after(() => d.shutdown());
  await d.start("b", work, "options");
  await until(() => state() === "done", "done");
  assert.deepEqual(d.get("b")!.choices, ["Billing", "Finance"]);
});

test("mode and model change through the settings Copilot offers", async (t) => {
  const { work, d, got } = setup("settings");
  t.after(() => d.shutdown());
  await d.start("b", work);
  assert.equal(d.get("b")!.config![0].currentValue, "m1");
  await d.setOption("b", "model", "m2");
  await d.setOption("b", "mode", "plan");
  assert.equal(d.get("b")!.config![0].currentValue, "m2");
  assert.equal(d.get("b")!.modes!.currentModeId, "plan");
  await assert.rejects(d.setOption("b", "mode", "yolo"), /modes: agent, plan/);
  await assert.rejects(d.setOption("b", "colour", "red"), /no setting colour/);
  assert.deepEqual(got().filter((m) => m.method?.startsWith("session/set")).map((m) => m.method), ["session/set_config_option", "session/set_mode"]);
});

test("a Copilot that dies shows why, and the next prompt starts it again on the same session", async (t) => {
  const { work, d, until, state, got } = setup("crash");
  t.after(() => d.shutdown());
  await d.start("b", work);
  d.prompt("b", "crash");
  await until(() => state() === "failed", "failed");
  assert.match(d.get("b")!.error!, /exited with code 3: boom/);
  d.prompt("b", "hello");
  await until(() => state() === "done", "done");
  assert.ok(got().some((m) => m.method === "session/load"));
});

test("a Copilot that can't start leaves the session failed, saying why", async (t) => {
  const home = tmp("missing");
  const d = new Driver({ home, copilot: path.join(home, "no-copilot-here") });
  t.after(() => d.shutdown());
  await assert.rejects(d.start("b", home), /ENOENT|not found/);
  assert.equal(d.get("b")!.state, "failed");
  assert.match(d.get("b")!.error!, /ENOENT|not found/);
});

test("closing ends the session in the log, so learning reads it", async (t) => {
  const { home, work, d } = setup("close");
  t.after(() => d.shutdown());
  await d.start("b", work);
  await d.close("b");
  assert.equal(d.get("b")!.state, "closed");
  const end = readLog(home).find((e) => e.event === "sessionEnd");
  assert.equal(end?.terminal, "b");
  assert.deepEqual(toLearn(readLog(home), path.join(home, "knowledge")).map((x) => x.session), [d.get("b")!.session]);
  assert.throws(() => d.prompt("b", "hi"), /closed; start a new session/);
});

test("handed to Copilot's own screen, the desk won't drive it until it's given back", async (t) => {
  const { work, d, until, state } = setup("handoff");
  t.after(() => d.shutdown());
  await d.start("b", work);
  d.prompt("b", "slow");
  await until(() => state() === "working", "working");
  assert.throws(() => d.handoff("b"), /working: stop it first/);
  d.stop("b");
  await until(() => state() === "idle", "stopped");
  const h = d.handoff("b");
  assert.equal(h.session, d.get("b")!.session);
  assert.equal(state(), "in its own screen");
  assert.throws(() => d.prompt("b", "hi"), /open in Copilot's own screen/);
  d.back("b");
  assert.equal(state(), "asleep");
  d.prompt("b", "hello");
  await until(() => state() === "done", "driven again");
});

test("sessions outlive the desk: the next desk finds them asleep, with their conversation", async () => {
  const { home, work, d, until, state } = setup("restart");
  await d.start("b", work, "hello");
  await until(() => state() === "done", "done");
  d.shutdown();
  const again = new Driver({ home, copilot: FAKE });
  assert.equal(again.get("b")!.state, "asleep");
  assert.ok(again.get("b")!.items.some((i) => i.text === "Hello from fake"));
  assert.deepEqual(readDriven(home).map((r) => r.name), ["b"]);
  assert.deepEqual(terminals(home).map((x) => [x.name, x.state]), [["b", "asleep"]], "the desk's MCP tools see it as an open terminal");
  again.shutdown();
});

test("the hook leaves a driven session to the desk: nothing recorded or held, notes still handed over", () => {
  const home = tmp("hook");
  writeJson(pageFile(home), { at: Date.now() });
  const env = { ...process.env, AF_DESK_HOME: home, AF_DESK_DRIVEN: "1", AF_DESK_TERMINAL: "b" };
  const run = (event: string, input: object) => spawnSync(process.execPath, ["--no-warnings", HOOK, event], { input: JSON.stringify(input), env, encoding: "utf8", timeout: 10_000 });
  const ask = run("permissionRequest", { sessionId: "s1", cwd: "/w/b", toolName: "shell", toolInput: { command: "npm test" } });
  assert.equal(ask.status, 0);
  assert.equal(ask.stdout, "", "Copilot asks the desk over ACP instead");
  assert.equal(run("sessionStart", { sessionId: "s1", cwd: "/w/b" }).stdout, "");
  assert.deepEqual(readLog(home), []);
  send("you", "b", "check the schema", { home });
  assert.match(JSON.parse(run("postToolUse", { sessionId: "s1", cwd: "/w/b" }).stdout).additionalContext, /check the schema/);
});

test("the page drives a session with its token, and shows it apart from the hooked terminals", async (t) => {
  const { home, work } = setup("server");
  const opened: string[] = [];
  const desk = await startDesk({ home, port: 0, copilot: FAKE, analyst: async () => "{}", learnEveryMs: 3_600_000, window: async (name) => (opened.push(name), true) });
  t.after(() => desk.close());
  const post = (p: string, body: object, token = desk.token) => fetch(new URL(p, desk.url), { method: "POST", headers: { "x-desk-token": token, "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post("/api/drive/start", { name: "b", cwd: work }, "x".repeat(48))).status, 403);
  const started = await post("/api/drive/start", { name: "b", cwd: work, prompt: "hello" });
  assert.equal(started.status, 200);
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 80 && !ok(); i++) await desk.drive.next(100);
    assert.ok(ok());
  };
  await until(() => desk.drive.get("b")?.state === "done");
  const state = await (await fetch(new URL("/api/state?wait=0", desk.url), { headers: { "x-desk-token": desk.token } })).json();
  assert.equal(state.driven[0].name, "b");
  assert.equal(state.driven[0].repo, "billing");
  assert.ok(state.driven[0].items.some((i: { text: string }) => i.text === "Hello from fake"));
  assert.ok(state.folders.includes(work));
  assert.equal(state.terminals.length, 0, "its own log rows aren't a second terminal");
  assert.equal(readJson<{ token?: string }>(pageFile(home), {}).token, desk.token, "attached windows find the token where only you can read it");
  const bad = await post("/api/drive/prompt", { name: "nope", text: "hi" });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /no session named nope/);
  assert.equal((await post("/api/drive/window", { name: "b" })).status, 200);
  assert.deepEqual(opened, ["b"]);
  const watch = await (await fetch(new URL("/api/drive/watch?name=b&rev=0&wait=0", desk.url), { headers: { "x-desk-token": desk.token } })).json();
  assert.ok(watch.items.length >= 4);
  assert.equal(watch.view.state, "done");
});

test("a window attached to a session sends what you type, answers its asks, and hands it to Copilot's own screen", async (t) => {
  const { home, work } = setup("attach");
  const desk = await startDesk({ home, port: 0, copilot: FAKE, analyst: async () => "{}", learnEveryMs: 3_600_000 });
  t.after(() => desk.close());
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = "";
  output.on("data", (c: Buffer) => (shown += c.toString()));
  const screens: Array<{ args: string[]; name: string }> = [];
  const ended = attach("w", work, { home, input, output, screen: async (args, _cwd, name) => (screens.push({ args, name }), 0) });
  const until = async (ok: () => boolean, what: string) => {
    for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(ok(), `${what}:\n${shown}`);
  };
  await until(() => desk.drive.get("w")?.state === "idle", "started in this folder");
  assert.equal(desk.drive.get("w")!.cwd, work);
  input.write("hello\n");
  await until(() => shown.includes("Hello from fake"), "the answer");
  input.write("run npm test\n");
  await until(() => shown.includes("── w asks: npm test") && shown.includes("1  Allow once"), "the ask");
  input.write("1\n");
  await until(() => shown.includes("ran npm test"), "allowed from the window");
  input.write("options\n");
  await until(() => shown.includes("reply with a number"), "the options");
  input.write("2\n");
  await until(() => desk.drive.get("w")!.items.some((i) => i.type === "you" && i.text === "2. Finance"), "an option by its number");
  await until(() => desk.drive.get("w")!.state === "done", "done");
  input.write("/model m2\n");
  await until(() => desk.drive.get("w")!.config?.[0].currentValue === "m2", "the model");
  input.write("/tui\n");
  await until(() => screens.length === 1 && desk.drive.get("w")!.state === "asleep", "Copilot's own screen, and back");
  assert.deepEqual(screens[0], { args: ["--resume", desk.drive.get("w")!.session], name: "w" });
  input.write("/quit\n");
  assert.equal(await ended, "detached");
  assert.equal(desk.drive.get("w")!.state, "asleep", "the session stays on the desk");
});

test("with no desk running, attach says so, so the launcher can start Copilot's own screen instead", async () => {
  const home = tmp("nodesk");
  assert.equal(await attach("w", home, { home, input: new PassThrough(), output: new PassThrough() }), "no-desk");
});
