// Long-running harness: types.
//
// The harness keeps engagements moving over weeks or months without a human acting
// as the clock. State is an append-only event log in git; everything else (what is
// believed, what is ready, what is blocked) is computed from it.

// ---------- beliefs and evidence ----------

// What kind of risk an assumption carries. The riskiest open category is the
// engagement's "phase": phases are derived, never configured.
export type Category = "desirability" | "feasibility" | "viability" | "compliance" | "safety";

// How a finding was obtained. Agents can only produce opinion and reported findings;
// the stronger grades come from the world: jobs (measured), metric sources (stated or
// behavioral, set by the source), people answering asks (expert or measured).
export type Grade = "opinion" | "reported" | "stated" | "behavioral" | "measured" | "expert";
export const GRADES: Grade[] = ["opinion", "reported", "stated", "behavioral", "measured", "expert"];
export const AGENT_GRADES: Grade[] = ["opinion", "reported"];

export type Direction = "supports" | "refutes" | "neutral";
export type Op = "<" | "<=" | ">" | ">=";
export type Threshold = { metric: string; op: Op; value: number };

export type AssumptionDef = {
  id: string;
  text: string;
  category: Category;
  risk: number; // 1-5: damage if wrong
  uncertainty: number; // 1-5
  loadBearing?: boolean; // the goal's direction depends on it
  threshold?: Threshold; // pre-registered by the owner; jobs and waits testing it must use it
  test?: string;
};

export type BeliefStatus = "untested" | "testing" | "supported" | "refuted" | "contested";

export type Finding = {
  id: string;
  goal: string;
  assumption?: string;
  direction: Direction;
  grade: Grade;
  source: string; // url, repo:<path>, job:<todo>, metric:<source>, ask:<id>
  author: string; // agent id, "job:<todo>", "metric:<source>", or the person who answered
  text: string;
  metrics?: Record<string, number>;
  runs?: number;
  untrusted?: boolean; // came from outside content (web pages, client text)
  todo?: string;
  turn?: string;
};

// ---------- goals ----------

export type Criterion = {
  id: string;
  // Either a metric threshold...
  metric?: string;
  op?: Op;
  value?: number;
  minSample?: { metric: string; value: number }; // don't judge before enough data
  // ...or a belief.
  assumption?: string;
  status?: "supported" | "refuted";
};

export type Budget = { turns?: number; turnsPerWeek?: number; usd?: number; gpuHours?: number };

export type MonitorDef = {
  id: string;
  target: string; // what the probe watches
  cadenceMinutes: number;
  expiresAt?: string; // ISO; an expired monitor stops and never catches up
  basis?: string; // bump this basis record on change, so pinned artifacts go stale
  urgent?: boolean; // the ask on change interrupts instead of waiting for the digest
  onChange: { todo?: TodoDraft; ask?: { to: string; question: string } };
};

export type Blackout = { from: string; to: string; lanes: string[]; reason: string };

export type GoalDef = {
  id: string;
  title: string;
  objective: string;
  owner: string; // role that decides for this goal
  parent?: string;
  scope: string[]; // paths this goal's work may write
  assumptions: AssumptionDef[];
  success?: Criterion[];
  kill?: Criterion[]; // pre-registered: checked by the harness, not by the agents doing the work
  budget: Budget;
  share?: number; // compute share among goals (default 1)
  perpetual?: boolean; // never "done" (maintenance, monitoring)
  monitors?: MonitorDef[];
  blackouts?: Blackout[];
  interfaces?: string[]; // contract files a child goal builds against; must exist to spawn it
  todos?: TodoDraft[]; // seed work
};

export type GoalRevision = {
  objective?: string;
  title?: string;
  assumptions?: AssumptionDef[]; // replaces the set
  success?: Criterion[];
  kill?: Criterion[];
  budget?: Budget;
  todos?: TodoDraft[]; // seed work for the new version
  carry?: string[]; // open todos that stay valid after a pivot
};

