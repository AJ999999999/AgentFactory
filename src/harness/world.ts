// The world the harness talks to, behind small interfaces: a clock, external jobs,
// metric sources, monitors' probes, and checkers. Production plugs in CI runs, GPU
// queues, analytics and feeds; tests plug in a simulated world where months pass in
// milliseconds.
import type { Grade } from "./types.ts";
import type { TodoState } from "./project.ts";

export interface Clock {
  now(): number;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

export class SimClock implements Clock {
  t: number;
  constructor(start: string | number) {
    this.t = typeof start === "string" ? Date.parse(start) : start;
  }
  now(): number {
    return this.t;
  }
  set(t: number): void {
    if (t > this.t) this.t = t;
  }
  advance(minutes: number): void {
    this.t += minutes * 60_000;
  }
}

// A running job may say when it expects to finish; the harness doesn't poll before then.
export type JobOutcome = { status: "running"; eta?: number } | { status: "succeeded" | "failed"; metrics: Record<string, number>; gpuHours?: number; note?: string };

export interface JobProvider {
  start(todo: TodoState, now: number): Promise<string>; // returns a handle
  poll(handle: string, now: number): Promise<JobOutcome>;
}

// A metric source reports counts over a window. Its grade is a property of the
// source (a survey is "stated", sign-ups and pre-orders are "behavioral"), never of
// whoever proposed the wait.
export interface MetricSource {
  grade: Grade;
  read(since: number, now: number, todo: TodoState): Promise<Record<string, number>>;
}

export interface Probe {
  check(target: string, now: number): Promise<{ fingerprint: string; summary: string }>;
}

export type Checker = (wtDir: string, ctx: { todo: TodoState; files: string[] }) => string[] | Promise<string[]>;

export type World = {
  jobs?: JobProvider;
  metrics?: Record<string, MetricSource>;
  probe?: Probe;
  checkers?: Record<string, Checker>;
};

// ---------- simulation ----------

type SimJob = { todo: TodoState; startedAt: number; attempt: number };

// Jobs finish after a scripted duration with scripted metrics (a function of the todo
// and the attempt), so tests can make the first shadow run fail and the second pass.
export class SimJobs implements JobProvider {
  jobs = new Map<string, SimJob>();
  attempts = new Map<string, number>();
  outcome: (todo: TodoState, attempt: number) => { minutes: number; status?: "succeeded" | "failed"; metrics: Record<string, number>; gpuHours?: number };
  started: string[] = [];
  constructor(outcome: SimJobs["outcome"]) {
    this.outcome = outcome;
  }
  async start(todo: TodoState, now: number): Promise<string> {
    const attempt = (this.attempts.get(todo.id) ?? 0) + 1;
    this.attempts.set(todo.id, attempt);
    const handle = `sim-${todo.id}-${attempt}`;
    this.jobs.set(handle, { todo, startedAt: now, attempt });
    this.started.push(todo.id);
    return handle;
  }
  async poll(handle: string, now: number): Promise<JobOutcome> {
    const j = this.jobs.get(handle);
    if (!j) return { status: "failed", metrics: {}, note: "unknown handle" };
    const o = this.outcome(j.todo, j.attempt);
    if (now < j.startedAt + o.minutes * 60_000) return { status: "running", eta: j.startedAt + o.minutes * 60_000 };
    return { status: o.status ?? "succeeded", metrics: o.metrics, gpuHours: o.gpuHours };
  }
}

// Metric source driven by a rate function: value(t) for each metric, given days since
// the wait started.
export class SimMetrics implements MetricSource {
  grade: Grade;
  fn: (days: number, todo: TodoState) => Record<string, number>;
  constructor(grade: Grade, fn: SimMetrics["fn"]) {
    this.grade = grade;
    this.fn = fn;
  }
  async read(since: number, now: number, todo: TodoState): Promise<Record<string, number>> {
    return this.fn((now - since) / 86_400_000, todo);
  }
}

// A probe whose answer changes at scripted times.
export class SimProbe implements Probe {
  timeline: Record<string, Array<{ at: number; fingerprint: string; summary: string }>>;
  checks: Array<{ target: string; at: number }> = [];
  constructor(timeline: SimProbe["timeline"]) {
    this.timeline = timeline;
  }
  async check(target: string, now: number): Promise<{ fingerprint: string; summary: string }> {
    this.checks.push({ target, at: now });
    const steps = (this.timeline[target] ?? []).filter((s) => s.at <= now);
    return steps.length ? steps[steps.length - 1] : { fingerprint: "initial", summary: "no change" };
  }
}
