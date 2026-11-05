// A check that fails on the commit a turn started from too isn't the turn's fault. In the
// second private engagement a test that needed a missing local cache threw away a good
// 19-minute turn, and the retry was told it had failed, though it couldn't have fixed it.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadPolicy, project } from "../src/harness/project.ts";
import { settle } from "../src/harness/rules.ts";
import { answerEvents } from "../src/harness/answers.ts";
import { criteriaHash } from "../src/harness/validate.ts";
import { MUST_ASK } from "../src/harness/standing.ts";
import { ScriptedTurnAgent } from "../src/harness/agents.ts";
import { Sim } from "../src/harness/sim.ts";
import type { EngagementDef, GoalDef, HEvent } from "../src/harness/types.ts";

const policy = loadPolicy(path.join(import.meta.dirname, "..", "policy", "harness.json"));
const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `af-base-${name}-`));
const write = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const runner = { runner: { id: "r1", capabilities: ["shell"] } };

function engagement(): EngagementDef {
  return {
    id: "base", title: "Base check", principals: { partner: "you" },
    goals: [{
      id: "G", title: "Build", objective: "Build the app", owner: "partner", scope: ["app"],
      assumptions: [{ id: "A1", text: "It can be built", category: "feasibility", risk: 3, uncertainty: 3 }],
      budget: { turns: 20 },
      todos: [{ id: "app", lane: "build", text: "Build the app", writeScope: ["app"], check: "tests" }],
    }],
  };
}

test("a check that fails on the starting commit too isn't counted against the turn, isn't retried, and asks the owner", async () => {
  // The tests need a cache the copy left out, until the partner restores it.
  let cache = false;
  let asked = "";
  const checkers = { tests: (dir: string) => (cache ? (fs.existsSync(path.join(dir, "app", "main.ts")) ? [] : ["app/main.ts missing"]) : ["tests fail: cache/ is missing"]) };
  const agent = new ScriptedTurnAgent([{ name: "app", when: (c) => c.todo.id === "app", run: (c) => { write(c.wtDir, "app/main.ts", "export {}"); return { done: true }; } }]);
  const partner = {
    role: "partner",
    answer: (a: { id: string; question: string }) => {
      if (!a.id.startsWith("ask-base")) return null;
      asked = a.question;
      cache = true; // fixed the setup
      return { by: "partner", choice: "retry" };
    },
  };
  const sim = await Sim.create({ dir: tmp("sim"), def: engagement(), policy, start: "2026-11-02T09:00:00Z", agent, runners: [runner], people: [partner], world: { checkers } });
  await sim.run({ until: "2026-11-09T00:00:00Z" });
  const s = await sim.harness.state();
  const turns = s.turns.filter((t) => t.todo === "app");
  assert.equal(turns[0].result, "base_failed");
  assert.match(turns[0].reasons[0], /^tests: tests fail: cache\/ is missing \(fails on [0-9a-f]{10}, the commit this turn started from, too\)$/);
  assert.match(asked, /fail on the commit its turn started from too, so the turn wasn't to blame/);
  assert.match(asked, /cache\/ is missing/);
  assert.equal(turns.length, 2, "one try, the question, then one try after the fix: no retries in between");
  assert.equal(turns[1].result, "completed");
  assert.equal(s.todos.get("app")!.status, "done");
  assert.equal(agent.calls.length, 2);
});

test("a check the turn itself broke still throws the turn away and counts as a failure", async () => {
  const checkers = { tests: (dir: string) => (fs.existsSync(path.join(dir, "app", "broken.ts")) ? ["tests fail: broken.ts"] : []) };
  const agent = new ScriptedTurnAgent([{ name: "app", when: (c) => c.todo.id === "app", run: (c) => { write(c.wtDir, "app/broken.ts", "x"); return { done: true }; } }]);
  const sim = await Sim.create({ dir: tmp("own"), def: engagement(), policy, start: "2026-11-02T09:00:00Z", agent, runners: [runner], people: [], world: { checkers } });
  await sim.harness.tick({ runner: runner.runner });
  const s = await sim.harness.state();
  assert.equal(s.turns[0].result, "validation_failed");
  assert.equal(s.todos.get("app")!.failures, 1);
  assert.ok(![...s.asks.values()].some((a) => a.origin === "rule:base_failed"));
});

test("the rule asks once per such turn, blocks the work until it's answered, and an answer doesn't bring the question back", () => {
  const T0 = Date.parse("2026-11-02T09:00:00Z");
  const g: GoalDef = { id: "G", title: "G", objective: "o", owner: "partner", scope: ["app"], assumptions: [], budget: { turns: 100 } };
  const base: HEvent[] = [
    { id: "open", at: T0, by: "partner", type: "engagement_opened", engagement: { id: "e", title: "E", principals: { partner: "you" } } },
    { id: "goal-G", at: T0, by: "partner", type: "goal_opened", goal: g, criteriaHash: criteriaHash(g) },
    { id: "add-app", at: T0, by: "partner", type: "todo_added", todo: { id: "app", goal: "G", lane: "build", text: "Build the app" }, provenance: "seed" },
    { id: "add-x", at: T0, by: "partner", type: "todo_added", todo: { id: "x", goal: "G", lane: "build", text: "Other work" }, provenance: "seed" },
    { id: "turn-1", at: T0 + 1, by: "r1", type: "turn", turn: { id: "1", todo: "app", goal: "G", agent: "r1", result: "validation_failed", granularity: "none", reasons: ["tests: a"], files: [] } },
    { id: "turn-2", at: T0 + 2, by: "r1", type: "turn", turn: { id: "2", todo: "app", goal: "G", agent: "r1", result: "base_failed", granularity: "none", reasons: ["tests: cache/ is missing (fails on abc, the commit this turn started from, too)"], files: [] } },
  ];
  let s = project(base, policy);
  assert.equal(s.todos.get("app")!.failures, 0, "not counted, and a fixed setup starts a fresh run of tries");
  const first = settle(s, T0 + 3);
  const asks = first.filter((e) => e.type === "ask_opened");
  assert.equal(asks.length, 1);
  assert.equal((asks[0] as Extract<HEvent, { type: "ask_opened" }>).ask.origin, "rule:base_failed");
  assert.ok(first.some((e) => e.type === "todo_blocked" && e.todo === "app"));
  assert.ok(!first.some((e) => e.type === "todo_blocked" && e.todo === "x"), "only that work waits");
  s = project([...base, ...first], policy);
  assert.equal(s.todos.get("app")!.status, "blocked");
  assert.deepEqual(settle(s, T0 + 4).filter((e) => e.type === "ask_opened"), [], "asked once");
  // Answered "fixed: try again": the work reopens and isn't asked about again.
  const id = (asks[0] as Extract<HEvent, { type: "ask_opened" }>).ask.id;
  const answered = answerEvents(s, id, { by: "partner", choice: "retry" }, T0 + 5);
  s = project([...base, ...first, ...answered], policy);
  assert.equal(s.todos.get("app")!.status, "open");
  assert.deepEqual(settle(s, T0 + 6).filter((e) => e.type === "ask_opened" || e.type === "todo_blocked"), []);
});

test("a standing \"retry\" never answers it: only a person can say the setup is fixed", () => {
  assert.ok(MUST_ASK.has("rule:base_failed"));
});
