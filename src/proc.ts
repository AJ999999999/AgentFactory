// Starting other programs (Copilot CLI) the same way on Linux, macOS and Windows.
//
// On Windows, `npm install -g @github/copilot` puts a `copilot.cmd` shim on PATH. Node
// won't run a .cmd without a shell, and running one through cmd.exe would pass the
// prompt (which carries text from web pages and agents) through cmd.exe's parser:
// `&`, `|` or `%` in it could run commands. So a .cmd shim is never executed: its
// JavaScript entry point is read out of it and run directly with node. A native
// copilot.exe (WinGet) runs as is.
import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export type Resolved = { file: string; prefix: string[] };

type Env = { platform?: NodeJS.Platform; env?: Record<string, string | undefined>; nodePath?: string };

const JS = /\.(c|m)?js$/i;

export function resolveCommand(bin: string, opts: Env = {}): Resolved {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const node = opts.nodePath ?? process.execPath;
  const p = platform === "win32" ? path.win32 : path.posix;
  if (JS.test(bin)) return { file: node, prefix: [bin] };
  if (platform !== "win32") return { file: bin, prefix: [] };

  const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((e) => e.toLowerCase());
  const hasDir = bin.includes("/") || bin.includes("\\");
  const dirs = hasDir ? [""] : (env.PATH ?? env.Path ?? "").split(";").filter(Boolean);
  const names = p.extname(bin) ? [bin] : [...exts.map((e) => bin + e), bin];
  for (const dir of dirs) {
    for (const name of names) {
      const full = dir ? p.join(dir, name) : name;
      if (!isFile(full)) continue;
      const ext = p.extname(full).toLowerCase();
      if (ext === ".exe" || ext === ".com") return { file: full, prefix: [] };
      if (ext === ".cmd" || ext === ".bat") {
        const entry = shimEntry(full, p);
        if (entry) return { file: node, prefix: [entry] };
        throw new Error(`${full} is a batch file whose JavaScript entry point couldn't be found. Batch files aren't run (the prompt would pass through cmd.exe). Install the native copilot.exe, or pass --copilot <path to the .js entry or the .exe>.`);
      }
      if (JS.test(full)) return { file: node, prefix: [full] };
    }
  }
  throw new Error(`${bin} not found on PATH`);
}

// npm's cmd shims end with: "%_prog%"  "%dp0%\node_modules\<pkg>\<entry>.js" %*
export function shimEntry(shim: string, p: typeof path.win32 = path.win32): string | null {
  let text: string;
  try {
    text = fs.readFileSync(shim, "utf8");
  } catch {
    return null;
  }
  const dir = p.dirname(shim);
  const hits = [...text.matchAll(/"%~?dp0%\\?([^"]+?)"/gi)].map((m) => m[1]).filter((x) => JS.test(x));
  for (const rel of hits.reverse()) {
    const full = p.join(dir, rel);
    if (isFile(full)) return full;
  }
  return null;
}

function isFile(f: string): boolean {
  try {
    return fs.statSync(f).isFile();
  } catch {
    return false;
  }
}

// Windows limits a command line to 32,767 characters.
const WIN_MAX = 32_000;

export async function runCommand(bin: string, args: string[], opts: { cwd?: string; timeout?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv } = {}): Promise<{ stdout: string; stderr: string }> {
  const r = resolveCommand(bin);
  const all = [...r.prefix, ...args];
  if (process.platform === "win32") {
    const len = [r.file, ...all].reduce((n, a) => n + a.length + 3, 0);
    if (len > WIN_MAX) throw new Error(`command line is ${len} characters; Windows allows about 32,000. Shorten the prompt.`);
  }
  const { stdout, stderr } = await execFileP(r.file, all, { cwd: opts.cwd, timeout: opts.timeout, maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024, env: opts.env, windowsHide: true });
  return { stdout: String(stdout), stderr: String(stderr) };
}

// The same as runCommand, but output is handed over as it arrives (so a running turn can
// be watched) and the run can be stopped. Stopping or timing out kills the whole process
// tree: Copilot's npm loader starts the CLI as a child, and killing only the loader would
// leave the agent working. Rejects like execFile does (stdout, stderr and code on the
// error), with `stopped` set when the signal stopped it.
export type RunError = Error & { stdout: string; stderr: string; code: number | null; stopped?: boolean; timedOut?: boolean };

export function spawnCommand(bin: string, args: string[], opts: { cwd?: string; timeout?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal; input?: string; onStdout?: (s: string) => void; onStderr?: (s: string) => void } = {}): Promise<{ stdout: string; stderr: string }> {
  const r = resolveCommand(bin);
  const all = [...r.prefix, ...args];
  if (process.platform === "win32") {
    const len = [r.file, ...all].reduce((n, a) => n + a.length + 3, 0);
    if (len > WIN_MAX) return Promise.reject(new Error(`command line is ${len} characters; Windows allows about 32,000. Shorten the prompt.`));
  }
  const max = opts.maxBuffer ?? 32 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(Object.assign(new Error("stopped before it started"), { stdout: "", stderr: "", code: null, stopped: true }));
    // stdin carries `input` and is then closed, so nothing waits for input. On POSIX the
    // child leads its own process group, so the group can be killed together.
    const child = spawn(r.file, all, { cwd: opts.cwd, env: opts.env, windowsHide: true, stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    if (opts.input !== undefined) {
      child.stdin!.on("error", () => {}); // a child that exits before reading it all
      child.stdin!.end(opts.input);
    }
    let stdout = "";
    let stderr = "";
    let why: "stopped" | "timedOut" | "overflow" | null = null;
    const kill = (reason: typeof why) => {
      if (why) return;
      why = reason;
      killTree(child.pid);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (s: string) => {
      if (stdout.length + s.length > max) return kill("overflow");
      stdout += s;
      opts.onStdout?.(s);
    });
    child.stderr.on("data", (s: string) => {
      if (stderr.length < max) stderr += s;
      opts.onStderr?.(s);
    });
    const timer = opts.timeout ? setTimeout(() => kill("timedOut"), opts.timeout) : null;
    const onAbort = () => kill("stopped");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const done = () => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };
    child.on("error", (e) => {
      done();
      reject(Object.assign(e, { stdout, stderr, code: null }));
    });
    child.on("close", (code) => {
      done();
      if (!why && code === 0) return resolve({ stdout, stderr });
      const msg = why === "stopped" ? "stopped" : why === "timedOut" ? `timed out after ${Math.round((opts.timeout ?? 0) / 1000)}s` : why === "overflow" ? `output passed ${max} bytes` : `exited with code ${code}`;
      reject(Object.assign(new Error(`${path.basename(bin)} ${msg}${stderr ? `\n${stderr.slice(0, 2000)}` : ""}`), { stdout, stderr, code, ...(why === "stopped" ? { stopped: true } : {}), ...(why === "timedOut" ? { timedOut: true } : {}) }));
    });
  });
}

// Kill a process and everything it started. taskkill is a real program in System32, run
// with fixed arguments (no shell).
export function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    const taskkill = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
    execFile(taskkill, ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }, 5_000).unref();
}

// Sleep until a wall-clock time. A laptop that sleeps doesn't advance timers the way
// the wall clock moves, so this wakes at least every `step` ms and checks the clock.
export async function sleepUntil(at: number, opts: { step?: number; now?: () => number; wait?: (ms: number) => Promise<void> } = {}): Promise<void> {
  const step = opts.step ?? 30_000;
  const now = opts.now ?? Date.now;
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let left = at - now(); left > 0; left = at - now()) await wait(Math.min(step, left));
}
