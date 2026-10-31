// Case 2: "SpaceX Starship 3D printing for kids."
//
// What makes it hard: the brief is ambiguous (kits? lessons? for parents or schools?),
// the brand belongs to someone else, it's a children's product (safety), demand is the
// real unknown and the fun part (designing the rocket) tempts everyone to start there,
// market tests take weeks and cost money, people with printers and lawyers have to do
// part of the work, and the first market is likely the wrong one.
//
// What the harness should do: test demand before designing anything; ask for the ad
// money right before it's needed; freeze the landing page while the test runs; not
// count "80% of surveyed parents would buy" as demand; take the IP lawyer's word on the
// name and drop the branded work; when pre-orders miss, trip the kill criterion and
// let the partner pivot (to classrooms), dropping the old plan's work; then run the
// new market test, the print test with a real printer, and a safety review. The team
// follows the work: the library has no role for CAD or lesson plans, so both get
// generated roles on probation. The CAD role's work is vouched for by the printability
// checker; the lessons go to an independent reviewer, who sends back the first draft.
import * as fs from "node:fs";
import * as path from "node:path";
import { ScriptedTurnAgent } from "../agents.ts";
import type { EngagementDef, GoalRevision } from "../types.ts";
import { SimMetrics } from "../world.ts";
import type { CaseSetup } from "./kit.ts";
import { about, contains, exists, lane, nth, on, origin, person, write } from "./kit.ts";

const START = "2026-11-02T09:00:00Z";

export function kidsDef(): EngagementDef {
  return {
    id: "kids-rockets", title: "SpaceX Starship 3D printing for kids",
    principals: { partner: "you", "ip-lawyer": "outside counsel", maker: "a teacher with a printer", "toy-safety": "a toy-safety consultant" },
    experts: ["ip-lawyer", "toy-safety"],
    redLines: ["small-parts-label"],
    goals: [{
      id: "kids", title: "Printable rocket kits", objective: "Starship-style rocket models kids can 3D print", owner: "partner",
      scope: ["research", "site", "cad", "curriculum"],
      budget: { turns: 200, usd: 500 },
      assumptions: [
        { id: "D1", text: "Parents will pre-order a $29 printable rocket kit", category: "desirability", risk: 5, uncertainty: 4, loadBearing: true, threshold: { metric: "preorders", op: ">=", value: 40 } },
        { id: "C1", text: "We can sell it under the Starship name", category: "compliance", risk: 5, uncertainty: 3 },
        { id: "F1", text: "The parts print reliably on common school printers", category: "feasibility", risk: 2, uncertainty: 2 },
        { id: "S1", text: "The kit is safe for ages 8+ and labeled for younger siblings", category: "safety", risk: 4, uncertainty: 2 },
      ],
      kill: [{ id: "K1", metric: "conversion", op: "<", value: 0.02, minSample: { metric: "visitors", value: 2000 } }],
      todos: [
        { id: "landing", lane: "build", text: "Landing page with a $29 pre-order", tests: "D1", writeScope: ["site/landing"], check: "page" },
        { id: "ads", kind: "wait", lane: "market", text: "Two weeks of ads to parents", after: ["landing"], cost: { usd: 200 }, freeze: ["site/landing"], wait: { source: "parents", minDays: 14, informs: [{ assumption: "D1", metric: "preorders" }] } },
        { id: "survey", kind: "wait", lane: "market", text: "Parent survey: would you buy it?", wait: { source: "survey", minDays: 7, informs: [{ assumption: "D1", metric: "would_buy", threshold: { metric: "would_buy", op: ">=", value: 0.5 } }] } },
        { id: "polish", lane: "build", text: "Tighten the landing copy once the first visitors are in", tests: "D1", priority: 3, notBefore: "2026-11-06T09:00:00Z", writeScope: ["site/landing"] },
        { id: "name", lane: "research", text: "Can we sell under the SpaceX/Starship name?", tests: "C1", writeScope: ["research"] },
        { id: "brand", lane: "build", text: "Brand the kit 'Starship Junior'", assumes: ["C1"], writeScope: ["site/brand"] },
        { id: "cad", lane: "design", text: "Design the printable kit", assumes: ["D1"], writeScope: ["cad"], check: "printable" },
      ],
    }],
  };
}

