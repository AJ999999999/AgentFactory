// The foundation: shared context layer, sealed divergence, and the challenge gates.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { main as cli } from "../src/foundation/cli.ts";
import { runContractRegistry } from "../src/foundation/demo.ts";
import { EntryStore } from "../src/foundation/entries.ts";
import type { Entry } from "../src/foundation/entries.ts";
import { Challenge, loadAngles } from "../src/foundation/process.ts";
import type { ChallengeDef } from "../src/foundation/process.ts";
import { CopilotAngleRunner, parseDrafts, ScriptedAngleRunner } from "../src/foundation/runners.ts";
import type { AngleRunner, AngleTask } from "../src/foundation/runners.ts";
import { readSealed, sealedRef, submitSealed } from "../src/foundation/seal.ts";
import { createWorkspace } from "../src/foundation/workspace.ts";
import { PROJECT_ROOT } from "../src/scenario.ts";

const angles = loadAngles(path.join(PROJECT_ROOT, "policy/angles.json"));
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), `af-${p}-`));

function entry(id: string, angle: string, body: Record<string, unknown> = {}): Entry {
  return { id, challenge: "c1", type: "option", author: { agent: `${angle}-agent`, role: "angle", angle }, refs: [], visibility: "sealed", status: "active", createdAt: "2026-10-29T00:00:00.000Z", body: { title: id, summary: "s", ...body } };
}

describe("entry store", () => {
  it("never edits: a change supersedes, and views show the latest version", () => {
    const store = new EntryStore(tmp("store"), "c1");
    const a = store.add({ type: "assumption", author: { agent: "x", role: "angle", angle: "risk" }, refs: [], body: { text: "t", risk: 3, uncertainty: 3 } });
    assert.throws(() => store.write(a), /never edited/);
    const b = store.supersede(a.id, { author: { agent: "y", role: "owner" }, status: "refuted" });
    assert.equal(b.id, "risk.A1~2");
    assert.equal(store.head("risk.A1").status, "refuted");
    assert.deepEqual(store.current().map((e) => e.id), ["risk.A1~2"]);
    assert.equal(store.all().length, 2, "history kept");
  });
  it("dependents follow refs transitively, across versions", () => {
    const store = new EntryStore(tmp("deps"), "c1");
    const author = { agent: "x", role: "angle" as const, angle: "a" };
    const o = store.add({ type: "option", author, refs: [], body: {} });
    const d = store.add({ type: "decision", author: { agent: "p", role: "owner" }, refs: [o.id], body: {} });
    const p = store.add({ type: "plan", author, refs: [d.id], body: {} });
    store.supersede(o.id, { author, body: { title: "v2" } });
    assert.deepEqual(store.dependents("a.O1~2").map((e) => e.id).sort(), [d.id, p.id].sort());
  });
});

describe("sealed commit-reveal", () => {
  it("keeps submissions off the main line, verifies them at reveal, and refuses resubmission or tampering", async () => {
    const control = await createWorkspace({ dir: tmp("seal") });
    const mine = [entry("risk.O1", "risk")];
    const s = await submitSealed(control, "c1", "risk", mine);
    assert.equal(control.listFiles("HEAD").some((f) => f.includes("risk.O1")), false, "nothing on main");
    assert.match(control.run(["ls-remote", "origin", sealedRef("c1", "risk")]), /refs\/sealed\/c1\/risk/);
    await assert.rejects(submitSealed(control, "c1", "risk", [entry("risk.O2", "risk")]), /already submitted/);
    const ok = await readSealed(control, "c1", "risk", s.hash);
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.entries.map((e) => e.id), ["risk.O1"]);
    // Someone rewrites the sealed ref after the commitment: reveal catches it.
    const forged = await submitSealed(control, "c1", "forger", [entry("risk.O1", "risk", { summary: "changed after seeing others" })]);
    await control.runAsync(["push", "-q", "-f", "origin", `${forged.commit}:${sealedRef("c1", "risk")}`]);
    const bad = await readSealed(control, "c1", "risk", s.hash);
    assert.equal(bad.ok, false);
    assert.match(String(bad.reason), /changed after commitment/);
  });
});

class Recorder implements AngleRunner {
  name = "recorder";
  inner: AngleRunner;
  tasks: AngleTask[] = [];
  constructor(inner: AngleRunner) {
    this.inner = inner;
  }
  run(task: AngleTask) {
    this.tasks.push(structuredClone(task));
    return this.inner.run(task);
  }
}

