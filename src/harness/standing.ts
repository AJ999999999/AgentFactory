// Standing decisions: "from now on" on an answer, so the next question of the same shape
// in the same goal doesn't reach the person. The harness settles it with their earlier
// choice, recorded as the harness's own act (ask_auto_closed, reason "standing") that
// points at the answer it repeats: never dressed up as a fresh answer from the person, so
// the escalation numbers stay honest and the daily spot check can draw from it.
//
// What may stand is narrow on purpose. The harness never closes a goal, pivots or raises a
// budget by itself (docs/harness.md); a standing answer can't do those either, and the
// questions on the must-ask list always reach the person.
import type { AskState, State } from "./project.ts";
import { irreversibleEffect, type AskOption } from "./types.ts";

// Questions that are always the person's to answer, whatever they said before: money,
// closing, the goal's direction and budget, and the spot check itself. The policy's
// standing.mustAsk adds more by origin.
export const MUST_ASK = new Set([
  "rule:money", "rule:success", "rule:kill_criterion", "rule:thrash", "rule:scope_vs_budget",
  "rule:budget_exhausted", "rule:budget_forecast", "rule:load_bearing_refuted", "rule:spin", "rule:contested", "rule:probation",
  // The brakes on a standing "retry": the turn cap, a turn you stopped yourself, and checks
  // that fail before the turn starts (only a person can say the setup is fixed).
  "rule:turn_cap", "rule:stopped", "rule:base_failed",
  // A pull request larger than the goal's ship.maxFiles: look at it every time.
  "rule:ship_large",
  // Telling a ticket's reporter the problem was their own doing (playbook.ts).
  "rule:jira_reply_user_error",
]);
// The effects a standing answer may repeat: ones that don't change the goal itself.
const STANDABLE = new Set(["ack", "approve", "retry", "reopen"]);
export const STANDING_DAYS = 30;

// The shape of a question: what makes two of them "the same kind". Questions from the
// harness's rules and monitors have one; an agent's free-form question doesn't (the
// existing precedent check matches those by their exact words).
export function askShape(s: State, a: Pick<AskState, "origin" | "lane" | "todo">): string | undefined {
  const origin = a.origin ?? "";
  if (origin.startsWith("monitor:") || origin.startsWith("event:")) return origin;
  if (!origin.startsWith("rule:")) return undefined;
  const lane = a.lane ?? (a.todo ? s.todos.get(a.todo)?.lane : undefined);
  return lane ? `${origin}|${lane}` : origin;
}

export const standingKey = (goal: string, shape: string) => `${goal}::${shape}`;

const mustAsk = (s: State, origin = "") => MUST_ASK.has(origin) || origin.startsWith("audit:") || (s.policy.standing?.mustAsk ?? []).includes(origin);

// Why this answer can't stand, or undefined when it can.
export function cannotStand(s: State, a: AskState, choice: string): string | undefined {
  if (a.urgent) return "urgent questions are always yours";
  if (mustAsk(s, a.origin)) return `${a.origin} questions are always yours (the must-ask list)`;
  const shape = askShape(s, a);
  if (!shape) return "only the harness's own questions (rules, monitors, events) can have a standing answer";
  const opt: AskOption | undefined = a.options.find((o) => o.id === choice);
  if (!opt) return `no option ${choice}`;
  if (opt.irreversible || irreversibleEffect(opt.effect)) return "an option that can't be undone is always yours";
  if (opt.effect && !STANDABLE.has(opt.effect.type)) return `a "${opt.effect.type}" answer changes the goal itself, so it's always yours`;
  return undefined;
}

export type Standing = { goal: string; shape: string; choice: string; ask: string; by: string; at: number; goalVersion: number; note?: string };

// The standing decision that settles this open question now, if one does: same goal and
// shape, set on the goal's current direction, not expired, and still allowed for it.
export function standingFor(s: State, a: AskState, now: number): Standing | undefined {
  const shape = askShape(s, a);
  if (!shape) return undefined;
  const d = s.standing.get(standingKey(a.goal, shape));
  if (!d || d.ask === a.id) return undefined;
  const g = s.goals.get(a.goal);
  if (!g || g.version !== d.goalVersion) return undefined;
  const days = s.policy.standing?.days ?? STANDING_DAYS;
  if (now - d.at > days * 86_400_000) return undefined;
  if (cannotStand(s, a, d.choice)) return undefined;
  return d;
}
