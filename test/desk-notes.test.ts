// Notes between terminals: sent from the desk, the command line or another session's
// send_note tool, handed to a working session after its next tool call, marked with
// whose words they are, and never a way to start work.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { installMcp, mcpConfigFile, uninstallMcp } from "../src/desk/install.ts";
import { append } from "../src/desk/log.ts";
import { deskTools, whoAmI } from "../src/desk/mcp.ts";
import { claim, recent, renderNotes, send, waiting } from "../src/desk/notes.ts";
import { startDesk } from "../src/desk/server.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const HOOK = path.join(ROOT, "src", "desk", "hook.ts");
const MCP = path.join(ROOT, "src", "desk", "mcp.ts");
const tmp = (n: string) => fs.mkdtempSync(path.join(os.tmpdir(), `af-notes-${n}-`));
const open = (home: string, name: string, session = `s-${name}`) => append({ at: Date.now(), event: "sessionStart", session, cwd: `/w/${name}` }, home);
const hook = (home: string, event: string, input: object, env: Record<string, string> = {}) =>
  spawnSync(process.execPath, ["--no-warnings", HOOK, event], { input: JSON.stringify(input), env: { ...process.env, AF_DESK_HOME: home, ...env }, encoding: "utf8" });

test("a note goes to a named terminal or to every other open one, and to no terminal that isn't there", () => {
  const home = tmp("send");
  const known = ["billing", "web", "etl"];
  assert.equal(send("web", "billing", "renamed totalCents", { home, known }).length, 1);
  assert.deepEqual(send("web", "all", "heads up", { home, known }).map((n) => n.to).sort(), ["billing", "etl"]);
  assert.throws(() => send("web", "payroll", "x", { home, known }), /no terminal named payroll \(there are: billing, web, etl, you\)/);
  assert.throws(() => send("web", "web", "x", { home, known }), /that's this terminal/);
  assert.throws(() => send("web", "billing", "  ", { home, known }), /needs some text/);
  assert.equal(waiting(home).length, 3);
});

test("a session reads a note from you as yours, and one from another terminal as a colleague's request", () => {
  const text = renderNotes([{ id: "1", at: 0, from: "you", to: "billing", text: "use finance" }, { id: "2", at: 0, from: "web", to: "billing", text: "renamed a field" }], "billing");
  assert.match(text, /From the user \(sent from their desk\): use finance/);
  assert.match(text, /From the Copilot session in the "web" terminal \(another agent, not the user; weigh it as a colleague's request/);
  assert.match(text, /don't start new work because of a note unless the user asked for it/);
});

test("the hook hands a working session its notes after a tool call, once, and records nothing else per tool", () => {
  const home = tmp("hook");
  open(home, "billing");
  send("you", "billing", "use the finance schema", { home });
  send("you", "web", "not for billing", { home });
  const r = hook(home, "postToolUse", { sessionId: "s-billing", cwd: "/w/billing", toolName: "shell" });
  assert.equal(r.status, 0);
  assert.match(JSON.parse(r.stdout).additionalContext, /use the finance schema/);
  assert.doesNotMatch(r.stdout, /not for billing/);
  assert.equal(hook(home, "postToolUse", { sessionId: "s-billing", cwd: "/w/billing" }).stdout, "", "delivered once");
  const delivered = recent(home).find((n) => n.to === "billing")!;
  assert.equal(delivered.delivered?.session, "s-billing");
  assert.equal(fs.readFileSync(path.join(home, "events.jsonl"), "utf8").trim().split("\n").length, 1, "only the session start is in the log");
});

test("a new session gets the notes that waited for its terminal", () => {
  const home = tmp("start");
  send("you", "billing", "the e2e suite is flaky today", { home });
  const r = hook(home, "sessionStart", { sessionId: "s2", cwd: "/w/billing" });
  assert.match(JSON.parse(r.stdout).additionalContext, /e2e suite is flaky/);
});

test("harness turns and the desk's own runs are neither tracked nor handed notes", () => {
  const home = tmp("turn");
  send("you", "billing", "for the person's session only", { home });
  for (const env of [{ AF_TURN: "t1" }, { AF_DESK_QUIET: "1" }]) {
    const r = hook(home, "postToolUse", { sessionId: "turn", cwd: "/w/billing" }, env);
    assert.equal(r.stdout, "");
  }
  assert.equal(waiting(home).length, 1);
  assert.equal(fs.existsSync(path.join(home, "events.jsonl")), false);
});

test("a session's send_note and list_terminals see the other open terminals; the sender is the terminal it runs in", async () => {
  const home = tmp("tools");
  open(home, "billing");
  open(home, "web");
  assert.equal(whoAmI({ AF_DESK_TERMINAL: "web" }, "/x/y"), "web");
  assert.equal(whoAmI({}, "/w/etl"), "etl");
  const tools = deskTools("web", home);
  const list = (await tools.find((t) => t.name === "list_terminals")!.call({})) as { text: string };
  assert.match(list.text, /- web \(this terminal\)/);
  assert.match(list.text, /- billing: \/w\/billing; working/);
  await tools.find((t) => t.name === "send_note")!.call({ to: "billing", text: "renamed totalCents to total_cents" });
  assert.deepEqual(waiting(home).map((n) => [n.from, n.to]), [["web", "billing"]]);
  await assert.rejects(async () => tools.find((t) => t.name === "send_note")!.call({ to: "payroll", text: "x" }), /no terminal named payroll/);
});

test("the MCP server answers over stdio, and serves nothing inside a harness turn", async () => {
  const home = tmp("stdio");
  open(home, "billing");
  const talk = (env: Record<string, string>) => new Promise<Array<{ id: number; result: any }>>((resolve) => {
    const p = spawn(process.execPath, ["--no-warnings", MCP], { env: { ...process.env, AF_DESK_HOME: home, AF_DESK_TERMINAL: "web", ...env } });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "send_note", arguments: { to: "billing", text: "hello" } } }) + "\n");
    setTimeout(() => { p.kill(); resolve(out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))); }, 1500);
  });
  const r = await talk({});
  assert.deepEqual(r[1].result.tools.map((t: { name: string }) => t.name), ["list_terminals", "send_note"]);
  assert.match(r[2].result.content[0].text, /Sent to billing/);
  const inTurn = await talk({ AF_TURN: "t1" });
  assert.deepEqual(inTurn[1].result.tools, []);
});

