// Learning from a finished session: its file is read into a digest, Copilot CLI
// (headless, read-only) is asked what in it will still be true next time, and the
// answers go into the knowledge repo as guesses for you to confirm.
//
// The analysis is a Copilot run like a harness turn, held tighter: it may only read
// the digest in a scratch folder (no shell, no writes, no MCP servers, no custom
// instructions), and it runs with AF_DESK_QUIET so the desk's own hook ignores it.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CopilotStream } from "../harness/agents.ts";
import { spawnCommand } from "../proc.ts";
import { readJson, writeJson } from "./hold.ts";
import { commit, contextFor, knowledgeDir, recordProposals, rejected, repoNameOf, repoPrincipal, YOU } from "./knowledge.ts";
import { deskHome, readLog, type DeskEvent } from "./log.ts";
import { digest, readEvents, sessionFile } from "./session.ts";

// Given the prompt and the folder holding the digest, returns what the model replied.
export type Analyst = (prompt: string, workdir: string) => Promise<string>;

export type LearnConfig = { learn: "auto" | "off"; model?: string; copilot?: string; timeoutSec: number };
export function learnConfig(home = deskHome()): LearnConfig {
  const c = readJson<Partial<LearnConfig>>(path.join(home, "config.json"), {});
  return { learn: c.learn === "off" ? "off" : "auto", timeoutSec: c.timeoutSec ?? 600, ...(c.model ? { model: c.model } : {}), ...(c.copilot ? { copilot: c.copilot } : {}) };
}

export function copilotAnalyst(cfg: LearnConfig, say: (l: string) => void = () => {}): Analyst {
  return async (prompt, workdir) => {
    const stream = new CopilotStream((...l) => l.forEach(say));
    const args = ["-p", prompt, "--output-format", "json", "--no-ask-user", "--no-custom-instructions", "--deny-tool", "shell", "--deny-tool", "write", "--disable-mcp-server", "agentfactory", ...(cfg.model ? ["--model", cfg.model] : [])];
    await spawnCommand(cfg.copilot ?? "copilot", args, { cwd: workdir, env: { ...process.env, AF_DESK_QUIET: "1", AF_TURN: "desk-analysis", GIT_TERMINAL_PROMPT: "0" }, timeout: cfg.timeoutSec * 1000, maxBuffer: 32 * 1024 * 1024, onStdout: (s) => stream.feed(s), onStderr: (s) => stream.stderr(s) });
    stream.end();
    return stream.reply();
  };
}

export function analysisPrompt(repo: string, known: string | undefined, wrong: string[]): string {
  return [
    `Read session.md in this folder: a digest of one Copilot CLI session in the repo "${repo}". Find what in it will still be true and useful in a future session in this repo, or about how this person works anywhere.`,
    "",
    "Keep only what the session shows, not what you assume:",
    "- a command that worked for building, testing, running or deploying (and one that didn't, with what to use instead)",
    "- a rule the person stated or corrected you on (\"no, we use X\", \"never touch Y\"), a refusal and its reason",
    "- a fact about the codebase that took effort to find: where something lives, how parts connect, a trap and its fix",
    "- how this person likes to work (style, review, what they refuse)",
    "Leave out: what was done in this task only, anything you'd find in a minute by reading the code, guesses, and anything secret (tokens, passwords, keys, personal data).",
    "",
    known ? `Already known (don't repeat it; if the session contradicts it, propose the new version):\n${known}\n` : "",
    wrong.length ? `The person marked these wrong; never propose them again:\n${wrong.map((w) => `- ${w}`).join("\n")}\n` : "",
    "Reply with only a JSON object, at most 12 items, the most useful first:",
    '{"items":[{"scope":"repo"|"you","kind":"fact"|"constraint"|"preference","subject":"short.dotted-name","value":"what is compared when two disagree (optional)","text":"one sentence, in plain words","condition":"when it holds (optional)","evidence":"the line in the digest that shows it"}]}',
    'If nothing is worth keeping, reply {"items":[]}.',
  ].filter((l) => l !== "").join("\n");
}

// The last JSON object in a reply that has an "items" list.
export function parseItems(reply: string): unknown[] | null {
  for (let end = reply.lastIndexOf("}"); end >= 0; end = reply.lastIndexOf("}", end - 1)) {
    for (let start = reply.lastIndexOf("{", end); start >= 0; start = reply.lastIndexOf("{", start - 1)) {
      try {
        const v = JSON.parse(reply.slice(start, end + 1)) as { items?: unknown };
        if (v && Array.isArray(v.items)) return v.items;
      } catch {
        /* keep widening */
      }
    }
  }
  return null;
}

