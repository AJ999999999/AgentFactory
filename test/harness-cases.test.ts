// The six cases, simulated end to end through the real harness and git. Each test
// asserts the behavior the case needs, not just that it finished.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadPolicy } from "../src/harness/project.ts";
import type { State } from "../src/harness/project.ts";
import { Sim } from "../src/harness/sim.ts";
import { readEvents } from "../src/harness/store.ts";
import type { ScriptedTurnAgent } from "../src/harness/agents.ts";
import type { HEvent } from "../src/harness/types.ts";
import type { CaseSetup } from "../src/harness/cases/kit.ts";
import { gameEngine } from "../src/harness/cases/game-engine.ts";
import { kidsRockets } from "../src/harness/cases/kids-rockets.ts";
import { seniorMeds } from "../src/harness/cases/senior-meds.ts";
import { migration } from "../src/harness/cases/migration.ts";
import { research } from "../src/harness/cases/research.ts";
import { stewardship } from "../src/harness/cases/stewardship.ts";

const policy = loadPolicy(path.join(import.meta.dirname, "..", "policy", "harness.json"));

async function play(setup: CaseSetup) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `af-case-${setup.name}-`));
  const sim = await Sim.create({ dir, def: setup.def, policy, start: setup.start, world: setup.world, agent: setup.agent, runners: setup.runners, people: setup.people });
  await sim.run({ until: setup.until });
  const s: State = await sim.harness.state();
  const events: HEvent[] = readEvents(sim.harness.control.cwd, setup.def.id);
  const onMain = (p: string): string | null => {
    try {
      return sim.harness.control.run(["show", `origin/main:${p}`]);
    } catch {
      return null;
    }
  };
  const ask = (pred: (a: State["asks"] extends Map<string, infer A> ? A : never) => boolean) => [...s.asks.values()].find(pred);
  const turnsOf = (todo: string) => s.turns.filter((t) => t.todo === todo);
  const started = (todo: string) => events.filter((e) => e.type === "todo_started" && e.todo === todo);
  const calls = (setup.agent as ScriptedTurnAgent).calls;
  const firstPickAfter = (at: number) => sim.ticks.find((t) => t.at >= at && t.turns.length)?.turns[0]?.todo;
  return { sim, s, events, onMain, ask, turnsOf, started, calls, firstPickAfter };
}

const status = (s: State, goal: string, a: string) => {
  const g = s.goals.get(goal)!;
  const def = g.def.assumptions.find((x) => x.id === a)!;
  return import("../src/harness/project.ts").then((m) => m.beliefOf(s, goal, def).status);
};

test("case 1, an Unreal 6 engine: scope first, the riskiest assumption next, GPU work on GPU runners, teams only after contracts", async () => {
  const r = await play(gameEngine());
  const scopeAsk = r.ask((a) => a.origin === "rule:scope_vs_budget")!;
  assert.ok(scopeAsk, "the scope-versus-budget question was asked");
  assert.ok(r.s.turns.filter((t) => t.at < scopeAsk.answeredAt!).every((t) => t.todo === "scope"), "nothing was built before the scope was settled");
  assert.match(r.s.todos.get("core")!.reason!, /no longer part of the goal/);
  assert.equal(r.firstPickAfter(scopeAsk.answeredAt!), "landing", "demand (risk x uncertainty 30) goes before the renderer spikes");
  const landing = r.turnsOf("landing");
  assert.equal(landing[0].result, "validation_failed");
  assert.ok(landing[0].reasons.some((x) => x.includes("trademark")));
  assert.doesNotMatch(r.onMain("brand/site/index.html")!, /unreal/i);
  for (const j of ["bench-a", "bench-b", "reload-bench"]) assert.deepEqual(r.started(j).map((e) => e.by), ["gpu-1"], `${j} ran on the GPU runner only`);
  const choice = r.ask((a) => a.question.includes("Which approach"))!;
  assert.equal(choice.choice, "A");
  assert.ok(r.turnsOf("contracts")[0].at >= choice.answeredAt!, "contracts wait for the decision");
  assert.ok(r.turnsOf("teams")[0].at >= r.s.todos.get("waitlist")!.doneAt!, "the team grows only after developers showed up");
  const spawn = r.ask((a) => a.id.startsWith("ask-spawn"))!;
  assert.equal(spawn.choice, "approve");
  assert.deepEqual(["renderer", "editor", "assets"].map((g) => r.s.goals.get(g)?.def.parent), ["engine", "engine", "engine"]);
  assert.equal(r.s.goals.get("engine")!.def.budget.turns, 250, "150 turns carved out of the parent");
  // The competitor's announcement earned a proper re-test, not a pivot.
  const mon = [...r.s.todos.values()].find((t) => t.id.startsWith("mon-engine-competitors"))!;
  assert.equal(mon.status, "done");
  assert.ok([...r.s.todos.values()].some((t) => t.lane === "replicate" && t.tests === "W1"));
  assert.equal(await status(r.s, "engine", "W1"), "supported");
  assert.ok(!r.ask((a) => a.origin === "rule:load_bearing_refuted"));
  assert.equal(r.s.goals.get("engine")!.spent.gpuHours, 14);
});

