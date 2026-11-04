// The harness's questions on Slack, answered with one tap. Your company lets you build
// Slack workflows but not apps, so nothing can call this PC: the loop posts each card to a
// workflow that starts from a webhook, the workflow messages you, and your tap comes back as
// a mail the loop reads from Outlook, the same way the desk's permission asks do
// (src/desk/slack.ts). It's a second workflow, because a card here has its own fields.
//
// A card carries the question's options as numbers, since a workflow's form can only offer
// fixed choices: you pick 1 to 4, or "Open the panel". An option that can't be undone, or
// that needs words from you (a new goal, a number), is answered on the panel only, and the
// card says so. A tap counts only with the question's id and the one-time code its card
// carried, from your own address, while the question is still open; it's recorded as your
// answer, so its grade is yours.
//
// Set up in ~/.af/harness/slack.json (outside the engagement: it's yours, not the project's):
//   { "webhook": "https://hooks.slack.com/triggers/...", "me": "you@company.com", "replies": "outlook", "digestHour": 9 }
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Answer } from "./answers.ts";
import type { AskState, State } from "./project.ts";
import { irreversibleEffect } from "./types.ts";

export type SlackConfig = { webhook: string; me?: string; replies?: "outlook"; digestHour?: number };

// What the workflow gets: flat text fields only, each added to its webhook trigger by this
// name. `kind` is "ask" (has options: show the Answer button), "notice" or "result".
export type Card = { kind: "ask" | "notice" | "result"; engagement: string; goal: string; headline: string; what: string; why: string; options: string; ask: string; nonce: string };
export type Post = (url: string, card: Card) => Promise<void>;
export type Mail = { subject: string; body: string; from: string };
export type ReadMail = (only?: string, prefix?: string) => Promise<Mail[]>;

export const notifyHome = (env: NodeJS.ProcessEnv = process.env) => env.AF_HARNESS_NOTIFY_HOME || path.join(os.homedir(), ".af", "harness");
const configFile = (home: string) => path.join(home, "slack.json");
const sentFile = (home: string) => path.join(home, "slack-sent.json");

export function slackConfig(home = notifyHome()): SlackConfig | undefined {
  try {
    const c = JSON.parse(fs.readFileSync(configFile(home), "utf8")) as SlackConfig;
    return typeof c.webhook === "string" && /^https:\/\/hooks\.slack\.com\//.test(c.webhook) ? c : undefined;
  } catch {
    return undefined;
  }
}

type SentOne = { nonce: string; at: number; kind: Card["kind"]; done?: number; followed?: boolean };
type Sent = Record<string, SentOne>; // "<engagement>/<ask>" or "<engagement>/notice/<what>"
const readSent = (home: string): Sent => {
  try {
    return JSON.parse(fs.readFileSync(sentFile(home), "utf8")) as Sent;
  } catch {
    return {};
  }
};
const writeSent = (home: string, s: Sent) => {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(sentFile(home), JSON.stringify(s, null, 1));
};

export const post: Post = async (url, card) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(card), signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`Slack said ${r.status}: ${(await r.text()).slice(0, 200)}`);
};

// Why an option can't be answered from Slack, or undefined when it can.
export function panelOnly(a: AskState, i: number): string | undefined {
  const o = a.options[i];
  if (!o) return "no such option";
  if (o.irreversible || irreversibleEffect(o.effect)) return "can't be undone";
  if (o.effect?.type === "revise" || o.effect?.type === "budget") return "needs words from you";
  if (a.kind === "action" && o.id === "done") return "needs what you observed";
  return undefined;
}

const firstSentence = (q: string) => (/^(.{20,160}?[.?!])(\s|$)/.exec(q)?.[1] ?? q.slice(0, 160)).trim();

export function cardFor(s: State, engagement: string, a: AskState, nonce: string): Card {
  const g = s.goals.get(a.goal);
  const about = a.todo ? s.todos.get(a.todo)?.text : undefined;
  const rec = a.recommend ? a.options.find((o) => o.id === a.recommend!.option) : undefined;
  const options = a.options.slice(0, 4).map((o, i) => {
    const off = panelOnly(a, i);
    return `${i + 1}. ${o.label}${rec === o ? " (recommended)" : ""}${off ? ` (${off}: answer on the panel)` : ""}`;
  });
  if (a.options.length > 4) options.push(`More options on the panel.`);
  return {
    kind: "ask",
    engagement,
    goal: g?.def.title ?? a.goal,
    headline: firstSentence(a.question),
    what: [a.question, about && about !== a.question ? `About: ${about.split("\n")[0].slice(0, 200)}` : ""].filter(Boolean).join("\n").slice(0, 1500),
    why: rec ? `Recommended: ${rec.label}. ${a.recommend!.why}`.slice(0, 600) : "",
    options: options.join("\n"),
    ask: a.id,
    nonce,
  };
}

