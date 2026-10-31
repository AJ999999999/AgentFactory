// Shared pieces for the case simulations.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Behavior, TurnContext, TurnAgent } from "../agents.ts";
import type { Answer } from "../answers.ts";
import type { AskState, State } from "../project.ts";
import type { Person } from "../sim.ts";
import type { Runner } from "../select.ts";
import type { EngagementDef } from "../types.ts";
import type { TurnOutput } from "../validate.ts";
import type { World } from "../world.ts";

export type CaseSetup = {
  name: string;
  summary: string;
  def: EngagementDef;
  start: string;
  until: string;
  world: World;
  agent: TurnAgent;
  runners: Array<{ runner: Runner; slots?: number }>;
  people: Person[];
  seedFiles?: Record<string, string>;
};

export function write(ctx: TurnContext, rel: string, text: string): void {
  const f = path.join(ctx.wtDir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
}

export const on = (prefix: string, run: (c: TurnContext) => TurnOutput | Promise<TurnOutput>): Behavior => ({ name: prefix, when: (c) => c.todo.id === prefix || c.todo.id.startsWith(`${prefix}-`), run });
export const lane = (l: string, run: (c: TurnContext) => TurnOutput | Promise<TurnOutput>): Behavior => ({ name: `lane:${l}`, when: (c) => c.todo.lane === l, run });
export const nth = (c: TurnContext) => c.todo.turns + 1; // which attempt this is

// A person who answers asks by matching their id prefix or origin; delay in minutes.
export function person(role: string, delayMinutes: number, rules: Array<{ match: (a: AskState, s: State) => boolean; answer: (a: AskState, s: State) => Omit<Answer, "by"> & { by?: string } }>): Person {
  return {
    role,
    delayMinutes: () => delayMinutes,
    answer: (a, s) => {
      const r = rules.find((x) => x.match(a, s));
      return r ? ({ by: role, ...r.answer(a, s) } as Answer) : null;
    },
  };
}

export const origin = (o: string) => (a: AskState) => a.origin === o;
export const about = (todo: string) => (a: AskState) => a.todo === todo;
export const idStarts = (p: string) => (a: AskState) => a.id.startsWith(p);

// Checkers that read files the turn wrote.
export function contains(dir: string, files: string[], re: RegExp, under: string[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (!under.some((u) => f === u || f.startsWith(u + "/"))) continue;
    const p = path.join(dir, f);
    if (fs.existsSync(p) && re.test(fs.readFileSync(p, "utf8"))) out.push(`${f} matches ${re}`);
  }
  return out;
}

export function exists(dir: string, rel: string): string[] {
  return fs.existsSync(path.join(dir, rel)) ? [] : [`${rel} is missing`];
}
