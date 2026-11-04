// The keeper holds the desk's terminals in a process of its own, so stopping the desk
// leaves Copilot running and the next desk picks each terminal up again.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { KeptTerminals, keeperAddress, startKeeper } from "../src/desk/keeper.ts";
import { startDesk } from "../src/desk/server.ts";
import type { Bridge } from "../src/desk/terminal.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const tmp = (n: string) => fs.mkdtempSync(path.join(os.tmpdir(), `af-keep-${n}-`));

// An echo loop in a real pseudo-terminal: "ready", then "got:<line>" for each line.
const echoBridge: Bridge = ({ cwd, cols, rows }) =>
  process.platform === "win32"
    ? {
        command: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(ROOT, "scripts", "windows", "conpty.ps1")],
        env: {
          AF_DESK_PTY_CMD: `powershell.exe -NoProfile -NoLogo -Command "& { 'ready'; while ($null -ne ($l = [Console]::In.ReadLine())) { 'got:' + $l } }"`,
          AF_DESK_PTY_CWD: cwd, AF_DESK_PTY_COLS: String(cols), AF_DESK_PTY_ROWS: String(rows),
        },
      }
    : { command: "python3", args: ["-I", path.join(ROOT, "scripts", "pty-bridge.py"), String(cols), String(rows), cwd, "/bin/sh", "-c", 'echo ready; while read line; do echo "got:$line"; done'] };

// Reads a desk's /api/term stream until the screen matches.
async function screenOf(desk: { url: string; token: string }, name: string, signal: AbortSignal) {
  const res = await fetch(new URL(`/api/term?name=${name}`, desk.url), { headers: { "x-desk-token": desk.token }, signal });
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  let screen = "";
  return async (re: RegExp) => {
    const end = Date.now() + 60_000;
    while (!re.test(screen)) {
      if (Date.now() > end) assert.fail(`never saw ${re} in:\n${screen}`);
      const { value, done } = await reader.read();
      if (done) assert.fail(`the terminal ended before ${re}:\n${screen}`);
      screen += Buffer.from(value).toString("utf8");
    }
    return screen;
  };
}

test("a terminal opened on the desk outlives it: the next desk shows the same terminal, what it drew, and types into it", { timeout: 90_000 }, async (t) => {
  const home = tmp("outlive");
  const work = path.join(home, "billing");
  fs.mkdirSync(work);
  const keeper = await startKeeper({ home, bridge: echoBridge });
  t.after(() => keeper.close());

  const first = await startDesk({ home, port: 0, learnEveryMs: 3_600_000 });
  const headers = (d: { token: string }) => ({ "x-desk-token": d.token, "content-type": "application/json" });
  assert.equal((await fetch(new URL("/api/start", first.url), { method: "POST", headers: headers(first), body: JSON.stringify({ folder: work, cols: 80, rows: 24 }) })).status, 200);
  const c1 = new AbortController();
  await (await screenOf(first, "billing", c1.signal))(/ready/);
  c1.abort();
  await first.close();

  const second = await startDesk({ home, port: 0, learnEveryMs: 3_600_000 });
  t.after(() => second.close());
  const state = await (await fetch(new URL("/api/state?wait=0", second.url), { headers: headers(second) })).json();
  assert.deepEqual(state.hosted.map((x: { name: string; exited?: unknown }) => [x.name, !!x.exited]), [["billing", false]], "still running after the first desk stopped");
  const c2 = new AbortController();
  t.after(() => c2.abort());
  const until = await screenOf(second, "billing", c2.signal);
  await until(/ready/); // redrawn from what the keeper kept
  assert.equal((await fetch(new URL("/api/term/in", second.url), { method: "POST", headers: headers(second), body: JSON.stringify({ name: "billing", data: "hello\r" }) })).status, 200);
  await until(/got:hello/);

  // Closing it on the page ends it in the keeper.
  assert.equal((await fetch(new URL("/api/term/close", second.url), { method: "POST", headers: headers(second), body: JSON.stringify({ name: "billing" }) })).status, 200);
  const after = await (await fetch(new URL("/api/state?wait=0", second.url), { headers: headers(second) })).json();
  assert.deepEqual(after.hosted, []);
});

test("only the desk that knows the keeper's token can reach your terminals", { timeout: 30_000 }, async (t) => {
  const home = tmp("token");
  const keeper = await startKeeper({ home, bridge: echoBridge });
  t.after(() => keeper.close());
  const answer = await new Promise<string>((resolve) => {
    const s = net.connect(keeperAddress(home), () => s.write(`${JSON.stringify({ op: "hello", token: "not-it", id: 0 })}\n`));
    let got = "";
    s.on("data", (b) => { got += b.toString(); });
    s.on("close", () => resolve(got));
    s.on("error", () => resolve(got));
  });
  assert.match(answer, /wrong token/);
  const k = await KeptTerminals.connect(home, { start: false });
  assert.deepEqual(k.list(), []);
  k.detach();
});

test("the keeper ends by itself once it holds no terminal and no desk is connected", { timeout: 30_000 }, async () => {
  const home = tmp("idle");
  await startKeeper({ home, bridge: echoBridge, idleMs: 200 });
  const k = await KeptTerminals.connect(home, { start: false });
  k.detach(); // the desk left; nothing is kept
  await new Promise((r) => setTimeout(r, 800));
  await assert.rejects(KeptTerminals.connect(home, { start: false }), "nobody answers any more");
});

test("a desk with no keeper running starts none until you open a terminal", { timeout: 30_000 }, async (t) => {
  const home = tmp("lazy");
  const desk = await startDesk({ home, port: 0, learnEveryMs: 3_600_000 });
  t.after(() => desk.close());
  const state = await (await fetch(new URL("/api/state?wait=0", desk.url), { headers: { "x-desk-token": desk.token } })).json();
  assert.deepEqual(state.hosted, []);
  assert.equal(fs.existsSync(path.join(home, "keeper.token")), false, "no keeper was started");
});

test("the desk starts a keeper of its own, in its own process, when none is running", { timeout: 30_000 }, async () => {
  const home = tmp("spawn");
  const k = await KeptTerminals.connect(home);
  assert.notEqual(k.pid, process.pid, "a separate process, so it outlives the desk");
  assert.deepEqual(k.list(), []);
  await k.stop();
  await new Promise((r) => setTimeout(r, 300));
  await assert.rejects(KeptTerminals.connect(home, { start: false }), "stop ends it");
});
