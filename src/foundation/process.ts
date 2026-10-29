// How a team takes on a hard problem: frame, diverge (sealed), reveal, critique,
// score, converge (owner decides), plan the MVP around the riskiest assumptions,
// build, and test. Every stage reads and writes typed entries in the shared context
// layer, and each has a gate that stops a known failure:
//
//   frame       criteria are fixed and confirmed by the owner before any option exists
//   diverge     angles work sealed; refs to anything outside an angle's view are refused
//   reveal      every submission is checked against its commitment hash
//   critique    no critiquing your own option; no evidence and no test = discarded
//   score       no scoring your own option; scores must name the frozen criteria hash
//   converge    only the owner decides; every rejected option needs a reason; no voting
//   plan MVP    the riskiest assumptions are tested first; they become versioned basis
//   experiment  a refuted assumption reopens the decision built on it
import type { AgentConfig, AgentRunner, RunSpec } from "../agents/runner.ts";
import { basisRef, currentBasis, writeBasis, writeTask } from "../context.ts";
import type { ContextBundle } from "../context.ts";
import type { Git } from "../git.ts";
import { repoLock } from "../git.ts";
import { observe } from "../observator.ts";
import type { Observation } from "../observator.ts";
import type { Coordinator } from "../orchestrator.ts";
import { sha256, writeJson } from "../util.ts";
import type { LogFn } from "../util.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { EntryStore, rootOf, stableStringify } from "./entries.ts";
import type { Author, Draft, Entry, EntryType } from "./entries.ts";
import type { AngleConfig, AngleRunner, AnglesFile, Stage } from "./runners.ts";
import { readSealed, submitSealed } from "./seal.ts";

export type Criterion = { id: string; text: string; weight: number };

export type ChallengeDef = {
  id: string; // ref-safe: lowercase letters, digits, dashes
  title: string;
  problem: string;
  constraints: string[];
  criteria: Criterion[];
  owner: string;
  angles: string[];
  challenger: string;
  lead: string;
  budget: { optionsPerAngle: number; mvpAssumptions: number };
  evidence: Array<{ source: string; text: string; tags?: string[] }>;
};

export type Rejected = { angle: string; stage: string; draft: Draft; reason: string };

const ANGLE_VISIBLE: EntryType[] = ["frame", "question", "evidence", "option", "assumption", "critique", "score", "decision", "plan", "experiment"];

export class Challenge {
  control: Git;
  def: ChallengeDef;
  angles: AnglesFile;
  runner: AngleRunner;
  store: EntryStore;
  log: LogFn;

  constructor(opts: { control: Git; def: ChallengeDef; angles: AnglesFile; runner: AngleRunner; log?: LogFn }) {
    this.control = opts.control;
    this.def = opts.def;
    this.angles = opts.angles;
    this.runner = opts.runner;
    this.store = new EntryStore(opts.control.cwd, opts.def.id);
    this.log = opts.log ?? (() => {});
  }

  get repo(): string {
    return this.control.cwd;
  }

  angle(id: string): AngleConfig {
    const a = this.angles.angles[id];
    if (!a) throw new Error(`unknown angle ${id}`);
    return { id, ...a };
  }

  criteriaHash(): string {
    return sha256(stableStringify(this.def.criteria));
  }

  // ---------- git plumbing: the runner is the only writer of entries ----------

  async sync(): Promise<void> {
    await repoLock(this.control).run(async () => {
      await this.control.runAsync(["fetch", "-q", "origin"]);
      await this.control.runAsync(["rebase", "-q", "origin/main"]);
    });
  }

  async commit(message: string, trailers: Record<string, string> = {}): Promise<string | null> {
    return repoLock(this.control).run(async () => {
      await this.control.runAsync(["add", "-A"]);
      if (!(await this.control.changedFiles()).length) return null;
      const args = ["commit", "-q", "-m", message, "--trailer", `Challenge: ${this.def.id}`];
      for (const [k, v] of Object.entries(trailers)) args.push("--trailer", `${k}: ${v}`);
      await this.control.runAsync(args);
      for (let attempt = 0; attempt < 5; attempt++) {
        await this.control.runAsync(["fetch", "-q", "origin"]);
        await this.control.runAsync(["rebase", "-q", "origin/main"]);
        if ((await this.control.tryAsync(["push", "-q", "origin", "HEAD:main"])).ok) return this.control.runAsync(["rev-parse", "HEAD"]);
      }
      throw new Error(`push failed: ${message}`);
    });
  }

