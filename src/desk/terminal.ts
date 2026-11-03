// Terminals the desk hosts: a PowerShell running Copilot, in a pseudo-console the desk
// owns, shown on the page and typed into there. It's the same native Copilot screen as
// in Windows Terminal; the desk only carries the bytes. Closing the browser leaves a
// terminal running; stopping the desk closes it.
//
// Windows uses its own ConPTY through scripts/windows/conpty.ps1 (compiled at start, so
// nothing is installed); Mac and Linux use python3's pty (scripts/pty-bridge.py). Both
// read the same framed input and write the screen's bytes as they come.
import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { killTree, resolveCommand } from "../proc.ts";

// `progress`: what Copilot's progress signal says (OSC 9;4, the one Windows Terminal
// draws on a tab while Copilot works), read from the screen's bytes as they pass.
export type Progress = "working" | "error" | "paused";
export type HostedView = { name: string; cwd: string; started: number; exited?: { at: number; code: number | null }; progress?: Progress };

// OSC 9;4;<state>[;<percent>], ended by BEL or ST. States: 0 cleared, 1 a percentage,
// 2 error, 3 busy with no percentage, 4 paused.
const PROGRESS = /\x1b\]9;4;(\d)(?:;\d*)?(?:\x07|\x1b\\)/g;
const STATE: Record<string, Progress | undefined> = { "0": undefined, "1": "working", "2": "error", "3": "working", "4": "paused" };
// The last progress a chunk of the screen sets, if it sets any. `carry` is the end of the
// chunk before, so a signal split across two chunks is still read.
export function progressIn(chunk: string, carry = ""): { set: boolean; progress?: Progress; carry: string } {
  const text = carry + chunk;
  let set = false;
  let progress: Progress | undefined;
  for (const m of text.matchAll(PROGRESS)) {
    set = true;
    progress = STATE[m[1]];
  }
  // Keep a possible unfinished signal for the next chunk.
  const open = text.lastIndexOf("\x1b]");
  return { set, ...(progress ? { progress } : {}), carry: open >= 0 && text.length - open < 32 && !/\x07|\x1b\\/.test(text.slice(open + 2)) ? text.slice(open) : "" };
}

// How to start a terminal's bridge. `env` is added to the desk's own.
export type Bridge = (t: { name: string; cwd: string; cols: number; rows: number }) => { command: string; args: string[]; env?: Record<string, string> };

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const CONPTY = path.join(ROOT, "scripts", "windows", "conpty.ps1");
const PTY_PY = path.join(ROOT, "scripts", "pty-bridge.py");
const HERE = path.join(ROOT, "scripts", "windows", "copilot-here.ps1");

// What a hosted terminal runs: what copilot-here.ps1 does in a terminal of your own,
// staying in PowerShell when Copilot exits, as a terminal would.
export const defaultBridge: Bridge = ({ name, cwd, cols, rows }) => {
  const env = { AF_DESK_TERMINAL: name };
  if (process.platform === "win32") {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", CONPTY],
      env: { ...env, AF_DESK_PTY_CMD: `powershell.exe -NoLogo -NoExit -ExecutionPolicy Bypass -File "${HERE}" -Name ${name}`, AF_DESK_PTY_CWD: cwd, AF_DESK_PTY_COLS: String(cols), AF_DESK_PTY_ROWS: String(rows) },
    };
  }
  return { command: "python3", args: ["-I", PTY_PY, String(cols), String(rows), cwd, "/bin/sh", "-c", 'copilot; exec "${SHELL:-/bin/sh}"'], env };
};

const KEEP = 1 << 20; // the screen bytes kept to redraw a terminal when you look at it again
const frame = (type: number, body: Buffer) => {
  const head = Buffer.alloc(5);
  head.writeUInt8(type, 0);
  head.writeUInt32LE(body.length, 1);
  return Buffer.concat([head, body]);
};

type Hosted = HostedView & { proc: ChildProcess; chunks: Buffer[]; kept: number; watchers: Set<(b: Buffer) => void>; carry: string };

export class HostedTerminals {
  private all = new Map<string, Hosted>();
  private bridge: Bridge;
  private now: () => number;
  private onChange: () => void;

