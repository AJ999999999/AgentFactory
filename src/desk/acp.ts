// Talking to Copilot CLI over the Agent Client Protocol (ACP): `copilot --acp --stdio`,
// Copilot's own interface for programs that drive it (public preview). The desk uses it
// to start a session, send your prompts, stop a turn, and be asked for every permission
// the way the terminal would ask you.
//
// Herdr gets this control by owning each agent's terminal and typing into it, which
// needs a native terminal library on Windows and reads the agent's state off the
// screen. ACP gives the same control as messages Copilot itself defines.
//
// The wire is JSON-RPC 2.0, one message per line on the child's stdin and stdout. Both
// sides send requests: the desk prompts, and Copilot asks the desk for permission.
import { spawn } from "node:child_process";
import { killTree, resolveCommand } from "../proc.ts";

export type RpcError = Error & { code?: number; data?: unknown };
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string };
type Handler = (params: Record<string, unknown>) => unknown | Promise<unknown>;

const NOT_FOUND = -32601;

export class Acp {
  private next = 1;
  private waiting = new Map<number | string, Pending>();
  private handlers = new Map<string, Handler>();
  private ended?: Error;
  onNotify: (method: string, params: Record<string, unknown>) => void = () => {};
  private write: (line: string) => void;

  constructor(write: (line: string) => void) {
    this.write = write;
  }

  request<T = Record<string, unknown>>(method: string, params: Record<string, unknown>): Promise<T> {
    if (this.ended) return Promise.reject(this.ended);
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject, method });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (!this.ended) this.send({ jsonrpc: "2.0", method, params });
  }

  // What the desk answers when Copilot asks it something (a permission, a question).
  handle(method: string, fn: Handler): void {
    this.handlers.set(method, fn);
  }

  receive(line: string): void {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // not ours: stdout is the protocol's, but a stray line mustn't break it
    }
    if (!m || typeof m !== "object") return;
    const id = m.id as number | string | undefined;
    if (typeof m.method === "string") {
      const params = (m.params && typeof m.params === "object" ? m.params : {}) as Record<string, unknown>;
      if (id === undefined || id === null) return this.onNotify(m.method, params);
      const fn = this.handlers.get(m.method);
      if (!fn) return this.send({ jsonrpc: "2.0", id, error: { code: NOT_FOUND, message: `the desk doesn't handle ${m.method}` } });
      Promise.resolve()
        .then(() => fn(params))
        .then(
          (result) => this.send({ jsonrpc: "2.0", id, result: result ?? {} }),
          (e: Error) => this.send({ jsonrpc: "2.0", id, error: { code: -32603, message: e.message } }),
        );
      return;
    }
    const p = id !== undefined ? this.waiting.get(id) : undefined;
    if (!p) return;
    this.waiting.delete(id!);
    if (m.error) {
      const err = m.error as { code?: number; message?: string; data?: unknown };
      p.reject(Object.assign(new Error(`${p.method}: ${err.message ?? "failed"}`), { code: err.code, data: err.data }) as RpcError);
    } else p.resolve(m.result ?? {});
  }

  // The other side is gone: everything still waiting fails with why.
  end(why: Error): void {
    if (this.ended) return;
    this.ended = why;
    for (const p of this.waiting.values()) p.reject(why);
    this.waiting.clear();
  }

  get alive(): boolean {
    return !this.ended;
  }

  private send(m: unknown): void {
    try {
      this.write(JSON.stringify(m) + "\n");
    } catch (e) {
      this.end(e as Error);
    }
  }
}

export type AcpProcess = { acp: Acp; pid?: number; exited: Promise<{ code: number | null; stderr: string }>; kill: () => void };

// Start `copilot --acp --stdio` (or whatever `bin` and `args` say) in a folder. A
// `.cmd` shim is never run through cmd.exe (proc.ts): your prompts go over stdin, not
// the command line, but the rule holds everywhere the desk starts Copilot.
export function spawnAcp(bin: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): AcpProcess {
  const r = resolveCommand(bin);
  // On POSIX the child leads its own group, so stopping it stops what it started.
  const child = spawn(r.file, [...r.prefix, ...args], { cwd: opts.cwd, env: opts.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
  const acp = new Acp((line) => child.stdin.write(line));
  child.stdin.on("error", () => {}); // it exited; `exited` says why
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (s: string) => {
    buf += s;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) acp.receive(line);
    }
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (s: string) => (stderr = (stderr + s).slice(-4000)));
  const exited = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    child.on("error", (e) => {
      acp.end(e);
      resolve({ code: null, stderr: stderr || e.message });
    });
    child.on("close", (code) => {
      acp.end(new Error(`Copilot exited${code === null ? "" : ` with code ${code}`}${stderr.trim() ? `: ${stderr.trim().split("\n").slice(-3).join(" ")}` : ""}`));
      resolve({ code, stderr });
    });
  });
  return {
    acp,
    pid: child.pid,
    exited,
    kill: () => {
      child.stdin.end();
      killTree(child.pid);
    },
  };
}
