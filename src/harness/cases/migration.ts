// Case 4 (added): "Move the order-management service off the legacy platform."
//
// Why it's here: none of the first three cases touch production. A brownfield
// migration has no market risk at all; its risks are correctness against a system
// people rely on, other teams who own the contracts, change freezes on the calendar,
// irreversible steps, and a finish line that has to actually stop the work.
//
// What the harness should do: build and shadow-test while the billing team takes its
// time on the contract; when the first shadow run misses the match bar, let the owner
// choose "fix and test again" without losing the cut-over plan; never start a
// deployment inside the holiday freeze, and sleep through it cheaply; keep the
// irreversible steps (go/no-go, decommission) with a person; and stop when done.
import { ScriptedTurnAgent } from "../agents.ts";
import type { EngagementDef } from "../types.ts";
import { SimJobs } from "../world.ts";
import type { CaseSetup } from "./kit.ts";
import { about, exists, on, origin, person, write } from "./kit.ts";

const START = "2026-11-02T09:00:00Z";

export function migrationDef(): EngagementDef {
  return {
    id: "migration", title: "Order management off the legacy platform",
    principals: { partner: "you", "billing-team": "the billing platform team" },
    redLines: [],
    goals: [{
      id: "orders", title: "Order service migration", objective: "Move order management to the new service with no lost or wrong orders", owner: "partner",
      scope: ["svc", "contracts", "runbooks"],
      budget: { turns: 150 },
      blackouts: [{ from: "2026-12-15T00:00:00Z", to: "2027-01-05T00:00:00Z", lanes: ["deploy"], reason: "holiday change freeze" }],
      assumptions: [
        { id: "M1", text: "The new service matches legacy on at least 99.9% of orders in shadow traffic", category: "feasibility", risk: 5, uncertainty: 4, loadBearing: true, threshold: { metric: "match_rate", op: ">=", value: 0.999 } },
      ],
      kill: [{ id: "rollback", metric: "cutover_error_rate", op: ">", value: 0.001 }],
      success: [{ id: "moved", metric: "traffic_on_new", op: ">=", value: 1 }, { id: "gone", metric: "legacy_decommissioned", op: ">=", value: 1 }],
      todos: [
        { id: "service", lane: "build", text: "Order service and legacy adapter", writeScope: ["svc"], check: "tests" },
        { id: "contract", lane: "build", text: "Order contract v2 for billing", writeScope: ["contracts"], check: "contract" },
        { id: "signoff", kind: "action", lane: "review", text: "Sign off order contract v2", assignee: "billing-team", after: ["contract"] },
        { id: "shadow", kind: "job", lane: "verify", text: "Shadow a week of production traffic", after: ["service"], job: { spec: { days: 7 }, runs: 3, informs: [{ assumption: "M1", metric: "match_rate" }] } },
        { id: "go-10", kind: "action", lane: "review", text: "Go/no-go: cut over 10% of traffic", assignee: "partner", after: ["shadow", "signoff"], assumes: ["M1"] },
        { id: "cut-10", kind: "job", lane: "deploy", text: "Cut over 10% of traffic and watch for five days", after: ["go-10"], assumes: ["M1"], job: { spec: { traffic: 0.1 } } },
        { id: "cut-100", kind: "job", lane: "deploy", text: "Cut over the remaining traffic", after: ["cut-10"], assumes: ["M1"], job: { spec: { traffic: 1 } } },
        { id: "decommission", kind: "action", lane: "review", text: "Decommission the legacy order module (irreversible)", assignee: "partner", after: ["cut-100"] },
      ],
    }],
  };
}

export function migration(): CaseSetup {
  const agent = new ScriptedTurnAgent([
    on("service", (c) => { write(c, "svc/orders.ts", "export function place() {}\n// tests: 214 passing\n"); return { done: true }; }),
    on("contract", (c) => { write(c, "contracts/order-v2.md", "# Order contract v2\n"); return { done: true }; }),
    on("fix", (c) => {
      write(c, "svc/rounding.ts", "// tax rounding now matches legacy (banker's rounding)\n// tests: 221 passing\n");
      return { done: true, note: "Mismatches were tax rounding; matched legacy" };
    }),
  ]);

  const jobs = new SimJobs((t): { minutes: number; metrics: Record<string, number> } => {
    if (t.id === "shadow") return { minutes: 7 * 24 * 60, metrics: { match_rate: 0.996 } };
    if (t.id === "shadow-2") return { minutes: 7 * 24 * 60, metrics: { match_rate: 0.9995 } };
    if (t.id === "cut-10") return { minutes: 5 * 24 * 60, metrics: { cutover_error_rate: 0.0002, traffic_on_new: 0.1 } };
    if (t.id === "cut-100") return { minutes: 2 * 24 * 60, metrics: { cutover_error_rate: 0.0001, traffic_on_new: 1 } };
    return { minutes: 60, metrics: {} };
  });

  const partner = person("partner", 24 * 60, [
    {
      match: origin("rule:load_bearing_refuted"),
      answer: () => ({
        choice: "fix", note: "Mismatches look like rounding; fix and shadow again",
        revision: {
          todos: [
            { id: "fix", lane: "build", text: "Fix the mismatch classes found in shadow", writeScope: ["svc"], check: "tests" },
            { id: "shadow-2", kind: "job", lane: "verify", text: "Shadow another week after the fix", after: ["fix"], job: { spec: { days: 7 }, runs: 3, informs: [{ assumption: "M1", metric: "match_rate" }] } },
          ],
        },
      }),
    },
    { match: about("go-10"), answer: () => ({ choice: "done", note: "Go" }) },
    { match: about("decommission"), answer: () => ({ choice: "done", finding: { direction: "neutral", text: "Legacy module switched off", metrics: { legacy_decommissioned: 1 } } }) },
    { match: origin("rule:success"), answer: () => ({ choice: "close" }) },
  ]);
  // The other team is slow: over five weeks to sign off, which pushes the cut-over
  // into the holiday freeze.
  const billing = person("billing-team", 38 * 24 * 60, [{ match: about("signoff"), answer: () => ({ choice: "done" }) }]);

  return {
    name: "migration",
    summary: "Move order management off a legacy platform",
    def: migrationDef(),
    start: START,
    until: "2027-03-31T00:00:00Z",
    agent,
    runners: [{ runner: { id: "r1", capabilities: ["shell"] }, slots: 1 }],
    people: [partner, billing],
    world: {
      jobs,
      checkers: {
        tests: (_dir, { files }) => (files.length ? [] : ["no change"]),
        contract: (dir) => exists(dir, "contracts/order-v2.md"),
      },
    },
  };
}
