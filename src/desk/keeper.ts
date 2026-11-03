// The keeper: a small process of its own that holds the desk's terminals, so they outlive
// the desk. Stop `npm run desk`, upgrade it, or let it crash, and Copilot keeps running in
// its terminal; the next desk connects again and the page redraws each terminal from what
// the keeper kept. It's the reason a terminal on the desk behaves like one in Windows
// Terminal rather than like a tab that dies with its page.
//
// The desk reaches it over a named pipe on Windows and a unix socket elsewhere, both named
// after the desk's home. The first line on a connection must carry the token the keeper
// wrote to keeper.token in that home (readable only by you), so another user's process on
// the same PC can't type into your terminals. Messages are JSON, one per line; a terminal's
// bytes travel as base64.
//
// It ends by itself once no terminal is left and no desk has been connected for a minute.
//
//   node src/desk/keeper.ts --home <desk home>    started by the desk when it isn't running
import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { type Bridge, HostedTerminals, type HostedView, type Terms } from "./terminal.ts";

export function keeperAddress(home: string): string {
  const id = createHash("sha256").update(path.resolve(home).toLowerCase()).digest("hex").slice(0, 16);
  if (process.platform === "win32") return `\\\\.\\pipe\\af-desk-keeper-${id}`;
  // A unix socket's path holds about 100 bytes; a deep home gets a short one in the temp
  // folder instead (still only yours: it's made 0600, and the token guards it).
  const near = path.join(home, "keeper.sock");
  return Buffer.byteLength(near) <= 100 ? near : path.join(os.tmpdir(), `af-desk-keeper-${id}.sock`);
}
const tokenFile = (home: string) => path.join(home, "keeper.token");

type Msg = Record<string, unknown>;
const line = (m: Msg) => `${JSON.stringify(m)}\n`;

// Splits a stream into JSON lines; a line that isn't JSON ends the connection.
function lines(sock: net.Socket, fn: (m: Msg) => void, start = ""): void {
  let buf = "";
  sock.setEncoding("utf8");
  const take = (s: string) => {
    buf += s;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const one = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!one) continue;
      let m: unknown;
      try {
        m = JSON.parse(one);
      } catch {
        sock.destroy();
        return;
      }
      if (m && typeof m === "object" && !Array.isArray(m)) fn(m as Msg);
    }
    // A desk sends small messages; a huge unfinished line is someone else.
    if (buf.length > 4 << 20) sock.destroy();
  };
  sock.on("data", take);
  if (start) take(start);
}

export type Keeper = { address: string; close: () => Promise<void> };