  // ---------- stage bookkeeping ----------

  stages(): string[] {
    return this.store.current().filter((e) => e.type === "stage").map((e) => e.body.name);
  }

  private require(stage: string, action: string): void {
    if (!this.stages().includes(stage)) throw new Error(`${action} needs stage "${stage}" first`);
  }

  private forbid(stage: string, action: string): void {
    if (this.stages().includes(stage)) throw new Error(`${action} is closed: stage "${stage}" already happened`);
  }

  private markStage(name: string, body: Record<string, unknown> = {}): Entry {
    return this.store.add({ type: "stage", author: { agent: "runner", role: "runner" }, refs: [], body: { name, ...body } });
  }

  frameEntry(): Entry {
    const f = this.store.current().find((e) => e.type === "frame");
    if (!f) throw new Error("no frame yet");
    return f;
  }

  private angleView(angle: AngleConfig): Entry[] {
    return this.store.view({ angle: angle.id, role: "angle", tags: angle.reads }).filter((e) => ANGLE_VISIBLE.includes(e.type));
  }

  // ---------- validation: the gates every draft passes ----------

  private validate(stage: Stage, angle: AngleConfig, drafts: Draft[], view: Entry[], visibility: "sealed" | "team"): { accepted: Entry[]; rejected: Rejected[] } {
    const allowed = this.angles.stages[stage].allowed;
    const viewIds = new Map(view.map((e) => [rootOf(e.id), e]));
    const taken = new Set<string>();
    const local = new Map<string, string>();
    const author: Author = { agent: `${angle.id}-agent`, role: angle.id === this.def.lead ? "lead" : "angle", angle: angle.id, config: `${angle.id}@${angle.model}` };
    const pending = drafts.map((d) => {
      const id = this.store.nextId(d.type, angle.id, taken);
      taken.add(id);
      if (d.localId) local.set(d.localId, id);
      return { d, id };
    });
    const rejected: Rejected[] = [];
    const reject = (d: Draft, reason: string) => rejected.push({ angle: angle.id, stage, draft: d, reason });
    const out = new Map<string, Entry>();
    let optionCount = 0;

    for (const { d, id } of pending) {
      if (!allowed.includes(d.type)) { reject(d, `type ${d.type} not allowed in ${stage}`); continue; }
      const refs: string[] = [];
      let bad = "";
      for (const r of d.refs ?? []) {
        if (local.has(r)) refs.push(local.get(r)!);
        else if (viewIds.has(rootOf(r))) refs.push(r);
        else { bad = `unresolved ref ${r}: not visible to ${angle.id}`; break; }
      }
      if (bad) { reject(d, bad); continue; }
      const e: Entry = { id, challenge: this.def.id, type: d.type, author, refs, visibility, status: d.status ?? "active", createdAt: new Date().toISOString(), body: d.body };
      const refEntry = (r: string) => viewIds.get(rootOf(r)) ?? out.get(r);

      if (d.type === "option") {
        if (!d.body.title || !d.body.summary) { reject(d, "option needs title and summary"); continue; }
        if (++optionCount > this.def.budget.optionsPerAngle) { reject(d, `over budget: ${this.def.budget.optionsPerAngle} options per angle`); continue; }
      }
      if (d.type === "assumption") {
        const ok = (n: unknown) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 5;
        if (!d.body.text || !ok(d.body.risk) || !ok(d.body.uncertainty)) { reject(d, "assumption needs text, risk 1-5 and uncertainty 1-5"); continue; }
        if (stage === "assumptions" && !refs.some((r) => rootOf(r) === rootOf(this.decision()?.body.chosen ?? ""))) { reject(d, "planning assumptions must ref the chosen option"); continue; }
      }
      if (d.type === "evidence") {
        if (!d.body.source || !d.body.text) { reject(d, "evidence needs source and text"); continue; }
        e.status = this.factCheck(String(d.body.source));
      }
      if (d.type === "critique") {
        const targets = refs.map(refEntry).filter((x): x is Entry => x?.type === "option");
        if (!targets.length) { reject(d, "critique must ref an option"); continue; }
        if (targets.some((t) => t.author.angle === angle.id)) { reject(d, "self-critique: angles never critique their own options"); continue; }
        const evidence: string[] = (d.body.evidenceRefs ?? []).map((r: string) => local.get(r) ?? r);
        const evidenceOk = evidence.length > 0 && evidence.every((r) => refEntry(r)?.type === "evidence");
        if (d.body.evidenceRefs?.length && !evidenceOk) { reject(d, "critique cites evidence that isn't visible evidence"); continue; }
        e.body = { ...d.body, evidenceRefs: evidence };
        if (!evidenceOk && !d.body.test) e.status = "discarded"; // no evidence and no test: theater
      }
      if (d.type === "score") {
        const opt = refEntry(String(d.body.option ?? ""));
        if (!opt || opt.type !== "option") { reject(d, "score must name a visible option"); continue; }
        if (opt.author.angle === angle.id) { reject(d, "angles never score their own options"); continue; }
        if (d.body.criteriaHash !== this.criteriaHash()) { reject(d, "score uses criteria other than the frozen ones"); continue; }
        const ids = new Set(this.def.criteria.map((c) => c.id));
        const scores = d.body.scores ?? {};
        if (!Object.entries(scores).every(([k, v]) => ids.has(k) && Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 5)) { reject(d, "scores must be 1-5 on the frame's criteria"); continue; }
        if (!refs.length) e.refs = [opt.id];
      }
      out.set(id, e);
    }
    // Drop anything that leans on a rejected draft from the same batch.
    const rejectedIds = new Set(pending.filter((p) => rejected.some((r) => r.draft === p.d)).map((p) => p.id));
    for (const [id, e] of [...out]) {
      if (e.refs.some((r) => rejectedIds.has(r))) {
        out.delete(id);
        rejected.push({ angle: angle.id, stage, draft: pending.find((p) => p.id === id)!.d, reason: "depends on a rejected draft" });
      }
    }
    return { accepted: [...out.values()], rejected };
  }

