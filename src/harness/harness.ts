// The harness: one wake ("tick") at a time. Every tick starts from git, never from
// memory or a transcript, so a runner can crash, restart, or run on another machine
// and pick up exactly where things stand.
//
// A tick:
//   1. reaps expired claims (a dead runner's turn counts as a failed turn)
//   2. checks due monitors; a change bumps basis, adds work or asks someone
//   3. polls running jobs and waits; results become findings, graded by the world
//   4. starts jobs and waits that are ready on this runner
//   5. applies the rules (kill criteria, spin, money, contradictions, ...)
//   6. commits what changed in one commit, then picks at most `slots` tasks for
//      model turns: claim, run in a worktree, validate, write back, release
//   7. says when to wake next. Quiet ticks cost nothing and commit nothing.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Git } from "../git.ts";
import { Coordinator } from "../orchestrator.ts";
import { basisRef, currentBasis, readLockfile, writeBasis, writeLockfile, writeTask } from "../context.ts";
import type { LogFn } from "../util.ts";
import { sha256 } from "../util.ts";
import type { AgentRunner } from "../agents/runner.ts";
import type { TurnAgent } from "./agents.ts";
import { Claims, Pulse } from "./claims.ts";
import type { Claim, PulseData } from "./claims.ts";
import { buildPacket } from "./packet.ts";
import type { AskState, HarnessPolicy, State, TodoState } from "./project.ts";
import { apply, beliefs, compare, findAssumption, openAsks, project, seatOf, seatPermissions } from "./project.ts";
import { settle } from "./rules.ts";
import type { Answer } from "./answers.ts";
import { answerEvents } from "./answers.ts";
import type { Hint, Runner } from "./select.ts";
import { blockers, nextPollAt, nextWake, rank, readyTodos, ts } from "./select.ts";
import { appendEvents, eid, readEvents, readSynced, safeId, writeEventFiles } from "./store.ts";
import type { Budget, EngagementDef, Finding, HEvent, TurnRecord } from "./types.ts";
import type { TurnOutput } from "./validate.ts";
import { criteriaHash, validateTurn } from "./validate.ts";
import type { Clock, World } from "./world.ts";

const MIN = 60_000;
const DAY = 86_400_000;

export type TickResult = {
  runner: string;
  at: number;
  maintenance: HEvent[];
  turns: Array<{ todo: string; result: string; granularity: string; reasons: string[] }>;
  started: string[];
  hint: Hint;
  quiet?: boolean;
};

const noRunner: AgentRunner = { name: "none", run: async () => ({ ok: false, changedFiles: [], costTokens: 0, transcript: [], error: "unused" }) };

export class Harness {
  control: Git;
  engagement: string;
  policy: HarnessPolicy;
  clock: Clock;
  world: World;
  agent: TurnAgent;
  claims: Claims;
  pulse: Pulse;
  coord: Coordinator;
  log: LogFn;
  // What memory says about the people the engagement serves, as packet lines.
  about: (s: State) => string[];

  constructor(opts: { control: Git; engagement: string; policy: HarnessPolicy; clock: Clock; world: World; agent: TurnAgent; worktreeRoot: string; slots?: number; log?: LogFn; about?: (s: State) => string[] }) {
    if (opts.policy.claims.turnTimeoutMinutes >= opts.policy.claims.ttlMinutes) throw new Error("turn timeout must be shorter than the claim TTL, or a slow turn could outlive its claim");
    if (!safeId(opts.engagement)) throw new Error(`bad engagement id ${opts.engagement}`);
    this.control = opts.control;
    this.engagement = opts.engagement;
    this.policy = opts.policy;
    this.clock = opts.clock;
    this.world = opts.world;
    this.agent = opts.agent;
    this.claims = new Claims(opts.control, opts.engagement);
    this.pulse = new Pulse(opts.control, opts.engagement);
    this.log = opts.log ?? (() => {});
    this.about = opts.about ?? (() => []);
    this.coord = new Coordinator({ control: opts.control, worktreeRoot: opts.worktreeRoot, runner: noRunner, concurrency: opts.slots ?? 2, log: this.log });
  }

  // ---------- opening an engagement ----------