export async function startKeeper(opts: { home: string; bridge?: Bridge; idleMs?: number; log?: (l: string) => void }): Promise<Keeper> {
  const { home } = opts;
  const log = opts.log ?? (() => {});
  fs.mkdirSync(home, { recursive: true });
  const address = keeperAddress(home);
  const token = randomBytes(24).toString("hex");
  const clients = new Set<net.Socket>();
  const terms: HostedTerminals = new HostedTerminals({ ...(opts.bridge ? { bridge: opts.bridge } : {}), onChange: () => tellAll() });
  const tellAll = () => {
    const m = line({ ev: "list", terms: terms.list() });
    for (const c of clients) c.write(m);
  };

  const server = net.createServer((sock) => {
    let ok = false;
    const watches = new Map<number, () => void>();
    const reply = (re: unknown, body: Msg) => sock.write(line({ re, ...body }));
    sock.on("error", () => {});
    sock.on("close", () => {
      for (const stop of watches.values()) stop();
      clients.delete(sock);
      idle();
    });
    lines(sock, (m) => {
      if (!ok) {
        const given = typeof m.token === "string" ? Buffer.from(m.token) : Buffer.alloc(0);
        if (m.op !== "hello" || given.length !== token.length || !timingSafeEqual(given, Buffer.from(token))) {
          sock.end(line({ error: "wrong token" }));
          return;
        }
        ok = true;
        clients.add(sock);
        idle();
        reply(m.id, { ok: true, terms: terms.list(), pid: process.pid });
        return;
      }
      const name = typeof m.name === "string" ? m.name : "";
      try {
        switch (m.op) {
          case "open": {
            const v = terms.open(name, String(m.cwd), Number(m.cols) || 120, Number(m.rows) || 32);
            log(`opened ${name} in ${v.cwd}`);
            return reply(m.id, { ok: true, view: v });
          }
          case "in":
            terms.write(name, String(m.data ?? ""));
            return;
          case "size":
            terms.resize(name, Number(m.cols), Number(m.rows));
            return;
          case "close":
            terms.close(name);
            log(`closed ${name}`);
            idle();
            return reply(m.id, { ok: true });
          case "watch": {
            const wid = Number(m.wid);
            watches.get(wid)?.();
            watches.set(wid, terms.watch(name, (b) => sock.write(line({ ev: "data", wid, b64: b.toString("base64") }))));
            return;
          }
          case "unwatch": {
            const wid = Number(m.wid);
            watches.get(wid)?.();
            watches.delete(wid);
            return;
          }
          case "stop":
            // Every terminal ends, then the keeper: `npm run desk -- terminals stop`.
            reply(m.id, { ok: true });
            void close();
            return;
          default:
            return reply(m.id, { error: `unknown op ${String(m.op)}` });
        }
      } catch (e) {
        if (m.id !== undefined) reply(m.id, { error: (e as Error).message });
      }
    });
  });

  // An earlier keeper that died leaves its socket file behind; one that's alive answers.
  if (process.platform !== "win32" && fs.existsSync(address)) {
    const alive = await new Promise<boolean>((r) => {
      const s = net.connect(address, () => { s.destroy(); r(true); });
      s.on("error", () => r(false));
    });
    if (alive) throw new Error(`a keeper is already running at ${address}`);
    fs.rmSync(address, { force: true });
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(address, () => resolve());
  });
  if (process.platform !== "win32") fs.chmodSync(address, 0o600);
  fs.writeFileSync(tokenFile(home), token, { mode: 0o600 });

  let timer: NodeJS.Timeout | undefined;
  const idleMs = opts.idleMs ?? 60_000;
  // Nothing to keep and nobody to keep it for: end, so a keeper never lingers unseen.
  function idle() {
    clearTimeout(timer);
    if (clients.size || terms.list().length) return;
    timer = setTimeout(() => void close(), idleMs);
    timer.unref();
  }
  idle();

  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    closing ??= new Promise<void>((r) => {
      clearTimeout(timer);
      terms.closeAll();
      for (const c of clients) c.destroy();
      try {
        if (fs.readFileSync(tokenFile(home), "utf8") === token) fs.rmSync(tokenFile(home), { force: true });
      } catch { /* already gone */ }
      server.close(() => r());
      log("stopped");
    });
    return closing;
  }
  log(`listening on ${address} (pid ${process.pid})`);
  return { address, close };
}

// The desk's side: the same calls as HostedTerminals, carried to the keeper. The list is
// kept current by the keeper's own messages, so reading it costs nothing.
export class KeptTerminals implements Terms {
  private views: HostedView[] = [];
  private waiting = new Map<number, (m: Msg) => void>();
  private watchers = new Map<number, (b: Buffer) => void>();
  private next = 1;
  private onChange: () => void;
  private sock: net.Socket;
  readonly pid: number;

  private constructor(sock: net.Socket, hello: Msg, onChange: () => void, rest: string) {
    this.sock = sock;
    this.views = (hello.terms as HostedView[]) ?? [];
    this.pid = Number(hello.pid);
    this.onChange = onChange;
    lines(sock, (m) => {
      if (m.ev === "list") {
        this.views = (m.terms as HostedView[]) ?? [];
        this.onChange();
      } else if (m.ev === "data") this.watchers.get(Number(m.wid))?.(Buffer.from(String(m.b64), "base64"));
      else if (m.re !== undefined) {
        const w = this.waiting.get(Number(m.re));
        this.waiting.delete(Number(m.re));
        w?.(m);
      }
    }, rest);
    sock.on("close", () => {
      for (const w of this.waiting.values()) w({ error: "the keeper went away" });
      this.waiting.clear();
      this.views = [];
      this.onChange();
    });
  }

  // Connects to the keeper for `home`, starting one when none answers.
  static async connect(home: string, opts: { onChange?: () => void; start?: boolean; startTimeoutMs?: number } = {}): Promise<KeptTerminals> {
    const tryOnce = () => KeptTerminals.attach(home, opts.onChange ?? (() => {}));
    try {
      return await tryOnce();
    } catch (e) {
      if (opts.start === false) throw e;
    }
    startKeeperProcess(home);
    const end = Date.now() + (opts.startTimeoutMs ?? 10_000);
    for (;;) {
      await new Promise((r) => setTimeout(r, 150));
      try {
        return await tryOnce();
      } catch (e) {
        if (Date.now() > end) throw new Error(`the terminal keeper didn't start (see ${path.join(home, "keeper.log")}): ${(e as Error).message}`);
      }
    }
  }

