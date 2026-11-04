// Asks on Slack while you're away from the desk. Your company lets you build Slack
// workflows but not apps, so there's no token and Slack can't reach this PC: the desk
// posts to a workflow that starts from a webhook, and the workflow messages you.
//
// The way back is your mailbox. The message's button opens a form; the workflow emails
// what you chose to yourself, subject "af-desk <ask> <code> <choice>", and the desk reads
// it from the Outlook app on this PC (scripts/windows/outlook-replies.ps1). An answer
// counts only with the ask's id and the one-time code its message carried, from your
// own address, while the ask still waits. Without that set up, Slack only tells you, and
// you answer when you're back.
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { answer, type Ask, awaySince, type Choice, loadConfig, pending, readJson, slackOf, writeJson } from "./hold.ts";
import { runCommand } from "../proc.ts";
import { deskHome } from "./log.ts";
import { type About, headline } from "./teams.ts";
import { wantsOf } from "./threads.ts";

export const slackSentFile = (home = deskHome()) => path.join(home, "slack.json");
type Sent = Record<string, { nonce: string; at: number; done?: number }>;
const KEEP_MS = 24 * 3600_000;

// What the workflow gets. Slack's webhook trigger takes only flat text fields, and each
// one you use in a message has to be added to the trigger by this name.
export type SlackMessage = { headline: string; thread: string; wants: string; doing: string; folder: string; since: string; ask: string; nonce: string };

export function message(ask: Ask, nonce: string, about: About = {}): SlackMessage {
  return {
    headline: headline(ask),
    thread: about.title ?? "",
    wants: wantsOf(ask.tool, ask.detail) ?? ask.tool,
    doing: about.doing ?? "",
    folder: ask.cwd,
    since: new Date(ask.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
    ask: ask.id,
    nonce,
  };
}

export type Post = (url: string, body: SlackMessage) => Promise<void>;
export const post: Post = async (url, body) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`Slack said ${r.status}: ${(await r.text()).slice(0, 200)}`);
};

export type SlackTick = { sent: string[]; failed?: string };

// One pass while the desk runs: message the asks now due, once each. A message Slack
// didn't take is tried again next pass.
export async function slackTick(home = deskHome(), now = Date.now(), about: (a: Ask) => About = () => ({}), send: Post = post): Promise<SlackTick> {
  const result: SlackTick = { sent: [] };
  const cfg = slackOf(loadConfig(home));
  if (!cfg) return result;
  const sent = readJson<Sent>(slackSentFile(home), {});
  const before = JSON.stringify(sent);
  const waiting = pending(home);
  const away = awaySince(home) !== undefined;
  for (const a of waiting) {
    if (sent[a.id]) continue;
    // Away, everything held goes at once; otherwise only asks a terminal holds on the
    // desk, once they've waited there a while.
    if (!away && now - a.at < cfg.afterSec * 1000) continue;
    const nonce = randomBytes(12).toString("hex");
    try {
      await send(cfg.webhook, message(a, nonce, about(a)));
    } catch (e) {
      result.failed = (e as Error).message;
      break;
    }
    sent[a.id] = { nonce, at: now };
    result.sent.push(a.id);
  }
  const open = new Set(waiting.map((a) => a.id));
  for (const [id, s] of Object.entries(sent)) {
    if (open.has(id)) continue;
    s.done ??= now;
    if (now - s.done > KEEP_MS) delete sent[id];
  }
  if (JSON.stringify(sent) !== before) writeJson(slackSentFile(home), sent);
  return result;
}

// One mail the workflow sent you, as Outlook has it.
export type Mail = { subject: string; body: string; from: string };
export type ReadMail = (only?: string, prefix?: string) => Promise<Mail[]>;

const READER = path.join(import.meta.dirname, "..", "..", "scripts", "windows", "outlook-replies.ps1");
// `prefix`: whose mails ("af-desk" for the desk's, "af-harness" for the harness's).
export const readOutlook: ReadMail = async (only, prefix) => {
  if (process.platform !== "win32") throw new Error("answers by Outlook need the Outlook app on Windows");
  const { stdout } = await runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", READER, ...(only ? ["-Only", only] : []), ...(prefix ? ["-Prefix", prefix] : [])], { timeout: 60_000 });
  const v = JSON.parse(stdout.trim() || "[]") as unknown;
  return (Array.isArray(v) ? v : [v]).filter((m): m is Mail => !!m && typeof (m as Mail).subject === "string");
};

// The form's choices as Slack shows them, and the answers they are.
const CHOICE_OF: Record<string, Choice> = {
  allow: "allow",
  "allow from now on": "always",
  always: "always",
  deny: "deny",
  "answer in the terminal": "terminal",
  terminal: "terminal",
};

export type Reply = { ask: string; nonce: string; choice?: Choice; said: string; reason?: string; who: string };
export function readReply(m: Mail): Reply | undefined {
  const r = /af-desk\s+(\S+)\s+(\S+)\s+(.+?)\s*$/i.exec(m.subject);
  if (!r) return undefined;
  const said = r[3].toLowerCase().replace(/\s+/g, " ");
  const reason = (m.body ?? "").replace(/\s+/g, " ").trim().slice(0, 1000);
  return { ask: r[1], nonce: r[2], said, ...(CHOICE_OF[said] ? { choice: CHOICE_OF[said] } : {}), ...(reason ? { reason } : {}), who: (m.from ?? "").trim() };
}

