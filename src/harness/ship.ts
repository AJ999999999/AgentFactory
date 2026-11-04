// Shipping: a pull request on GitHub for each piece of work that's done and checked, once
// you say so (docs/next/120-ci-loop.md, option B).
//
// No turn can push, and that stays so. The loop pushes, with its own narrow identity (a
// GitHub App or a machine user's fine-grained token, contents and pull requests only), read
// from the environment variable the goal's `ship.tokenEnv` names. GitHub's rulesets keep it
// off `main`. The token reaches git through git's own environment configuration, never on
// a command line another process could read.
//
// The steps:
//   1. rule:ship asks "open a pull request for this?"; approve can stand for a lane
//   2. on approve, a job todo: the work's commits in the engagement repo (found by their
//      Todo trailer) replayed on af/<todo> from the repository's base branch, limited to
//      the goal's directory; pushed (forced, so a second try updates the same pull
//      request); the pull request opened, or found again
//   3. the head commit's check runs polled like any job; passed is measured evidence on
//      the work, failed reopens the work with the failing checks' names
// A review on the other model and watching for the merge come next (docs/next/120).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { log, type Git } from "../git.ts";
import { runCommand } from "../proc.ts";
import type { GoalState, State, TodoState } from "./project.ts";
import { eid } from "./store.ts";
import type { HEvent, TodoDraft } from "./types.ts";
import type { JobOutcome } from "./world.ts";

// A goal's `ship`: where its work goes. `dir` is the engagement path that is the
// repository's root ("app" ships app/x.ts as x.ts).
export type ShipDef = {
  repo: string; // "owner/name"
  dir: string;
  base?: string; // "main"
  api?: string; // "https://api.github.com", or "https://<host>/api/v3" for GitHub Enterprise Server
  tokenEnv?: string; // "AF_GITHUB_TOKEN"
  lanes?: string[]; // only these lanes' work (default: every lane)
  maxFiles?: number; // more files than this: always asked (30)
  remote?: string; // where to push, if not the repository's own address (tests)
  // How often the engagement's copy under `dir` takes in what changed on the base (60
  // minutes; 0 never). The first look only notes where the base is.
  syncMinutes?: number;
  // After a merge: a probe target (World.probe) checked once, with what it found noted.
  check?: string;
};

const API = "https://api.github.com";
const host = (api: string) => (api === API ? "https://github.com" : api.replace(/\/api\/v3\/?$/, ""));
export const branchOf = (todo: string) => `af/${todo}`;
const firstLine = (t: string) => t.split("\n")[0].slice(0, 120);

// The files a todo's turns wrote under the goal's directory.
export function shippedFiles(s: State, t: TodoState, dir: string): string[] {
  const pre = `${dir.replace(/\/+$/, "")}/`;
  return [...new Set(s.turns.filter((x) => x.todo === t.id).flatMap((x) => x.files).filter((f) => f.startsWith(pre)))].sort();
}

// ---------- the rule ----------

