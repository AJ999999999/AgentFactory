// Turns as they run, for the partner to watch and stop. The runner and the panel are
// separate processes on the same PC (the loop runs from Task Scheduler), so they meet in
// files under .af/harness/<engagement>/turns/:
//
//   <turn>.json  while the turn runs: what it's doing and which process runs it
//   <turn>.log   what the agent did, a line per step; kept after the turn ends
//   <turn>.stop  the partner asked to stop it; the runner kills the agent and records it
//
// None of this is engagement state: the turn's outcome still goes through the event log.
import * as fs from "node:fs";
import * as path from "node:path";

export type LiveTurn = {
  turn: string;
  todo: string;
  goal: string;
  text: string;
  runner: string;
  role?: string;
  pid: number; // the runner's process, to tell a running turn from a dead runner's leftovers
  startedAt: number;
  until: number; // the turn can't run past this (its timeout)
};

export type LiveView = LiveTurn & { stopping: boolean; tail: string[] };

const MAX_LOG = 2 * 1024 * 1024;
const KEEP_LOGS = 200;

// Turn ids are made by the harness, but they're also used as file names.
export const fileSafe = (id: string) => id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160);

export class LiveTurns {
  dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  private file(turn: string, ext: string): string {
    return path.join(this.dir, `${fileSafe(turn)}.${ext}`);
  }

  start(t: LiveTurn): { log: (...lines: string[]) => void; stopRequested: () => boolean; finish: (summary: string) => void } {
    fs.mkdirSync(this.dir, { recursive: true });
    const logFile = this.file(t.turn, "log");
    let size = 0;
    let full = false;
    const write = (lines: string[]) => {
      if (full) return;
      const stamp = new Date().toTimeString().slice(0, 8);
      const text = lines.map((l) => `${stamp} ${l}`).join("\n") + "\n";
      size += Buffer.byteLength(text);
      try {
        if (size > MAX_LOG) {
          full = true;
          fs.appendFileSync(logFile, `${stamp} … log stopped at ${MAX_LOG} bytes\n`);
        } else fs.appendFileSync(logFile, text);
      } catch {
        /* a log that can't be written must not fail the turn */
      }
    };
    write([`turn ${t.turn} · todo ${t.todo}${t.role ? ` · ${t.role}` : ""} · runner ${t.runner}`, t.text]);
    fs.writeFileSync(this.file(t.turn, "json"), JSON.stringify(t, null, 2));
    return {
      log: (...lines) => write(lines),
      stopRequested: () => fs.existsSync(this.file(t.turn, "stop")),
      finish: (summary) => {
        write([`--- ${summary}`]);
        for (const ext of ["json", "stop"]) fs.rmSync(this.file(t.turn, ext), { force: true });
        this.prune();
      },
    };
  }

  // Turns running now on this PC, newest first, with the end of each log.
  list(now: number, tailLines = 15): LiveView[] {
    if (!fs.existsSync(this.dir)) return [];
    const out: LiveView[] = [];
    for (const f of fs.readdirSync(this.dir).filter((x) => x.endsWith(".json"))) {
      let t: LiveTurn;
      try {
        t = JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8")) as LiveTurn;
      } catch {
        continue; // being written
      }
      if (t.until < now || !alive(t.pid)) continue; // a runner that died mid-turn
      out.push({ ...t, stopping: fs.existsSync(this.file(t.turn, "stop")), tail: this.tail(t.turn, tailLines, true) });
    }
    return out.sort((a, b) => b.startedAt - a.startedAt);
  }

  // The end of a turn's log. Without the prompt (it's in the file, but on the panel it
  // would hide what the agent is doing): what came after it, or before it while it's
  // still being written.
  tail(turn: string, n: number, skipPrompt = false): string[] {
    const f = this.file(turn, "log");
    try {
      const fd = fs.openSync(f, "r");
      try {
        const size = fs.fstatSync(fd).size;
        const len = Math.min(size, 64 * 1024);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, size - len);
        let lines = buf.toString("utf8").split("\n").filter((l) => l.length);
        if (skipPrompt) {
          const work = lines.findLastIndex((l) => l.endsWith(" --- work ---"));
          const prompt = lines.findLastIndex((l) => l.endsWith(" --- prompt ---"));
          if (work >= 0) lines = lines.slice(work + 1);
          else if (prompt >= 0) lines = lines.slice(0, prompt);
        }
        return lines.slice(-n);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return [];
    }
  }

  // Ask the runner to stop a turn. False when that turn isn't running (any more).
  requestStop(turn: string, by: string, now: number): boolean {
    if (!this.list(now, 0).some((t) => t.turn === turn)) return false;
    fs.writeFileSync(this.file(turn, "stop"), JSON.stringify({ by, at: new Date(now).toISOString() }));
    return true;
  }

  private prune(): void {
    try {
      const logs = fs.readdirSync(this.dir).filter((x) => x.endsWith(".log")).map((x) => ({ x, t: fs.statSync(path.join(this.dir, x)).mtimeMs })).sort((a, b) => b.t - a.t);
      for (const { x } of logs.slice(KEEP_LOGS)) fs.rmSync(path.join(this.dir, x), { force: true });
    } catch {
      /* best effort */
    }
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