  async open(def: EngagementDef): Promise<void> {
    if (def.id !== this.engagement) throw new Error(`engagement id ${def.id} != ${this.engagement}`);
    const now = this.clock.now();
    const by = "partner";
    const events: HEvent[] = [];
    const { goals, ...meta } = def;
    events.push({ id: eid("open", def.id), at: now, by, type: "engagement_opened", engagement: meta });
    const basisNames = new Set<string>();
    for (const g of goals) {
      if (!safeId(g.id)) throw new Error(`bad goal id ${g.id}`);
      events.push({ id: eid("goal", g.id), at: now, by, type: "goal_opened", goal: g, criteriaHash: criteriaHash(g) });
      for (const [i, d] of (g.todos ?? []).entries()) {
        const id = d.id ?? eid(g.id, "seed", i);
        if (!safeId(id)) throw new Error(`bad todo id ${id}`);
        events.push({ id: `add-${id}`, at: now, by, type: "todo_added", todo: { ...d, id, goal: g.id }, provenance: "seed" });
      }
      for (const m of g.monitors ?? []) if (m.basis) basisNames.add(m.basis);
    }
    await appendEvents(this.control, this.engagement, events, `open engagement ${def.id}`, {}, (repo) => {
      // Monitored sources become versioned basis, so artifacts built on them are
      // pinned and go stale when the source changes.
      writeTask(repo, {
        id: def.id, goal: def.title, rules: [], basis: [...basisNames], criteria: "",
        permissions: { author: ["goal", "rules", "state", "evidence"], reviewer: ["goal", "rules", "state", "evidence", "results"] },
      });
      for (const name of basisNames) if (!currentBasis(repo, def.id, name)) writeBasis(repo, def.id, name, { fingerprint: "initial" }, "open");
    });
    // Run the rules once, so the team is staffed and the first questions (an intake
    // action, a spend) are waiting the moment the engagement is opened.
    const s = await this.state();
    const follow = settle(s, now);
    if (follow.length) await appendEvents(this.control, this.engagement, follow, `harness: open ${def.id}`);
  }

  async state(knownMain?: string): Promise<State> {
    const main = knownMain ?? (await this.control.runAsync(["ls-remote", "origin", "refs/heads/main"])).split("\t")[0];
    return project(await readSynced(this.control, this.engagement, main), this.policy);
  }

  // Every ref the harness cares about, from one ls-remote.
  async remoteRefs(): Promise<Map<string, string>> {
    const out = await this.control.runAsync(["ls-remote", "origin", "refs/heads/main", `refs/claims/${this.engagement}/*`, `refs/pulse/${this.engagement}`]);
    const m = new Map<string, string>();
    for (const line of out.split("\n").filter(Boolean)) {
      const [sha, ref] = line.split("\t");
      m.set(ref, sha);
    }
    return m;
  }

  // ---------- answering ----------

  async answer(askId: string, ans: Answer): Promise<HEvent[]> {
    const s = await this.state();
    const events = answerEvents(s, askId, ans, this.clock.now());
    for (const e of events) apply(s, e);
    const follow = settle(s, this.clock.now());
    await appendEvents(this.control, this.engagement, [...events, ...follow], `answer ${askId}: ${ans.choice}`, { Ask: askId, "Answered-by": ans.by });
    return events;
  }

  // ---------- the partner's controls ----------

  // Pause: nothing new starts (turns, jobs, waits, people's tasks) until resumed.
  // Running jobs and waits are still polled, so no result is lost. Returns false when
  // it was already in that state.
  async pause(paused: boolean, by = "partner", reason?: string): Promise<boolean> {
    const s = await this.state();
    if (!!s.paused === paused) return false;
    const now = this.clock.now();
    const e: HEvent = { id: eid(paused ? "pause" : "resume", now), at: now, by, type: "paused", paused, ...(reason ? { reason } : {}) };
    apply(s, e);
    const follow = settle(s, now);
    await appendEvents(this.control, this.engagement, [e, ...follow], `${paused ? "pause" : "resume"} ${this.engagement}`, { "Changed-by": by });
    return true;
  }

