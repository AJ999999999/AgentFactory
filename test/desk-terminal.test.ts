// A thread's terminal on the desk: a real pseudo-terminal (ConPTY on Windows, a pty
// elsewhere) the page draws and types into; and a terminal of your own, followed from
// its session file.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startDesk } from "../src/desk/server.ts";
import { conversation } from "../src/desk/session.ts";
import type { Bridge } from "../src/desk/terminal.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const tmp = (n: string) => fs.mkdtempSync(path.join(os.tmpdir(), `af-term-${n}-`));

// The same bridges the desk uses, running a small echo loop instead of Copilot: it says
// "ready", then for each line answers "got:<line>" and the terminal's width.
const echoBridge: Bridge = ({ cwd, cols, rows }) =>
  process.platform === "win32"
    ? {
        command: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(ROOT, "scripts", "windows", "conpty.ps1")],
        env: {
          AF_DESK_PTY_CMD: `powershell.exe -NoProfile -NoLogo -Command "& { 'ready'; while ($null -ne ($l = [Console]::In.ReadLine())) { 'got:' + $l; 'width:' + [Console]::WindowWidth } }"`,
          AF_DESK_PTY_CWD: cwd, AF_DESK_PTY_COLS: String(cols), AF_DESK_PTY_ROWS: String(rows),
        },
      }
    : { command: "python3", args: ["-I", path.join(ROOT, "scripts", "pty-bridge.py"), String(cols), String(rows), cwd, "/bin/sh", "-c", 'echo ready; while read line; do echo "got:$line"; echo "width:$(stty size | cut -d" " -f2)"; done'] };

test("a thread started on the desk runs in a real terminal there: you see what it draws, type into it, resize and close it", { timeout: 90_000 }, async (t) => {
  const home = tmp("hosted");
  const work = path.join(home, "billing");
  fs.mkdirSync(work);
  const desk = await startDesk({ home, port: 0, bridge: echoBridge, learnEveryMs: 3_600_000 });
  t.after(() => desk.close());
  const headers = { "x-desk-token": desk.token, "content-type": "application/json" };
  const post = (p: string, body: object) => fetch(new URL(p, desk.url), { method: "POST", headers, body: JSON.stringify(body) });
  const state = async () => (await fetch(new URL("/api/state?wait=0", desk.url), { headers })).json();

  assert.equal((await post("/api/start", { folder: work, cols: 80, rows: 24 })).status, 200);
  assert.deepEqual((await state()).hosted.map((x: { name: string; cwd: string }) => [x.name, x.cwd]), [["billing", work]]);
  assert.match((await (await post("/api/start", { folder: work })).json()).error, /billing is already open/);

  assert.equal((await fetch(new URL("/api/term?name=billing", desk.url))).status, 403, "the token guards the terminal too");
  const ctrl = new AbortController();
  t.after(() => ctrl.abort());
  const res = await fetch(new URL("/api/term?name=billing", desk.url), { headers, signal: ctrl.signal });
  const reader = res.body!.getReader();
  let screen = "";
  const until = async (re: RegExp) => {
    const end = Date.now() + 60_000;
    while (!re.test(screen)) {
      if (Date.now() > end) assert.fail(`never saw ${re} in:\n${screen}`);
      const { value, done } = await reader.read();
      if (done) assert.fail(`the terminal ended before ${re}:\n${screen}`);
      screen += Buffer.from(value).toString("utf8");
    }
  };
  await until(/ready/);
  assert.equal((await post("/api/term/size", { name: "billing", cols: 100, rows: 30 })).status, 200);
  assert.equal((await post("/api/term/in", { name: "billing", data: "x\r" })).status, 200);
  await until(/got:x[\s\S]*width:\s*100/);

  // Looking again later replays what it drew.
  const again = await fetch(new URL("/api/term?name=billing", desk.url), { headers, signal: ctrl.signal });
  const first = Buffer.from((await again.body!.getReader().read()).value!).toString("utf8");
  assert.match(first, /ready/);

  assert.equal((await post("/api/term/close", { name: "billing" })).status, 200);
  assert.deepEqual((await state()).hosted, []);
  assert.match((await (await post("/api/term/in", { name: "billing", data: "y" })).json()).error, /isn't open on the desk/);
  assert.equal((await fetch(new URL("/api/term?name=nope", desk.url), { headers })).status, 404);
});

test("a terminal of your own is followed from its session: your prompts, what Copilot said, and each step with how it ended", () => {
  const ev = (type: string, data: Record<string, unknown>) => ({ type, data });
  assert.deepEqual(conversation([
    ev("user.message", { content: "Fix the rounding." }),
    ev("tool.execution_start", { toolCallId: "1", toolName: "report_intent", arguments: { intent: "Fixing rounding" } }),
    ev("tool.execution_start", { toolCallId: "2", toolName: "powershell", arguments: { command: "npm test" } }),
    ev("tool.execution_complete", { toolCallId: "2", success: true, shellExecution: { exitCode: 1 } }),
    ev("tool.execution_start", { toolCallId: "3", toolName: "edit", arguments: { path: "src/money.ts" } }),
    ev("tool.execution_complete", { toolCallId: "3", success: true }),
    ev("assistant.message", { content: "a sub-agent", parentToolCallId: "9" }),
    ev("assistant.message", { content: "Rounded the total only." }),
    ev("tool.execution_start", { toolCallId: "4", toolName: "powershell", arguments: { command: "npm test" } }),
  ]), [
    { k: "you", text: "Fix the rounding." },
    { k: "now", text: "Fixing rounding" },
    { k: "run", text: "npm test", running: false, ok: false },
    { k: "run", text: "edit src/money.ts", running: false, ok: true },
    { k: "said", text: "Rounded the total only." },
    { k: "run", text: "npm test", running: true },
  ]);
});
