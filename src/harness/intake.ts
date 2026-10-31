// From a decided challenge to a long-running goal. The foundation decides what to
// build and which assumptions the decision rests on; the harness keeps testing those
// assumptions, building on the ones that hold and asking when one breaks.
import type { ChallengeDef } from "../foundation/process.ts";
import type { Entry } from "../foundation/entries.ts";
import type { Budget, Category, GoalDef } from "./types.ts";

export function goalFromPlan(def: ChallengeDef, decision: Entry, plan: Entry, opts: { scope: string[]; budget: Budget; categories?: Record<string, Category> }): GoalDef {
  const chosen = plan.body.chosen as string;
  const tested = plan.body.test as Array<{ id: string; text: string; risk: number; uncertainty: number; test?: string }>;
  const deferred = (plan.body.deferred ?? []) as typeof tested;
  const safe = (id: string) => id.replace(/[^A-Za-z0-9._-]+/g, "_");
  const assumption = (a: (typeof tested)[number], loadBearing: boolean) => ({
    id: safe(a.id), text: a.text, risk: a.risk, uncertainty: a.uncertainty, test: a.test, loadBearing,
    category: opts.categories?.[a.id] ?? ("feasibility" as Category),
  });
  return {
    id: safe(def.id),
    title: def.title,
    objective: `${def.problem} Chosen: ${chosen}.${decision.body.note ? ` ${decision.body.note}` : ""}`,
    owner: def.owner,
    scope: opts.scope,
    budget: opts.budget,
    // The plan's riskiest assumptions are the ones the decision rests on.
    assumptions: [...tested.map((a) => assumption(a, true)), ...deferred.map((a) => assumption(a, false))],
    todos: tested.map((a) => ({
      id: safe(`design-test-${a.id}`), lane: "test-design", tests: safe(a.id),
      text: `Design the test for ${a.id} ("${a.text}")${a.test ? `: ${a.test}` : ""}. Propose a job, wait or action with a pass line stated now.`,
    })),
  };
}
