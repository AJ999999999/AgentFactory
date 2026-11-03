// The partner's panel: one page on this PC over every engagement in a workspace. It
// reads the same event log as `status` and writes through the same code as `answer`,
// so nothing it shows or does is a second copy of the state.
//
// Local only: it listens on 127.0.0.1, answers only requests addressed to that host
// (a web page elsewhere can't reach it by DNS tricks), and every API call carries a
// token that only the page it served knows (a web page elsewhere can't post to it).
import { randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { Git } from "../git.ts";
import type { TurnAgent } from "../harness/agents.ts";
import type { Answer } from "../harness/answers.ts";
import { Harness } from "../harness/harness.ts";
import { LiveTurns } from "../harness/live.ts";
import type { HarnessPolicy } from "../harness/project.ts";
import type { Direction, GoalRevision } from "../harness/types.ts";
import { SystemClock } from "../harness/world.ts";
import type { EngagementView, RunnerView } from "./view.ts";
import { engagementView } from "./view.ts";

// models: the agents policy's placeholder -> CLI mapping, so the page can say what runs
// each agent. It's the policy's mapping; a loop started with --models overrides it.
export type PanelOptions = { dir: string | string[]; policy: HarnessPolicy; models?: Record<string, string>; port?: number; log?: (line: string) => void };
export type Panel = { url: string; port: number; token: string; close: () => Promise<void> };

const PAGE = path.join(import.meta.dirname, "page.html");
const MAX_BODY = 256 * 1024;

// A request the person can fix: shown to them as is.
export class BadRequest extends Error {}

// The panel never runs turns; the loop does.
const noTurns: TurnAgent = { name: "panel", run: async () => { throw new Error("the panel doesn't run turns"); } };

// One engagement the panel shows: where it lives, and the name the page uses for it.
// That name is the engagement's id, unless two folders hold engagements with the same
// id; then each gets its folder's name after it.
type Entry = { key: string; id: string; dir: string };

export class Workspace {
  dirs: string[];
  policy: HarnessPolicy;
  models?: Record<string, string>;
  private harnesses = new Map<string, Harness>();
  private lastGood = new Map<string, EngagementView>();
  constructor(dirs: string | string[], policy: HarnessPolicy, models?: Record<string, string>) {
    this.dirs = typeof dirs === "string" ? [dirs] : dirs;
    this.policy = policy;
    this.models = models;
  }

  get dir(): string {
    return this.dirs[0];
  }

  // Read fresh each time: an engagement opened while the panel runs shows up.
  entries(): Entry[] {
    const found: Array<{ id: string; dir: string }> = [];
    for (const dir of this.dirs) {
      const root = path.join(dir, ".af", "harness");
      if (!fs.existsSync(root)) continue;
      for (const id of fs.readdirSync(root).filter((e) => fs.existsSync(path.join(root, e, "config.json"))).sort()) found.push({ id, dir });
    }
    const used = new Set<string>();
    return found.map(({ id, dir }) => {
      let key = found.filter((f) => f.id === id).length > 1 ? `${id}@${path.basename(dir)}` : id;
      for (let n = 2; used.has(key); n++) key = `${id}@${path.basename(dir)}-${n}`;
      used.add(key);
      return { key, id, dir };
    });
  }

  ids(): string[] {
    return this.entries().map((e) => e.key);
  }

  private entry(key: string): Entry {
    const e = this.entries().find((x) => x.key === key);
    if (!e) throw new BadRequest(`no engagement ${key}`);
    return e;
  }

  private home(e: Entry): string {
    return path.join(e.dir, ".af", "harness", e.id);
  }

  harness(key: string): Harness {
    const e = this.entry(key);
    // Cached by place, not by name: a name can move to another engagement when a
    // folder is added, a place can't.
    const home = this.home(e);
    let h = this.harnesses.get(home);
    if (!h) {
      const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8")) as { repo: string };
      h = new Harness({ control: new Git(cfg.repo), engagement: e.id, policy: this.policy, clock: new SystemClock(), world: {}, agent: noTurns, worktreeRoot: path.join(home, "wt") });
      this.harnesses.set(home, h);
    }
    return h;
  }

  runners(key: string): RunnerView[] {
    const dir = this.home(this.entry(key));
    const out: RunnerView[] = [];
    for (const f of fs.readdirSync(dir).filter((x) => x.startsWith("heartbeat-") && x.endsWith(".json"))) {
      try {
        const hb = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as { at: string; quiet?: boolean; next?: { at: string; why: string } };
        out.push({ id: f.slice(10, -5), at: Date.parse(hb.at), quiet: !!hb.quiet, ...(hb.next ? { next: { at: Date.parse(hb.next.at), why: hb.next.why } } : {}) });
      } catch {
        /* being rewritten */
      }
    }
    return out.sort((a, b) => b.at - a.at);
  }

  // Turns running on this PC: the loop writes their markers and logs next to its heartbeat.
  live(key: string): LiveTurns {
    return new LiveTurns(path.join(this.home(this.entry(key)), "turns"));
  }

  // Every engagement, read fresh from git. One that can't be read (remote down) shows
  // what was last read, with the error.
  async snapshot(): Promise<{ now: number; dir: string; dirs: string[]; engagements: EngagementView[] }> {
    const now = Date.now();
    const engagements = await Promise.all(this.entries().map(async (e) => {
      const home = this.home(e);
      try {
        const running = this.live(e.key).list(now);
        const v = { ...engagementView(await this.harness(e.key).state(), e.key, now, this.runners(e.key), { models: this.models, running }), running, folder: e.dir };
        this.lastGood.set(home, v);
        return v;
      } catch (err) {
        const msg = (err as Error).message.split("\n")[0].slice(0, 300);
        const last = this.lastGood.get(home);
        return last ? { ...last, id: e.key, running: this.live(e.key).list(now), error: msg } : { id: e.key, title: e.key, paused: null, capacity: [], running: this.live(e.key).list(now), goals: [], asks: [], runners: this.runners(e.key), error: msg, folder: e.dir };
      }
    }));
    return { now, dir: this.dir, dirs: this.dirs, engagements };
  }
}

// ---------- requests ----------

type AnswerBody = { engagement: string; ask: string; choice: string; relayed?: boolean; note?: string; budget?: Record<string, number>; revision?: GoalRevision; observation?: { direction: Direction; metrics?: Record<string, number>; runs?: number } };

function str(v: unknown, name: string, max = 4000): string {
  if (typeof v !== "string" || !v.length || v.length > max) throw new BadRequest(`${name} is missing or too long`);
  return v;
}

function numbers(v: unknown, name: string): Record<string, number> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new BadRequest(`${name} must be name: number pairs`);
  const out: Record<string, number> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(k) || typeof x !== "number" || !Number.isFinite(x)) throw new BadRequest(`${name}: "${k}" must be a name with a number`);
    out[k] = x;
  }
  return out;
}