  // Claims are checked by lookup, never by asking a model whether they sound right.
  factCheck(source: string): string {
    if (source.startsWith("repo:")) return fs.existsSync(path.join(this.repo, source.slice(5))) ? "verified" : "failed";
    if (source.startsWith("entry:")) return this.store.get(source.slice(6)) ? "verified" : "failed";
    return "unverified";
  }

  private writeRejections(rejected: Rejected[], visibility: "sealed" | "team" = "team"): Entry[] {
    return rejected.map((r) => ({ id: "", challenge: this.def.id, type: "rejection" as EntryType, author: { agent: "runner", role: "runner" as const }, refs: [], visibility, status: "rejected", createdAt: new Date().toISOString(), body: r }));
  }

  // ---------- stages ----------

  async open(): Promise<Entry> {
    if (this.store.current().some((e) => e.type === "frame")) throw new Error("challenge already open");
    const lead: Author = { agent: `${this.def.lead}-agent`, role: "lead", angle: this.def.lead };
    const frame = this.store.add({
      type: "frame",
      author: lead,
      refs: [],
      body: { title: this.def.title, problem: this.def.problem, constraints: this.def.constraints, criteria: this.def.criteria, criteriaHash: this.criteriaHash(), owner: this.def.owner },
    });
    for (const ev of this.def.evidence) {
      this.store.add({ type: "evidence", author: lead, refs: [frame.id], status: this.factCheck(ev.source), body: { source: ev.source, text: ev.text, tags: ev.tags ?? [] } });
    }
    this.markStage("frame", { criteriaHash: this.criteriaHash() });
    await this.commit("frame the challenge", { Stage: "frame" });
    this.log("stage", { name: "frame" });
    return frame;
  }

  async challengeFrame(): Promise<Entry[]> {
    this.require("frame", "challenging the frame");
    this.forbid("frame_confirmed", "challenging the frame");
    const a = this.angle(this.def.challenger);
    const view = this.angleView(a);
    const drafts = await this.runner.run({ stage: "challenge_frame", angle: a, challenge: this.def, view, instructions: this.angles.stages.challenge_frame.instructions });
    const { accepted, rejected } = this.validate("challenge_frame", a, drafts, view, "team");
    for (const e of [...accepted, ...this.writeRejections(rejected)]) this.store.add({ ...e, id: e.id || undefined });
    await this.commit("challenge the frame", { Stage: "challenge_frame" });
    this.log("stage", { name: "challenge_frame", questions: accepted.length });
    return accepted;
  }

