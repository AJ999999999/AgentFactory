// The team: who does each lane of work. Like the phase, it's derived from the work,
// never configured. The first open task in a lane of a goal staffs a seat for it:
//
// - a role from the firm library when the library covers the lane, with the role's
//   model, skills and permissions (filtered through the catalog: template drift never
//   widens access, and permissions that need a decision wait for the goal's owner, who
//   is asked once; only that lane waits);
// - otherwise a role generated for the lane, with the minimum permissions and on
//   probation: its finished work goes to an independent reviewer on a different model
//   unless a checker or a named person already vouches for it. Enough acceptances in a
//   row promote it; repeated rejections ask the owner.
//
// Seats are per goal, so each spawned workstream gets its own team. Lanes that judge
// other lanes' work (replan, synthesis, probation review) must run on a different
// model from the work they judge; checkLibrary enforces that for the library.
import { resolvePermissions } from "../factory.ts";
import type { Catalog, Library } from "../factory.ts";
import type { GoalState, SeatState, State } from "./project.ts";
import { seatKey } from "./project.ts";
import type { HEvent, SeatDef } from "./types.ts";
import { eid } from "./store.ts";

export const REVIEW_LANE = "probation-review";

export function seatAskId(goal: string, lane: string): string {
  return eid("ask-seat", goal, lane);
}

// Staff one seat. Returns the events (the seat, and a question when a permission needs
// the owner's decision), or nothing when the policy has no team.
export function staffSeat(s: State, g: GoalState, lane: string, now: number): HEvent[] {
  const team = s.policy.team;
  if (!team) return [];
  const { library: lib, catalog } = team;
  const roleId = lib.lanes?.[lane];
  const role = roleId ? lib.roles[roleId] : undefined;
  let seat: SeatDef;
  if (roleId && role) {
    const { granted, pending } = resolvePermissions(role.permissions, catalog);
    seat = {
      goal: g.id, lane, role: roleId, template: `${roleId}@v${role.version}`, model: role.model, agent: roleId,
      skills: [...lib.skills.base, ...role.skills], permissions: granted, pending, generated: false,
    };
  } else {
    // No library role: generate one for this lane, with the least access, on probation.
    // The charter here is deterministic; a model-backed factory would write it, behind
    // the same limits.
    const gen = lib.generated ?? { agent: "author", model: "model-a", permissions: ["repo:read", "repo:write:lease"] };
    const { granted, pending } = resolvePermissions(gen.permissions, catalog);
    const work = [...s.todos.values()].filter((t) => t.goal === g.id && t.lane === lane && t.status === "open").map((t) => t.text);
    seat = {
      goal: g.id, lane, role: `gen-${lane}`, template: `generated:${lane}@v1`, model: gen.model, agent: gen.agent,
      skills: [...lib.skills.base, `${lane} (generated, probation)`], permissions: granted, pending, generated: true,
      charter: `Do the ${lane} work of "${g.def.title}": ${work.join("; ")}`.slice(0, 280),
    };
  }
  const key = seatKey(g.id, lane);
  const out: HEvent[] = [];
  let ask: string | undefined;
  if (seat.pending.length) {
    ask = seatAskId(g.id, lane);
    out.push({
      id: ask, at: now, by: "harness", type: "ask_opened",
      ask: {
        id: ask, goal: g.id, to: g.def.owner, kind: "decision", lane, origin: "rule:staffing",
        question: `The ${seat.role} seat for ${lane} work in ${g.def.title} needs ${seat.pending.map((p) => `${p.permission} (${p.decision})`).join(", ")}. Grant it?`,
        options: [{ id: "grant", label: "Grant", effect: { type: "ack" } }, { id: "without", label: "Work without it", effect: { type: "ack" } }],
      },
    });
  }
  out.unshift({ id: eid("seat", key), at: now, by: "harness", type: "seat_staffed", seat, ask });
  return out;
}

// The library's own consistency, checked before it's used.
export function checkLibrary(lib: Library, catalog: Catalog): string[] {
  const v: string[] = [];
  const judge = new Set(lib.judgeLanes ?? []);
  for (const [lane, role] of Object.entries(lib.lanes ?? {})) {
    if (!lib.roles[role]) v.push(`lane ${lane} maps to unknown role ${role}`);
  }
  for (const [id, r] of Object.entries(lib.roles)) {
    for (const p of r.permissions) if (!catalog[p]) v.push(`${id}: permission ${p} is not in the catalog`);
  }
  // A judge on the same model as the work it judges shares its blind spots.
  const workModels = new Map<string, string>();
  for (const [lane, role] of Object.entries(lib.lanes ?? {})) if (!judge.has(lane) && lib.roles[role]) workModels.set(lane, lib.roles[role].model);
  if (lib.generated) workModels.set("(generated)", lib.generated.model);
  for (const lane of judge) {
    const role = lib.lanes?.[lane];
    const model = role ? lib.roles[role]?.model : lib.generated?.model;
    if (!model) continue;
    const same = [...workModels].filter(([, m]) => m === model).map(([l]) => l);
    // Replan and synthesis judge every lane; a probation review judges generated roles.
    const judged = lane === REVIEW_LANE ? same.filter((l) => l === "(generated)") : same;
    if (judged.length) v.push(`judge lane ${lane} runs on ${model}, the same model as ${judged.join(", ")}`);
  }
  return v;
}

// Copilot CLI tool flags for a seat: per-permission allows from the agent config, a
// deny for writes when the seat may not write, and the flags every turn gets.
export type ToolConfig = { tools?: Record<string, string[]>; always?: string[] };

export function toolFlags(perms: string[], cfg: ToolConfig): string[] {
  const out: string[] = [];
  for (const p of perms) out.push(...(cfg.tools?.[p.startsWith("repo:write:") ? "repo:write:lease" : p] ?? []));
  if (!perms.some((p) => p.startsWith("repo:write:"))) out.push("--deny-tool", "write");
  out.push(...(cfg.always ?? []));
  return out;
}

export type SeatView = SeatState & { effective: string[] };