export async function answerFromBody(ws: Workspace, b: AnswerBody): Promise<void> {
  const h = ws.harness(str(b.engagement, "engagement", 100));
  const s = await h.state();
  const ask = s.asks.get(str(b.ask, "ask", 200));
  if (!ask) throw new BadRequest(`no question ${b.ask}`);
  const tests = ask.todo ? s.todos.get(ask.todo)?.tests : undefined;
  const note = b.note === undefined || b.note === "" ? undefined : str(b.note, "note");
  const o = b.observation;
  if (o && !["supports", "refutes", "neutral"].includes(o.direction)) throw new BadRequest("what you saw supports, refutes, or is neutral");
  const ans: Answer = {
    // You answer as yourself. What you report counts as the parent's or the lawyer's
    // evidence only when you say you're passing on what they told you ("relayed"), as
    // with `answer --by <role>` on the command line.
    by: b.relayed === true ? ask.to : "partner",
    choice: str(b.choice, "choice", 100),
    ...(note ? { note } : {}),
    ...(b.budget ? { budget: numbers(b.budget, "budget") } : {}),
    ...(b.revision ? { revision: b.revision } : {}),
    ...(o ? { finding: { assumption: tests, direction: o.direction, text: note ?? "", ...(o.metrics ? { metrics: numbers(o.metrics, "metrics") } : {}), ...(o.runs !== undefined ? { runs: Math.max(1, Math.round(Number(o.runs)) || 1) } : {}) } } : {}),
  };
  if (b.revision !== undefined && (typeof b.revision !== "object" || b.revision === null || Array.isArray(b.revision))) throw new BadRequest("the revised goal must be a JSON object");
  await h.answer(ask.id, ans);
}

