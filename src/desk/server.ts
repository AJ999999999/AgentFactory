// The desk's page: every Copilot CLI terminal on this PC, what each is waiting on, and
// the permission asks held for you, answered with one click.
//
// Same guards as the partner's panel: it listens on 127.0.0.1 only, answers only
// requests addressed to that host, and every call carries a token only the served page
// knows. While it runs it beats `page.json`; the hook holds an ask only while that beat
// is fresh, so stopping the desk hands every terminal its own prompts back.
//
// The page waits on /api/state for a change instead of polling on a timer: browsers
// slow timers in background tabs to once a minute, but not a pending request.
import { randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { runCommand } from "../proc.ts";
import { answer, type Choice, loadConfig, modesFile, pageFile, pending, readJson, type Rule, rulesFile, writeJson } from "./hold.ts";
import { deskHome, readLog } from "./log.ts";
import { deskView } from "./view.ts";

const PAGE = path.join(import.meta.dirname, "page.html");
const MAX_BODY = 64 * 1024;
const CHOICES: Choice[] = ["allow", "deny", "terminal", "always"];

class BadRequest extends Error {}

export type DeskOptions = { home?: string; port?: number; log?: (line: string) => void; jump?: (title: string) => Promise<boolean> };
export type Desk = { url: string; port: number; token: string; close: () => Promise<void> };

// Bring a terminal's window forward by the title `copilot-here.ps1` gave it. The title
// travels in an environment variable, never inside the script text.
export async function jumpWindows(title: string): Promise<boolean> {
  if (process.platform !== "win32") return false;
  try {
    const { stdout } = await runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(New-Object -ComObject WScript.Shell).AppActivate($env:AF_DESK_JUMP)"], { env: { ...process.env, AF_DESK_JUMP: title }, timeout: 10_000 });
    return stdout.trim().toLowerCase() === "true";
  } catch {
    return false;
  }
}

export function snapshot(home: string, now = Date.now()) {
  const cfg = loadConfig(home);
  // An ask the hook left behind (Copilot killed it, the PC slept) is past its wait.
  const asks = pending(home).filter((a) => now - a.at < cfg.holdSec * 1000);
  const rules = readJson<Rule[]>(rulesFile(home), []);
  const modes = readJson<Record<string, string>>(modesFile(home), {});
  return { now, holdSec: cfg.holdSec, terminals: deskView(readLog(home), asks, rules, modes, now) };
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
  const log = opts.log ?? (() => {});
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
      "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    res.end(body);
  };
  const json = (res: http.ServerResponse, status: number, v: unknown) => send(res, status, JSON.stringify(v), "application/json; charset=utf-8");

  const server = http.createServer(async (req, res) => {
    try {
      if (!hosts().has(req.headers.host ?? "")) return send(res, 403, "wrong host", "text/plain");
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      if (req.method === "GET" && url.pathname === "/") return send(res, 200, fs.readFileSync(PAGE, "utf8").replace("__TOKEN__", token), "text/html; charset=utf-8");
      if (!url.pathname.startsWith("/api/")) return send(res, 404, "not found", "text/plain");
      const origin = req.headers.origin;
      if (origin !== undefined && !hosts().has(origin.replace(/^http:\/\//, ""))) return json(res, 403, { error: "wrong origin" });
      const given = req.headers["x-desk-token"];
      if (typeof given !== "string" || given.length !== token.length || !timingSafeEqual(Buffer.from(given), Buffer.from(token))) return json(res, 403, { error: "this page is out of date: reload it" });

      if (req.method === "GET" && url.pathname === "/api/state") {
        const since = url.searchParams.get("since");
        const until = Date.now() + Math.min(Number(url.searchParams.get("wait") ?? 25_000) || 0, 25_000);
        for (;;) {
          const snap = snapshot(home);
          const version = fingerprint(snap);
          if (version !== since || Date.now() >= until || req.destroyed) return json(res, 200, { ...snap, version });
          await new Promise((r) => setTimeout(r, 400));
        }
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