// For each done, checked piece of work in a shipping goal: the question, and once it's
// approved, the job that opens the pull request. Ids come from the work and how many
// turns it took, so work reopened and done again is asked about again.
export function shipRules(s: State, g: GoalState, now: number, emit: (e: HEvent) => void): void {
  const d = g.def.ship;
  if (!d || g.status !== "active") return;
  for (const t of s.todos.values()) {
    if (t.goal !== g.id || t.kind !== "task" || t.status !== "done" || t.lane === "ship" || t.provenance === "rule:ship") continue;
    if (d.lanes?.length && !d.lanes.includes(t.lane)) continue;
    const files = shippedFiles(s, t, d.dir);
    if (!files.length) continue;
    const askId = eid("ask-ship", t.id, t.turns);
    const jobId = eid("ship", t.id, t.turns);
    if (s.todos.has(jobId)) continue;
    const a = s.asks.get(askId);
    if (!a) {
      const large = files.length > (d.maxFiles ?? 30);
      emit({
        id: askId, at: now, by: "harness", type: "ask_opened",
        ask: {
          id: askId, goal: g.id, to: g.def.owner, kind: "decision", todo: t.id,
          // A large change is always yours: it can't be covered by "from now on".
          origin: large ? "rule:ship_large" : "rule:ship",
          question: `"${firstLine(t.text)}" is done and checked. Open a pull request for it on ${d.repo}?`,
          options: [
            { id: "approve", label: "Open the pull request", effect: { type: "approve" }, consequence: `pushes ${branchOf(t.id)} and opens a pull request against ${d.base ?? "main"}; merging stays yours` },
            { id: "skip", label: "Not this one", effect: { type: "ack" } },
          ],
          recommend: { option: "approve", why: `${files.length} file${files.length === 1 ? "" : "s"} in ${d.dir}${large ? `, more than ${d.maxFiles ?? 30}: look first` : ""}`, by: "harness" },
        },
      });
      continue;
    }
    const approved = (a.status === "answered" || a.status === "auto_closed") && a.choice === "approve";
    // (watching for the merge comes after the job: see below)
    if (!approved) continue;
    const draft: TodoDraft & { id: string } = {
      id: jobId, kind: "job", lane: "ship", priority: 1, because: t.id,
      text: `Open a pull request on ${d.repo} for "${firstLine(t.text)}" and wait for its checks`,
      job: { spec: { ship: t.id, turns: t.turns, repo: d.repo, dir: d.dir, base: d.base ?? "main", api: d.api ?? API, tokenEnv: d.tokenEnv ?? "AF_GITHUB_TOKEN", ...(d.remote ? { remote: d.remote } : {}), title: firstLine(t.text) }, ...(t.tests ? { informs: [{ assumption: t.tests, metric: "checks_failed" }] } : {}) },
    };
    emit({ id: `add-${jobId}`, at: now, by: "harness", type: "todo_added", todo: { ...draft, goal: g.id }, provenance: "rule:ship" });
  }
  // A pull request whose checks passed: watch for its merge (merging stays a person's act).
  for (const t of s.todos.values()) {
    if (t.goal !== g.id || t.status !== "done" || !t.job?.spec?.ship || !t.handle?.startsWith("gh|")) continue;
    const id = eid("merge", t.id);
    if (s.todos.has(id)) continue;
    emit({ id: `add-${id}`, at: now, by: "harness", type: "todo_added", provenance: "rule:ship", todo: {
      id, goal: g.id, kind: "job", lane: "ship", priority: 2, because: t.id,
      text: `Watch ${t.handle.split("|")[2]}#${t.handle.split("|")[3]} for its merge${d.check ? `, then check ${d.check}` : ""}`,
      job: { spec: { watch: t.handle, ...(d.check ? { check: d.check } : {}) } },
    } });
  }
}

// ---------- GitHub ----------