function sameToken(given: string | undefined, token: string): boolean {
  if (!given || given.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(token));
}

export async function startPanel(opts: PanelOptions): Promise<Panel> {
  const ws = new Workspace(opts.dir, opts.policy, opts.models);
  const token = randomBytes(24).toString("hex");
  const log = opts.log ?? (() => {});
  let port = 0;
  const hosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  const send = (res: http.ServerResponse, status: number, body: string, type: string) => {
    res.writeHead(status, {
      "Content-Type": type,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });
    res.end(body);
  };
  const json = (res: http.ServerResponse, status: number, v: unknown) => send(res, status, JSON.stringify(v), "application/json; charset=utf-8");

  const server = http.createServer(async (req, res) => {
    try {
      // Only requests addressed to this machine by name: a page on another site that
      // points its own domain at 127.0.0.1 still sends its own Host, and is refused.
      if (!hosts().has(req.headers.host ?? "")) return send(res, 403, "wrong host", "text/plain");
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      if (req.method === "GET" && url.pathname === "/") {
        const page = fs.readFileSync(PAGE, "utf8").replace("__TOKEN__", token);
        return send(res, 200, page, "text/html; charset=utf-8");
      }
      if (!url.pathname.startsWith("/api/")) return send(res, 404, "not found", "text/plain");
      const origin = req.headers.origin;
      if (origin !== undefined && !hosts().has(origin.replace(/^http:\/\//, ""))) return json(res, 403, { error: "wrong origin" });
      if (!sameToken(req.headers["x-panel-token"] as string | undefined, token)) return json(res, 403, { error: "this page is out of date: reload it" });

      if (req.method === "GET" && url.pathname === "/api/state") return json(res, 200, await ws.snapshot());
      if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
      if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return json(res, 415, { error: "send JSON" });
      const body = await readBody(req);
      switch (url.pathname) {
        case "/api/answer":
          await answerFromBody(ws, body as AnswerBody);
          log(`answered ${body.ask}: ${body.choice}`);
          break;
        case "/api/pause": {
          const paused = body.paused === true;
          await ws.harness(str(body.engagement, "engagement", 100)).pause(paused, "partner");
          log(`${paused ? "paused" : "resumed"} ${body.engagement}`);
          break;
        }
        case "/api/stop": {
          // The runner checks for this every second, kills the agent, throws its changes
          // away and records the turn as stopped; the work then waits for your call.
          const eng = str(body.engagement, "engagement", 100);
          ws.harness(eng); // a known engagement
          const turn = str(body.turn, "turn", 200);
          if (!ws.live(eng).requestStop(turn, "partner", Date.now())) throw new BadRequest("that turn isn't running any more");
          log(`stop requested: ${eng} ${turn}`);
          break;
        }
        case "/api/budget":
          await ws.harness(str(body.engagement, "engagement", 100)).setBudget(str(body.goal, "goal", 100), numbers(body.budget, "budget"), "partner");
          log(`budget ${body.goal}: ${JSON.stringify(body.budget)}`);
          break;
        default:
          return json(res, 404, { error: "not found" });
      }
      return json(res, 200, { ok: true });
    } catch (e) {
      // Refusals ("already answered", "a pivot needs the revised goal") and failures
      // (the remote is unreachable) are both the person's to see: the first line only.
      const err = e as Error;
      log(`error: ${err.message.split("\n")[0]}`);
      return json(res, err instanceof BadRequest ? 400 : 500, { error: err.message.split("\n")[0].slice(0, 300) });
    }
  });

  const want = opts.port ?? 4700;
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
  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    token,
    close: () => new Promise<void>((r) => {
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