export type SlackReplies = { answered: Array<{ ask: string; choice: Choice; who: string }>; ignored: Array<{ subject: string; why: string }> };

// One read of your mailbox: answer the asks your mails are for. Only while some ask has
// a message on Slack; the mails are read once, whatever they say.
export async function slackReplies(home = deskHome(), now = Date.now(), read: ReadMail = readOutlook): Promise<SlackReplies> {
  const result: SlackReplies = { answered: [], ignored: [] };
  const cfg = slackOf(loadConfig(home));
  if (!cfg?.replies || !slackSentIds(home).length) return result;
  const sent = readJson<Sent>(slackSentFile(home), {});
  for (const m of await read()) {
    const why = take(m, sent, cfg.me, home, now, result);
    if (why) result.ignored.push({ subject: m.subject, why });
  }
  return result;
}

function take(m: Mail, sent: Sent, me: string, home: string, now: number, result: SlackReplies): string | undefined {
  const r = readReply(m);
  if (!r) return "not an answer: the subject should be af-desk <ask> <nonce> <choice>";
  const s = sent[r.ask];
  if (!s || s.nonce !== r.nonce) return "not a message the desk sent";
  if (r.who.toLowerCase() !== me.toLowerCase()) return `sent by ${r.who || "someone unknown"}, not ${me}`;
  if (!r.choice) return `no such answer: ${r.said}`;
  if (s.done || !pending(home).some((a) => a.id === r.ask)) return "already answered, or no longer waiting";
  try {
    answer(r.ask, r.choice, r.choice === "deny" ? r.reason : undefined, home, now, { via: "slack", who: r.who });
  } catch (e) {
    return (e as Error).message;
  }
  result.answered.push({ ask: r.ask, choice: r.choice, who: r.who });
  return undefined;
}

export function slackSentIds(home = deskHome()): string[] {
  return Object.entries(readJson<Sent>(slackSentFile(home), {})).filter(([, s]) => !s.done).map(([id]) => id);
}

// `npm run desk -- slack test`: one message that asks nothing, to check the workflow.
export async function slackTest(home = deskHome(), send: Post = post, opts: { read?: ReadMail; sleep?: (ms: number) => Promise<void>; waitMs?: number } = {}): Promise<{ ok: boolean; lines: string[] }> {
  const cfg = slackOf(loadConfig(home));
  if (!cfg) return { ok: false, lines: [`Slack isn't set up: add "slack": {"webhook": "https://hooks.slack.com/triggers/..."} to ${path.join(home, "config.json")}.`] };
  const nonce = randomBytes(12).toString("hex");
  const ask: Ask = { id: `test-${Date.now()}`, at: Date.now(), session: "test", cwd: home, terminal: "desk", tool: "shell", detail: JSON.stringify({ command: "echo the desk reaches you on Slack" }) };
  try {
    await send(cfg.webhook, message(ask, nonce, { title: cfg.replies ? "A test message from the desk: answer it, and nothing runs." : "A test message from the desk. Nothing is waiting." }));
  } catch (e) {
    return { ok: false, lines: [`Couldn't post to the workflow: ${(e as Error).message}`, "Check the address, and that this PC reaches hooks.slack.com (try it in a browser)."] };
  }
  const lines = ["Posted. A message from your workflow should reach you on Slack in a few seconds; if it doesn't, check the workflow's activity in Workflow Builder."];
  if (!cfg.replies) return { ok: true, lines };
  lines.push("Answer it there with any choice. Waiting for the mail in Outlook...");
  const read = opts.read ?? readOutlook;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const until = Date.now() + (opts.waitMs ?? 600_000);
  try {
    while (Date.now() < until) {
      const [m] = await read(ask.id);
      if (m) {
        const r = readReply(m);
        const problems = [
          !r || r.nonce !== nonce ? `the subject doesn't carry what the message did: it should be "af-desk {ask} {nonce} {choice}", got "${m.subject}"` : "",
          r && !r.choice ? `"${r.said}" isn't one of the choices: Allow, Allow from now on, Deny, Answer in the terminal` : "",
          r && r.who.toLowerCase() !== cfg.me.toLowerCase() ? `it came from ${r.who || "an unknown sender"}, but slack.me is ${cfg.me}: the desk would ignore it` : "",
        ].filter(Boolean);
        lines.push(`The mail came back: ${r?.who || "someone"} chose ${r?.said ?? "nothing"}.`, ...(problems.length ? problems : ["It works: you can answer asks on Slack while you're away."]));
        return { ok: !problems.length, lines };
      }
      await sleep(10_000);
    }
  } catch (e) {
    lines.push(`Couldn't read Outlook: ${(e as Error).message}`);
    return { ok: false, lines };
  }
  lines.push("No mail came back. Check the workflow's activity in Workflow Builder, and that its Outlook step sends to you with the subject above.");
  return { ok: false, lines };
}