  // The owner confirms the problem (optionally reframed) before anyone proposes a solution.
  async confirmFrame(opts: { by: string; reframe?: string; answer?: string }): Promise<Entry> {
    this.require("frame", "confirming the frame");
    this.forbid("frame_confirmed", "confirming the frame");
    if (opts.by !== this.def.owner) throw new Error(`only the owner (${this.def.owner}) confirms the frame`);
    const owner: Author = { agent: opts.by, role: "owner" };
    let frame = this.frameEntry();
    if (opts.reframe) frame = this.store.supersede(frame.id, { author: owner, body: { problem: opts.reframe } });
    const questions = this.store.current().filter((e) => e.type === "question");
    const d = this.store.add({ type: "decision", author: owner, refs: [frame.id, ...questions.map((q) => q.id)], body: { kind: "frame", criteriaHash: this.criteriaHash(), reframed: !!opts.reframe, answer: opts.answer ?? "" } });
    this.markStage("frame_confirmed", { criteriaHash: this.criteriaHash(), decision: d.id });
    await this.commit("owner confirms the frame", { Stage: "frame_confirmed", "Decided-by": opts.by });
    return d;
  }

  // Angles propose options alone. Their entries go to sealed refs; only commitment
  // hashes reach the main line until every angle is done.
  async diverge(): Promise<{ commitments: Entry[]; rejected: Rejected[] }> {
    this.require("frame_confirmed", "diverging");
    this.forbid("diverge", "diverging");
    this.markStage("diverge", { criteriaHash: this.criteriaHash(), angles: this.def.angles });
    await this.commit("open divergence", { Stage: "diverge" });
    const tasks = this.def.angles.map((id) => {
      const a = this.angle(id);
      const view = this.angleView(a);
      return { a, view, run: this.runner.run({ stage: "diverge", angle: a, challenge: this.def, view, instructions: this.angles.stages.diverge.instructions, budget: this.def.budget.optionsPerAngle }) };
    });
    const results = await Promise.all(tasks.map((t) => t.run));
    const commitments: Entry[] = [];
    const allRejected: Rejected[] = [];
    for (let i = 0; i < tasks.length; i++) {
      const { a, view } = tasks[i];
      const { accepted, rejected } = this.validate("diverge", a, results[i], view, "sealed");
      const rejections = this.writeRejections(rejected, "sealed").map((r, j) => ({ ...r, id: `${a.id}.J${j + 1}` }));
      const sealed = await submitSealed(this.control, this.def.id, a.id, [...accepted, ...rejections]);
      commitments.push(this.store.add({ type: "commitment", author: { agent: `${a.id}-agent`, role: "angle", angle: a.id }, refs: [], body: { hash: sealed.hash, ref: sealed.ref, entries: accepted.length + rejections.length } }));
      allRejected.push(...rejected);
    }
    await this.commit("record sealed commitments", { Stage: "diverge" });
    this.log("stage", { name: "diverge", angles: commitments.length });
    return { commitments, rejected: allRejected };
  }

  async reveal(): Promise<{ revealed: Entry[]; failed: Array<{ angle: string; reason: string }> }> {
    this.require("diverge", "revealing");
    this.forbid("reveal", "revealing");
    const revealed: Entry[] = [];
    const failed: Array<{ angle: string; reason: string }> = [];
    for (const k of this.store.current().filter((e) => e.type === "commitment")) {
      const r = await readSealed(this.control, this.def.id, k.author.angle!, k.body.hash);
      if (!r.ok) { failed.push({ angle: r.angle, reason: r.reason! }); continue; }
      for (const e of r.entries) revealed.push(this.store.write({ ...e, visibility: "team" }));
    }
    for (const f of failed) this.store.add({ type: "rejection", author: { agent: "runner", role: "runner" }, refs: [], status: "rejected", body: { angle: f.angle, stage: "reveal", reason: f.reason } });
    this.markStage("reveal", { revealed: revealed.length, failed: failed.map((f) => f.angle) });
    await this.commit("reveal all submissions together", { Stage: "reveal" });
    this.log("stage", { name: "reveal", revealed: revealed.length, failed });
    return { revealed, failed };
  }

