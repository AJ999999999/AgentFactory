// Role and skill factory. Assembles a team from the firm library; generates only on a
// gap, and anything generated starts on probation. Permissions come only from the
// catalog through role templates: free text (client notes, SOW prose) can describe
// needs and raise a question, but it never grants anything.
//
// This planner is deterministic code standing in for the model-backed one. The
// guardrails (catalog, lease scoping, team size, probation) are the real part.
import type { Policy } from "./policy.ts";

export type CatalogEntry = { grantableByFactory: boolean; requiresDecision?: string; never?: boolean; description: string };
export type Catalog = Record<string, CatalogEntry>;

export type RoleTemplate = { version: number; kind: "lead" | "coordinator" | "worker" | "side"; model: string; skills: string[]; permissions: string[]; decisionRights: string[] };
export type Library = {
  skills: { base: string[]; lead: string[]; coordinator: string[]; domain: Record<string, { source: string; status: string; note?: string }> };
  roles: Record<string, RoleTemplate>;
  moduleKinds: Record<string, string>;
  // Long-running harness: which role does each lane of work, what a role generated for
  // a lane the library doesn't cover may do, and which lanes judge other lanes' work
  // (they must run on a different model from the work they judge).
  lanes?: Record<string, string>;
  generated?: { agent: string; model: string; permissions: string[] };
  judgeLanes?: string[];
};

// What a template's permission list actually grants, through the catalog only. Entries
// the factory can't grant are dropped (template drift never widens access); entries
// that need a decision come back as pending.
export function resolvePermissions(perms: string[], catalog: Catalog, writePaths: string[] = []): { granted: string[]; pending: Array<{ permission: string; decision: string }> } {
  const granted: string[] = [];
  const pending: Array<{ permission: string; decision: string }> = [];
  for (const p of perms) {
    const entry = catalog[p];
    if (!entry || !entry.grantableByFactory || entry.never) continue;
    if (entry.requiresDecision) pending.push({ permission: p, decision: entry.requiresDecision });
    else granted.push(p === "repo:write:lease" && writePaths.length ? `repo:write:${writePaths.join(",")}` : p);
  }
  return { granted, pending };
}

export type Requirements = {
  engagement: string;
  profile: string;
  leaseRoot: string;
  modules: Array<{ id: string; kind: string; paths: string[] }>;
  domainSkills: string[];
  clientNotes: string; // untrusted text from client documents
};

export type Member = {
  id: string;
  template: string; // e.g. backend-engineer@v7
  kind: RoleTemplate["kind"];
  module?: string;
  model: string;
  skills: string[];
  permissions: string[]; // granted now
  pendingPermissions: Array<{ permission: string; decision: string }>;
  writePaths: string[];
  decisionRights: string[];
  probation: boolean;
};

export type TeamPlan = {
  engagement: string;
  profile: string;
  members: Member[];
  generatedSkills: Array<{ name: string; status: "probation"; testsBy: string }>;
  questions: string[]; // become briefs to the owner
};

const PERMISSION_TALK = /\b(access|credential|password|token|api key|broker|place (the )?(orders?|trades?)|permission|admin)\b/i;

export function planTeam(req: Requirements, lib: Library, catalog: Catalog, policy: Policy): TeamPlan {
  const profile = policy.profiles?.[req.profile] ?? policy.profiles?.standard ?? { coordinator: true, max_workers: 7, combined_digest_when_client_is_partner: false };
  const questions: string[] = [];
  const members: Member[] = [];
  const generated: TeamPlan["generatedSkills"] = [];

  // Domain skills: reuse what the library has; generate the rest, on probation, with
  // tests written by a different worker than the skill's author.
  const domain: string[] = [];
  for (const s of req.domainSkills) {
    if (lib.skills.domain[s]) domain.push(s);
    else {
      generated.push({ name: s, status: "probation", testsBy: "test-case-worker" });
      domain.push(`${s} (generated, probation)`);
    }
  }

  const make = (id: string, templateName: string, module?: { id: string; paths: string[] }): Member => {
    const t = lib.roles[templateName];
    const writePaths = module ? module.paths.map((p) => `${req.leaseRoot}/${p}`) : [];
    const { granted, pending } = resolvePermissions(t.permissions, catalog, writePaths);
    // Keep the old shape for a member with no module: "repo:write:" with no paths.
    for (const [i, g] of granted.entries()) if (g === "repo:write:lease") granted[i] = "repo:write:";
    const skills = [...lib.skills.base, ...(t.kind === "lead" ? lib.skills.lead : []), ...(t.kind === "coordinator" || (t.kind === "lead" && !profile.coordinator) ? lib.skills.coordinator : []), ...t.skills, ...(t.kind === "worker" || t.kind === "side" ? domain : [])];
    const usesGenerated = skills.some((s) => s.includes("(generated"));
    return { id, template: `${templateName}@v${t.version}`, kind: t.kind, module: module?.id, model: t.model, skills, permissions: granted, pendingPermissions: pending, writePaths, decisionRights: t.decisionRights, probation: usesGenerated };
  };

  members.push(make("lead", "engagement-lead"));
  if (profile.coordinator) members.push(make("coordinator", "coordinator"));

  // One agent per independent module; extra agents must be argued for, so none here.
  const workerModules = req.modules.slice(0, profile.max_workers);
  if (req.modules.length > profile.max_workers) questions.push(`${req.modules.length} modules exceed the ${req.profile} profile's ${profile.max_workers} workers: merge modules or move to the standard profile`);
  for (const m of workerModules) {
    const templateName = lib.moduleKinds[m.kind];
    if (!templateName) {
      questions.push(`No library role for module kind "${m.kind}" (${m.id}); a new role would start on probation`);
      continue;
    }
    members.push(make(m.id, templateName, m));
  }

  // Client text is read for needs, never for grants.
  for (const sentence of req.clientNotes.split(/(?<=[.!?])\s+/).filter(Boolean)) {
    if (PERMISSION_TALK.test(sentence)) questions.push(`Client note asks for access, not granted by the factory: "${sentence.trim()}"`);
  }
  for (const m of members) for (const p of m.pendingPermissions) questions.push(`${m.id} needs ${p.permission}, pending decision: ${p.decision}`);

  return { engagement: req.engagement, profile: req.profile, members, generatedSkills: generated, questions: [...new Set(questions)] };
}

// Independent check of any team, however it was produced (factory or hand-edited).
export function validateTeam(plan: TeamPlan, catalog: Catalog, leaseRoot: string, policy: Policy): string[] {
  const v: string[] = [];
  const profile = policy.profiles?.[plan.profile];
  for (const m of plan.members) {
    for (const p of m.permissions) {
      const key = p.startsWith("repo:write:") ? "repo:write:lease" : p;
      const entry = catalog[key];
      if (!entry) v.push(`${m.id}: ${p} is not in the catalog`);
      else if (entry.never || !entry.grantableByFactory) v.push(`${m.id}: ${p} can't be granted by the factory`);
      else if (entry.requiresDecision) v.push(`${m.id}: ${p} granted before decision ${entry.requiresDecision}`);
    }
    for (const w of m.writePaths) if (!(w === leaseRoot || w.startsWith(leaseRoot + "/"))) v.push(`${m.id}: write path ${w} is outside ${leaseRoot}`);
  }
  const workers = plan.members.filter((m) => m.kind === "worker" || m.kind === "side").length;
  if (profile && workers > profile.max_workers) v.push(`${workers} workers exceed the profile's ${profile.max_workers}`);
  if (profile && !profile.coordinator && plan.members.some((m) => m.kind === "coordinator")) v.push("small profile has no separate coordinator");
  return v;
}