// When a question's card goes out: an urgent one at once; the rest at the digest hour (9
// by default, this PC's time) on or after it opened, so they reach you together.
export function dueAt(a: AskState, digestHour = 9): number {
  if (a.urgent) return a.openedAt;
  const d = new Date(a.openedAt);
  d.setHours(digestHour, 0, 0, 0);
  if (d.getTime() < a.openedAt) d.setDate(d.getDate() + 1);
  return d.getTime();
}

export type Reply = { ask: string; nonce: string; said: string; note?: string; who: string };
export function readReply(m: Mail): Reply | undefined {
  const r = /af-harness\s+(\S+)\s+(\S+)\s+(.+?)\s*$/i.exec(m.subject);
  if (!r) return undefined;
  const note = (m.body ?? "").replace(/\s+/g, " ").trim().slice(0, 1000);
  return { ask: r[1], nonce: r[2], said: r[3].toLowerCase().trim(), ...(note ? { note } : {}), who: (m.from ?? "").trim() };
}

export type NotifyDeps = {
  engagement: string;
  state: () => Promise<State>;
  answer: (ask: string, ans: Answer) => Promise<unknown>;
  home?: string;
  now?: number;
  send?: Post;
  read?: ReadMail;
};
export type NotifyResult = { sent: string[]; answered: Array<{ ask: string; choice: string }>; ignored: Array<{ subject: string; why: string }>; failed?: string };