  // A new budget for a goal. When the harness has already asked about the budget, this
  // is the answer to that question (so it doesn't stay open); otherwise it's recorded
  // as a change made by the partner.
  async setBudget(goalId: string, budget: Budget, by = "partner"): Promise<void> {
    for (const [k, v] of Object.entries(budget)) if (!(typeof v === "number" && Number.isFinite(v) && v >= 0)) throw new Error(`budget ${k} must be a number of 0 or more`);
    const s = await this.state();
    const g = s.goals.get(goalId);
    if (!g) throw new Error(`no goal ${goalId}`);
    if (g.status !== "active") throw new Error(`${goalId} is ${g.status}`);
    const asked = openAsks(s, goalId).find((a) => a.origin.startsWith("rule:budget") && a.options.some((o) => o.id === "raise" && o.effect?.type === "budget"));
    if (asked) {
      await this.answer(asked.id, { by, choice: "raise", budget });
      return;
    }
    const now = this.clock.now();
    const e: HEvent = { id: eid("budget", goalId, g.budgetVersion + 1, now), at: now, by, type: "budget_set", goal: goalId, budget: { ...g.def.budget, ...budget } };
    apply(s, e);
    const follow = settle(s, now);
    await appendEvents(this.control, this.engagement, [e, ...follow], `budget ${goalId}: ${Object.entries(budget).map(([k, v]) => `${k}=${v}`).join(", ")}`, { "Changed-by": by });
  }

  // ---------- the tick ----------

  private last = new Map<string, { main: string; hint: Hint }>();

  // The quiet-wake memory (main's commit and the last hint), so a runner a scheduler
  // starts fresh every few minutes can still skip a wake with one ls-remote.
  memory(runnerId: string): { main: string; hint: Hint } | undefined {
    return this.last.get(runnerId);
  }
  remember(runnerId: string, m: { main: string; hint: Hint }): void {
    this.last.set(runnerId, m);
  }
  private claimsAtStart: Promise<Claim[]> = Promise.resolve([]);

