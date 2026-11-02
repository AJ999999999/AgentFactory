// Asks on Teams while you're away from the desk. Teams can't reach this PC, and the
// company allows only the apps it approved, so the way there and back is a folder in
// your OneDrive, which syncs both ways on its own. The desk writes a card for each ask
// it holds to `out`; a flow you build once in Teams' Workflows app posts the card to your
// chat with the Workflows bot and waits; your tap comes back as a file in `in`, and the
// desk answers with it as if you'd clicked on the page.
//
// A tap counts only when it carries the ask's id and the one-time code its card was sent
// with, comes from your account, and the ask is still waiting. A late tap, an old card or
// anyone else's changes nothing.
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { answer, type Ask, awaySince, type Choice, loadConfig, pending, readJson, teamsOf, writeJson } from "./hold.ts";
import { deskHome } from "./log.ts";
import { wantsOf } from "./threads.ts";

// The cards sent: by ask id, the code each carries. Kept a day after the ask settles, so
// a late tap is told apart from a stranger's.
export const sentFile = (home = deskHome()) => path.join(home, "teams.json");
type Sent = Record<string, { nonce: string; at: number; terminal: string; done?: number }>;
const KEEP_MS = 24 * 3600_000;
// A file in `in` that still doesn't read after this is broken, not half synced.
const UNREADABLE_MS = 120_000;
// The test card's files (teamsTest), which the desk leaves alone.
const TEST = "test-";

// What the page knows about the thread, for the card: its title and what it's doing.
export type About = { title?: string; doing?: string };

const CHOICES: Choice[] = ["allow", "deny", "terminal", "always"];

const commandIn = (detail?: string): boolean => {
  try {
    return typeof (JSON.parse(detail ?? "") as Record<string, unknown>).command === "string";
  } catch {
    return false;
  }
};