describe("the first challenge: contract registry, end to end", () => {
  let r: Awaited<ReturnType<typeof runContractRegistry>>;
  let rec: Recorder;
  let base: string;
  before(async () => {
    base = tmp("cr");
    r = await runContractRegistry(base, false, (inner) => (rec = new Recorder(inner)));
  });
  after(() => fs.rmSync(base, { recursive: true, force: true }));

  it("no peeking: during divergence every angle's view has no options at all", () => {
    const views = rec.tasks.filter((t) => t.stage === "diverge");
    assert.equal(views.length, 5);
    for (const t of views) assert.equal(t.view.filter((e) => e.type === "option").length, 0, t.angle.id);
  });
  it("a reference to another angle's sealed option is refused", () => {
    assert.ok(r.div.rejected.some((j) => j.angle === "contrarian" && /unresolved ref risk\.O1/.test(j.reason)));
  });
  it("evidence slices: each angle sees only evidence tagged for it", () => {
    const view = (id: string) => rec.tasks.find((t) => t.stage === "diverge" && t.angle.id === id)!.view.filter((e) => e.type === "evidence").map((e) => e.id);
    assert.deepEqual(view("feasibility"), ["lead.E1", "lead.E2", "lead.E5"]);
    assert.deepEqual(view("outside-view"), ["lead.E4"]);
    assert.equal(view("contrarian").length, 5, "reads nothing in particular, so sees everything");
  });
  it("budget: the third option is refused", () => {
    assert.ok(r.div.rejected.some((j) => j.angle === "feasibility" && /over budget/.test(j.reason)));
  });
  it("all submissions are revealed together and every one matches its commitment", () => {
    assert.equal(r.rev.failed.length, 0);
    assert.equal(r.rev.revealed.length, 15);
    assert.ok(rec.tasks.filter((t) => t.stage === "critique").every((t) => t.view.filter((e) => e.type === "option").length === 6));
  });
  it("critique gates: no self-critique, no evidence outside the view, theater discarded", () => {
    const reasons = r.crit.rejected.map((j) => `${j.angle}: ${j.reason}`);
    assert.ok(reasons.includes("risk: self-critique: angles never critique their own options"));
    assert.ok(reasons.some((x) => x.startsWith("user-value: critique cites evidence")));
    assert.deepEqual(r.crit.accepted.filter((e) => e.status === "discarded").map((e) => e.author.angle), ["contrarian"]);
  });
  it("score gates: no scoring your own option, no stale criteria", () => {
    const reasons = r.sc.rejected.map((j) => `${j.angle}: ${j.reason}`);
    assert.ok(reasons.includes("feasibility: angles never score their own options"));
    assert.ok(reasons.includes("contrarian: score uses criteria other than the frozen ones"));
  });
  it("fact-checking by lookup: repo sources verified, missing file failed, prose unverified", () => {
    const status = Object.fromEntries(r.ch.store.current().filter((e) => e.type === "evidence").map((e) => [e.id, e.status]));
    assert.equal(status["lead.E1"], "verified");
    assert.equal(status["lead.E5"], "failed");
    assert.equal(status["lead.E3"], "unverified");
  });
  it("the reframe was the owner's call and froze nothing new: the criteria hash held", () => {
    assert.match(r.ch.frameEntry().body.problem, /declared, pinned and checked/);
    assert.equal(r.decision.body.criteriaHash, r.ch.criteriaHash());
  });
  it("MVP plan tests the riskiest assumptions of the chosen option first", () => {
    assert.deepEqual(r.plan.body.test.map((a: { id: string }) => a.id), ["lead.A1", "lead.A2", "risk.A1"]);
    assert.deepEqual(r.plan.body.deferred.map((a: { id: string }) => a.id), ["lead.A3"]);
  });
  it("a refuted assumption reopens the decision, asks the owner, and marks the MVP stale; a supported one doesn't", () => {
    assert.deepEqual(r.supported.reopened, []);
    assert.equal(r.refuted.reopened.length, 1);
    assert.equal(r.refuted.reopened[0].status, "reopened");
    assert.equal(r.refuted.questions[0].body.to, "partner");
    assert.deepEqual(r.refuted.breakpoints.map((b) => [b.pinned, b.current]), [["contract-registry/risk.A1@v1", "contract-registry/risk.A1@v2"]]);
  });
  it("the record names who decided and what was rejected", () => {
    assert.match(r.report, /partner chose risk\.O1/);
    assert.match(r.report, /\*\*Reopened\*\* by X2/);
  });
});