  async tick(runner: Runner, opts: { slots?: number } = {}): Promise<TickResult> {
    const now = this.clock.now();
    // Quiet wake: main hasn't moved and no timer is due. One ls-remote, nothing else.
    const refs = await this.remoteRefs();
    const main = refs.get("refs/heads/main") ?? "";
    const prev = this.last.get(runner.id);
    if (prev && prev.main === main && prev.hint.action === "sleep" && now < prev.hint.at) {
      return { runner: runner.id, at: now, maintenance: [], turns: [], started: [], hint: prev.hint, quiet: true };
    }
    let s = await this.state(main);
    const pulse = mergePulse((await this.pulse.read(refs)).data, this.memPulse);
    const pulseOut: PulseData = { monitors: {}, polls: {} };
    const events: HEvent[] = [];
    const add = (e: HEvent) => {
      if (s.eventIds.has(e.id) || events.some((x) => x.id === e.id)) return;
      apply(s, e);
      events.push(e);
    };
    const basisWrites: Array<(repo: string) => void> = [];

    // 1. reap: path leases left by a dead runner (wall-clock TTL), then expired claims
    await this.coord.leases.reapExpired(Date.now());
    for (const c of await this.claims.reapExpired(now, refs)) {
      const rec: TurnRecord = { id: c.turn, todo: c.todo, goal: s.todos.get(c.todo)?.goal ?? "", agent: c.agent, result: "host_failure", granularity: "none", reasons: ["runner died or hung: claim expired"], files: [] };
      if (rec.goal) add({ id: `turn-${c.turn}`, at: now, by: "harness", type: "turn", turn: rec });
    }

    // 2. monitors
    for (const g of s.goals.values()) {
      if (g.status !== "active" || !this.world.probe) continue;
      for (const m of g.def.monitors ?? []) {
        const key = `${g.id}/${m.id}`;
        const exp = ts(m.expiresAt);
        if (exp !== undefined && exp <= now) continue; // expired monitors never catch up
        const last = pulse.monitors[key]?.checkedAt;
        if (last !== undefined && last + m.cadenceMinutes * MIN > now) continue;
        const res = await this.world.probe.check(m.target, now);
        pulseOut.monitors[key] = { checkedAt: now };
        const prev = s.sources.get(key);
        if (prev && prev.fingerprint === res.fingerprint) continue;
        add({ id: eid("src", g.id, m.id, res.fingerprint), at: now, by: "harness", type: "source_changed", goal: g.id, monitor: m.id, fingerprint: res.fingerprint, summary: prev ? res.summary : `baseline: ${res.summary}` });
        if (!prev) continue; // first look is a baseline, not a change
        if (m.basis) {
          const name = m.basis;
          basisWrites.push((repo) => {
            const cur = currentBasis(repo, this.engagement, name)?.value as { fingerprint?: string } | undefined;
            if (cur?.fingerprint !== res.fingerprint) writeBasis(repo, this.engagement, name, { fingerprint: res.fingerprint, summary: res.summary }, `monitor:${m.id}`);
          });
        }
        if (m.onChange.todo) {
          const id = eid("mon", g.id, m.id, res.fingerprint);
          add({ id: `add-${id}`, at: now, by: "harness", type: "todo_added", todo: { ...m.onChange.todo, id, goal: g.id, text: m.onChange.todo.text.replace("{summary}", res.summary), because: `monitor:${m.id}` }, provenance: `monitor:${m.id}` });
        }
        if (m.onChange.ask) {
          const id = eid("ask-mon", g.id, m.id, res.fingerprint);
          add({ id, at: now, by: "harness", type: "ask_opened", ask: { id, goal: g.id, to: m.onChange.ask.to, kind: "decision", urgent: m.urgent, origin: `monitor:${m.id}`, question: `${m.onChange.ask.question} (${res.summary})`, options: [{ id: "noted", label: "Noted", effect: { type: "ack" } }, { id: "stop", label: "Stop this goal", effect: { type: "close", status: "killed" } }] } });
        }
      }
    }

    // 3. polls
    for (const t of [...s.todos.values()]) {
      if (t.status !== "running" || (t.kind !== "job" && t.kind !== "wait")) continue;
      if (nextPollAt(s, t, pulse, now) > now) continue;
      pulseOut.polls[t.id] = { at: now, n: (pulse.polls[t.id]?.n ?? 0) + 1 };
      if (t.kind === "job") {
        const eta = await this.pollJob(s, t, now, add);
        if (eta !== undefined) pulseOut.polls[t.id].eta = eta;
      } else await this.pollWait(s, t, now, add);
    }

    // 4. rules, then revalidation of artifacts built on a superseded basis
    for (const e of settle(s, now)) events.push(e);
    if (basisWrites.length) {
      await appendEvents(this.control, this.engagement, events.splice(0), `harness: ${runner.id} maintenance`, {}, (repo) => basisWrites.forEach((w) => w(repo)));
      s = await this.state();
    }
    for (const e of this.revalidations(s, now)) add(e);
    for (const e of settle(s, now)) events.push(e);

    // 5. commit maintenance
    const maintenance = [...events];
    if (events.length) await appendEvents(this.control, this.engagement, events, `harness: ${runner.id} maintenance`);
    await this.writePulse(pulseOut, now);

    // 6. start ready jobs and waits on this runner. Launching costs real money or GPU
    // time, so it happens under a claim: two runners never launch the same job.
    const started: string[] = [];
    for (const t of readyTodos(s, now, runner, new Set(), ["job", "wait"])) {
      if (t.kind === "job" && !this.world.jobs) continue;
      if (t.kind === "wait" && !this.world.metrics?.[t.wait!.source]) continue;
      const claim = await this.claims.tryClaim(t.id, runner.id, eid("launch", t.id, sha256(`${runner.id}-${now}-${Math.random()}`).slice(0, 6)), now + this.policy.claims.ttlMinutes * MIN);
      if (!claim) continue;
      try {
        const fresh = (await this.state()).todos.get(t.id);
        if (!fresh || fresh.status !== "open") continue;
        const handle = t.kind === "job" ? await this.world.jobs!.start(fresh, now) : `wait:${t.wait!.source}`;
        const ev: HEvent[] = [{ id: eid("start", t.id, fresh.failures, fresh.turns, handle), at: now, by: runner.id, type: "todo_started", todo: t.id, handle }];
        if (t.cost?.usd) ev.push({ id: eid("spend", t.id, handle), at: now, by: runner.id, type: "spend", goal: t.goal, todo: t.id, usd: t.cost.usd });
        await appendEvents(this.control, this.engagement, ev, `harness: start ${t.id}`);
        maintenance.push(...ev);
        started.push(t.id);
      } finally {
        await this.claims.release(claim);
      }
    }
    if (started.length) s = await this.state();

    // 7. model turns

    const turns: TickResult["turns"] = [];
    this.claimsAtStart = maintenance.length || started.length ? this.claims.list() : this.claims.list(refs);
    const claimed = new Set((await this.claimsAtStart).map((c) => c.todo));
    const picks: Array<{ todo: TodoState; why: string }> = [];
    for (let i = 0; i < (opts.slots ?? 1); i++) {
      const pick = rank(s, readyTodos(s, now, runner, claimed, ["task"]), now);
      if (!pick) break;
      claimed.add(pick.todo.id);
      picks.push(pick);
    }
    const results = await Promise.all(picks.map((p) => this.turn(runner, p.todo, p.why, now).catch(async (e: Error) => {
      // A bug or a failed merge: record it as a failed turn so the retry cap applies.
      this.log("turn_error", { todo: p.todo.id, error: e.message });
      const turnId = eid(p.todo.id, "err", sha256(`${now}-${Math.random()}`).slice(0, 6));
      await appendEvents(this.control, this.engagement, [turnEvent(turnId, p.todo, runner.id, now, p.why, "host_failure", [e.message.slice(0, 300)], [])], `turn ${p.todo.id}: host_failure`);
      return { todo: p.todo.id, result: "host_failure", granularity: "none", reasons: [e.message] };
    })));
    for (const r of results) if (r) turns.push(r);

    // 8. settle what the turns changed (a flipped belief, a spin streak) right away
    const wrote = maintenance.length > 0 || turns.length > 0 || started.length > 0;
    if (wrote) s = await this.state();
    if (turns.length) {
      const after = settle(s, now);
      if (after.length) {
        await appendEvents(this.control, this.engagement, after, `harness: ${runner.id} after turns`);
        maintenance.push(...after);
        s = await this.state();
      }
    }

    // 9. next wake
    const claims = wrote ? await this.claims.list() : await this.claimsAtStart;
    const readyNow = readyTodos(s, now, runner, new Set(claims.map((c) => c.todo)), ["task", "job", "wait"]).length > 0;
    const pulseNow = mergePulse(pulse, pulseOut);
    const hint = nextWake(s, now, { readyNow, pulse: pulseNow, claimExpiries: claims.map((c) => c.expiresAt) });
    const mainAfter = wrote ? (await this.control.runAsync(["ls-remote", "origin", "refs/heads/main"])).split("\t")[0] : main;
    this.last.set(runner.id, { main: mainAfter, hint });
    this.log("tick", { runner: runner.id, at: new Date(now).toISOString(), maintenance: maintenance.length, turns: turns.map((t) => `${t.todo}:${t.result}`), hint });
    return { runner: runner.id, at: now, maintenance, turns, started, hint };
  }