export type ShipSpec = { ship: string; turns: number; repo: string; dir: string; base: string; api: string; tokenEnv: string; remote?: string; title: string };
type Fetch = (url: string, init: { method?: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;
type Run = (args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }) => Promise<string>;

// The handle says everything polling needs, so a loop that restarted can go on: the API,
// the repository, the pull request, the commit its checks run on, when it opened, and the
// environment variable that holds the token (never the token).
const SEP = "|";
const handleOf = (spec: ShipSpec, pr: number, sha: string, at: number) => ["gh", spec.api, spec.repo, pr, sha, at, spec.tokenEnv].join(SEP);
const failedHandle = (why: string) => `ghfail${SEP}${why.replace(/\s+/g, " ").slice(0, 300)}`;

export class GitHubShip {
  control: Git;
  root: string;
  env: NodeJS.ProcessEnv;
  fetch: Fetch;
  run: Run;
  constructor(opts: { control: Git; root: string; env?: NodeJS.ProcessEnv; fetch?: Fetch; run?: Run }) {
    this.control = opts.control;
    this.root = opts.root;
    this.env = opts.env ?? process.env;
    this.fetch = opts.fetch ?? ((u, i) => fetch(u, i) as ReturnType<Fetch>);
    this.run = opts.run ?? (async (args, o) => (await runCommand("git", args, { cwd: o.cwd, env: o.env, timeout: 300_000 })).stdout.trim());
  }

  private api(spec: ShipSpec, token: string, p: string, init: { method?: string; body?: unknown } = {}) {
    return this.fetch(`${spec.api.replace(/\/+$/, "")}${p}`, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(init.body ? { "content-type": "application/json" } : {}) },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    });
  }

  // Git's own environment configuration carries the token as a header for this host only.
  gitEnvFor(spec: ShipSpec, token: string): NodeJS.ProcessEnv {
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    return { ...this.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `http.${host(spec.api)}/.extraheader`, GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}` };
  }

  // The loop's own clone of the repository, made once.
  async clone(spec: ShipSpec, token: string): Promise<string> {
    const dir = path.join(this.root, spec.repo.replace(/[^\w.-]+/g, "_"));
    if (!fs.existsSync(path.join(dir, ".git"))) {
      fs.mkdirSync(this.root, { recursive: true });
      await this.run(["clone", "-q", "-c", "core.autocrlf=false", "-c", "core.longpaths=true", spec.remote ?? `${host(spec.api)}/${spec.repo}.git`, dir], { cwd: this.root, env: this.gitEnvFor(spec, token) });
    }
    return dir;
  }

  // Never throws: a step that fails becomes a handle the first poll reports as failed.
  async start(todo: TodoState, now: number): Promise<string> {
    const watch = todo.job?.spec?.watch as string | undefined;
    if (watch) return `watch${SEP}${watch}`;
    const spec = todo.job?.spec as unknown as ShipSpec;
    try {
      const token = this.env[spec.tokenEnv];
      if (!token) return failedHandle(`set ${spec.tokenEnv} to the token of the identity that opens pull requests`);
      const env = this.gitEnvFor(spec, token);
      const dir = await this.clone(spec, token);
      const git = (args: string[]) => this.run(["-c", "core.autocrlf=false", "-c", "core.longpaths=true", ...args], { cwd: dir, env });
      await git(["fetch", "-q", "origin", spec.base]);
      const branch = branchOf(spec.ship);
      await git(["checkout", "-q", "-B", branch, `origin/${spec.base}`]);
      await git(["reset", "-q", "--hard", `origin/${spec.base}`]);
      await git(["clean", "-qfdx"]);
      // The work's own commits, oldest first, each one's change under dir.
      const commits = log(this.control, "HEAD").filter((c) => (c.trailers.Todo ?? []).includes(spec.ship)).reverse();
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "af-ship-"));
      try {
        for (const [i, c] of commits.entries()) {
          // --root: a work's first commit can be the repository's first.
          const patch = await this.control.runAsync(["diff-tree", "-p", "--root", "--binary", "--no-commit-id", `--relative=${spec.dir.replace(/\/+$/, "")}`, c.sha]);
          if (!patch.trim()) continue;
          const file = path.join(tmp, `${i}.patch`);
          fs.writeFileSync(file, `${patch}\n`);
          try {
            await git(["apply", "--3way", "--whitespace=nowarn", file]);
          } catch (e) {
            return failedHandle(`the work doesn't apply on ${spec.base} any more (${(e as { stderr?: string }).stderr?.split("\n").find((l) => /conflict|error/i.test(l)) ?? "conflict"}): bring it up to date`);
          }
        }
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
      await git(["add", "-A"]);
      if (!(await git(["status", "--porcelain"])).trim()) return failedHandle(`nothing to ship: ${spec.base} already has this work`);
      await git(["-c", "user.name=AgentFactory harness", "-c", "user.email=harness@agentfactory.local", "commit", "-q", "-m", spec.title, "-m", `From the harness's work ${spec.ship}.`]);
      const sha = await git(["rev-parse", "HEAD"]);
      await git(["push", "-q", "--force", "origin", `HEAD:refs/heads/${branch}`]);
      const [owner] = spec.repo.split("/");
      const open = await this.api(spec, token, `/repos/${spec.repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`);
      if (!open.ok) return failedHandle(`GitHub answered ${open.status} listing pull requests: ${(await open.text()).slice(0, 160)}`);
      let pr = ((await open.json()) as Array<{ number: number }>)[0]?.number;
      if (!pr) {
        const made = await this.api(spec, token, `/repos/${spec.repo}/pulls`, { method: "POST", body: { title: spec.title, head: branch, base: spec.base, body: `Opened by the AgentFactory harness for its work \`${spec.ship}\`, after you approved it.\n\nMerging is yours.` } });
        if (!made.ok) return failedHandle(`GitHub answered ${made.status} opening the pull request: ${(await made.text()).slice(0, 160)}`);
        pr = ((await made.json()) as { number: number }).number;
      }
      return handleOf(spec, pr, sha, now);
    } catch (e) {
      const err = e as Error & { stderr?: string };
      return failedHandle(`${(err.stderr || err.message).split("\n")[0].slice(0, 200)}`);
    }
  }

  async poll(handle: string, now: number): Promise<JobOutcome & { pr?: string }> {
    const [kind, ...rest] = handle.split(SEP);
    if (kind === "ghfail") return { status: "failed", metrics: {}, note: rest.join(SEP) };
    if (kind === "watch") {
      const [, api, repo, pr, , , tokenEnv] = rest;
      const url = `${host(api)}/${repo}/pull/${pr}`;
      const token = this.env[tokenEnv || "AF_GITHUB_TOKEN"];
      if (!token) return { status: "running", eta: now + 30 * 60_000 };
      const r = await this.api({ api, repo } as ShipSpec, token, `/repos/${repo}/pulls/${pr}`);
      if (!r.ok) return { status: "running", eta: now + 30 * 60_000 };
      const p = (await r.json()) as { state?: string; merged?: boolean; merged_at?: string | null; merged_by?: { login?: string } | null };
      if (p.merged) return { status: "succeeded", metrics: { merged: 1 }, note: `${url} was merged${p.merged_by?.login ? ` by ${p.merged_by.login}` : ""}${p.merged_at ? ` at ${p.merged_at}` : ""}`, pr: url };
      if (p.state === "closed") return { status: "failed", metrics: { merged: 0 }, note: `${url} was closed without merging`, pr: url };
      return { status: "running", eta: now + 30 * 60_000 };
    }
    const [api, repo, pr, sha, at, tokenEnv] = rest;
    const spec = { api, repo } as ShipSpec;
    const url = `${host(api)}/${repo}/pull/${pr}`;
    const token = this.env[tokenEnv || "AF_GITHUB_TOKEN"];
    // The token gone from the environment (a new session): wait for it rather than fail the work.
    if (!token) return { status: "running", eta: now + 30 * 60_000 };
    const r = await this.api(spec, token, `/repos/${repo}/commits/${sha}/check-runs?per_page=100`);
    if (!r.ok) return { status: "running", eta: now + 10 * 60_000 };
    const runs = ((await r.json()) as { check_runs?: Array<{ name: string; status: string; conclusion: string | null }> }).check_runs ?? [];
    if (!runs.length) {
      // No checks yet; after two hours, a repository with none.
      return now - Number(at) < 2 * 3_600_000 ? { status: "running", eta: now + 10 * 60_000 } : { status: "succeeded", metrics: { checks: 0, checks_failed: 0 }, note: `no checks ran on ${url}`, pr: url };
    }
    if (runs.some((c) => c.status !== "completed")) return { status: "running", eta: now + 5 * 60_000 };
    const bad = runs.filter((c) => !["success", "neutral", "skipped"].includes(c.conclusion ?? ""));
    return bad.length
      ? { status: "failed", metrics: { checks: runs.length, checks_failed: bad.length }, note: `checks failed on ${url}: ${bad.map((c) => `${c.name} (${c.conclusion})`).join(", ")}`, pr: url }
      : { status: "succeeded", metrics: { checks: runs.length, checks_failed: 0 }, note: `${runs.length} check${runs.length === 1 ? "" : "s"} passed on ${url}`, pr: url };
  }
}