// The card for one ask, in Adaptive Card 1.2, which Teams shows on the phone too. Every
// button carries the ask's id and code; the flow sends back what the button carried.
export function card(ask: Ask, nonce: string, about: About = {}): Record<string, unknown> {
  const data = (choice: Choice) => ({ ask: ask.id, nonce, choice });
  const wants = wantsOf(ask.tool, ask.detail) ?? ask.tool;
  const since = new Date(ask.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const facts = [{ title: "Folder", value: ask.cwd }, ...(about.doing ? [{ title: "Doing", value: about.doing }] : []), { title: "Waiting since", value: since }];
  return {
    type: "AdaptiveCard",
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.2",
    body: [
      { type: "TextBlock", text: commandIn(ask.detail) ? `${ask.terminal} wants to run a command` : `${ask.terminal} wants to use ${ask.tool}`, weight: "Bolder", size: "Medium", wrap: true },
      ...(about.title ? [{ type: "TextBlock", text: about.title, isSubtle: true, wrap: true }] : []),
      { type: "TextBlock", text: wants, fontType: "Monospace", wrap: true },
      { type: "FactSet", facts },
    ],
    actions: [
      { type: "Action.Submit", title: "Allow", style: "positive", data: data("allow") },
      ...(ask.always ? [{ type: "Action.Submit", title: `Allow ${ask.always.prefix ? `"${ask.always.prefix} …"` : ask.tool} in ${ask.terminal} from now on`, data: data("always") }] : []),
      {
        type: "Action.ShowCard",
        title: "Deny…",
        card: {
          type: "AdaptiveCard",
          body: [{ type: "Input.Text", id: "reason", placeholder: "Why not (Copilot reads this and tries another way)", isMultiline: true }],
          actions: [{ type: "Action.Submit", title: "Deny", style: "destructive", data: data("deny") }],
        },
      },
      { type: "Action.Submit", title: "Answer in the terminal", data: data("terminal") },
    ],
  };
}

export type TeamsTick = { sent: string[]; answered: Array<{ ask: string; choice: Choice; who: string }>; ignored: Array<{ file: string; why: string }> };

// One pass, every few seconds while the desk runs: take the taps that came back, send the
// asks now due, and take back the cards of asks settled elsewhere.
export function teamsTick(home = deskHome(), now = Date.now(), about: (a: Ask) => About = () => ({})): TeamsTick {
  const result: TeamsTick = { sent: [], answered: [], ignored: [] };
  const cfg = teamsOf(loadConfig(home));
  if (!cfg) return result;
  const out = path.join(cfg.folder, "out");
  const inbox = path.join(cfg.folder, "in");
  fs.mkdirSync(out, { recursive: true });
  fs.mkdirSync(inbox, { recursive: true });
  const sent = readJson<Sent>(sentFile(home), {});
  const before = JSON.stringify(sent);
  let waiting = pending(home);

  // `test-` files are `npm run desk -- teams test`'s own, waited for there.
  for (const f of fs.readdirSync(inbox).filter((n) => n.endsWith(".json") && !n.startsWith(TEST))) {
    const file = path.join(inbox, f);
    const r = readJson<Record<string, unknown> | null>(file, null);
    if (!r) {
      const age = now - (fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? now);
      if (age > UNREADABLE_MS) {
        fs.rmSync(file, { force: true });
        result.ignored.push({ file: f, why: "it isn't JSON" });
      }
      continue;
    }
    const why = take(r, sent, waiting, cfg.me, home, now, result);
    if (why) result.ignored.push({ file: f, why });
    fs.rmSync(file, { force: true });
  }
  if (result.answered.length) waiting = pending(home);

  const away = awaySince(home) !== undefined;
  for (const a of waiting) {
    if (sent[a.id]) continue;
    // Away, everything held goes at once. Otherwise only a terminal you answer on the
    // desk has asks held, and they go once they've waited there a while.
    if (!away && now - a.at < cfg.afterSec * 1000) continue;
    const nonce = randomBytes(12).toString("hex");
    // Written in place, not renamed into place: OneDrive would upload the temporary
    // name too, and the flow would see a file it can't use.
    fs.writeFileSync(path.join(out, `${a.id}.json`), JSON.stringify(card(a, nonce, about(a))));
    sent[a.id] = { nonce, at: now, terminal: a.terminal };
    result.sent.push(a.id);
  }

  const open = new Set(waiting.map((a) => a.id));
  for (const [id, s] of Object.entries(sent)) {
    if (open.has(id)) continue;
    // Settled on the page, in the terminal or by its wait: a card the flow hasn't picked
    // up yet isn't sent.
    fs.rmSync(path.join(out, `${id}.json`), { force: true });
    s.done ??= now;
    if (now - s.done > KEEP_MS) delete sent[id];
  }
  if (JSON.stringify(sent) !== before) writeJson(sentFile(home), sent);
  return result;
}

// One tap that came back, as the flow wrote it: the card's response, with who tapped
// (`responder`) and what the button carried plus what was typed (`data`).
export type Tap = { who: string; ask: string; nonce: string; choice: string; reason?: string };
export function readTap(r: Record<string, unknown>): Tap {
  const data = (typeof r.data === "object" && r.data ? r.data : r) as Record<string, unknown>;
  const responder = (typeof r.responder === "object" && r.responder ? r.responder : {}) as Record<string, unknown>;
  const reason = typeof data.reason === "string" && data.reason.trim() ? data.reason.trim().slice(0, 1000) : undefined;
  return { who: String(responder.userPrincipalName ?? responder.email ?? ""), ask: String(data.ask ?? ""), nonce: String(data.nonce ?? ""), choice: String(data.choice ?? ""), ...(reason ? { reason } : {}) };
}

// Answers the ask a tap is for, or says why not.
function take(r: Record<string, unknown>, sent: Sent, waiting: Ask[], me: string, home: string, now: number, result: TeamsTick): string | undefined {
  const tap = readTap(r);
  const { who, ask: id, nonce, reason } = tap;
  const choice = tap.choice as Choice;
  const s = sent[id];
  if (!s || s.nonce !== nonce) return "not a card the desk sent";
  if (!who) return "the flow didn't say who tapped: write the card's whole response to the file";
  if (who.toLowerCase() !== me.toLowerCase()) return `tapped by ${who}, not ${me}`;
  if (!CHOICES.includes(choice)) return `no such answer: ${choice}`;
  if (!waiting.some((a) => a.id === id)) return "already answered, or no longer waiting";
  try {
    answer(id, choice, choice === "deny" ? reason : undefined, home, now, { via: "teams", who });
  } catch (e) {
    return (e as Error).message;
  }
  result.answered.push({ ask: id, choice, who });
  return undefined;
}

// For the page: which waiting asks have a card on Teams.
export function sentIds(home = deskHome()): string[] {
  return Object.entries(readJson<Sent>(sentFile(home), {})).filter(([, s]) => !s.done).map(([id]) => id);
}

// `npm run desk -- teams test`: one card that asks nothing, to check the flow end to end
// before an ask depends on it. Its tap comes back to the command, not to the desk.
export async function teamsTest(home = deskHome(), opts: { now?: () => number; sleep?: (ms: number) => Promise<void>; waitMs?: number } = {}): Promise<{ ok: boolean; lines: string[] }> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const cfg = teamsOf(loadConfig(home));
  if (!cfg) return { ok: false, lines: [`Teams isn't set up: add "teams": {"folder": "<your OneDrive folder for the desk>", "me": "<your Teams sign-in>"} to ${path.join(home, "config.json")}.`] };
  const id = `${TEST}${now()}`;
  const nonce = randomBytes(12).toString("hex");
  const ask: Ask = { id, at: now(), session: "test", cwd: cfg.folder, terminal: "desk", tool: "shell", detail: JSON.stringify({ command: "echo the desk reaches you on Teams" }) };
  const out = path.join(cfg.folder, "out", `${id}.json`);
  const back = path.join(cfg.folder, "in", `${id}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.mkdirSync(path.dirname(back), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(card(ask, nonce, { title: "A test card from the desk: tap any button. Nothing runs." })));
  const lines = [`Wrote ${out}. Tap any button on the card in Teams.`];
  const until = now() + (opts.waitMs ?? 600_000);
  try {
    while (now() < until) {
      const r = readJson<Record<string, unknown> | null>(back, null);
      if (r) {
        const t = readTap(r);
        const problems = [
          t.ask !== id || t.nonce !== nonce ? "the reply doesn't carry what the button carried: write the card's whole response to the file" : "",
          !t.who ? "the reply doesn't say who tapped: write the card's whole response to the file" : t.who.toLowerCase() !== cfg.me.toLowerCase() ? `it was tapped by ${t.who}, but teams.me is ${cfg.me}: the desk would ignore it` : "",
        ].filter(Boolean);
        lines.push(`The card came back: ${t.who || "someone"} chose ${t.choice || "nothing"}.`, ...(problems.length ? problems : ["It works: asks will reach you on Teams while you're away."]));
        return { ok: !problems.length, lines };
      }
      await sleep(2000);
    }
    lines.push(`Nothing came back to ${back}. Check the flow's run history in Teams (Workflows), and that OneDrive is syncing that folder.`);
    return { ok: false, lines };
  } finally {
    fs.rmSync(out, { force: true });
    fs.rmSync(back, { force: true });
  }
}
