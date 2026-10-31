// Simulation driver: runs runners against a simulated clock, answers asks the way a
// scripted person would (late, partially, or never), and jumps the clock to the next
// wake-up. Months of an engagement run in seconds, through the real harness, git and
// all; only the agents, the world and the people are scripted.
import * as path from "node:path";
import type { Git } from "../git.ts";
import { createWorkspace } from "../foundation/workspace.ts";
import type { TurnAgent } from "./agents.ts";
import type { Answer } from "./answers.ts";
import type { TickResult } from "./harness.ts";
import { Harness } from "./harness.ts";
import type { AskState, HarnessPolicy, State } from "./project.ts";
import type { Runner } from "./select.ts";
import type { EngagementDef } from "./types.ts";
import type { World } from "./world.ts";
import { SimClock } from "./world.ts";

const MIN = 60_000;

export type Person = {
  role: string;
  // Answer an ask, or return null to leave it (a person who is away, or waiting).
  answer: (a: AskState, s: State, now: number) => Answer | null;
  delayMinutes?: (a: AskState) => number; // how long until they get to it
  awayUntil?: number;
};

export type SimLog = { at: number; kind: string; detail: string };

export class Sim {
  clock: SimClock;
  harness: Harness;
  runners: Array<{ runner: Runner; slots: number }>;
  people: Person[];
  log: SimLog[] = [];
  ticks: TickResult[] = [];
  stalls = 0;

  constructor(opts: { harness: Harness; clock: SimClock; runners: Array<{ runner: Runner; slots?: number }>; people: Person[] }) {
    this.harness = opts.harness;
    this.clock = opts.clock;
    this.runners = opts.runners.map((r) => ({ runner: r.runner, slots: r.slots ?? 1 }));
    this.people = opts.people;
  }

  static async create(opts: {
    dir: string;
    def: EngagementDef;
    policy: HarnessPolicy;
    start: string;
    world: World;
    agent: TurnAgent;
    runners: Array<{ runner: Runner; slots?: number }>;
    people: Person[];
    seed?: (repo: Git) => Promise<void>;
  }): Promise<Sim> {
    const control = await createWorkspace({ dir: opts.dir });
    if (opts.seed) await opts.seed(control);
    const clock = new SimClock(opts.start);
    const harness = new Harness({ control, engagement: opts.def.id, policy: opts.policy, clock, world: opts.world, agent: opts.agent, worktreeRoot: path.join(opts.dir, "wt") });
    await harness.open(opts.def);
    return new Sim({ harness, clock, runners: opts.runners, people: opts.people });
  }

  note(kind: string, detail: string): void {
    this.log.push({ at: this.clock.now(), kind, detail });
  }

  private async answerDue(): Promise<{ answered: number; nextAt: number | null }> {
    const s = await this.harness.state();
    const now = this.clock.now();
    let answered = 0;
    let nextAt: number | null = null;
    for (const a of [...s.asks.values()].filter((x) => x.status === "open").sort((x, y) => x.openedAt - y.openedAt)) {
      const p = this.people.find((x) => x.role === a.to) ?? this.people.find((x) => x.role === "partner");
      if (!p) continue;
      const due = Math.max(a.openedAt + (p.delayMinutes?.(a) ?? 60) * MIN, p.awayUntil ?? 0);
      if (due > now) {
        nextAt = nextAt === null ? due : Math.min(nextAt, due);
        continue;
      }
      // An earlier answer in this pass may have made this one moot.
      const fresh = await this.harness.state();
      if (fresh.asks.get(a.id)?.status !== "open") continue;
      const ans = p.answer(a, fresh, now);
      if (!ans) continue;
      await this.harness.answer(a.id, { ...ans, by: ans.by ?? p.role });
      this.note("answer", `${a.id} -> ${ans.choice} by ${ans.by ?? p.role}`);
      answered++;
    }
    return { answered, nextAt };
  }

  // Run until every goal is closed, nothing is pending, or the clock passes `until`.
  async run(opts: { until: string; maxIterations?: number }): Promise<void> {
    const until = Date.parse(opts.until);
    let idle = 0;
    for (let i = 0; i < (opts.maxIterations ?? 400); i++) {
      const hints: TickResult["hint"][] = [];
      let did = 0;
      for (const r of this.runners) {
        const t = await this.harness.tick(r.runner, { slots: r.slots });
        this.ticks.push(t);
        hints.push(t.hint);
        did += t.maintenance.length + t.turns.length + t.started.length;
        for (const x of t.turns) this.note("turn", `${r.runner.id} ${x.todo}: ${x.result}/${x.granularity}${x.reasons.length ? ` (${x.reasons.join("; ")})` : ""}`);
        for (const x of t.started) this.note("start", `${r.runner.id} ${x}`);
      }
      const { answered, nextAt } = await this.answerDue();
      did += answered;
      if (did) {
        idle = 0;
        continue;
      }
      const now = this.clock.now();
      // The sim knows when its people will act, so it can jump straight to the next
      // real event instead of waking on the recheck cap.
      const timers = hints.filter((h) => h.action !== "stop" && !h.idle).map((h) => (h.action === "run_now" ? h.at : h.timer ?? h.at));
      if (nextAt !== null) timers.push(nextAt);
      if (!timers.length) {
        this.note("end", hints.every((h) => h.action === "stop") ? "every goal closed" : "only people can move things now");
        return;
      }
      let next = Math.min(...timers);
      if (next <= now) {
        // A wake that is "due" but does nothing: never spin on it.
        if (++idle > 2) {
          this.stalls++;
          next = now + MIN;
        } else continue;
      }
      if (next > until) {
        this.clock.set(until);
        this.note("end", "reached the end of the simulated window");
        return;
      }
      this.clock.set(next);
    }
    this.note("end", "iteration cap");
  }
}

export function day(iso: string, days: number): number {
  return Date.parse(iso) + days * 86_400_000;
}
