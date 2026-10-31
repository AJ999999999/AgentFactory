// Escalation quality over the harness log: how often asking the partner changed anything,
// and how often the harness decided alone where the partner would have chosen otherwise.
// Pure functions over events, like project(); nothing here writes or changes routing.
//
//   asked but needn't have   an answer that only acknowledged or approved (the work would
//                            have gone the same way), counted per ask origin
//   should have asked        estimated from a daily audit: one decision the harness made by
//                            itself goes back to the partner as a question
//
// Some asks must happen whatever the numbers say (money, access, a refuted or killing
// assumption, scope far over budget, work only a person can do). Those are the floor and
// stay out of the rates, so a quick "approve" on them never reads as a wasted question.
import { seededRandom } from "../util.ts";
import type { HarnessPolicy, State } from "./project.ts";
import { eid } from "./store.ts";
import type { Ask, Effect, HEvent } from "./types.ts";

const DAY = 86_400_000;
const DEFAULTS = { missCostRatio: 10, blindShare: 0 };
const escalationPolicy = (p?: HarnessPolicy) => ({ ...DEFAULTS, ...(p?.escalation ?? {}) });

export const FLOOR_ORIGINS = new Set([
  "rule:money",
  "rule:staffing",
  "rule:load_bearing_refuted",
  "rule:kill_criterion",
  "rule:scope_vs_budget",
  "rule:budget_exhausted",
]);

// Effects that leave the course as it was. Anything else (close, revise, budget, decide,
// supersede, retry, reopen, spawn, accept-after-review) changed what happens next.
const KEEPS_COURSE = new Set<Effect["type"] | "none">(["none", "ack", "approve"]);

// Origins grouped the way they are tuned: one rule, one monitor family, agents' questions.
export function originFamily(origin: string): string {
  if (origin.startsWith("rule:")) return origin;
  return origin.split(":")[0];
}

export function isFloor(a: Ask): boolean {
  return FLOOR_ORIGINS.has(a.origin) || a.kind === "action" || a.kind === "review" || a.origin.startsWith("audit:");
}

// An agent's question is sometimes shown without its recommendation until it is answered.
// Comparing how often the partner picks the recommended option with and without seeing it
// tells "I agree" apart from "I went along". Decided from the ask id, so every view (panel,
// report) agrees without storing anything. Floor questions and urgent ones are never blind.
export function isBlind(policy: HarnessPolicy | undefined, a: Ask): boolean {
  const share = escalationPolicy(policy).blindShare;
  if (!a.recommend || a.urgent || isFloor(a) || share <= 0) return false;
  return seededRandom(`blind:${a.id}`)() < share;
}

export type OriginStats = {
  origin: string;
  opened: number;
  answered: number;
  open: number;
  keptCourse: number; // answered with an option that changed nothing
  changedCourse: number;
  keptRate: number | null; // keptCourse / answered: the "asked but needn't have" rate
  withRecommendation: number;
  followedShown: { n: number; followed: number }; // recommendation visible to the partner
  followedBlind: { n: number; followed: number }; // recommendation hidden until answered
  medianHoursToAnswer: number | null;
};

export type AuditVerdict = "same" | "would_differ" | "wanted_to_be_asked";