// `npm run harness -- ship test`: what the goal's identity can do on its repository, before
// any work is shipped. It should be able to push and open pull requests, not administer the
// repository, and main should need a pull request.
export async function shipTest(d: ShipDef, opts: { env?: NodeJS.ProcessEnv; fetch?: Fetch } = {}): Promise<{ ok: boolean; lines: string[] }> {
  const env = opts.env ?? process.env;
  const get: Fetch = opts.fetch ?? ((u, i) => fetch(u, i) as ReturnType<Fetch>);
  const api = (d.api ?? API).replace(/\/+$/, "");
  const tokenEnv = d.tokenEnv ?? "AF_GITHUB_TOKEN";
  const token = env[tokenEnv];
  if (!token) return { ok: false, lines: [`${tokenEnv} isn't set: put the token of the identity that opens pull requests there (a GitHub App's or a machine user's, not yours).`] };
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  const lines: string[] = [];
  let ok = true;
  const repo = await get(`${api}/repos/${d.repo}`, { headers });
  if (!repo.ok) return { ok: false, lines: [`GitHub answered ${repo.status} for ${d.repo}: check the name, the API address (${api}), and that the identity is installed on or invited to it.`] };
  const r = (await repo.json()) as { default_branch?: string; permissions?: { admin?: boolean; push?: boolean } };
  lines.push(`${d.repo} is reachable; its default branch is ${r.default_branch ?? "?"}${d.base && d.base !== r.default_branch ? ` (the goal ships to ${d.base})` : ""}.`);
  if (r.permissions) {
    if (!r.permissions.push) { ok = false; lines.push("The identity can't push: give it contents write."); }
    if (r.permissions.admin) { ok = false; lines.push("The identity administers the repository: it could change the rules that keep it off main. Use one with contents and pull requests write only."); }
  }
  const rules = await get(`${api}/repos/${d.repo}/rules/branches/${encodeURIComponent(d.base ?? r.default_branch ?? "main")}`, { headers });
  const list = rules.ok ? ((await rules.json()) as Array<{ type: string }>) : [];
  if (list.some((x) => x.type === "pull_request")) lines.push(`${d.base ?? "main"} needs a pull request: the identity can't merge on its own.`);
  else { ok = false; lines.push(`${d.base ?? "main"} has no rule requiring a pull request (or the identity can't read its rules). Add a ruleset: a pull request, an approval and the required checks, with the identity not on the bypass list.`); }
  if (ok) lines.push("Ready: approved work will open pull requests here.");
  return { ok, lines };
}

