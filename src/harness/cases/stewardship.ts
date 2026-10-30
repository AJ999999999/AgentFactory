// Case 6 (added): "Keep our open-source library healthy."
//
// Why it's here: the other cases end. This one never does. Most days nothing happens,
// and the failure modes are the opposite of the others: an agent loop that invents
// busywork to look productive, a schedule that burns turns polling, a "done" that
// closes something that should stay open, and an emergency (a security advisory) that
// must jump the queue the moment it lands.
//
// What the harness should do: spend nothing on quiet days; turn each event (issue,
// dependency release, advisory) into exactly one piece of work; put the security fix
// ahead of everything and in front of a person before release; never ask "is this goal
// done?"; and refuse work an agent proposes without a reason.
import { ScriptedTurnAgent } from "../agents.ts";
import type { Person } from "../sim.ts";
import { day } from "../sim.ts";
import type { EngagementDef } from "../types.ts";
import { SimProbe } from "../world.ts";
import type { CaseSetup } from "./kit.ts";
import { lane, write } from "./kit.ts";

const START = "2026-11-02T09:00:00Z";

export function stewardshipDef(): EngagementDef {
  return {
    id: "stewardship", title: "Keep the library healthy",
    principals: { partner: "you" },
    goals: [{
      id: "lib", title: "Library stewardship", objective: "Issues answered, dependencies current, vulnerabilities patched fast", owner: "partner",
      scope: ["lib", "docs"], perpetual: true, share: 0.2,
      assumptions: [],
      budget: { turnsPerWeek: 10 },
      monitors: [
        { id: "issues", target: "issue-tracker", cadenceMinutes: 6 * 60, onChange: { todo: { lane: "triage", text: "New issue: {summary}. Reproduce it and label it.", writeScope: ["docs/triage"] } } },
        { id: "deps", target: "dependency-releases", cadenceMinutes: 24 * 60, onChange: { todo: { lane: "deps", text: "Dependency release: {summary}. Update and run the tests.", writeScope: ["lib"], check: "tests" } } },
        {
          id: "advisories", target: "security-advisories", cadenceMinutes: 3 * 60, urgent: true,
          onChange: {
            todo: { lane: "security", text: "Security advisory: {summary}. Patch it.", priority: 0, writeScope: ["lib"], check: "tests", review: "partner" },
            ask: { to: "partner", question: "Security advisory affecting the library; a patch is being prepared for your review" },
          },
        },
      ],
    }],
  };
}

export function stewardship(): CaseSetup {
  const agent = new ScriptedTurnAgent([
    lane("triage", (c) => {
      write(c, `docs/triage/${c.todo.id.slice(-8)}.md`, `Reproduced. Label: bug.\n`);
      // The agent also tries to queue some "improvements" with no reason behind them.
      return { done: true, todos: [{ lane: "polish", text: "Refactor the config loader for clarity" }, { lane: "polish", text: "Rewrite the README intro" }] };
    }),
    lane("deps", (c) => { write(c, "lib/package.json", JSON.stringify({ dependencies: { parser: "3.2.1" } })); return { done: true }; }),
    lane("security", (c) => { write(c, "lib/yaml-loader.ts", "// safe_load only; tests: 88 passing\n"); return { done: true, note: "Switched to safe loading; added a regression test" }; }),
  ]);
  const partner: Person = {
    role: "partner",
    delayMinutes: (a) => (a.urgent || a.kind === "review" ? 60 : 24 * 60),
    answer: (a) => (a.kind === "review" ? { by: "partner", choice: "approve" } : a.origin.startsWith("monitor:") ? { by: "partner", choice: "noted" } : null),
  };
  return {
    name: "stewardship",
    summary: "Perpetual: keep an open-source library healthy",
    def: stewardshipDef(),
    start: START,
    until: "2026-12-17T09:00:00Z",
    agent,
    runners: [{ runner: { id: "r1", capabilities: ["shell"] } }],
    people: [partner],
    world: {
      probe: new SimProbe({
        "issue-tracker": [{ at: day(START, 3), fingerprint: "141", summary: "#141 crash on an empty config file" }, { at: day(START, 33), fingerprint: "152", summary: "#152 typo in the quick start" }],
        "dependency-releases": [{ at: day(START, 9), fingerprint: "parser-3.2.1", summary: "parser 3.2.1" }],
        "security-advisories": [{ at: day(START, 20) + 30 * 60_000, fingerprint: "CVE-2026-1234", summary: "CVE-2026-1234: unsafe YAML loading" }],
      }),
      checkers: { tests: (_dir, { files }) => (files.length ? [] : ["no change"]) },
    },
  };
}