  // The pulse lives in memory between ticks and is written to its ref when a poll moved
  // (job backoff matters across runners) or every 12 hours for monitor checks. A
  // restart loses at most one round of "already checked": one extra check.
  private memPulse: PulseData = { monitors: {}, polls: {} };
  private pulseWrittenAt = -Infinity;

  private async writePulse(out: PulseData, now: number): Promise<void> {
    this.memPulse = mergePulse(this.memPulse, out);
    const polled = Object.keys(out.polls).length > 0;
    if (!polled && !(Object.keys(out.monitors).length && now - this.pulseWrittenAt >= 12 * 60 * MIN)) return;
    const mem = this.memPulse;
    await this.pulse.update((d) => Object.assign(d, mergePulse(d, mem)));
    this.pulseWrittenAt = now;
  }

  // Results of jobs and waits become findings. The direction comes from comparing the
  // metric with the threshold registered before the data existed.
  private informFindings(s: State, t: TodoState, metrics: Record<string, number>, grade: Finding["grade"], runs: number, now: number): HEvent[] {
    const out: HEvent[] = [];
    const informs = (t.kind === "job" ? t.job?.informs : t.wait?.informs) ?? [];
    const source = t.kind === "job" ? `job:${t.id}` : `metric:${t.wait!.source}`;
    const mk = (suffix: string, f: Omit<Finding, "id">): HEvent => {
      const id = eid("res", t.id, t.failures, suffix);
      return { id, at: now, by: "harness", type: "finding", finding: { ...f, id } };
    };
    if (!informs.length) out.push(mk("m", { goal: t.goal, direction: "neutral", grade, source, author: source, text: `${t.text}: ${JSON.stringify(metrics)}`, metrics, runs, todo: t.id }));
    for (const inf of informs) {
      const a = findAssumption(s, t.goal, inf.assumption);
      const thr = a?.def.threshold?.metric === inf.metric ? a.def.threshold : inf.threshold;
      const v = metrics[inf.metric];
      const direction = !a || !thr || v === undefined ? "neutral" : compare(v, thr.op, thr.value) ? "supports" : "refutes";
      out.push(mk(inf.assumption, {
        goal: a?.goal ?? t.goal, assumption: inf.assumption, direction, grade, source, author: source, runs, todo: t.id, metrics,
        text: v === undefined ? `${inf.metric} missing from results` : `${inf.metric} = ${v} (pass: ${thr ? `${thr.op} ${thr.value}` : "no threshold"})`,
      }));
    }
    return out;
  }