export type EngagementDef = {
  id: string;
  title: string;
  principals: Record<string, string>; // role -> person ("partner", "pharmacist", "billing-team")
  goals: GoalDef[];
  experts?: string[]; // roles whose judgments count as expert evidence (lawyer, pharmacist)
  redLines?: string[]; // registered checkers run on every turn
  evidence?: Partial<Record<Category, Grade[]>>; // overrides policy defaults
  // Whose memory the agents should see, and on which subjects ("work.*"): what applies
  // reaches their packets as defaults and things to check, never as permission.
  memory?: { principal: string; subjects: string[] };
};

// ---------- work ----------

// task: one bounded agent turn. job: external run with a handle (build, benchmark,
// training). wait: a calendar/metric window (market test, shadow traffic). action: work
// only a person can do (print a part, call a clinic); it becomes an ask.
export type TodoKind = "task" | "job" | "wait" | "action";

export type Informs = { assumption: string; metric: string; threshold?: Threshold };

export type JobSpec = { spec: Record<string, unknown>; runs?: number; gpuHours?: number; informs?: Informs[] };
export type WaitSpec = { source: string; minDays?: number; maxDays?: number; until?: { metric: string; atLeast: number }; informs?: Informs[] };

export type TodoDraft = {
  id?: string;
  kind?: TodoKind;
  lane: string;
  text: string;
  priority?: number; // 0 urgent .. 3 low; agents may not propose 0
  after?: string[]; // todo or ask ids that must finish first
  tests?: string; // assumption this produces evidence for
  assumes?: string[]; // assumptions this work is only worth doing if true
  writeScope?: string[];
  requires?: string[]; // runner capabilities ("gpu", "browser")
  notBefore?: string; // ISO
  artifact?: string; // artifact dir; gets a context.lock.json pinned to `pins`
  pins?: string[]; // basis names the artifact is built on
  check?: string; // registered checker for this todo's output
  review?: string; // role that must approve the output
  forOption?: string; // tied to an option of a pending decision
  carry?: boolean;
  excludeAgents?: string[];
  because?: string; // provenance: finding, ask or todo that motivated it
  job?: JobSpec;
  wait?: WaitSpec;
  freeze?: string[]; // paths nobody may change while this job/wait runs
  assignee?: string; // action: role that does it
  cost?: { usd: number }; // money: authorized before, not accounted after
  maxTurns?: number; // stopping rule for open-ended tasks
  reviews?: string; // probation review: the todo whose output this reviews
};

// ---------- the team ----------

// A seat is who does one lane of work in one goal: a role from the firm library, or a
// role generated for a lane the library doesn't cover (on probation until independent
// reviews accept its work). Seats are derived from the work, never configured: the
// first open todo in a lane staffs it. Permissions come only from the catalog.
export type SeatDef = {
  goal: string;
  lane: string;
  role: string; // library role, or "gen-<lane>"
  template: string; // "builder@v1", "generated:<lane>@v1"
  model: string;
  agent: string; // Copilot CLI custom agent
  skills: string[];
  permissions: string[]; // granted now
  pending: Array<{ permission: string; decision: string }>; // need the owner's decision
  generated: boolean;
  charter?: string; // what a generated role is for
};

export type Verdict = "accept" | "reject";

// ---------- asks ----------

export type Effect =
  | { type: "approve" }
  | { type: "ack"; criterion?: string; assumption?: string }
  | { type: "close"; status: "done" | "killed" }
  | { type: "revise"; pivot: boolean; revision?: GoalRevision; resetAssumptions?: string[] }
  | { type: "reset"; assumptions: string[] }
  | { type: "budget"; budget: Budget }
  | { type: "decide"; rejected: string[] }
  | { type: "supersede"; todos: string[] }
  | { type: "retry"; todo: string }
  | { type: "accept"; todo: string }
  | { type: "reopen"; todo: string }
  | { type: "spawn"; goals: GoalDef[] };