  private async angleRound(stage: "critique" | "score", angleIds: string[]): Promise<{ accepted: Entry[]; rejected: Rejected[] }> {
    const results = await Promise.all(angleIds.map(async (id) => {
      const a = this.angle(id);
      const view = this.angleView(a);
      const drafts = await this.runner.run({ stage, angle: a, challenge: this.def, view, instructions: this.angles.stages[stage].instructions });
      return { a, view, drafts };
    }));
    const accepted: Entry[] = [];
    const rejected: Rejected[] = [];
    for (const { a, view, drafts } of results) {
      const v = this.validate(stage, a, drafts, view, "team");
      for (const e of v.accepted) accepted.push(this.store.write(e));
      rejected.push(...v.rejected);
    }
    for (const r of this.writeRejections(rejected)) this.store.add({ ...r, id: undefined });
    return { accepted, rejected };
  }

  async critique(): Promise<{ accepted: Entry[]; rejected: Rejected[] }> {
    this.require("reveal", "critiquing");
    this.forbid("critique", "critiquing");
    const res = await this.angleRound("critique", this.def.angles);
    this.markStage("critique");
    await this.commit("cross-critique", { Stage: "critique" });
    this.log("stage", { name: "critique", accepted: res.accepted.length, discarded: res.accepted.filter((e) => e.status === "discarded").length, rejected: res.rejected.length });
    return res;
  }

  async score(): Promise<{ accepted: Entry[]; rejected: Rejected[] }> {
    this.require("critique", "scoring");
    this.forbid("score", "scoring");
    const res = await this.angleRound("score", this.def.angles);
    this.markStage("score");
    await this.commit("score against the frozen criteria", { Stage: "score" });
    return res;
  }

  options(): Entry[] {
    return this.store.current().filter((e) => e.type === "option");
  }

  // Mean score per criterion from other angles, and a weighted total. Shown to the
  // owner as information, never used to pick: agents with correlated errors agreeing
  // isn't evidence.
  scoreTable(): Record<string, { perCriterion: Record<string, number>; weighted: number; raters: number }> {
    const out: Record<string, { perCriterion: Record<string, number>; weighted: number; raters: number }> = {};
    const scores = this.store.current().filter((e) => e.type === "score");
    for (const o of this.options()) {
      const mine = scores.filter((s) => rootOf(s.body.option) === rootOf(o.id));
      const perCriterion: Record<string, number> = {};
      for (const c of this.def.criteria) {
        const vals = mine.map((s) => s.body.scores[c.id]).filter((v) => typeof v === "number");
        perCriterion[c.id] = vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : 0;
      }
      const w = this.def.criteria.reduce((s, c) => s + c.weight, 0);
      out[o.id] = { perCriterion, weighted: Math.round((this.def.criteria.reduce((s, c) => s + c.weight * perCriterion[c.id], 0) / w) * 100) / 100, raters: mine.length };
    }
    return out;
  }

  decision(): Entry | undefined {
    return this.store.current().find((e) => e.type === "decision" && e.body.kind === "converge");
  }

  async decide(opts: { by: string; chosen: string; rejected: Record<string, string>; criteriaHash: string; note?: string }): Promise<Entry> {
    this.require("score", "deciding");
    this.forbid("decided", "deciding");
    if (opts.by !== this.def.owner) throw new Error(`only the owner (${this.def.owner}) decides; agents don't vote`);
    if (opts.criteriaHash !== this.criteriaHash()) throw new Error("decision must use the criteria frozen at frame confirmation");
    const options = this.options();
    const chosen = options.find((o) => rootOf(o.id) === rootOf(opts.chosen));
    if (!chosen) throw new Error(`${opts.chosen} is not an option`);
    const unknown = Object.keys(opts.rejected).filter((id) => !options.some((o) => o.id === id));
    if (unknown.length) throw new Error(`not options: ${unknown.join(", ")}`);
    const missing = options.filter((o) => o.id !== chosen.id && !(opts.rejected[o.id] ?? "").trim());
    if (missing.length) throw new Error(`every other option needs a reason: ${missing.map((o) => o.id).join(", ")}`);
    const d = this.store.add({
      type: "decision",
      author: { agent: opts.by, role: "owner" },
      refs: [chosen.id, ...Object.keys(opts.rejected)],
      body: { kind: "converge", chosen: chosen.id, rejected: Object.entries(opts.rejected).map(([option, reason]) => ({ option, reason })), criteriaHash: opts.criteriaHash, note: opts.note ?? "" },
    });
    this.markStage("decided", { decision: d.id });
    await this.commit(`owner chooses ${chosen.id}`, { Stage: "decided", "Decided-by": opts.by });
    return d;
  }