  private async pollJob(s: State, t: TodoState, now: number, add: (e: HEvent) => void): Promise<number | undefined> {
    const r = await this.world.jobs!.poll(t.handle!, now);
    if (r.status === "running") return r.eta;
    add({ id: eid("fin", t.id, t.failures, t.handle ?? ""), at: now, by: "harness", type: "job_finished", todo: t.id, status: r.status, metrics: r.metrics, gpuHours: r.gpuHours });
    if (r.status === "failed") return;
    for (const e of this.informFindings(s, t, r.metrics, "measured", t.job?.runs ?? 1, now)) add(e);
    add({ id: eid("done", t.id), at: now, by: "harness", type: "todo_done", todo: t.id });
  }

  private async pollWait(s: State, t: TodoState, now: number, add: (e: HEvent) => void): Promise<void> {
    const w = t.wait!;
    const src = this.world.metrics?.[w.source];
    if (!src) return;
    const metrics = await src.read(t.startedAt!, now, t);
    const days = (now - t.startedAt!) / DAY;
    const reached = !w.until || (metrics[w.until.metric] ?? 0) >= w.until.atLeast;
    const finished = (days >= (w.minDays ?? 0) && reached) || (w.maxDays !== undefined && days >= w.maxDays);
    if (!finished) return;
    for (const e of this.informFindings(s, t, metrics, src.grade, 1, now)) add(e);
    add({ id: eid("done", t.id), at: now, by: "harness", type: "todo_done", todo: t.id });
  }

  // An artifact pinned to a basis version that has since been superseded is stale;
  // the todo that built it gets a revalidation successor (with the same reviewer).
  private revalidations(s: State, now: number): HEvent[] {
    const out: HEvent[] = [];
    for (const t of s.todos.values()) {
      if (t.status !== "done" || !t.artifact || !t.pins?.length) continue;
      const lock = readLockfile(this.control.cwd, t.artifact);
      if (!lock) continue;
      const stale = lock.basis.filter((ref) => {
        const [, rest] = ref.split("/");
        const [name, v] = rest.split("@v");
        const cur = currentBasis(this.control.cwd, this.engagement, name);
        return cur && cur.version > Number(v);
      });
      if (!stale.length) continue;
      const id = eid("reval", t.id, sha256(stale.join()).slice(0, 8));
      if (s.todos.has(id)) continue;
      out.push({
        id: `add-${id}`, at: now, by: "harness", type: "todo_added", provenance: `rule:stale_basis`,
        todo: {
          id, goal: t.goal, lane: t.lane, kind: "task", priority: 0, text: `Revalidate ${t.artifact}: built on ${stale.join(", ")}, which changed since. (${t.text})`,
          writeScope: t.writeScope, artifact: t.artifact, pins: t.pins, check: t.check, review: t.review, because: t.id, tests: t.tests,
        },
      });
    }
    return out;
  }

  // ---------- one model turn ----------