test("install adds the desk's tools to your Copilot MCP config and keeps your other servers", () => {
  const home = tmp("mcpcfg");
  const file = mcpConfigFile({ COPILOT_HOME: home });
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { mine: { type: "local", command: "x" } } }));
  installMcp(MCP, file);
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(cfg.mcpServers).sort(), ["af-desk", "mine"]);
  assert.deepEqual(cfg.mcpServers["af-desk"].args, ["--no-warnings", MCP]);
  assert.equal(uninstallMcp(file), true);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers), ["mine"]);
  fs.writeFileSync(file, "{ not json");
  assert.throws(() => installMcp(MCP, file), /isn't valid JSON/);
  assert.equal(fs.readFileSync(file, "utf8"), "{ not json", "a broken config is left as it was");
});

test("on the desk you send a terminal a note and mark a note to you as read", async () => {
  const home = tmp("server");
  open(home, "billing");
  send("billing", "you", "needs finance sign-off", { home });
  const desk = await startDesk({ home, port: 0, learnEveryMs: 60_000 });
  try {
    const base = desk.url.replace(/\/$/, "");
    const h = { "x-desk-token": desk.token, "content-type": "application/json" };
    let s = await (await fetch(`${base}/api/state?wait=0`, { headers: h })).json();
    assert.deepEqual(s.forYou.map((n: { text: string }) => n.text), ["needs finance sign-off"]);
    assert.equal((await fetch(`${base}/api/read`, { method: "POST", headers: h, body: JSON.stringify({ note: s.forYou[0].id }) })).status, 200);
    assert.equal((await fetch(`${base}/api/note`, { method: "POST", headers: h, body: JSON.stringify({ to: "billing", text: "use finance" }) })).status, 200);
    assert.equal((await fetch(`${base}/api/note`, { method: "POST", headers: h, body: JSON.stringify({ to: "nobody", text: "x" }) })).status, 400);
    s = await (await fetch(`${base}/api/state?wait=0`, { headers: h })).json();
    assert.deepEqual(s.forYou, []);
    assert.deepEqual(s.threads[0].notes.map((n: { from: string; text: string }) => [n.from, n.text]), [["you", "use finance"], ["billing", "needs finance sign-off"]]);
    assert.equal(claim("billing", "s-billing", { home }).length, 1);
  } finally {
    await desk.close();
  }
});