// One pass, after each wake of the loop: post what's due, read your taps, and post what
// your answers led to.
export async function notifyTick(d: NotifyDeps): Promise<NotifyResult> {
  const home = d.home ?? notifyHome();
  const out: NotifyResult = { sent: [], answered: [], ignored: [] };
  const cfg = slackConfig(home);
  if (!cfg) return out;
  const now = d.now ?? Date.now();
  const send = d.send ?? post;
  const sent = readSent(home);
  const before = JSON.stringify(sent);
  const key = (id: string) => `${d.engagement}/${id}`;
  let s = await d.state();

  // Your taps first, so a card answered by mail isn't followed by a reminder.
  if (cfg.replies === "outlook" && cfg.me && Object.entries(sent).some(([k, v]) => k.startsWith(`${d.engagement}/`) && v.kind === "ask" && !v.done)) {
    const read = d.read ?? (async (only, prefix) => (await import("../desk/slack.ts")).readOutlook(only, prefix));
    try {
      for (const m of await read(undefined, "af-harness")) {
        const why = await take(m);
        if (why) out.ignored.push({ subject: m.subject, why });
      }
    } catch (e) {
      out.failed = `couldn't read Outlook: ${(e as Error).message}`;
    }
    s = await d.state();
  }
  async function take(m: Mail): Promise<string | undefined> {
    const r = readReply(m);
    if (!r) return "not an answer: the subject should be af-harness <ask> <code> <1-4>";
    const one = sent[key(r.ask)];
    if (!one || one.nonce !== r.nonce) return "not a card this engagement sent";
    if (r.who.toLowerCase() !== cfg!.me!.toLowerCase()) return `sent by ${r.who || "someone unknown"}, not ${cfg!.me}`;
    const a = s.asks.get(r.ask);
    if (!a || a.status !== "open") return "already answered, or no longer open";
    if (/panel/.test(r.said)) return undefined; // you'll answer there
    const i = Number(/\d+/.exec(r.said)?.[0]) - 1;
    const off = panelOnly(a, i);
    if (off) return `option ${i + 1} ${off === "no such option" ? "doesn't exist" : `${off}: answer it on the panel`}`;
    await d.answer(a.id, { by: "partner", choice: a.options[i].id, ...(r.note ? { note: r.note } : {}) });
    out.answered.push({ ask: a.id, choice: a.options[i].id });
    return undefined;
  }

  const postOne = async (k: string, card: Card): Promise<boolean> => {
    try {
      await send(cfg.webhook, card);
      return true;
    } catch (e) {
      out.failed = (e as Error).message;
      return false;
    }
  };

  // Cards for your open questions, once each, when due.
  for (const a of [...s.asks.values()].sort((x, y) => x.openedAt - y.openedAt)) {
    if (a.status !== "open" || a.to !== "partner" || sent[key(a.id)] || out.failed) continue;
    if (now < dueAt(a, cfg.digestHour)) continue;
    const nonce = randomBytes(12).toString("hex");
    if (!(await postOne(key(a.id), cardFor(s, d.engagement, a, nonce)))) break;
    sent[key(a.id)] = { nonce, at: now, kind: "ask" };
    out.sent.push(a.id);
  }

  // What your answer led to: once the work it was about has had a turn since (or at once
  // when it was about no work), under a card of its own.
  for (const [k, one] of Object.entries(sent)) {
    if (!k.startsWith(`${d.engagement}/`) || one.kind !== "ask" || one.followed || out.failed) continue;
    const a = s.asks.get(k.slice(d.engagement.length + 1));
    if (!a || a.status === "open") continue;
    one.done ??= now;
    const turn = a.todo ? [...s.turns].reverse().find((t) => t.todo === a.todo && t.at >= (a.answeredAt ?? 0)) : undefined;
    if (a.todo && !turn && now - (a.answeredAt ?? now) < 24 * 3_600_000) continue;
    const chose = a.options.find((o) => o.id === a.choice)?.label ?? a.choice ?? "";
    const how = a.status === "auto_closed" ? `Settled without you (${a.autoReason ?? "by the harness"}): ${chose}.` : a.choice === "moot" ? `No longer needed: ${a.note ?? "the goal moved on"}.` : `${a.answeredBy === "partner" ? "You" : a.answeredBy} chose: ${chose}.`;
    const then = turn ? ` Then its work ran: ${turn.result}${turn.reasons.length ? ` (${turn.reasons.join("; ").slice(0, 200)})` : ""}.` : "";
    if (await postOne(k, { kind: "result", engagement: d.engagement, goal: s.goals.get(a.goal)?.def.title ?? a.goal, headline: `Done: ${firstSentence(a.question)}`, what: `${how}${then}`, why: "", options: "", ask: a.id, nonce: "" })) one.followed = true;
  }

  // Notices that need no answer: a model service holding its seats for hours, and events a
  // rule marked "tell me now".
  const notice = async (id: string, headline: string, what: string, goal = "") => {
    const k = key(`notice/${id}`);
    if (sent[k] || out.failed) return;
    if (await postOne(k, { kind: "notice", engagement: d.engagement, goal, headline, what, why: "", options: "", ask: "", nonce: "" })) sent[k] = { nonce: "", at: now, kind: "notice", done: now };
  };
  for (const c of s.capacity.values()) {
    if (c.until - now >= 2 * 3_600_000) await notice(`cap-${c.vendor}-${c.until}`, `${c.vendor} turns wait until ${new Date(c.until).toLocaleString()}`, `${c.reason}. Its seats wait; nothing is counted as failed.`);
  }
  const tell = new Map((s.engagement?.events?.rules ?? []).filter((r) => r.tell === "now").map((r) => [r.id, r]));
  for (const [id, r] of s.outside) {
    const rule = r.rule ? tell.get(r.rule) : undefined;
    if (rule && now - r.at < 24 * 3_600_000) await notice(`evt-${id}`, `${r.event.type} ${r.event.id}: ${r.event.title}`, `From ${r.event.source}${r.event.url ? ` (${r.event.url})` : ""}. It goes to ${rule.lane} in ${rule.goal}.`, rule.goal);
  }

  // Forget what's long done.
  for (const [k, one] of Object.entries(sent)) if (one.done && now - one.done > 7 * 86_400_000) delete sent[k];
  if (JSON.stringify(sent) !== before) writeSent(home, sent);
  return out;
}

// `npm run harness -- slack test`: one card that asks nothing, to check the workflow.
export async function slackTest(home = notifyHome(), send: Post = post): Promise<{ ok: boolean; lines: string[] }> {
  const cfg = slackConfig(home);
  if (!cfg) return { ok: false, lines: [`Slack isn't set up: write {"webhook": "https://hooks.slack.com/triggers/...", "me": "you@company.com", "replies": "outlook"} to ${configFile(home)}.`] };
  try {
    await send(cfg.webhook, { kind: "ask", engagement: "test", goal: "A test from the harness", headline: "Does the card reach you?", what: "Nothing is waiting: this checks the workflow. Tap any number; the mail it sends is ignored.", why: "", options: "1. Yes\n2. Also yes", ask: `test-${Date.now()}`, nonce: randomBytes(6).toString("hex") });
  } catch (e) {
    return { ok: false, lines: [`Couldn't post to the workflow: ${(e as Error).message}`, "Check the address, and that this PC reaches hooks.slack.com."] };
  }
  return { ok: true, lines: ["Posted. The card should reach you on Slack in a few seconds; if it doesn't, check the workflow's activity in Workflow Builder.", cfg.replies ? `Tap a number: the mail should arrive in Outlook with the subject "af-harness test-... <code> <number>", from ${cfg.me ?? "your address (set \"me\")"}.` : "Replies aren't set up (\"replies\": \"outlook\"), so cards only tell you; answer on the panel."] };
}