export const classrooms: GoalRevision = {
  title: "Classroom rocket-engineering packs",
  objective: "Rocket-engineering packs for grades 4-6: teachers buy, kids print at school",
  assumptions: [
    { id: "T1", text: "Teachers will pre-order a $49 class pack", category: "desirability", risk: 5, uncertainty: 4, loadBearing: true, threshold: { metric: "class_preorders", op: ">=", value: 15 } },
    { id: "C1", text: "We can sell it under the Starship name", category: "compliance", risk: 5, uncertainty: 3 },
    { id: "F1", text: "The parts print reliably on common school printers", category: "feasibility", risk: 2, uncertainty: 2 },
    { id: "S1", text: "The kit is safe for ages 8+ and labeled for younger siblings", category: "safety", risk: 4, uncertainty: 2 },
  ],
  kill: [{ id: "K2", metric: "class_preorders", op: "<", value: 5, minSample: { metric: "days_listed", value: 21 } }],
  success: [{ id: "teachers", assumption: "T1" }, { id: "prints", assumption: "F1" }, { id: "safe", assumption: "S1" }],
  todos: [
    { id: "teacher-page", lane: "build", text: "Class-pack page for teachers, standards-aligned", tests: "T1", writeScope: ["site/classroom"], check: "classpage" },
    { id: "teacher-test", kind: "wait", lane: "market", text: "Three weeks listed on a teacher marketplace", after: ["teacher-page"], cost: { usd: 150 }, freeze: ["site/classroom"], wait: { source: "teachers", minDays: 21, informs: [{ assumption: "T1", metric: "class_preorders" }] } },
    { id: "cad2", lane: "design", text: "Design the printable class pack (generic rocket, no trademarks)", assumes: ["T1"], writeScope: ["cad"], check: "printable" },
    { id: "lessons", lane: "curriculum", text: "Three lessons: thrust, stability, recovery", assumes: ["T1"], writeScope: ["curriculum"] },
    { id: "print-test", kind: "action", lane: "test", text: "Print the pack on a school printer; report print time and failures", assignee: "maker", after: ["cad2"] },
    { id: "safety-review", kind: "action", lane: "review", text: "Review the pack and labels for ages 8+", assignee: "toy-safety", after: ["cad2"] },
  ],
};