  // The MVP exists to test what the chosen option depends on, riskiest first.
  async planMvp(): Promise<Entry> {
    this.require("decided", "planning the MVP");
    this.forbid("planned", "planning the MVP");
    const chosen = this.decision()!.body.chosen as string;
    const lead = this.angle(this.def.lead);
    const view = this.angleView(lead);
    const drafts = await this.runner.run({ stage: "assumptions", angle: lead, challenge: this.def, view, instructions: this.angles.stages.assumptions.instructions });
    const { accepted, rejected } = this.validate("assumptions", lead, drafts, view, "team");
    for (const e of accepted) this.store.write(e);
    for (const r of this.writeRejections(rejected)) this.store.add({ ...r, id: undefined });

    const candidates = this.store.current().filter((e) => e.type === "assumption" && e.refs.some((r) => rootOf(r) === rootOf(chosen)));
    const ranked = candidates
      .map((a) => ({ id: a.id, text: a.body.text as string, risk: a.body.risk as number, uncertainty: a.body.uncertainty as number, priority: (a.body.risk as number) * (a.body.uncertainty as number), test: (a.body.test as string) ?? "" }))
      .sort((x, y) => y.priority - x.priority || x.id.localeCompare(y.id));
    const k = this.def.budget.mvpAssumptions;
    const selected = ranked.slice(0, k);
    const plan = this.store.add({
      type: "plan",
      author: { agent: `${lead.id}-agent`, role: "lead", angle: lead.id },
      refs: [this.decision()!.id, ...selected.map((a) => a.id)],
      body: { chosen, test: selected, deferred: ranked.slice(k), acceptance: selected.map((a) => `${a.id} is supported or refuted by: ${a.test || "an experiment named in the plan"}`) },
    });

    // Assumptions under test become versioned basis: anything built on them is pinned,
    // and a refutation shows up in the Observator like any other basis change.
    writeTask(this.repo, {
      id: this.def.id,
      goal: this.def.problem,
      rules: this.def.constraints,
      basis: selected.map((a) => a.id),
      criteria: `.agents/challenges/${this.def.id}/acceptance.json`,
      permissions: { author: ["goal", "rules", "state", "evidence"], reviewer: ["goal", "rules", "state", "evidence", "results"] },
    });
    writeJson(path.join(this.repo, ".agents", "challenges", this.def.id, "acceptance.json"), { plan: plan.id, acceptance: plan.body.acceptance });
    for (const a of selected) writeBasis(this.repo, this.def.id, a.id, { status: "untested", text: a.text, risk: a.risk, uncertainty: a.uncertainty, test: a.test }, plan.id);
    this.markStage("planned", { plan: plan.id });
    await this.commit("plan the MVP around the riskiest assumptions", { Stage: "planned" });
    return plan;
  }

  plan(): Entry | undefined {
    return this.store.current().find((e) => e.type === "plan");
  }

  async build(coord: Coordinator, config: AgentConfig): Promise<Entry> {
    this.require("planned", "building");
    const plan = this.plan()!;
    const artifact = `prototypes/${this.def.id}`;
    const res = await coord.runAgent(`${this.def.id}-mvp`, { agent: config.id, task: this.def.id, artifact, kind: "prototype" as RunSpec["kind"], config });
    await this.sync();
    const pins = plan.body.test.map((a: { id: string }) => basisRef(this.def.id, a.id, currentBasis(this.repo, this.def.id, a.id)!.version));
    const entry = this.store.add({ type: "artifact", author: { agent: config.id, role: "builder" }, refs: [plan.id, ...plan.body.test.map((a: { id: string }) => a.id)], body: { path: artifact, commit: res.sha, pins } });
    this.markStage("built", { artifact: entry.id });
    await this.commit("record the MVP build", { Stage: "built" });
    return entry;
  }