  constructor(opts: { bridge?: Bridge; now?: () => number; onChange?: () => void } = {}) {
    this.bridge = opts.bridge ?? defaultBridge;
    this.now = opts.now ?? Date.now;
    this.onChange = opts.onChange ?? (() => {});
  }

  list(): HostedView[] {
    return [...this.all.values()].map(({ name, cwd, started, exited, progress }) => ({ name, cwd, started, ...(exited ? { exited } : {}), ...(progress && !exited ? { progress } : {}) }));
  }

  running(name: string): boolean {
    const t = this.all.get(name);
    return !!t && !t.exited;
  }

  open(name: string, cwd: string, cols = 120, rows = 32): HostedView {
    if (this.running(name)) throw new Error(`${name} is already open on the desk`);
    const b = this.bridge({ name, cwd, cols, rows });
    const r = resolveCommand(b.command);
    const proc = spawn(r.file, [...r.prefix, ...b.args], {
      cwd,
      env: { ...process.env, ...b.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // Its own process group off Windows, so closing it ends everything it started.
      detached: process.platform !== "win32",
    });
    const t: Hosted = { name, cwd, started: this.now(), proc, chunks: [], kept: 0, watchers: new Set(), carry: "" };
    this.all.set(name, t);
    const take = (b: Buffer) => {
      const p = progressIn(b.toString("latin1"), t.carry);
      t.carry = p.carry;
      if (p.set && p.progress !== t.progress) {
        t.progress = p.progress;
        this.onChange();
      }
      t.chunks.push(b);
      t.kept += b.length;
      while (t.kept > KEEP && t.chunks.length > 1) t.kept -= t.chunks.shift()!.length;
      for (const w of t.watchers) w(b);
    };
    proc.stdout!.on("data", take);
    // The bridge's own errors (PowerShell refusing to compile it, python3 missing) show
    // where the terminal would.
    proc.stderr!.on("data", (b: Buffer) => take(Buffer.from(b.toString("utf8").replace(/\r?\n/g, "\r\n"))));
    proc.stdin!.on("error", () => {});
    const end = (code: number | null) => {
      if (t.exited) return;
      t.exited = { at: this.now(), code };
      take(Buffer.from(`\r\n[the terminal closed${code ? ` (exit code ${code})` : ""}]\r\n`));
      this.onChange();
    };
    proc.on("exit", (code) => end(code));
    proc.on("error", (e) => {
      take(Buffer.from(`${e.message}\r\n`));
      end(null);
    });
    this.onChange();
    return { name, cwd, started: t.started };
  }

  write(name: string, data: string): void {
    this.live(name).proc.stdin!.write(frame(0, Buffer.from(data, "utf8")));
  }

  resize(name: string, cols: number, rows: number): void {
    const body = Buffer.alloc(4);
    body.writeUInt16LE(Math.max(10, Math.min(500, Math.round(cols))), 0);
    body.writeUInt16LE(Math.max(4, Math.min(300, Math.round(rows))), 2);
    this.live(name).proc.stdin!.write(frame(1, body));
  }

  // Everything kept so far, then each new chunk as it comes. Returns the way to stop.
  watch(name: string, fn: (b: Buffer) => void): () => void {
    const t = this.all.get(name);
    if (!t) throw new Error(`no terminal named ${name} on the desk`);
    if (t.kept) fn(Buffer.concat(t.chunks));
    t.watchers.add(fn);
    return () => t.watchers.delete(fn);
  }

  // Closed from the page: ask the bridge to end it, then make sure. A terminal that
  // already ended is just forgotten.
  close(name: string): void {
    const t = this.all.get(name);
    if (!t) return;
    if (!t.exited) {
      try {
        t.proc.stdin!.write(frame(2, Buffer.alloc(0)));
        t.proc.stdin!.end();
      } catch {
        /* already gone */
      }
      setTimeout(() => { if (!t.exited) killTree(t.proc.pid); }, 2000).unref();
    }
    this.all.delete(name);
    this.onChange();
  }

  closeAll(): void {
    for (const t of this.all.values()) if (!t.exited) killTree(t.proc.pid);
    this.all.clear();
  }

  private live(name: string): Hosted {
    const t = this.all.get(name);
    if (!t || t.exited) throw new Error(`${name} isn't open on the desk`);
    return t;
  }
}
