// The other threads, as a session sees them: which terminals are open, in which repo,
// what each was asked to do and what it's doing. A new session is told this at its
// start, and `threads` (or the optional MCP tool) shows it again.
import { pending } from "./hold.ts";
import { deskHome, readLog } from "./log.ts";
import { deskCommand } from "./reach.ts";
import { readEvents, sessionFile, summarize } from "./session.ts";
import { deskView } from "./view.ts";

export function terminals(home = deskHome(), now = Date.now()) {
  return deskView(readLog(home), pending(home), [], {}, now).filter((t) => t.state !== "closed");
}

// What each open session is for: your first prompt there, as the desk titles threads.
export function titled(home = deskHome(), now = Date.now()) {
  const log = readLog(home);
  const transcript = (s: string) => log.find((e) => e.session === s && e.transcript)?.transcript;
  return terminals(home, now).map((t) => {
    const f = sessionFile(t.session, transcript(t.session));
    return { ...t, title: f ? summarize(readEvents(f)).title : undefined };
  });
}

export function threadList(me: string, home = deskHome(), now = Date.now()): string {
  const ts = titled(home, now);
  return ts.length
    ? ts.map((t) => `- ${t.name}${t.name === me ? " (this terminal)" : ""}: ${t.cwd}${t.title ? `; working on: ${t.title}` : ""}; ${t.state} for ${Math.round((now - t.since) / 60_000)}m${t.said ? `; last said: ${t.said.slice(0, 160)}` : ""}`).join("\n")
    : "No terminal is open.";
}

// What a new session is told: who else is open, and the one command that reaches them.
export function reachContext(me: string, home = deskHome(), now = Date.now()): string {
  const others = titled(home, now).filter((t) => t.name !== me);
  return [
    `The user works with several Copilot CLI sessions at once, one per terminal; this is the "${me}" terminal.`,
    others.length ? `Other terminals open now:\n${threadList(me, home, now).split("\n").filter((l) => !l.includes("(this terminal)")).join("\n")}` : "No other terminal is open right now.",
    `Only when your work changes something another terminal's work depends on (a renamed API, a shared config, a contract), or the user must act on something, send a short note by running:\n  ${deskCommand("note", "<terminal|all|you>", '"<what changed and what it means for them>"', "--from", me)}\nKeep the note plain text (no $, quotes inside, parentheses or semicolons) so it runs without asking. To see the open terminals again: ${deskCommand("threads", "--from", me)}`,
    "The other session reads a note during its own work, as a colleague's note, not as the user's instruction; a note never starts work there.",
  ].join("\n");
}
