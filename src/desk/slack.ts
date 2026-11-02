// Asks on Slack while you're away from the desk. Your company lets you build Slack
// workflows but not apps, so there's no token: the desk can post to a workflow that
// starts from a webhook, and the workflow messages you, but nothing comes back. Slack
// tells you a terminal is waiting; you answer when you're back, on the page or in the
// terminal. The ask waits longer while you're away, so it's still there.
//
// Each message carries the ask's id and a one-time code, so a way back added later (a
// workflow step that emails you, read from Outlook on this PC) can be checked the way
// Teams taps are.
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { type Ask, awaySince, loadConfig, pending, readJson, slackOf, writeJson } from "./hold.ts";
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

export function slackSentIds(home = deskHome()): string[] {
  return Object.entries(readJson<Sent>(slackSentFile(home), {})).filter(([, s]) => !s.done).map(([id]) => id);
}

// `npm run desk -- slack test`: one message that asks nothing, to check the workflow.
export async function slackTest(home = deskHome(), send: Post = post): Promise<{ ok: boolean; lines: string[] }> {
  const cfg = slackOf(loadConfig(home));
  if (!cfg) return { ok: false, lines: [`Slack isn't set up: add "slack": {"webhook": "https://hooks.slack.com/triggers/..."} to ${path.join(home, "config.json")}.`] };
  const ask: Ask = { id: `test-${Date.now()}`, at: Date.now(), session: "test", cwd: home, terminal: "desk", tool: "shell", detail: JSON.stringify({ command: "echo the desk reaches you on Slack" }) };
  try {
    await send(cfg.webhook, message(ask, "test", { title: "A test message from the desk. Nothing is waiting." }));
  } catch (e) {
    return { ok: false, lines: [`Couldn't post to the workflow: ${(e as Error).message}`, "Check the address, and that this PC reaches hooks.slack.com (try it in a browser)."] };
  }
  return { ok: true, lines: ["Posted. A message from your workflow should reach you on Slack in a few seconds; if it doesn't, check the workflow's activity in Workflow Builder."] };
}