export type AskOption = { id: string; label: string; effect?: Effect };
export type AskKind = "decision" | "approval" | "review" | "action";

export type Ask = {
  id: string;
  goal: string;
  to: string; // role
  kind: AskKind;
  question: string;
  options: AskOption[];
  blocksGoal?: boolean; // otherwise it blocks only the todos that depend on it
  lane?: string; // blocks the goal's tasks in this lane (a seat question)
  todo?: string; // the todo it is about
  origin: string; // "rule:<name>", "turn:<id>", "todo:<id>"
  urgent?: boolean;
  evidence?: string[];
  goalVersion?: number; // for questions about the goal's direction: moot once it changes
};

// ---------- turns ----------

export type TurnResult =
  | "completed"
  | "progress"
  | "blocked"
  | "validation_failed"
  | "host_failure"
  | "claim_lost"
  | "stopped"; // the partner stopped it: counted as spent, never as a failure

// Granularity is computed by the harness from what the turn changed, never claimed by
// the agent. none < surface < substantive < milestone.
export type Granularity = "none" | "surface" | "substantive" | "milestone";

export type TurnRecord = {
  id: string;
  todo: string;
  goal: string;
  agent: string;
  result: TurnResult;
  granularity: Granularity;
  reasons: string[];
  files: string[];
  why?: string; // why this todo was selected over the others
  seat?: string; // "<goal>/<lane>": who did it (the runner is only where)
};

// ---------- events ----------

type Base = { id: string; at: number; by: string };

export type HEvent = Base &
  (
    | { type: "engagement_opened"; engagement: Omit<EngagementDef, "goals"> }
    | { type: "goal_opened"; goal: GoalDef; criteriaHash: string; carvedFrom?: string }
    | { type: "goal_revised"; goal: string; version: number; revision: GoalRevision; pivot: boolean; reason: string; criteriaHash: string }
    | { type: "goal_closed"; goal: string; status: "done" | "killed"; reason: string }
    | { type: "todo_added"; todo: TodoDraft & { id: string; goal: string }; provenance: string }
    | { type: "todo_started"; todo: string; handle?: string; ask?: string }
    | { type: "todo_done"; todo: string; turn?: string }
    | { type: "todo_review"; todo: string; ask?: string; reviewTodo?: string }
    | { type: "todo_reopened"; todo: string; reason: string; resetFailures?: boolean }
    | { type: "todo_superseded"; todo: string; reason: string }
    | { type: "todo_blocked"; todo: string; reason: string; ask?: string }
    | { type: "ask_opened"; ask: Ask }
    | { type: "ask_answered"; ask: string; answeredBy: string; choice: string; note?: string; revision?: GoalRevision }
    | { type: "finding"; finding: Finding }
    | { type: "finding_discounted"; finding: string; reason: string }
    | { type: "assumption_reset"; goal: string; assumption: string; reason: string }
    | { type: "budget_set"; goal: string; budget: Budget }
    | { type: "turn"; turn: TurnRecord }
    | { type: "job_finished"; todo: string; status: "succeeded" | "failed"; metrics: Record<string, number>; gpuHours?: number }
    | { type: "spend"; goal: string; todo: string; usd: number }
    | { type: "source_changed"; goal: string; monitor: string; fingerprint: string; summary: string }
    | { type: "note"; goal: string; text: string; turn?: string }
    | { type: "seat_staffed"; seat: SeatDef; ask?: string }
    | { type: "review_verdict"; todo: string; review: string; seat: string; verdict: Verdict; note?: string }
    // The partner stops anything new from starting, or lets it start again.
    | { type: "paused"; paused: boolean; reason?: string }
    // The model service said "not now" (a usage limit, a rate limit). Model turns wait
    // until `until`; it is no failure of the work, so no turn is counted.
    | { type: "capacity"; until: number; reason: string; streak: number; vendor?: string; models?: string[] } // models: the seats' placeholders that wait; unset = all
  );

export type EventOf<T extends HEvent["type"]> = Extract<HEvent, { type: T }>;