export function kidsRockets(): CaseSetup {
  const agent = new ScriptedTurnAgent([
    on("landing", (c) => { write(c, "site/landing/index.html", "<h1>Print your own rocket</h1><button>Pre-order $29</button><p>Not for children under 3: small parts.</p>"); return { done: true }; }),
    on("name", (c) => {
      write(c, "research/name.md", "Trademark search: SpaceX holds marks on the name. Needs counsel.\n");
      return {
        done: true,
        findings: [{ assumption: "C1", direction: "refutes", grade: "reported", source: "https://tmsearch.uspto.gov", text: "SpaceX holds registered marks covering the name" }],
        todos: [{ kind: "action", lane: "review", text: "Can we sell a printable kit called 'Starship Junior'?", assignee: "ip-lawyer", tests: "C1" }],
      };
    }),
    on("polish", (c) => { write(c, "site/landing/index.html", "<h1>Build a rocket tonight</h1><p>Not for children under 3: small parts.</p>"); return { done: true }; }),
    lane("design", (c) => { write(c, "cad/rocket.stl", "solid rocket\n# overhang 40\nendsolid\n"); return { done: true }; }),
    on("teacher-page", (c) => { write(c, "site/classroom/index.html", "<h1>Class packs: NGSS-aligned rocket engineering</h1><button>Pre-order $49</button><p>Not for children under 3: small parts.</p>"); return { done: true }; }),
    lane("synthesis", () => ({ done: true, note: "Parents didn't convert (1.1%); teachers did. Name must stay generic. Prints fine." })),
    // Lesson plans are a teacher's work; the library has no role for it, so a generated
    // one writes them, on probation. Its first draft forgets launch safety.
    on("lessons", (c) => {
      const safety = nth(c) > 1 ? "\nLaunch day: ages 8+, eye protection, an adult runs the launcher.\n" : "";
      write(c, "curriculum/lessons.md", `1. Thrust\n2. Stability\n3. Recovery: launch and retrieve\n${safety}`);
      return { done: true };
    }),
    // The independent reviewer (another model) reads what was written.
    lane("probation-review", (c) => {
      const f = path.join(c.wtDir, "curriculum", "lessons.md");
      const text = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
      return /eye protection/i.test(text)
        ? { done: true, verdict: "accept", note: "Covers the three topics and launch safety for 8+" }
        : { done: true, verdict: "reject", note: "The recovery lesson has a launch but no safety rules for 8-year-olds" };
    }),
  ]);

  const partner = person("partner", 24 * 60, [
    { match: origin("rule:money"), answer: () => ({ choice: "approve" }) },
    { match: origin("rule:kill_criterion"), answer: () => ({ choice: "pivot", revision: classrooms, note: "Parents don't bite; teachers might" }) },
    { match: origin("rule:load_bearing_refuted"), answer: () => ({ choice: "pivot", revision: classrooms, note: "Parents don't bite; teachers might" }) },
    { match: origin("rule:success"), answer: () => ({ choice: "close" }) },
    { match: origin("rule:idle"), answer: () => ({ choice: "close" }) },
  ]);
  const lawyer = person("ip-lawyer", 3 * 24 * 60, [
    { match: (a) => a.kind === "action", answer: () => ({ choice: "done", finding: { assumption: "C1", direction: "refutes", text: "No: the marks cover toys and models. Use a generic name." } }) },
  ]);
  const maker = person("maker", 2 * 24 * 60, [
    { match: about("print-test"), answer: () => ({ choice: "done", finding: { assumption: "F1", direction: "supports", text: "Printed three packs on a Bambu A1, 3h10 each, no failures", metrics: { print_hours: 3.2, failures: 0 }, runs: 3 } }) },
  ]);
  const safety = person("toy-safety", 4 * 24 * 60, [
    { match: about("safety-review"), answer: () => ({ choice: "done", finding: { assumption: "S1", direction: "supports", text: "OK for 8+ with the small-parts label on the box and page" } }) },
  ]);

  return {
    name: "kids-rockets",
    summary: "SpaceX Starship 3D printing for kids",
    def: kidsDef(),
    start: START,
    until: "2027-03-31T00:00:00Z",
    agent,
    runners: [{ runner: { id: "r1", capabilities: ["shell"] }, slots: 1 }],
    people: [partner, lawyer, maker, safety],
    world: {
      metrics: {
        parents: new SimMetrics("behavioral", (d) => ({ visitors: Math.round(150 * d), conversion: 0.011, preorders: Math.round(150 * d * 0.011) })),
        survey: new SimMetrics("stated", () => ({ would_buy: 0.8, responses: 120 })),
        teachers: new SimMetrics("behavioral", (d) => ({ class_preorders: Math.round(d * 1.05), days_listed: Math.floor(d) })),
      },
      checkers: {
        page: (dir) => exists(dir, "site/landing/index.html"),
        classpage: (dir) => exists(dir, "site/classroom/index.html"),
        printable: (dir, { files }) => contains(dir, files, /overhang (6\d|[7-9]\d)/, ["cad"]).map((x) => `${x}: overhang over 60 degrees`),
        // Anything sold to families must carry the small-parts warning.
        "small-parts-label": (dir, { files }) => files.filter((f) => f.startsWith("site/") && f.endsWith(".html")).flatMap((f) => (contains(dir, [f], /small parts/i, ["site"]).length ? [] : [`${f} has no small-parts warning`])),
      },
    },
  };
}