test("case 2, Starship kits for kids: demand before design, money before ads, a frozen test, the lawyer decides the name, a pivot to classrooms", async () => {
  const r = await play(kidsRockets());
  assert.equal(r.calls[0].todo, "landing", "the riskiest assumption (demand) is tested first");
  for (const t of ["cad", "brand", "polish"]) assert.equal(r.turnsOf(t).length, 0, `${t} never ran`);
  const spend = r.ask((a) => a.id === "ask-spend-ads")!;
  assert.ok(r.s.todos.get("ads")!.startedAt! >= spend.answeredAt!, "the ad money was approved before the ads ran");
  assert.ok(r.events.some((e) => e.type === "spend" && e.todo === "ads" && e.usd === 200));
  const survey = [...r.s.findings.values()].find((f) => f.todo === "survey")!;
  assert.equal(survey.grade, "stated");
  assert.equal(survey.direction, "supports", "80% of surveyed parents said they'd buy...");
  const ads = [...r.s.findings.values()].find((f) => f.todo === "ads" && f.assumption === "D1")!;
  assert.equal(ads.direction, "refutes", "...but pre-orders said otherwise, and pre-orders are what count");
  assert.equal(r.s.todos.get("polish")!.reason, "D1 already refuted");
  const lawyer = [...r.s.findings.values()].find((f) => f.author === "ip-lawyer")!;
  assert.equal(lawyer.grade, "expert");
  assert.match(r.s.todos.get("brand")!.reason!, /assumed C1, which was refuted/);
  assert.equal(r.ask((a) => a.origin === "rule:kill_criterion")!.choice, "pivot");
  assert.equal(r.ask((a) => a.origin === "rule:load_bearing_refuted")!.choice, "moot", "one pivot, not two");
  assert.equal(r.s.todos.get("cad")!.reason, "goal pivoted to v2");
  const g = r.s.goals.get("kids")!;
  assert.equal(g.version, 2);
  assert.equal(g.status, "done");
  for (const a of ["T1", "F1", "S1"]) assert.equal(await status(r.s, "kids", a), "supported");
  assert.equal(g.spent.usd, 350);
});

test("case 3, a medicine assistant for seniors: work that doesn't depend on the regulator keeps moving, experts sign off, labels change after launch", async () => {
  const r = await play(seniorMeds());
  const classify = r.ask((a) => a.todo === "reg-classify")!;
  for (const t of ["shell", "ux-research", "reg-research"]) assert.ok(r.turnsOf(t)[0].at < classify.answeredAt!, `${t} ran while the regulatory question was open`);
  assert.ok(r.turnsOf("rules")[0].at >= classify.answeredAt!, "interaction rules waited for the classification");
  assert.equal(r.turnsOf("dosing").length, 0);
  assert.match(r.s.todos.get("dosing")!.reason!, /assumed R2, which was refuted/);
  const rules = r.turnsOf("rules");
  assert.equal(rules[0].result, "validation_failed");
  assert.ok(rules[0].reasons.some((x) => x.includes("dosing advice")));
  assert.ok(rules[1].reasons.some((x) => x.includes("can't record expert")), "a blog can't become expert evidence");
  assert.ok([...r.s.findings.values()].some((f) => f.source.includes("supplement-blog") && f.untrusted));
  assert.doesNotMatch(r.onMain("content/interactions/rules.md")!, /double dose/);
  assert.equal(r.ask((a) => a.kind === "review" && a.todo === "rules")!.answeredBy, "pharmacist");
  for (const a of ["R1", "S1", "S2", "D1", "A1"]) assert.equal(await status(r.s, "meds", a), "supported", a);
  // After launch the label feed changed: the rules went stale, were rebuilt, and went back to the pharmacist.
  assert.ok(r.onMain(".agents/context/basis/senior-meds/drug-db.v2.json"));
  const reval = [...r.s.todos.values()].find((t) => t.id.startsWith("reval-rules"))!;
  assert.equal(reval.priority, 0);
  assert.equal(reval.status, "done");
  assert.ok(r.ask((a) => a.kind === "review" && a.todo === reval.id && a.answeredBy === "pharmacist"));
  assert.ok(r.ask((a) => a.origin === "monitor:labels")!.urgent);
});

