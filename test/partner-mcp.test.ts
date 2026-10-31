// The partner's tools over MCP, for a normal Copilot or Claude Code session: status, the
// questions waiting, answers, new work, pause. Never a turn's tool.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createWorkspace } from "../src/foundation/workspace.ts";
import { CopilotTurnAgent } from "../src/harness/agents.ts";
import type { TurnAgent } from "../src/harness/agents.ts";
import { Harness } from "../src/harness/harness.ts";
import { partnerFolders } from "../src/harness/mcp.ts";
import { loadPolicy } from "../src/harness/project.ts";
import type { EngagementDef } from "../src/harness/types.ts";
import { SystemClock } from "../src/harness/world.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const SERVER = path.join(ROOT, "src", "harness", "mcp.ts");
const policy = loadPolicy(path.join(ROOT, "policy", "harness.json"));
const tmp = (n: string) => fs.mkdtempSync(path.join(os.tmpdir(), `af-pmcp-${n}-`));
const noTurns: TurnAgent = { name: "none", run: async () => ({ note: "unused" }) };

const def = (): EngagementDef => ({
  id: "shop", title: "A game for one boy", principals: { partner: "you", parent: "the parent" }, experts: ["parent"],
  goals: [{
    id: "g", title: "Game", objective: "A game he picks on his own", owner: "partner", scope: ["game"], budget: { turns: 10 },
    assumptions: [{ id: "A1", text: "He picks it on three days a week", category: "desirability", risk: 5, uncertainty: 5, loadBearing: true }],
    todos: [
      { id: "play", kind: "action", lane: "playtest", text: "Play it with him this week", assignee: "parent", tests: "A1" },
      { id: "core", lane: "build", text: "Build the core loop", writeScope: ["game"] },
    ],
  }],
});

async function workspace(): Promise<{ dir: string; h: Harness }> {
  const dir = tmp("ws");
  const home = path.join(dir, ".af", "harness", "shop");
  const control = await createWorkspace({ dir: home });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ repo: control.cwd, remote: path.join(home, "origin.git") }));
  const h = new Harness({ control, engagement: "shop", policy, clock: new SystemClock(), world: {}, agent: noTurns, worktreeRoot: path.join(home, "wt") });
  await h.open(def());
  return { dir, h };
}