  private async turn(runner: Runner, t: TodoState, why: string, now: number): Promise<TickResult["turns"][number] | null> {
    const turnId = eid(t.id, t.turns + 1, sha256(`${runner.id}-${now}-${Math.random()}`).slice(0, 6));
    const claim = await this.claims.tryClaim(t.id, runner.id, turnId, now + this.policy.claims.ttlMinutes * MIN);
    if (!claim) return null; // someone else got it first
    try {
      // The view we picked from may be stale: re-check on fresh state after claiming.
      const s = await this.state();
      const fresh = s.todos.get(t.id);
      if (!fresh || blockers(s, fresh, now, runner).length) return null;
      return await this.runTurn(runner, s, fresh, why, turnId, claim, now);
    } finally {
      await this.claims.release(claim);
    }
  }

  private async runTurn(runner: Runner, s: State, t: TodoState, why: string, turnId: string, claim: Claim, now: number): Promise<TickResult["turns"][number]> {
    let summary: TickResult["turns"][number] = { todo: t.id, result: "host_failure", granularity: "none", reasons: [] };
    const g = s.goals.get(t.goal)!;
    // Who does it: the lane's seat (role, model, permissions), when there's a team.
    const seatState = seatOf(s, t);
    const seat = seatState ? { ...seatState, effective: seatPermissions(s, seatState) } : undefined;
    // Path leases guard the files; the claim already guards the todo. A turn that
    // writes nothing gets a lease on a path of its own.
    const lockPaths = t.writeScope?.length ? t.writeScope : [`.agents/harness/${this.engagement}/turns/${turnId}`];
    await this.coord.transaction({
      id: turnId,
      identity: { name: runner.id, email: `${runner.id}@agents.local` },
      lockPaths,
      leaseTtlMs: this.policy.claims.ttlMinutes * MIN,
      work: async (wtDir, wt) => {
        let about: string[] = [];
        try {
          about = this.about(s);
        } catch (e) {
          this.log("memory_unreadable", { error: (e as Error).message });
        }
        const packet = buildPacket(s, t, why, about);
        const relevant = [...s.findings.values()].filter((f) => f.assumption && (f.assumption === t.tests || (t.assumes ?? []).includes(f.assumption)));
        let output: TurnOutput | null = null;
        let hostError = "";
        try {
          output = await withTimeout(
            this.agent.run({ turn: turnId, agent: runner.id, now, packet, todo: t, goal: g.def, beliefs: beliefs(s, g.id), findings: relevant, wtDir, state: s, seat }),
            this.policy.claims.turnTimeoutMinutes * MIN,
          );
        } catch (e) {
          hostError = (e as Error).message.slice(0, 300);
        }
        const files = await wt.changedFiles();
        let events: HEvent[];
        if (!output) {
          await discard(wt);
          events = [turnEvent(turnId, t, runner.id, now, why, "host_failure", [hostError || "no output"], files, seat?.key)];
        } else {
          const { failures, checked } = await this.runCheckers(wtDir, t, files);
          const v = validateTurn({ s, todo: t, agent: runner.id, turn: turnId, now, why, output, files, checkFailures: failures, checked, wtDir, knownSources: Object.keys(this.world.metrics ?? {}), seat: seatState });
          if (v.result === "validation_failed") await discard(wt);
          else if (t.artifact && t.pins?.length && v.result === "completed") {
            writeLockfile(wtDir, {
              artifact: t.artifact, task: this.engagement, builtBy: `${runner.id}:${t.id}`, config: `todo:${t.id}`,
              basis: t.pins.map((name) => basisRef(this.engagement, name, currentBasis(wtDir, this.engagement, name)?.version ?? 1)),
              inputs: [], builtAt: new Date(now).toISOString(),
            });
          }
          events = v.events;
        }
        // A turn that outlived its claim must not overwrite whoever took over.
        if (!(await this.claims.holds(claim))) {
          await discard(wt);
          events = [turnEvent(turnId, t, runner.id, now, why, "claim_lost", ["claim expired before writeback"], files, seat?.key)];
        }
        // Scratch never lands in history.
        fs.rmSync(path.join(wtDir, ".agents", "session.json"), { force: true });
        writeEventFiles(wtDir, this.engagement, events);
        const rec = (events.find((e) => e.type === "turn") as Extract<HEvent, { type: "turn" }>).turn;
        summary = { todo: t.id, result: rec.result, granularity: rec.granularity, reasons: rec.reasons };
        return {
          message: `turn ${t.id}: ${rec.result} (${rec.granularity})`,
          trailers: { Engagement: this.engagement, Turn: turnId, Todo: t.id, Agent: runner.id, ...(seat ? { Seat: `${seat.key} ${seat.template}${seat.probation ? " (probation)" : ""}` } : {}), Result: rec.result },
        };
      },
    });
    // Consequences of the turn (a flipped belief, a spin streak) are settled on the
    // next tick's rules pass; nothing waits on them here.
    return summary;
  }