  static attach(home: string, onChange: () => void): Promise<KeptTerminals> {
    return new Promise((resolve, reject) => {
      let token = "";
      try {
        token = fs.readFileSync(tokenFile(home), "utf8").trim();
      } catch {
        return reject(new Error("no keeper running"));
      }
      const sock = net.connect(keeperAddress(home));
      sock.once("error", reject);
      sock.once("connect", () => {
        sock.write(line({ op: "hello", token, id: 0 }));
        let buf = "";
        const first = (s: Buffer) => {
          buf += s.toString("utf8");
          const i = buf.indexOf("\n");
          if (i < 0) return;
          sock.off("data", first);
          sock.off("error", reject);
          sock.on("error", () => {});
          const hello = JSON.parse(buf.slice(0, i)) as Msg;
          if (hello.error) {
            sock.destroy();
            return reject(new Error(String(hello.error)));
          }
          resolve(new KeptTerminals(sock, hello, onChange, buf.slice(i + 1)));
        };
        sock.on("data", first);
      });
    });
  }

  private ask(m: Msg): Promise<Msg> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      if (this.sock.destroyed) return reject(new Error("the keeper went away"));
      this.waiting.set(id, (r) => (r.error ? reject(new Error(String(r.error))) : resolve(r)));
      this.sock.write(line({ ...m, id }));
    });
  }
  private tell(m: Msg): void {
    if (!this.sock.destroyed) this.sock.write(line(m));
  }

  get connected(): boolean {
    return !this.sock.destroyed;
  }
  list(): HostedView[] {
    return this.views;
  }
  running(name: string): boolean {
    return this.views.some((v) => v.name === name && !v.exited);
  }
  async open(name: string, cwd: string, cols = 120, rows = 32): Promise<HostedView> {
    if (this.running(name)) throw new Error(`${name} is already open on the desk`);
    return (await this.ask({ op: "open", name, cwd, cols, rows })).view as HostedView;
  }
  write(name: string, data: string): void {
    if (!this.running(name)) throw new Error(`${name} isn't open on the desk`);
    this.tell({ op: "in", name, data });
  }
  resize(name: string, cols: number, rows: number): void {
    if (!this.running(name)) throw new Error(`${name} isn't open on the desk`);
    this.tell({ op: "size", name, cols, rows });
  }
  watch(name: string, fn: (b: Buffer) => void): () => void {
    if (!this.views.some((v) => v.name === name)) throw new Error(`no terminal named ${name} on the desk`);
    const wid = this.next++;
    this.watchers.set(wid, fn);
    this.tell({ op: "watch", name, wid });
    return () => {
      this.watchers.delete(wid);
      this.tell({ op: "unwatch", wid });
    };
  }
  async close(name: string): Promise<void> {
    if (!this.views.some((v) => v.name === name)) return;
    await this.ask({ op: "close", name });
  }
  // Ends every terminal and the keeper with them.
  async stop(): Promise<void> {
    await this.ask({ op: "stop" }).catch(() => {});
  }
  // The desk is going: the terminals stay with the keeper.
  detach(): void {
    this.sock.end();
  }
}

// A keeper of its own, detached, so it outlives the desk that started it. Its log is next
// to the desk's state.
export function startKeeperProcess(home: string): void {
  fs.mkdirSync(home, { recursive: true });
  const out = fs.openSync(path.join(home, "keeper.log"), "a");
  const p = spawn(process.execPath, ["--no-warnings", import.meta.filename, "--home", home], {
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: true,
    env: { ...process.env, AF_DESK_HOME: home },
  });
  p.unref();
  fs.closeSync(out);
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const i = process.argv.indexOf("--home");
  const home = i >= 0 ? process.argv[i + 1] : "";
  if (!home) {
    console.error("usage: node src/desk/keeper.ts --home <desk home>");
    process.exit(2);
  }
  const stamp = () => new Date().toISOString();
  try {
    const k = await startKeeper({ home, log: (l) => console.log(`${stamp()} keeper: ${l}`) });
    const stop = () => void k.close().then(() => process.exit(0));
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  } catch (e) {
    // Two desks starting at once: the second keeper finds the first and leaves.
    console.log(`${stamp()} keeper: ${(e as Error).message}`);
    process.exit(0);
  }
}