// Where the repository's base is now, and what changed on it since `since` under the
// repository's root, as a patch for the engagement's copy under `dir` (keeping it in step).
export async function upstream(ship: GitHubShip, d: ShipDef, since: string | undefined): Promise<{ sha: string; patch: string } | { error: string }> {
  const spec = { repo: d.repo, base: d.base ?? "main", api: d.api ?? API, tokenEnv: d.tokenEnv ?? "AF_GITHUB_TOKEN", ...(d.remote ? { remote: d.remote } : {}) } as ShipSpec;
  const token = ship.env[spec.tokenEnv];
  if (!token) return { error: `set ${spec.tokenEnv} to keep ${d.dir} in step with ${d.repo}` };
  try {
    const dir = await ship.clone(spec, token);
    const git = (args: string[]) => ship.run(args, { cwd: dir, env: ship.gitEnvFor(spec, token) });
    await git(["fetch", "-q", "origin", spec.base]);
    const sha = await git(["rev-parse", `origin/${spec.base}`]);
    const patch = since && since !== sha ? await git(["diff", "--binary", since, sha]) : "";
    return { sha, patch };
  } catch (e) {
    const err = e as Error & { stderr?: string };
    return { error: (err.stderr || err.message).split("\n")[0].slice(0, 200) };
  }
}
