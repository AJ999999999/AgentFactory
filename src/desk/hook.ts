// The hook Copilot CLI runs on each session event: `node hook.ts <event>`, the event's
// JSON on stdin. A permission request may be held for the desk's page (hold.ts); a new
// session is told what earlier sessions in its repo taught (knowledge.ts) and how to
// reach the other terminals (others.ts); notes for
// this terminal are handed over after each tool call (notes.ts); everything else prints
// nothing, which Copilot reads as "go on as usual". Events are recorded, except the
// per-tool ones, which only deliver notes. It always exits 0: a command hook that fails
// denies the tool call, and a broken desk must never be what stops your session.
//
// Modules load only when the event needs them: postToolUse runs after every tool call.
import { append, HOOKED, toEvent, type DeskEventName } from "./log.ts";

const name = process.argv[2] as DeskEventName | "postToolUse";
// The desk's own analysis runs and the harness's turns are Copilot sessions too, but
// not ones you're driving: they aren't tracked, held or told anything.
if (process.env.AF_DESK_QUIET || process.env.AF_TURN) process.exit(0);
try {
  if (!HOOKED.includes(name)) throw new Error(`unknown event ${name}`);
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  const raw = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  const e = toEvent(name === "postToolUse" ? "notification" : name, raw);
  const context: string[] = [];
  if (name !== "postToolUse") append(e);
  if (name === "sessionStart") {
    const { contextFor } = await import("./knowledge.ts");
    const known = contextFor(e.cwd);
    if (known) context.push(known);
    const { reachContext } = await import("./others.ts");
    const { terminalOf } = await import("./hold.ts");
    context.push(reachContext(terminalOf(e)));
  }
  if (name === "sessionStart" || name === "postToolUse") {
    const { claim, renderNotes } = await import("./notes.ts");
    const { terminalOf } = await import("./hold.ts");
    const terminal = terminalOf(e);
    const notes = claim(terminal, e.session);
    if (notes.length) context.push(renderNotes(notes, terminal));
  }
  if (context.length) process.stdout.write(JSON.stringify({ additionalContext: context.join("\n\n") }));
  if (name === "permissionRequest") {
    const { commandOf, hold } = await import("./hold.ts");
    const r = await hold(e, {}, commandOf(raw));
    // Logged when the desk had a part in it: a standing answer, or an ask held for the page.
    if (!["pass", "desk-command", "terminal-mode", "no-desk"].includes(r.by)) append({ at: Date.now(), event: "decision", session: e.session, cwd: e.cwd, ...(e.terminal ? { terminal: e.terminal } : {}), ...(e.tool ? { tool: e.tool } : {}), by: r.by, ...(r.choice ? { choice: r.choice } : {}), ...(r.note ? { message: r.note } : {}), ...(r.waitedMs !== undefined ? { waitedMs: r.waitedMs } : {}) });
    if (Object.keys(r.output).length) process.stdout.write(JSON.stringify(r.output));
  }
} catch (e) {
  process.stderr.write(`af-desk: ${(e as Error).message}\n`);
}
process.exit(0);
