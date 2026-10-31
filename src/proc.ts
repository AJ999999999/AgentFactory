// Starting other programs (Copilot CLI) the same way on Linux, macOS and Windows.
//
// On Windows, `npm install -g @github/copilot` puts a `copilot.cmd` shim on PATH. Node
// won't run a .cmd without a shell, and running one through cmd.exe would pass the
// prompt (which carries text from web pages and agents) through cmd.exe's parser:
// `&`, `|` or `%` in it could run commands. So a .cmd shim is never executed: its
// JavaScript entry point is read out of it and run directly with node. A native
// copilot.exe (WinGet) runs as is.
import { execFile } from "node:child_process";
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

// Sleep until a wall-clock time. A laptop that sleeps doesn't advance timers the way
// the wall clock moves, so this wakes at least every `step` ms and checks the clock.
export async function sleepUntil(at: number, opts: { step?: number; now?: () => number; wait?: (ms: number) => Promise<void> } = {}): Promise<void> {
  const step = opts.step ?? 30_000;
  const now = opts.now ?? Date.now;
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let left = at - now(); left > 0; left = at - now()) await wait(Math.min(step, left));
}