describe("gates out of order", () => {
  const def: ChallengeDef = {
    id: "gates", title: "Gates", problem: "p", constraints: [], owner: "partner", angles: ["risk", "feasibility"], challenger: "challenger", lead: "lead",
    criteria: [{ id: "c", text: "c", weight: 1 }], budget: { optionsPerAngle: 1, mvpAssumptions: 1 }, evidence: [],
  };
  const script = {
    diverge: {
      risk: [{ type: "option", body: { title: "R", summary: "r" } }],
      feasibility: [{ type: "option", body: { title: "F", summary: "f" } }],
    },
    score: {
      risk: [{ type: "score", body: { option: "feasibility.O1", criteriaHash: "$CRITERIA_HASH", scores: { c: 5 } } }],
      feasibility: [{ type: "score", body: { option: "risk.O1", criteriaHash: "$CRITERIA_HASH", scores: { c: 1 } } }],
    },
  };
  it("refuses each step before its gate, and decisions by anyone but the owner", async () => {
    const control = await createWorkspace({ dir: tmp("gates") });
    const ch = new Challenge({ control, def, angles, runner: new ScriptedAngleRunner(script as never) });
    await ch.open();
    await assert.rejects(ch.diverge(), /needs stage "frame_confirmed"/);
    await assert.rejects(ch.confirmFrame({ by: "lead-agent" }), /only the owner/);
    await ch.confirmFrame({ by: "partner" });
    await assert.rejects(ch.challengeFrame(), /closed/);
    await ch.diverge();
    await assert.rejects(ch.critique(), /needs stage "reveal"/);
    await ch.reveal();
    await ch.critique();
    await ch.score();
    // The higher-scored option is not chosen for anyone: nothing happens until the owner rules.
    assert.ok(ch.scoreTable()["feasibility.O1"].weighted > ch.scoreTable()["risk.O1"].weighted);
    assert.equal(ch.decision(), undefined);
    await assert.rejects(ch.decide({ by: "risk-agent", chosen: "risk.O1", rejected: { "feasibility.O1": "x" }, criteriaHash: ch.criteriaHash() }), /only the owner/);
    await assert.rejects(ch.decide({ by: "partner", chosen: "risk.O1", rejected: {}, criteriaHash: ch.criteriaHash() }), /needs a reason: feasibility\.O1/);
    await assert.rejects(ch.decide({ by: "partner", chosen: "risk.O1", rejected: { "feasibility.O1": "x" }, criteriaHash: "other" }), /criteria frozen/);
    const d = await ch.decide({ by: "partner", chosen: "risk.O1", rejected: { "feasibility.O1": "too slow for us" }, criteriaHash: ch.criteriaHash() });
    assert.equal(d.body.chosen, "risk.O1", "the owner may choose the lower-scored option");
  });
});

describe("Copilot CLI angle runner", () => {
  it("runs each angle as its own headless call with only its view, and parses the reply", async () => {
    const dir = tmp("stub");
    const stub = path.join(dir, "copilot-stub.mjs");
    fs.writeFileSync(stub, `const p = process.argv[process.argv.indexOf("-p") + 1];\nconsole.log("Here are my drafts:\\n" + JSON.stringify([{ type: "option", localId: "o", body: { title: "From " + (p.match(/"(.+?)" angle/) || [])[1], summary: "s" } }]));\n`);
    const runner = new CopilotAngleRunner({ bin: process.execPath, binArgs: [stub] });
    const view = [{ id: "lead.F1", challenge: "c", type: "frame", author: { agent: "lead", role: "lead" }, refs: [], visibility: "team", status: "active", createdAt: "", body: { criteriaHash: "h" } }] as Entry[];
    const drafts = await runner.run({ stage: "diverge", angle: { id: "risk", title: "Risk", objective: "o", reads: [], model: "model-c" }, challenge: { id: "c", title: "C" }, view, instructions: "i", budget: 2 });
    assert.deepEqual(drafts.map((d) => d.body.title), ["From Risk"]);
    const args = runner.calls[0].args;
    assert.equal(args[args.indexOf("--model") + 1], "model-c");
    assert.ok(args.includes("--deny-tool"));
    assert.match(args[args.indexOf("-p") + 1], /lead\.F1/);
  });
  it("rejects replies without a JSON array", () => {
    assert.throws(() => parseDrafts("I think option A is best."), /no JSON array/);
  });
});

describe("CLI", () => {
  it("runs a challenge one owner gate at a time, picking up from git each time", async () => {
    const dir = tmp("cli");
    const run = (...a: string[]) => cli([...a, "--dir", dir]);
    const started = await run("start", "challenges/contract-registry.json", "--runner", "scripted", "--script", "challenges/contract-registry.script.json");
    assert.match(started, /frame challenger asks/);
    const brief = await run("confirm", "--by", "partner");
    assert.match(brief, /5 angles submitted sealed/);
    assert.ok(fs.existsSync(path.join(dir, "BRIEF.md")));
    const plan = await run("decide", "--by", "partner", "--chosen", "risk.O1",
      "--reject", "user-value.O1=generated tests instead", "--reject", "feasibility.O1=misses semantic changes",
      "--reject", "feasibility.O2=folded into the choice", "--reject", "contrarian.O1=clients won't merge repos",
      "--reject", "outside-view.O1=pointers don't catch semantics");
    assert.match(plan, /test lead\.A1/);
    assert.match(await run("build"), /pinned contract-registry\/lead\.A1@v1/);
    assert.match(await run("experiment", "--by", "partner", "--assumption", "risk.A1", "--result", "refuted", "--method", "m", "--evidence", "e"), /Question for you/);
    assert.match(await run("report"), /REPORT\.md/);
  });
});