// A client that talks to the server the way Copilot or Claude Code does.
function client(dir: string, env: NodeJS.ProcessEnv = {}, args = ["--dir", dir]) {
  const child = spawn(process.execPath, ["--no-warnings", SERVER, ...args], { cwd: dir, env: { ...process.env, AF_TURN: "", ...env }, stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
  let buf = "";
  const waiting = new Map<number, (v: any) => void>();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (s: string) => {
    buf += s;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      waiting.get(msg.id)?.(msg);
    }
  });
  let n = 0;
  const rpc = (method: string, params: unknown = {}) => new Promise<any>((resolve) => {
    const id = ++n;
    waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => (await rpc("tools/call", { name, arguments: args })).result as { content: Array<{ text: string }>; isError?: boolean; structuredContent?: { result: any } };
  return { rpc, call, close: () => child.kill() };
}

test("the partner's session sees what the firm is doing and what waits on them, and answers, adds work and pauses", async () => {
  const { dir, h } = await workspace();
  const c = client(dir);
  try {
    const init = await c.rpc("initialize", { protocolVersion: "2025-06-18" });
    assert.equal(init.result.serverInfo.name, "agentfactory");
    const names = (await c.rpc("tools/list")).result.tools.map((t: { name: string }) => t.name);
    assert.deepEqual(names, ["status", "open_questions", "answer", "add_work", "pause", "stop_turn"]);

    const status = await c.call("status");
    assert.match(status.content[0].text, /## shop: A game for one boy/);
    assert.match(status.content[0].text, /goal g v1: Game · 0\/10 turns/);
    assert.match(status.content[0].text, /waiting on you: \d+ question/);
    assert.equal((await c.call("status", { engagement: "nope" })).isError, true);

    const qs = await c.call("open_questions");
    const play = (qs.structuredContent!.result as Array<{ id: string; question: string }>).find((a) => a.question.startsWith("Play it"))!;
    assert.match(qs.content[0].text, /for parent, action: Play it with him this week/);
    assert.match(qs.content[0].text, /give observation/);

    const ok = await c.call("answer", { engagement: "shop", ask: play.id, choice: "done", relayed: true, note: "Picked it three days running", observation: { direction: "supports", metrics: { days: 3 }, runs: 1 } });
    assert.equal(ok.isError, undefined, ok.content[0].text);
    let s = await h.state();
    assert.equal(s.asks.get(play.id)!.answeredBy, "parent", "relayed: it counts as what the parent saw, as in the panel");
    assert.equal([...s.findings.values()].find((f) => f.source === `ask:${play.id}`)!.grade, "expert");
    assert.match((await c.call("answer", { engagement: "shop", ask: play.id, choice: "done" })).content[0].text, /already answered/);

    const added = await c.call("add_work", { engagement: "shop", goal: "g", text: "Add a pause button", lane: "build", write_scope: ["game/ui"], priority: 1 });
    assert.equal(added.isError, undefined, added.content[0].text);
    const id = added.structuredContent!.result.id as string;
    s = await h.state();
    const t = s.todos.get(id)!;
    assert.deepEqual([t.text, t.lane, t.writeScope, t.priority, t.provenance, t.status], ["Add a pause button", "build", ["game/ui"], 1, "partner", "open"]);
    assert.match((await c.call("add_work", { engagement: "shop", goal: "g", text: "x", lane: "build", write_scope: ["policy"] })).content[0].text, /outside the goal's scope/);
    assert.match((await c.call("add_work", { engagement: "shop", goal: "g", text: "x", lane: "build", write_scope: ["game/../policy"] })).content[0].text, /inside the repo/);
    assert.match((await c.call("add_work", { engagement: "shop", goal: "g", text: "x", lane: "build", tests: "A9" })).content[0].text, /no assumption A9/);

    assert.match((await c.call("pause", { engagement: "shop", paused: true, reason: "away" })).content[0].text, /shop paused/);
    assert.ok((await h.state()).paused);
    assert.match((await c.call("stop_turn", { engagement: "shop", turn: "core-1-x" })).content[0].text, /isn't running/);
  } finally {
    c.close();
  }
});

test("inside a turn the partner's server offers nothing, and every Copilot turn switches it off and says it's a turn", async () => {
  const { dir } = await workspace();
  const c = client(dir, { AF_TURN: "core-1-abc" });
  try {
    await c.rpc("initialize", {});
    assert.deepEqual((await c.rpc("tools/list")).result.tools, []);
    assert.equal((await c.rpc("tools/call", { name: "answer", arguments: {} })).error.code, -32602);
  } finally {
    c.close();
  }
  // What a Copilot turn is started with.
  const bins = tmp("bin");
  const fake = path.join(bins, "copilot.js");
  fs.writeFileSync(fake, `require("node:fs").writeFileSync(${JSON.stringify(path.join(bins, "seen.json"))}, JSON.stringify({ args: process.argv.slice(2), turn: process.env.AF_TURN }));
console.log(JSON.stringify({ type: "assistant.message", data: { content: '{"done": true}' } }));`);
  const agent = new CopilotTurnAgent({ bin: fake, fallback: { agent: "author", model: "model-a" }, profileDirs: null, timeoutMs: 30_000 });
  await agent.run({ turn: "core-1-abc", agent: "r", now: 0, packet: "p", todo: { id: "core", lane: "build", text: "t" }, wtDir: bins } as never);
  const seen = JSON.parse(fs.readFileSync(path.join(bins, "seen.json"), "utf8")) as { args: string[]; turn: string };
  assert.equal(seen.turn, "core-1-abc");
  assert.equal(seen.args[seen.args.indexOf("--disable-mcp-server") + 1], "agentfactory");
  // Nor any of your own Copilot instructions or skills.
  assert.ok(seen.args.includes("--no-custom-instructions"));
  assert.equal(seen.args[seen.args.indexOf("--excluded-tools") + 1], "skill");
});

test("the partner's session covers the same folders as the panel: every folder opened in, or only the ones named", async () => {
  const a = await workspace();
  const b = await workspace();
  const here = tmp("here");
  const file = path.join(tmp("folders"), "panel-folders.json");
  fs.writeFileSync(file, JSON.stringify({ folders: [a.dir, b.dir] }));
  assert.deepEqual(partnerFolders([], here, {}, file), [here, a.dir, b.dir]);
  assert.deepEqual(partnerFolders(["--dir", a.dir], here, {}, file), [a.dir], "folders you name are what you get");
  assert.deepEqual(partnerFolders([], here, { AF_DIR: b.dir }, file), [b.dir]);
  // End to end, without --dir: both engagements, named apart the way the panel names them.
  const c = client(here, { AF_PANEL_FOLDERS: file, AF_DIR: "" }, []);
  try {
    await c.rpc("initialize", {});
    const ids = (await c.call("status")).structuredContent!.result.map((e: { id: string }) => e.id);
    assert.deepEqual(ids, [`shop@${path.basename(a.dir)}`, `shop@${path.basename(b.dir)}`]);
  } finally {
    c.close();
  }
});