export type Analysis = { session: string; repo: string; at: number; ok: boolean; error?: string; kept: string[]; dropped: Array<{ proposal: unknown; why: string }>; digestChars: number };

export const analysesDir = (dir: string) => path.join(dir, "analyses");
export const analysisFile = (dir: string, session: string) => path.join(analysesDir(dir), `${session}.json`);

// One session, start to end. Safe to run twice: an analysed session is skipped unless forced.
export async function learn(session: string, opts: { home?: string; analyst: Analyst; now?: () => number; force?: boolean; transcript?: string; log?: (l: string) => void }): Promise<Analysis | null> {
  const home = opts.home ?? deskHome();
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const dir = knowledgeDir(home);
  if (!opts.force && fs.existsSync(analysisFile(dir, session))) return null;
  const deskEvents = readLog(home).filter((e) => e.session === session);
  const file = sessionFile(session, opts.transcript ?? deskEvents.find((e) => e.transcript)?.transcript);
  if (!file) throw new Error(`can't find Copilot's file for session ${session}`);
  const events = readEvents(file);
  const cwd = deskEvents[0]?.cwd ?? (events.find((e) => e.type === "session.start")?.data?.context?.cwd as string | undefined) ?? "";
  const repo = cwd ? repoNameOf(cwd) : "repo";
  const refusals = deskEvents.filter((e) => e.event === "decision" && e.choice === "deny").map((e) => ({ tool: e.tool, note: e.message }));
  const d = digest(events, refusals);

  const record: Analysis = { session, repo, at: now(), ok: false, kept: [], dropped: [], digestChars: d.text.length };
  if (d.prompts === 0) {
    record.ok = true;
    record.error = "nothing you asked: skipped";
  } else {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "af-desk-learn-"));
    try {
      fs.writeFileSync(path.join(work, "session.md"), d.text);
      const wrong = [repoPrincipal(repo), YOU].flatMap((p) => rejected(dir, p).map((r) => `${r.subject}: ${r.text}`));
      log(`learning from ${repo} session ${session.slice(0, 8)} (${d.prompts} prompts, ${d.tools} tool calls)`);
      const reply = await opts.analyst(analysisPrompt(repo, cwd ? contextFor(cwd, home, now()) : undefined, wrong), work);
      const items = parseItems(reply);
      if (!items) throw new Error(`the analysis didn't reply with JSON: ${reply.slice(0, 200)}`);
      const { kept, dropped } = recordProposals(dir, repo, items, { session, now: now() });
      Object.assign(record, { ok: true, kept: kept.map((e) => e.id), dropped });
    } catch (e) {
      record.error = (e as Error).message.split("\n")[0].slice(0, 400);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }
  fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
  fs.writeFileSync(path.join(dir, "sessions", `${session}.md`), d.text);
  writeJson(analysisFile(dir, session), record);
  await commit(dir, `learn from ${repo} session ${session.slice(0, 8)}: ${record.kept.length} kept${record.error ? ` (${record.error.slice(0, 60)})` : ""}`, { Session: session, Repo: repo }, log);
  log(record.error ? `learning ${session.slice(0, 8)}: ${record.error}` : `learned ${record.kept.length} things from ${repo} (${record.dropped.length} left out)`);
  return record;
}

// Sessions that ended and haven't been analysed, oldest first. A failed analysis is
// retried once a day, not on every pass.
export function toLearn(log: DeskEvent[], dir: string, now = Date.now()): Array<{ session: string; transcript?: string }> {
  const ended = new Map<string, string | undefined>();
  for (const e of log) {
    if (e.transcript) ended.set(e.session, ended.get(e.session) ?? e.transcript);
    if (e.event === "sessionEnd" && !ended.has(e.session)) ended.set(e.session, undefined);
  }
  const done = new Set(log.filter((e) => e.event === "sessionEnd").map((e) => e.session));
  return [...ended].filter(([s]) => done.has(s)).filter(([s]) => {
    const a = readJson<Analysis | null>(analysisFile(dir, s), null);
    return !a || (!a.ok && now - a.at > 86_400_000);
  }).map(([session, transcript]) => ({ session, ...(transcript ? { transcript } : {}) }));
}
