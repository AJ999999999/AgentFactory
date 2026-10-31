// Two ways of running an engagement's turns, each a wrapper around any turn agent, so
// they can be switched on in the policy or compared in the eval (src/eval/).
//
// Worker mode: every seat that does the work runs as one worker agent, given its lane's
// skill (the role-specific part of the role's profile) instead of a role of its own.
// Judges keep their roles: an independent check needs a different reviewer.
//
// Session mode: the worker's CLI session carries over from one turn of a todo (or of a
// goal) to the next, so it remembers what it read and decided; each turn still starts in
// a fresh worktree with a fresh packet, which stay the source of truth. Judges always
// start fresh.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { TurnAgent, TurnContext } from "./agents.ts";
import type { TurnOutput } from "./validate.ts";

// The role-specific part of a role's profile: everything above its "Every turn:" rules,
// which the worker's own profile already has.
export function roleSkill(dirs: string[], role: string, prefix = "af-"): string | undefined {
  for (const d of dirs) {
    const f = path.join(d, `${prefix}${role}.agent.md`);
    if (!fs.existsSync(f)) continue;
    const body = fs.readFileSync(f, "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
    return body.split(/\r?\n\s*Every turn:/)[0].trim();
  }
  return undefined;
}

export class WorkerMode implements TurnAgent {
  name: string;
  inner: TurnAgent;
  judgeLanes: Set<string>;
  skill: (role: string) => string | undefined;
  constructor(inner: TurnAgent, opts: { judgeLanes: Iterable<string>; skill: (role: string) => string | undefined }) {
    this.inner = inner;
    this.name = `worker(${inner.name})`;
    this.judgeLanes = new Set(opts.judgeLanes);
    this.skill = opts.skill;
  }
  run(ctx: TurnContext): Promise<TurnOutput> {
    const seat = ctx.seat;
    if (!seat || this.judgeLanes.has(ctx.todo.lane)) return this.inner.run(ctx);
    // A generated role's skill is its charter; a library role's is its profile.
    const text = seat.generated ? seat.charter : this.skill(seat.agent);
    return this.inner.run({
      ...ctx,
      seat: { ...seat, agent: "worker", generated: false },
      ...(text ? { skill: { name: seat.generated ? seat.lane : seat.role, text } } : {}),
    });
  }
}

type SessionBook = Record<string, { id: string; turns: number }>;

export class SessionMode implements TurnAgent {
  name: string;
  inner: TurnAgent;
  scope: "todo" | "goal";
  dir: string;
  salt: string;
  judgeLanes: Set<string>;
  constructor(inner: TurnAgent, opts: { scope: "todo" | "goal"; dir: string; salt: string; judgeLanes: Iterable<string> }) {
    this.inner = inner;
    this.name = `sessions:${opts.scope}(${inner.name})`;
    this.scope = opts.scope;
    this.dir = opts.dir;
    this.salt = opts.salt;
    this.judgeLanes = new Set(opts.judgeLanes);
  }

  // Which turns a session has had is kept on disk: the scheduled loop starts a fresh
  // process for every wake.
  private book(): SessionBook {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, "sessions.json"), "utf8")) as SessionBook;
    } catch {
      return {};
    }
  }
  private save(b: SessionBook): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, "sessions.json"), JSON.stringify(b, null, 2));
  }

  // A stable id per engagement and todo (or goal), shaped as the UUID Copilot wants.
  sessionId(key: string): string {
    const h = createHash("sha256").update(`${this.salt}:${this.scope}:${key}`).digest("hex");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
  }

  async run(ctx: TurnContext): Promise<TurnOutput> {
    if (this.judgeLanes.has(ctx.todo.lane)) return this.inner.run(ctx); // judges look with fresh eyes
    const key = this.scope === "todo" ? `${ctx.todo.goal}/${ctx.todo.id}` : ctx.todo.goal;
    const b = this.book();
    const had = b[key] ?? { id: this.sessionId(key), turns: 0 };
    const session = { id: had.id, scope: this.scope, turn: had.turns + 1, resumed: had.turns > 0, dir: this.dir };
    try {
      return await this.inner.run({ ...ctx, session });
    } finally {
      const now = this.book();
      now[key] = { id: had.id, turns: had.turns + 1 };
      this.save(now);
    }
  }
}