test("case 4 (added), a legacy migration: fix and retest keeps the plan, nothing deploys in the freeze, and done means stop", async () => {
  const r = await play(migration());
  const refuted = r.ask((a) => a.origin === "rule:load_bearing_refuted")!;
  assert.equal(refuted.choice, "fix");
  for (const t of ["cut-10", "cut-100", "decommission"]) assert.equal(r.s.todos.get(t)!.status, "done", `${t} survived the failed shadow run`);
  assert.ok(r.s.todos.get("shadow")!.startedAt! < r.ask((a) => a.todo === "signoff")!.answeredAt!, "shadow testing didn't wait for the billing team");
  const freezeFrom = Date.parse("2026-12-15T00:00:00Z");
  const freezeTo = Date.parse("2027-01-05T00:00:00Z");
  const deploys = r.events.filter((e) => e.type === "todo_started" && r.s.todos.get(e.todo)?.lane === "deploy");
  assert.ok(deploys.every((e) => e.at < freezeFrom || e.at >= freezeTo), "no deployment started in the freeze");
  assert.equal(r.s.todos.get("cut-100")!.startedAt, freezeTo, "and the cut-over went the moment it ended");
  const inFreeze = r.sim.ticks.filter((t) => t.at > freezeFrom + 2 * 86_400_000 && t.at < freezeTo && !t.quiet).length;
  assert.ok(inFreeze <= 3, `slept through the freeze (${inFreeze} full wakes)`);
  assert.equal(r.s.goals.get("orders")!.status, "done");
  assert.equal(r.sim.log.at(-1)!.detail, "every goal closed");
});

test("case 5 (added), an open research question: spin caught, contradiction synthesized, contamination discounted, a negative result turned into the next question", async () => {
  const r = await play(research());
  assert.equal(r.turnsOf("lit").length, 3);
  const replan = [...r.s.todos.values()].find((t) => t.lane === "replan")!;
  assert.equal(replan.priority, 0);
  assert.match(r.s.todos.get("lit")!.reason!, /^replan/);
  const synth = [...r.s.todos.values()].find((t) => t.lane === "synthesis" && t.tests === "H1")!;
  assert.equal(synth.status, "done");
  const disc = r.events.find((e) => e.type === "finding_discounted");
  assert.ok(disc && disc.type === "finding_discounted" && disc.reason.includes("contamination"));
  const refuted = r.ask((a) => a.origin === "rule:load_bearing_refuted")!;
  assert.ok(refuted.openedAt >= r.s.todos.get("eval-b")!.doneAt!, "the direction question waited for the second experiment");
  assert.equal(refuted.choice, "pivot");
  assert.equal(await status(r.s, "q", "H2"), "supported");
  assert.equal(r.s.goals.get("q")!.status, "done");
  assert.ok(r.s.goals.get("q")!.spent.gpuHours <= 120);
});

test("case 6 (added), perpetual stewardship: quiet days cost nothing, each event is one piece of work, busywork is refused, the advisory jumps the queue", async () => {
  const r = await play(stewardship());
  assert.equal(r.s.turns.length, 4);
  assert.ok(r.s.turns.every((t) => r.s.todos.get(t.todo)!.provenance.startsWith("monitor:")), "every turn answered an event");
  assert.ok(r.s.turns.some((t) => t.reasons.some((x) => x.includes("no reason to exist"))), "invented improvements were refused");
  assert.ok(![...r.s.todos.values()].some((t) => t.lane === "polish"));
  const cve = [...r.s.todos.values()].find((t) => t.lane === "security")!;
  assert.equal(cve.priority, 0);
  const advisoryAt = Date.parse("2026-11-22T09:30:00Z");
  assert.ok(r.turnsOf(cve.id)[0].at - advisoryAt <= 3 * 3_600_000, "patched within one monitor interval");
  assert.equal(r.ask((a) => a.kind === "review" && a.todo === cve.id)!.choice, "approve", "a person approved the release");
  assert.ok(!r.ask((a) => a.origin === "rule:idle"), "a perpetual goal is never asked whether it's done");
  assert.equal(r.s.goals.get("lib")!.status, "active");
  assert.equal(r.s.goals.get("lib")!.spent.turns, 4);
});