  private async runCheckers(wtDir: string, t: TodoState, files: string[]): Promise<{ failures: string[]; checked: boolean }> {
    const failures: string[] = [];
    const checkers = this.world.checkers ?? {};
    for (const name of this.redLines()) {
      const fn = checkers[name];
      if (!fn) failures.push(`red line checker ${name} is not registered`);
      else failures.push(...(await fn(wtDir, { todo: t, files })).map((f) => `red line ${name}: ${f}`));
    }
    let checked = false;
    if (t.check) {
      const fn = checkers[t.check];
      if (!fn) failures.push(`checker ${t.check} is not registered`);
      else {
        const f = await fn(wtDir, { todo: t, files });
        failures.push(...f.map((x) => `${t.check}: ${x}`));
        checked = f.length === 0 && files.length > 0;
      }
    }
    return { failures, checked };
  }

  private redLinesCache: string[] | null = null;
  private redLines(): string[] {
    if (this.redLinesCache) return this.redLinesCache;
    const s = project(readEvents(this.control.cwd, this.engagement), this.policy);
    return (this.redLinesCache = s.engagement?.redLines ?? []);
  }

  // ---------- reading ----------

  // Open asks for one person, most-blocking first; urgent ones on top.
  digest(s: State, role: string): Array<{ id: string; question: string; blocks: number; urgent: boolean; goal: string; options: string[] }> {
    const out = [];
    for (const a of s.asks.values()) {
      if (a.status !== "open" || (a.to !== role && role !== "partner")) continue;
      const blocks = heldBy(s, a).length;
      out.push({ id: a.id, question: a.question, blocks, urgent: !!a.urgent, goal: a.goal, options: a.options.map((o) => o.id) });
    }
    return out.sort((x, y) => Number(y.urgent) - Number(x.urgent) || y.blocks - x.blocks || x.id.localeCompare(y.id));
  }
}

// The live work an open question holds up: the whole goal, its lane, the work after
// it, or the todo it is about. A spent budget holds the goal's agent work until the
// question about it is answered.
export function heldBy(s: State, a: AskState): TodoState[] {
  const budget = a.origin === "rule:budget_exhausted";
  return [...s.todos.values()].filter((t) => ["open", "blocked", "review", "running"].includes(t.status) && ((a.blocksGoal && t.goal === a.goal) || (a.lane !== undefined && t.goal === a.goal && t.lane === a.lane && t.kind === "task") || (budget && t.goal === a.goal && t.kind === "task" && t.status === "open") || (t.after ?? []).includes(a.id) || t.ask === a.id || a.todo === t.id));
}

function mergePulse(a: PulseData, b: PulseData): PulseData {
  const out: PulseData = { monitors: { ...a.monitors }, polls: { ...a.polls } };
  for (const [k, v] of Object.entries(b.monitors)) if (!out.monitors[k] || out.monitors[k].checkedAt < v.checkedAt) out.monitors[k] = v;
  for (const [k, v] of Object.entries(b.polls)) if (!out.polls[k] || out.polls[k].at < v.at) out.polls[k] = v;
  return out;
}

function turnEvent(turn: string, t: TodoState, agent: string, now: number, why: string, result: TurnRecord["result"], reasons: string[], files: string[], seat?: string): HEvent {
  return { id: `turn-${turn}`, at: now, by: agent, type: "turn", turn: { id: turn, todo: t.id, goal: t.goal, agent, result, granularity: "none", reasons, files, why, seat } };
}

async function discard(wt: Git): Promise<void> {
  await wt.tryAsync(["checkout", "-q", "--", "."]);
  await wt.tryAsync(["clean", "-q", "-fd"]);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`turn timed out after ${Math.round(ms / MIN)} min`)), ms);
    }),
  ]);
}
