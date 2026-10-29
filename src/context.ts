// Shared context layer (RSCL-style). Git is the source of truth; everything here is
// plain files under .agents/ so it is versioned, diffable and reviewable.
//
//   .agents/context/tasks/<task>.json            goal, rules, which basis names apply, permissions
//   .agents/context/tasks/<task>.criteria.json   frozen acceptance criteria (human-owned)
//   .agents/context/basis/<task>/<name>.v<N>.json  versioned task basis (scope, sources, ...)
//   .agents/context/snapshots/<sha>.json         imported non-git sources, content-addressed
//   <artifact>/context.lock.json                 which basis versions an artifact was built on
import * as fs from "node:fs";
import * as path from "node:path";
import { readJson, sha256, writeJson } from "./util.ts";

export const AGENTS = ".agents";
export const CTX = `${AGENTS}/context`;

export type TaskDef = {
  id: string;
  goal: string;
  rules: string[];
  basis: string[];
  criteria: string;
  // role -> context fields that role may see
  permissions: Record<string, Array<"goal" | "rules" | "state" | "evidence" | "results">>;
};

export type BasisRecord = {
  task: string;
  name: string;
  version: number;
  value: unknown;
  supersedes: number | null;
  decision: string; // decision record id that created it
  createdAt: string;
};

export type Snapshot = { id: string; source: string; importedAt: string; content: unknown };

export type Lockfile = {
  artifact: string;
  task: string;
  builtBy: string;
  config: string; // agent config id@version (model + harness + context)
  basis: string[]; // e.g. ["task-123/scope@v1", "task-123/sources@v1"]
  inputs: string[]; // snapshot ids
  builtAt: string;
};

export function basisRef(task: string, name: string, version: number): string {
  return `${task}/${name}@v${version}`;
}

export function parseBasisRef(ref: string): { task: string; name: string; version: number } {
  const m = ref.match(/^([^/]+)\/([^@]+)@v(\d+)$/);
  if (!m) throw new Error(`bad basis ref: ${ref}`);
  return { task: m[1], name: m[2], version: Number(m[3]) };
}

// ---------- tasks ----------

export function writeTask(repo: string, task: TaskDef): void {
  writeJson(path.join(repo, CTX, "tasks", `${task.id}.json`), task);
}

export function readTask(repo: string, id: string): TaskDef {
  return readJson<TaskDef>(path.join(repo, CTX, "tasks", `${id}.json`));
}

// ---------- basis ----------

function basisDir(repo: string, task: string): string {
  return path.join(repo, CTX, "basis", task);
}

export function listBasisVersions(repo: string, task: string, name: string): BasisRecord[] {
  const dir = basisDir(repo, task);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${name}.v`) && f.endsWith(".json"))
    .map((f) => readJson<BasisRecord>(path.join(dir, f)))
    .sort((a, b) => a.version - b.version);
}

export function currentBasis(repo: string, task: string, name: string): BasisRecord | null {
  const all = listBasisVersions(repo, task, name);
  return all.length ? all[all.length - 1] : null;
}

export function writeBasis(repo: string, task: string, name: string, value: unknown, decision: string): BasisRecord {
  const prev = currentBasis(repo, task, name);
  const rec: BasisRecord = {
    task,
    name,
    version: (prev?.version ?? 0) + 1,
    value,
    supersedes: prev?.version ?? null,
    decision,
    createdAt: new Date().toISOString(),
  };
  writeJson(path.join(basisDir(repo, task), `${name}.v${rec.version}.json`), rec);
  return rec;
}

export function readBasisRef(repo: string, ref: string): BasisRecord {
  const { task, name, version } = parseBasisRef(ref);
  return readJson<BasisRecord>(path.join(basisDir(repo, task), `${name}.v${version}.json`));
}

export function currentPins(repo: string, taskId: string): string[] {
  const task = readTask(repo, taskId);
  return task.basis.map((n) => {
    const b = currentBasis(repo, taskId, n);
    if (!b) throw new Error(`task ${taskId} has no basis "${n}"`);
    return basisRef(taskId, n, b.version);
  });
}

// ---------- snapshots (non-git sources) ----------

export function importSnapshot(repo: string, source: string, content: unknown): Snapshot {
  const id = sha256(JSON.stringify(content)).slice(0, 16);
  const snap: Snapshot = { id, source, importedAt: new Date().toISOString(), content };
  const file = path.join(repo, CTX, "snapshots", `${id}.json`);
  if (!fs.existsSync(file)) writeJson(file, snap);
  return snap;
}

export function readSnapshot(repo: string, id: string): Snapshot {
  return readJson<Snapshot>(path.join(repo, CTX, "snapshots", `${id}.json`));
}

// ---------- lockfiles ----------

export const LOCKFILE = "context.lock.json";

export function writeLockfile(repo: string, lock: Lockfile): void {
  writeJson(path.join(repo, lock.artifact, LOCKFILE), lock);
}

export function readLockfile(repo: string, artifact: string): Lockfile | null {
  const f = path.join(repo, artifact, LOCKFILE);
  return fs.existsSync(f) ? readJson<Lockfile>(f) : null;
}

// ---------- task context bundle (what an agent is allowed to see) ----------

export type ContextBundle = {
  task: string;
  role: string;
  goal?: string;
  rules?: string[];
  state?: Record<string, { ref: string; value: unknown }>; // pinned basis values
  evidence?: Array<{ id: string; source: string }>;
  results?: Lockfile[];
};

// Build the bundle for given pins (current pins by default). Passing old pins
// reproduces exactly what a stale agent saw: that's what the Evaluator replays.
export function taskContext(repo: string, taskId: string, role: string, pins?: string[]): ContextBundle {
  const task = readTask(repo, taskId);
  const allowed = new Set(task.permissions[role] ?? []);
  const usePins = pins ?? currentPins(repo, taskId);
  const bundle: ContextBundle = { task: taskId, role };
  if (allowed.has("goal")) bundle.goal = task.goal;
  if (allowed.has("rules")) bundle.rules = task.rules;
  if (allowed.has("state")) {
    bundle.state = {};
    for (const ref of usePins) bundle.state[parseBasisRef(ref).name] = { ref, value: readBasisRef(repo, ref).value };
  }
  if (allowed.has("evidence")) {
    const dir = path.join(repo, CTX, "snapshots");
    bundle.evidence = fs.existsSync(dir)
      ? fs.readdirSync(dir).map((f) => {
          const s = readJson<Snapshot>(path.join(dir, f));
          return { id: s.id, source: s.source };
        })
      : [];
  }
  if (allowed.has("results")) bundle.results = findLockfiles(repo).filter((l) => l.task === taskId);
  return bundle;
}

export function findLockfiles(repo: string): Lockfile[] {
  const out: Lockfile[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === LOCKFILE) out.push(readJson<Lockfile>(p));
    }
  };
  walk(repo);
  return out;
}
