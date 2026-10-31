// Starting Copilot CLI safely on every platform, and a loop that survives a laptop
// sleeping. The Windows-only tests run on the Windows CI runner.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveCommand, runCommand, shimEntry, sleepUntil } from "../src/proc.ts";

const win = process.platform === "win32";
const tmp = (n: string) => fs.mkdtempSync(path.join(os.tmpdir(), `af-win-${n}-`));

// npm's cmd shim for a global package, as `npm install -g @github/copilot` writes it.
const SHIM = [
  "@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", "",
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ") ELSE (", '  SET "_prog=node"', "  SET PATHEXT=%PATHEXT:;.JS;=;%", ")", "",
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@github\\copilot\\index.js" %*',
].join("\r\n");

function npmLayout(): { dir: string; shim: string; entry: string } {
  const dir = tmp("npm");
  const pkg = path.join(dir, "node_modules", "@github", "copilot");
  fs.mkdirSync(pkg, { recursive: true });
  const entry = path.join(pkg, "index.js");
  fs.writeFileSync(entry, 'const fs = require("node:fs"); fs.writeFileSync("seen.json", JSON.stringify(process.argv.slice(2))); console.log("ok");\n');
  const shim = path.join(dir, "copilot.cmd");
  fs.writeFileSync(shim, SHIM);
  return { dir, shim, entry };
}

test("a .js entry point runs through node on every platform; elsewhere a name is passed through", () => {
  assert.deepEqual(resolveCommand("/opt/copilot/index.js", { platform: "linux", nodePath: "/usr/bin/node" }), { file: "/usr/bin/node", prefix: ["/opt/copilot/index.js"] });
  assert.deepEqual(resolveCommand("copilot", { platform: "linux" }), { file: "copilot", prefix: [] });
});

test("sleeping by the wall clock: a laptop that sleeps through the target wakes on time, not a timer's length later", async () => {
  let now = 0;
  const waits: number[] = [];
  // The machine sleeps 2 hours during the first wait.
  await sleepUntil(60 * 60_000, { now: () => now, wait: async (ms) => { waits.push(ms); now += waits.length === 1 ? 2 * 3_600_000 : ms; } });
  assert.deepEqual(waits, [30_000], "one short wait, then the clock says the time has passed");
  now = 0;
  waits.length = 0;
  await sleepUntil(95_000, { now: () => now, wait: async (ms) => { waits.push(ms); now += ms; } });
  assert.deepEqual(waits, [30_000, 30_000, 30_000, 5_000]);
});

test("Windows: npm's copilot.cmd shim is resolved to its JavaScript entry, by path and by PATH", { skip: !win }, () => {
  const { dir, shim, entry } = npmLayout();
  assert.equal(shimEntry(shim), entry);
  assert.deepEqual(resolveCommand(shim), { file: process.execPath, prefix: [entry] });
  assert.deepEqual(resolveCommand("copilot", { env: { PATH: `${dir};${process.env.PATH}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" } }), { file: process.execPath, prefix: [entry] });
  // A batch file we can't see into is refused, never run through cmd.exe.
  const other = path.join(dir, "other.cmd");
  fs.writeFileSync(other, "@echo off\r\nsomething.exe %*\r\n");
  assert.throws(() => resolveCommand(other), /batch file/);
});

test("Windows: a prompt full of cmd.exe metacharacters reaches Copilot intact and runs nothing", { skip: !win }, async () => {
  const { shim } = npmLayout();
  const cwd = tmp("cwd");
  const prompt = 'Review this: "quoted" & echo pwned > pwned.txt | type nul %PATH% ^& done';
  await runCommand(shim, ["-p", prompt, "--model", "m"], { cwd });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cwd, "seen.json"), "utf8")), ["-p", prompt, "--model", "m"]);
  assert.ok(!fs.existsSync(path.join(cwd, "pwned.txt")), "nothing ran");
});
