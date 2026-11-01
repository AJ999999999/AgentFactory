// The desk's page: every Copilot CLI session on this PC as a thread, the way a Claude
// project lists its threads, grouped by what each needs from you; the notes between
// them; what finished sessions taught, for you to confirm. The work happens in each
// terminal: one the desk opened is on the page itself (terminal.ts), one of your own
// windows is followed there and brought forward when you want to type. It also runs
// the learning: each ended session is analysed once.
//
// Same guards as the partner's panel: it listens on 127.0.0.1 only, answers only
// requests addressed to that host, and every call carries a token only the served page
// knows. While it runs it beats `page.json`; the hook holds an ask (for a terminal you
// chose to answer here) only while that beat is fresh.
//
// The page waits on /api/state for a change instead of polling on a timer: browsers
// slow timers in background tabs to once a minute, but not a pending request.
import { randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { runCommand } from "../proc.ts";
import { answer, type Choice, loadConfig, modesFile, pageFile, pending, readJson, type Rule, rulesFile, writeJson } from "./hold.ts";
import { confirm, guesses, knowledgeDir, commit, reject, repoNameOf, summary } from "./knowledge.ts";
import { type Analysis, type Analyst, analysesDir, copilotAnalyst, learn, learnConfig, toLearn } from "./learn.ts";
import { deskHome, readLog } from "./log.ts";
import { terminals } from "./others.ts";
import { claim, recent as recentNotes, send as sendNote, YOU } from "./notes.ts";
import { conversation, readEvents, sessionFile, sessionTail, summarize, type Summary } from "./session.ts";
import { type Bridge, HostedTerminals, type HostedView } from "./terminal.ts";
import { threads } from "./threads.ts";

const PAGE = path.join(import.meta.dirname, "page.html");
// xterm.js draws a hosted terminal on the page; it's kept in the repo, not installed.
const VENDOR: Record<string, [string, string]> = {
  "/vendor/xterm.js": ["xterm.js", "text/javascript; charset=utf-8"],
  "/vendor/addon-fit.js": ["addon-fit.js", "text/javascript; charset=utf-8"],
  "/vendor/xterm.css": ["xterm.css", "text/css; charset=utf-8"],
};
const PANEL_PAGE = path.join(import.meta.dirname, "..", "panel", "page.html");

// The desk wears the partner's panel's styles, taken from its page each time, so the
// two look like one product and a change to the panel's look reaches the desk too.
export function page(): string {
  const panel = fs.readFileSync(PANEL_PAGE, "utf8");
  const css = panel.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
  return fs.readFileSync(PAGE, "utf8").replace("/*__PANEL_CSS__*/", () => css);
}
const MAX_BODY = 64 * 1024;
const CHOICES: Choice[] = ["allow", "deny", "terminal", "always"];

class BadRequest extends Error {}

export type DeskOptions = {
  home?: string;
  port?: number;
  log?: (line: string) => void;
  jump?: (title: string) => Promise<boolean>;
  // Open a new terminal window with Copilot in a folder; tests replace it.
  launch?: (folder: string, name: string) => Promise<boolean>;
  // How a terminal on the desk starts; tests replace it.
  bridge?: Bridge;
  analyst?: Analyst;
  learnEveryMs?: number;
};

const LAUNCHER = path.join(import.meta.dirname, "..", "..", "scripts", "windows", "copilot-here.ps1");
export const NAME = /^[A-Za-z0-9][\w.-]{0,39}$/;

// A new PowerShell window in the folder, running Copilot under the name (copilot-here.ps1),
// like starting a thread. The values travel in environment variables, never inside the
// command text; the name is plain (NAME), and [char]34 quotes the script's path without
// a `"` in the command line, which would have to survive two parsers.
export async function launchWindows(folder: string, name: string): Promise<boolean> {
  if (process.platform !== "win32" || !NAME.test(name)) return false;
  try {
    await runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Start-Process -FilePath powershell.exe -WorkingDirectory $env:AF_DESK_CWD -ArgumentList ('-NoExit -ExecutionPolicy Bypass -File ' + [char]34 + $env:AF_DESK_LAUNCHER + [char]34 + ' -Name ' + $env:AF_DESK_NAME)"], { env: { ...process.env, AF_DESK_CWD: folder, AF_DESK_LAUNCHER: LAUNCHER, AF_DESK_NAME: name }, timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

export type Learning = { running?: { session: string; repo: string; since: number }; queued: number; recent: Analysis[] };
export type Desk = { url: string; port: number; token: string; close: () => Promise<void> };

// Bring a terminal forward by the title `copilot-here.ps1` gave it, selecting its tab
// first when it's one of several in a Windows Terminal window (focus-tab.ps1). The
// title travels in an environment variable, never inside the script text.
const FOCUS_TAB = path.join(import.meta.dirname, "..", "..", "scripts", "windows", "focus-tab.ps1");
export async function jumpWindows(title: string): Promise<boolean> {
  if (process.platform !== "win32") return false;
  try {
    const { stdout } = await runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", FOCUS_TAB], { env: { ...process.env, AF_DESK_JUMP: title }, timeout: 15_000 });
    return /\btrue\s*$/i.test(stdout.trim());
  } catch {
    return false;
  }
}

// Reading session files and the knowledge repo costs more than the rest; the page asks
// several times a second while it waits, so those parts are reused for a moment.
const cache = new Map<string, { at: number; value: unknown }>();
function cached<T>(key: string, ms: number, now: number, make: () => T): T {
  const c = cache.get(key);
  if (c && now - c.at < ms) return c.value as T;
  const value = make();
  cache.set(key, { at: now, value });
  return value;
}

export function recentAnalyses(dir: string, n = 6): Analysis[] {
  try {
    return fs.readdirSync(analysesDir(dir)).filter((f) => f.endsWith(".json")).map((f) => readJson<Analysis | null>(path.join(analysesDir(dir), f), null)).filter((a): a is Analysis => !!a).sort((a, b) => b.at - a.at).slice(0, n);
  } catch {
    return [];
  }
}

// What a session's file says about it, read again only when the file has changed (and
// not more than once a second while Copilot writes to it).
const summaries = new Map<string, { key: string; at: number; value: Summary }>();
export function summaryFor(session: string, transcript?: string, now = Date.now()): Summary | undefined {
  const f = sessionFile(session, transcript);
  if (!f) return undefined;
  const st = fs.statSync(f, { throwIfNoEntry: false });
  if (!st) return undefined;
  const key = `${st.size}:${st.mtimeMs}`;
  const c = summaries.get(f);
  if (c && (c.key === key || now - c.at < 1000)) return c.value;
  const value = summarize(readEvents(f));
  summaries.set(f, { key, at: now, value });
  return value;
}

export function snapshot(home: string, now = Date.now(), learning: Learning = { queued: 0, recent: [] }, hosted: HostedView[] = []) {
  const cfg = loadConfig(home);
  // An ask the hook left behind (Copilot killed it, the PC slept) is past its wait.
  const asks = pending(home).filter((a) => now - a.at < cfg.holdSec * 1000);
  const rules = readJson<Rule[]>(rulesFile(home), []);
  const modes = readJson<Record<string, string>>(modesFile(home), {});
  const log = readLog(home);
  const dir = knowledgeDir(home);
  const notes = recentNotes(home);
  const list = threads(log, asks, rules, modes, (s, t) => summaryFor(s, t, now), { now, askMode: cfg.asks }).map((t) => {
    const repo = repoNameOf(t.cwd);
    const transcript = log.find((e) => e.session === t.session && e.transcript)?.transcript;
    const tail = t.state === "closed" ? [] : cached(`tail:${t.session}`, 1500, now, () => {
      const f = sessionFile(t.session, transcript);
      return f ? sessionTail(f, 10) : [];
    });
    const onDesk = hosted.some((h) => h.name === t.name && !h.exited);
    return { ...t, repo, tail, onDesk, knowledge: cached(`know:${repo}`, 3000, now, () => summary(dir, repo, now)), notes: notes.filter((n) => n.to === t.name || n.from === t.name).slice(0, 6) };
  });
  const folders = [...new Set(log.map((e) => e.cwd))].slice(-30);
  return { now, holdSec: cfg.holdSec, askMode: cfg.asks, knowledgeDir: dir, threads: list, hosted, folders, notes: notes.slice(0, 30), guesses: cached("guesses", 3000, now, () => guesses(dir, now).slice(0, 40)), forYou: notes.filter((n) => n.to === YOU && !n.delivered), learning };
}

// Changes the page cares about; the clock alone isn't one.
const fingerprint = (snap: ReturnType<typeof snapshot>) => {
  const { now: _now, ...rest } = snap;
  return String(JSON.stringify(rest).split("").reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7));
};

const str = (v: unknown, what: string, max = 300): string => {
  if (typeof v !== "string" || !v || v.length > max) throw new BadRequest(`missing ${what}`);
  return v;
};

export async function startDesk(opts: DeskOptions = {}): Promise<Desk> {
  const home = opts.home ?? deskHome();
  const jump = opts.jump ?? jumpWindows;
  const launch = opts.launch ?? launchWindows;
  const log = opts.log ?? (() => {});
  const terms = new HostedTerminals({ ...(opts.bridge ? { bridge: opts.bridge } : {}) });
  const token = randomBytes(24).toString("hex");
  let port = 0;
  const hosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const send = (res: http.ServerResponse, status: number, body: string, type: string) => {
    res.writeHead(status, {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    res.end(body);
  };
  const json = (res: http.ServerResponse, status: number, v: unknown) => send(res, status, JSON.stringify(v), "application/json; charset=utf-8");

  const server = http.createServer(async (req, res) => {
    try {
      if (!hosts().has(req.headers.host ?? "")) return send(res, 403, "wrong host", "text/plain");
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      if (req.method === "GET" && url.pathname === "/") return send(res, 200, page().replace("__TOKEN__", token), "text/html; charset=utf-8");
      const v = req.method === "GET" ? VENDOR[url.pathname] : undefined;
      if (v) return send(res, 200, fs.readFileSync(path.join(import.meta.dirname, "vendor", v[0]), "utf8"), v[1]);
      if (!url.pathname.startsWith("/api/")) return send(res, 404, "not found", "text/plain");
      const origin = req.headers.origin;
      if (origin !== undefined && !hosts().has(origin.replace(/^http:\/\//, ""))) return json(res, 403, { error: "wrong origin" });
      const given = req.headers["x-desk-token"];
      if (typeof given !== "string" || given.length !== token.length || !timingSafeEqual(Buffer.from(given), Buffer.from(token))) return json(res, 403, { error: "this page is out of date: reload it" });

      if (req.method === "GET" && url.pathname === "/api/state") {
        const since = url.searchParams.get("since");
        const until = Date.now() + Math.min(Number(url.searchParams.get("wait") ?? 25_000) || 0, 25_000);
        for (;;) {
          const snap = snapshot(home, Date.now(), learning(), terms.list());
          const version = fingerprint(snap);
          if (version !== since || Date.now() >= until || req.destroyed) return json(res, 200, { ...snap, version });
          await new Promise((r) => setTimeout(r, 400));
        }
      }
      if (req.method === "GET" && url.pathname === "/api/term") {
        // A terminal on the desk, as the bytes it draws: what's kept first, then as it comes.
        const name = str(url.searchParams.get("name"), "name", 40);
        if (!terms.list().some((h) => h.name === name)) return json(res, 404, { error: `no terminal named ${name} on the desk` });
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
        res.flushHeaders();
        const stop = terms.watch(name, (b) => res.write(b));
        req.on("close", () => stop());
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/session") {
        // A session in a terminal of your own, as it goes, to follow it from the desk.
        const id = str(url.searchParams.get("id"), "id", 200);
        if (!/^[\w.-]+$/.test(id)) return json(res, 400, { error: "bad session id" });
        const transcript = readLog(home).find((e) => e.session === id && e.transcript)?.transcript;
        const f = sessionFile(id, transcript);
        return json(res, 200, { turns: f ? cached(`talk:${id}:${fs.statSync(f, { throwIfNoEntry: false })?.size ?? 0}`, 1000, Date.now(), () => conversation(readEvents(f))) : [] });
      }
      if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
      if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return json(res, 415, { error: "send JSON" });
      const body = await readBody(req);
      switch (url.pathname) {
        case "/api/answer": {
          const choice = str(body.choice, "choice", 20) as Choice;
          if (!CHOICES.includes(choice)) throw new BadRequest(`choice is one of ${CHOICES.join(", ")}`);
          const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 1000) : undefined;
          try {
            answer(str(body.ask, "ask", 100), choice, note, home);
          } catch (e) {
            throw new BadRequest((e as Error).message);
          }
          log(`answered ${body.ask}: ${choice}`);
          break;
        }
        case "/api/mode": {
          const terminal = str(body.terminal, "terminal");
          const mode = body.mode === "terminal" ? "terminal" : "desk";
          const modes = readJson<Record<string, string>>(modesFile(home), {});
          if (mode === "terminal") modes[terminal] = "terminal";
          else delete modes[terminal];
          writeJson(modesFile(home), modes);
          log(`${terminal}: answer ${mode === "terminal" ? "in the terminal" : "on the desk"}`);
          break;
        }
        case "/api/forget": {
          const terminal = str(body.terminal, "terminal");
          const tool = str(body.tool, "tool");
          const prefix = typeof body.prefix === "string" && body.prefix ? body.prefix : undefined;
          writeJson(rulesFile(home), readJson<Rule[]>(rulesFile(home), []).filter((r) => !(r.terminal === terminal && r.tool === tool && r.prefix === prefix)));
          log(`${terminal}: ${prefix ?? tool} asks again`);
          break;
        }
        case "/api/know": {
          // You confirm a guess (as it is, or in your words) or mark it wrong.
          const principal = str(body.principal, "principal", 100);
          const entry = str(body.entry, "entry", 200);
          const dir = knowledgeDir(home);
          try {
            if (body.verdict === "right") confirm(dir, principal, entry, Date.now(), typeof body.text === "string" ? body.text.slice(0, 500) : undefined);
            else if (body.verdict === "wrong") reject(dir, principal, entry, Date.now(), typeof body.text === "string" && body.text.trim() ? body.text.slice(0, 300) : undefined);
            else throw new Error("verdict is right or wrong");
          } catch (e) {
            throw new BadRequest((e as Error).message);
          }
          cache.clear();
          await commit(dir, `${body.verdict === "right" ? "confirm" : "retract"} ${entry}`, { Principal: principal }, log);
          log(`${principal}: ${entry} ${body.verdict}`);
          break;
        }
        case "/api/note": {
          // From you, to a terminal's session (read during its work) or to all of them.
          const known = terminals(home).map((t) => t.name);
          try {
            sendNote(YOU, str(body.to, "to", 100), typeof body.text === "string" ? body.text : "", { home, known });
          } catch (e) {
            throw new BadRequest((e as Error).message);
          }
          log(`note to ${body.to}`);
          break;
        }
        case "/api/read": {
          // A note a terminal sent you, seen.
          if (!claim(YOU, "desk", { home, id: str(body.note, "note", 100) }).length) throw new BadRequest("that note is already read");
          break;
        }
        case "/api/learn": {
          const session = str(body.session, "session", 200);
          if (!/^[\w.-]+$/.test(session)) throw new BadRequest("bad session id");
          learnNow(session);
          break;
        }
        case "/api/start": {
          // A new thread: a terminal in that folder with Copilot under that name, on the
          // desk (the default) or in a window of its own.
          const folder = path.resolve(str(body.folder, "folder", 1000));
          if (!fs.statSync(folder, { throwIfNoEntry: false })?.isDirectory()) throw new BadRequest(`no folder ${folder}`);
          const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : path.basename(folder).replace(/[^\w.-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "");
          if (!NAME.test(name)) throw new BadRequest("a name is letters, digits, '.', '-' or '_', up to 40");
          if (terminals(home).some((t) => t.name === name) || terms.running(name)) throw new BadRequest(`${name} is already open: go to it, or pick another name`);
          if (body.where === "window") {
            if (!(await launch(folder, name))) throw new BadRequest(`couldn't open a window: in a terminal, cd to ${folder} and run scripts\\windows\\copilot-here.ps1 -Name ${name}`);
          } else {
            const n = (v: unknown, d: number) => (typeof v === "number" && v > 0 ? v : d);
            terms.close(name); // one that ended under this name
            terms.open(name, folder, n(body.cols, 120), n(body.rows, 32));
          }
          log(`opened ${name} in ${folder}${body.where === "window" ? " (its own window)" : ""}`);
          break;
        }
        case "/api/term/in": {
          const data = typeof body.data === "string" ? body.data : "";
          try {
            terms.write(str(body.name, "name", 40), data);
          } catch (e) {
            throw new BadRequest((e as Error).message);
          }
          break;
        }
        case "/api/term/size": {
          try {
            terms.resize(str(body.name, "name", 40), Number(body.cols), Number(body.rows));
          } catch (e) {
            throw new BadRequest((e as Error).message);
          }
          break;
        }
        case "/api/term/close": {
          const name = str(body.name, "name", 40);
          terms.close(name);
          log(`closed ${name}'s terminal on the desk`);
          break;
        }
        case "/api/jump": {
          const terminal = str(body.terminal, "terminal");
          if (!(await jump(`copilot: ${terminal}`))) throw new BadRequest(`couldn't find a window titled "copilot: ${terminal}": start that terminal with copilot-here.ps1`);
          break;
        }
        default:
          return json(res, 404, { error: "not found" });
      }
      return json(res, 200, { ok: true });
    } catch (e) {
      const err = e as Error;
      log(`error: ${err.message.split("\n")[0]}`);
      return json(res, err instanceof BadRequest ? 400 : 500, { error: err.message.split("\n")[0].slice(0, 300) });
    }
  });

  const want = opts.port ?? 4710;
  for (let p = want; ; p++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(p, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE" || want === 0 || p - want >= 20) throw e;
    }
  }
  port = (server.address() as { port: number }).port;

  // Learning runs here, one session at a time, so analyses never pile up on your quota.
  let closed = false;
  let running: Learning["running"];
  let queued = 0;
  const analyst = opts.analyst ?? copilotAnalyst(learnConfig(home), () => {});
  const learning = (): Learning => ({ ...(running ? { running } : {}), queued, recent: cached("recent", 3000, Date.now(), () => recentAnalyses(knowledgeDir(home))) });
  const runOne = async (session: string, transcript?: string, force = false) => {
    const cwd = readLog(home).find((e) => e.session === session)?.cwd;
    running = { session, repo: cwd ? repoNameOf(cwd) : "", since: Date.now() };
    try {
      await learn(session, { home, analyst, force, ...(transcript ? { transcript } : {}), log });
    } catch (e) {
      log(`learning ${session.slice(0, 8)}: ${(e as Error).message.split("\n")[0]}`);
    } finally {
      running = undefined;
      cache.clear();
    }
  };
  let busy = false;
  const pass = async () => {
    if (busy || learnConfig(home).learn === "off") return;
    busy = true;
    try {
      const todo = toLearn(readLog(home), knowledgeDir(home));
      queued = todo.length;
      for (const t of todo) {
        if (closed) break;
        queued--;
        await runOne(t.session, t.transcript);
      }
    } finally {
      busy = false;
    }
  };
  const learnNow = (session: string) => {
    if (busy) throw new BadRequest("already learning from a session; try again in a minute");
    busy = true;
    void runOne(session, undefined, true).finally(() => (busy = false));
  };
  const learner = setInterval(() => void pass(), opts.learnEveryMs ?? 30_000);
  const first = setTimeout(() => void pass(), Math.min(opts.learnEveryMs ?? 5_000, 5_000));

  const beat = () => writeJson(pageFile(home), { at: Date.now(), pid: process.pid, url: `http://127.0.0.1:${port}/` });
  beat();
  const beating = setInterval(beat, 5_000);
  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    token,
    close: () =>
      new Promise<void>((r) => {
        // Stop holding at once rather than after the beat goes stale.
        clearInterval(beating);
        clearInterval(learner);
        clearTimeout(first);
        closed = true;
        terms.closeAll();
        fs.rmSync(pageFile(home), { force: true });
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new BadRequest("too much data"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
        resolve(v as Record<string, unknown>);
      } catch {
        reject(new BadRequest("send a JSON object"));
      }
    });
    req.on("error", reject);
  });
}
