// Small shared helpers. Zero dependencies: Node 22 built-ins only.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Deterministic PRNG so "nondeterministic" mock agents are reproducible per seed.
export function seededRandom(seedText: string): () => number {
  let h = parseInt(sha256(seedText).slice(0, 8), 16) || 1;
  return () => {
    h ^= h << 13; h >>>= 0;
    h ^= h >>> 17; h >>>= 0;
    h ^= h << 5; h >>>= 0;
    return (h >>> 0) / 0xffffffff;
  };
}

// Minimal glob: "**" any depth, "*" within one segment.
export function matchGlob(pattern: string, file: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") { re += ".*"; i++; }
    else if (c === "*") re += "[^/]*";
    else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(file);
}

// Is `child` equal to or inside `parent` (path units, no globs)?
export function pathWithin(child: string, parent: string): boolean {
  const c = child.replace(/\/+$/, "");
  const p = parent.replace(/\/+$/, "");
  return c === p || c.startsWith(p + "/");
}

export function pathsOverlap(a: string, b: string): boolean {
  return pathWithin(a, b) || pathWithin(b, a);
}

// Async mutex (used as the merge queue: one merge at a time).
export class Mutex {
  private tail: Promise<void> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

// Counting semaphore (caps concurrent agent sessions).
export class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;
  max: number;
  constructor(max: number) { this.max = max; }
  async acquire(): Promise<() => void> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    };
  }
}

export type LogFn = (event: string, data?: Record<string, unknown>) => void;

export function makeLogger(sink: Array<{ t: number; event: string; data?: Record<string, unknown> }>, echo = false): LogFn {
  const t0 = Date.now();
  return (event, data) => {
    const entry = { t: Date.now() - t0, event, data };
    sink.push(entry);
    if (echo) console.log(`[${String(entry.t).padStart(5)}ms] ${event}${data ? " " + JSON.stringify(data) : ""}`);
  };
}