export type EscalationReport = {
  byOrigin: OriginStats[]; // tunable origins only, most asks first
  floor: { opened: number; answered: number };
  autoClosed: number; // asks the harness closed itself (criteria met, or an earlier answer)
  audits: { asked: number; answered: number; verdicts: Record<AuditVerdict, number>; missRate: number | null };
};

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function escalationReport(events: HEvent[], policy?: HarnessPolicy): EscalationReport {
  const asks = new Map<string, { ask: Ask; at: number }>();
  const answers = new Map<string, { choice: string; at: number }>();
  const autoClosed = new Set<string>();
  for (const e of events) {
    if (e.type === "ask_opened") asks.set(e.ask.id, { ask: e.ask, at: e.at });
    // The harness answers "moot" when a goal moves on; that isn't the partner deciding.
    else if (e.type === "ask_answered" && e.answeredBy === "harness") autoClosed.add(e.ask);
    else if (e.type === "ask_answered" && !answers.has(e.ask)) answers.set(e.ask, { choice: e.choice, at: e.at });
    // Closed by the harness itself, not by a person: kept out of the partner's rates.
    else if ((e as { type: string }).type === "ask_auto_closed") autoClosed.add((e as unknown as { ask: string }).ask);
  }

  const stats = new Map<string, OriginStats & { hours: number[] }>();
  const floor = { opened: 0, answered: 0 };
  const verdicts: Record<AuditVerdict, number> = { same: 0, would_differ: 0, wanted_to_be_asked: 0 };
  let audited = 0;
  let auditsAnswered = 0;
  let weightSum = 0;
  let missWeight = 0;

  for (const { ask: a, at } of asks.values()) {
    if (autoClosed.has(a.id)) continue;
    const ans = answers.get(a.id);
    if (a.origin.startsWith("audit:")) {
      audited++;
      if (ans && ans.choice in verdicts) {
        auditsAnswered++;
        verdicts[ans.choice as AuditVerdict]++;
        // Weight each audit by 1/p so near-threshold items, drawn more often, don't
        // dominate the estimate.
        const w = 1 / (a.audit?.probability || 1);
        weightSum += w;
        if (ans.choice !== "same") missWeight += w;
      }
      continue;
    }
    if (isFloor(a)) {
      floor.opened++;
      if (ans) floor.answered++;
      continue;
    }
    const key = originFamily(a.origin);
    const st = stats.get(key) ?? {
      origin: key, opened: 0, answered: 0, open: 0, keptCourse: 0, changedCourse: 0, keptRate: null, withRecommendation: 0,
      followedShown: { n: 0, followed: 0 }, followedBlind: { n: 0, followed: 0 }, medianHoursToAnswer: null, hours: [],
    };
    st.opened++;
    if (!ans) {
      st.open++;
    } else {
      st.answered++;
      st.hours.push((ans.at - at) / 3_600_000);
      const opt = a.options.find((o) => o.id === ans.choice);
      if (KEEPS_COURSE.has(opt?.effect?.type ?? "none")) st.keptCourse++;
      else st.changedCourse++;
      if (a.recommend) {
        st.withRecommendation++;
        const bucket = isBlind(policy, a) ? st.followedBlind : st.followedShown;
        bucket.n++;
        if (ans.choice === a.recommend.option) bucket.followed++;
      }
    }
    stats.set(key, st);
  }

  const byOrigin = [...stats.values()]
    .map(({ hours, ...st }) => ({ ...st, keptRate: st.answered ? st.keptCourse / st.answered : null, medianHoursToAnswer: median(hours) }))
    .sort((a, b) => b.opened - a.opened || a.origin.localeCompare(b.origin));
  return { byOrigin, floor, autoClosed: autoClosed.size, audits: { asked: audited, answered: auditsAnswered, verdicts, missRate: weightSum ? missWeight / weightSum : null } };
}

// Whether a rate is low enough to stop asking, given k (one missed question costs as much
// as k needless ones): asking pays when the partner changes course more than 1/k of the
// time. Needs enough answers before it says anything.
export function worthAsking(st: OriginStats, k = DEFAULTS.missCostRatio, minAnswers = 20): "keep" | "consider_relaxing" | "too_few_answers" {
  if (st.answered < minAnswers) return "too_few_answers";
  return st.changedCourse / st.answered > 1 / k ? "keep" : "consider_relaxing";
}

// ---------- daily audit ----------

export const AUDIT_OPTIONS = [
  { id: "same", label: "I'd have decided the same", effect: { type: "ack" as const } },
  { id: "would_differ", label: "I'd have decided differently", effect: { type: "ack" as const } },
  { id: "wanted_to_be_asked", label: "Same or not, I'd have wanted to be asked", effect: { type: "ack" as const } },
];

// Once a day, one decision the harness made alone goes back to the goal's owner as a
// question. It holds no work: nothing depends on it, and the answer changes nothing in the
// engagement. It only feeds the "should have asked" estimate. Decisions already audited, and
// ones on goals that are no longer active, are skipped.
export function auditRule(s: State, now: number, emit: (e: HEvent) => void): void {
  const day = Math.floor(now / DAY);
  const id = eid("ask-audit", day);
  if (s.asks.has(id)) return;
  const audited = new Set([...s.asks.values()].map((a) => a.audit?.event).filter(Boolean));
  const pool = s.autonomous.filter((d) => !audited.has(d.event) && d.at <= now && s.goals.get(d.goal)?.status === "active");
  if (!pool.length) return;
  const pick = pool[Math.floor(seededRandom(`audit:${s.engagement?.id ?? ""}:${day}`)() * pool.length)];
  const g = s.goals.get(pick.goal)!;
  emit({
    id, at: now, by: "harness", type: "ask_opened",
    ask: {
      id, goal: g.id, to: g.def.owner, kind: "decision", origin: `audit:${pick.event}`,
      question: `Spot check: on ${new Date(pick.at).toISOString().slice(0, 10)} the harness ${pick.what}, without asking. If it had asked you, what would you have done?`,
      options: AUDIT_OPTIONS,
      audit: { event: pick.event, probability: 1 / pool.length },
    },
  });
}
