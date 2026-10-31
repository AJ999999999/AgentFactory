// Harness mechanics: one test per mechanism, on small engagements, through real git.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadPolicy } from "../src/harness/project.ts";
import { ScriptedTurnAgent } from "../src/harness/agents.ts";
import type { Behavior } from "../src/harness/agents.ts";
import { Sim } from "../src/harness/sim.ts";
import { SimJobs, SimMetrics, SimProbe } from "../src/harness/world.ts";
import type { EngagementDef } from "../src/harness/types.ts";

const policy = loadPolicy(path.join(import.meta.dirname, "..", "policy", "harness.json"));
const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `af-h-${name}-`));
const write = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const on = (id: string, run: Behavior["run"]): Behavior => ({ name: id, when: (c) => c.todo.id === id || c.todo.id.startsWith(id), run });
const lane = (l: string, run: Behavior["run"]): Behavior => ({ name: `lane:${l}`, when: (c) => c.todo.lane === l, run });
const partnerSays = (choices: Record<string, string>) => ({
  role: "partner",
  answer: (a: { id: string; options: Array<{ id: string }> }) => {
    const key = Object.keys(choices).find((k) => a.id.startsWith(k));
    return key ? { by: "partner", choice: choices[key] } : null;
  },
});
const runner = { runner: { id: "r1", capabilities: ["shell"] } };

function smallEngagement(): EngagementDef {
  return {
    id: "small", title: "Small test", principals: { partner: "you" },
    goals: [{
      id: "G", title: "Small goal", objective: "Find out if people want it, then build it", owner: "partner", scope: ["site", "app"],
      assumptions: [
        { id: "A1", text: "People sign up", category: "desirability", risk: 5, uncertainty: 4, loadBearing: true, threshold: { metric: "signups", op: ">=", value: 50 } },
      ],
      budget: { turns: 30 },
      todos: [
        { id: "page", lane: "build", text: "Build the landing page", writeScope: ["site"], check: "page" },
        { id: "test", kind: "wait", lane: "market", text: "Run the landing page for a week", after: ["page"], freeze: ["site"], wait: { source: "signups", minDays: 7, informs: [{ assumption: "A1", metric: "signups" }] } },
        { id: "product", lane: "build", text: "Build the product", assumes: ["A1"], writeScope: ["app"] },
      ],
    }],
  };
}

const pageChecker = { page: (dir: string) => (fs.existsSync(path.join(dir, "site", "index.html")) ? [] : ["site/index.html missing"]) };

test("a wait gates work by belief: nothing assuming A1 runs until the world supports it; the clock jumps the week", async () => {
  const agent = new ScriptedTurnAgent([
    on("page", (c) => { write(c.wtDir, "site/index.html", "<form>sign up</form>"); return { done: true }; }),
    on("product", (c) => { write(c.wtDir, "app/main.ts", "export {}"); return { done: true }; }),
  ]);
  const sim = await Sim.create({
    dir: tmp("small"), def: smallEngagement(), policy, start: "2026-11-02T09:00:00Z", agent, runners: [runner], people: [],
    world: { metrics: { signups: new SimMetrics("behavioral", (d) => ({ signups: Math.round(12 * d) })) }, checkers: pageChecker },
  });
  await sim.run({ until: "2026-12-31T00:00:00Z" });
  const s = await sim.harness.state();
  assert.deepEqual(agent.calls.map((c) => c.todo), ["page", "product"], "product only after A1 is supported");
  assert.equal(s.todos.get("test")!.status, "done");
  assert.equal(s.todos.get("product")!.status, "done");
  const f = [...s.findings.values()].find((x) => x.assumption === "A1")!;
  assert.equal(f.grade, "behavioral");
  assert.equal(f.direction, "supports");
  // the week passed without spending turns
  const productTurn = s.turns.find((t) => t.todo === "product")!;
  assert.ok(productTurn.at - s.turns.find((t) => t.todo === "page")!.at >= 7 * 86_400_000);
  assert.equal(s.goals.get("G")!.spent.turns, 2);
});

test("intake: a decided challenge becomes a long-running goal built on the assumptions the decision rests on", async () => {
  const { goalFromPlan } = await import("../src/harness/intake.ts");
  const def = { id: "contract-registry", title: "Contract registry", problem: "How should repos declare and check contracts?", constraints: [], criteria: [], owner: "partner", angles: [], challenger: "c", lead: "l", budget: { optionsPerAngle: 2, mvpAssumptions: 2 }, evidence: [] };
  const entry = (type: string, body: Record<string, unknown>) => ({ id: type, challenge: def.id, type, author: { agent: "a", role: "owner" }, refs: [], visibility: "team", status: "active", createdAt: "", body }) as never;
  const plan = entry("plan", {
    chosen: "option.feasibility.O1",
    test: [{ id: "risk.A1", text: "Consumers will register their usage", risk: 5, uncertainty: 4, test: "pilot with two repos" }, { id: "feasibility.A2", text: "Checks run under a minute", risk: 3, uncertainty: 3 }],
    deferred: [{ id: "cost.A3", text: "Hosting stays under $50/month", risk: 2, uncertainty: 2 }],
  });
  const g = goalFromPlan(def as never, entry("decision", { note: "start small" }), plan, { scope: ["registry"], budget: { turns: 80 }, categories: { "risk.A1": "desirability" } });
  assert.deepEqual(g.assumptions.map((a) => [a.id, a.category, a.loadBearing]), [["risk.A1", "desirability", true], ["feasibility.A2", "feasibility", true], ["cost.A3", "feasibility", false]]);
  assert.deepEqual(g.todos!.map((t) => t.tests), ["risk.A1", "feasibility.A2"]);
  assert.match(g.objective, /Chosen: option.feasibility.O1/);
});