  // A result updates the assumption, its basis version, and anything decided on it.
  async experiment(opts: { by: string; assumption: string; method: string; result: "supported" | "refuted"; evidence: string }): Promise<{ experiment: Entry; reopened: Entry[]; questions: Entry[]; breakpoints: Observation["breakpoints"] }> {
    this.require("planned", "recording an experiment");
    await this.sync();
    const plan = this.plan()!;
    const a = this.store.head(opts.assumption);
    if (!plan.body.test.some((t: { id: string }) => rootOf(t.id) === rootOf(a.id))) throw new Error(`${opts.assumption} is not under test in the plan`);
    const by: Author = { agent: opts.by, role: opts.by === this.def.owner ? "owner" : "builder" };
    const x = this.store.add({ type: "experiment", author: by, refs: [a.id], status: opts.result, body: { method: opts.method, result: opts.result, evidence: opts.evidence } });
    this.store.supersede(a.id, { author: by, status: opts.result, body: { result: opts.result, experiment: x.id } });
    // Support confirms what was built on; only a refutation changes the basis, so only
    // a refutation makes pinned work stale.
    if (opts.result === "refuted") {
      const prev = currentBasis(this.repo, this.def.id, rootOf(a.id))!;
      writeBasis(this.repo, this.def.id, rootOf(a.id), { ...(prev.value as object), status: "refuted", experiment: x.id }, x.id);
    }

    const reopened: Entry[] = [];
    const questions: Entry[] = [];
    if (opts.result === "refuted") {
      const supported = a.refs.filter((r) => this.store.get(r)?.type === "option").map(rootOf);
      for (const d of this.store.current().filter((e) => e.type === "decision" && e.body.kind === "converge" && e.status !== "reopened")) {
        if (!supported.includes(rootOf(d.body.chosen))) continue;
        reopened.push(this.store.supersede(d.id, { author: { agent: "runner", role: "runner" }, status: "reopened", body: { reopenedBy: x.id } }));
        questions.push(this.store.add({
          type: "question",
          author: { agent: "runner", role: "runner" },
          refs: [d.id, a.id, x.id],
          body: { to: this.def.owner, text: `Assumption ${rootOf(a.id)} ("${a.body.text}") was refuted by ${x.id}. Decision ${rootOf(d.id)} chose ${d.body.chosen}, which depends on it. Keep it with a change, or choose again?` },
        }));
      }
    }
    await this.commit(`experiment on ${rootOf(a.id)}: ${opts.result}`, { Stage: "experiment" });
    const obs = await observe(this.control, { artifactRoots: ["prototypes"] });
    return { experiment: x, reopened, questions, breakpoints: obs.breakpoints };
  }
}

export function loadAngles(file: string): AnglesFile {
  return JSON.parse(fs.readFileSync(file, "utf8")) as AnglesFile;
}

// A builder for the MVP stage: writes a prototype skeleton naming the assumptions it
// tests. Real builds go through CopilotCliRunner like any other delivery task.
export class PrototypeBuilder implements AgentRunner {
  name = "prototype-builder";
  async run(spec: RunSpec, workdir: string, bundle: ContextBundle) {
    const dir = path.join(workdir, spec.artifact);
    fs.mkdirSync(dir, { recursive: true });
    const lines = [`# MVP: ${bundle.goal ?? spec.task}`, "", "Built to test these assumptions (pinned):", ""];
    for (const s of Object.values(bundle.state ?? {})) {
      const v = s.value as { text: string; test: string; status: string };
      lines.push(`- ${s.ref}: ${v.text} (status: ${v.status})`, `  - test: ${v.test || "named in the plan"}`);
    }
    fs.writeFileSync(path.join(dir, "README.md"), lines.join("\n") + "\n");
    return { ok: true, changedFiles: [`${spec.artifact}/README.md`], costTokens: 300, transcript: ["prototype skeleton written"] };
  }
}
