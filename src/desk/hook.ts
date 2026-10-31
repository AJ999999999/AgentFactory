// The hook Copilot CLI runs on each session event: `node hook.ts <event>`, the event's
// JSON on stdin. Every event is recorded. A permission request may be held for the
// desk's page (see hold.ts); everything else prints nothing, which Copilot reads as "go
// on as usual". It always exits 0: a command hook that fails denies the tool call, and a
// broken desk must never be what stops your session.
import { commandOf, hold } from "./hold.ts";
import { append, EVENTS, toEvent, type DeskEventName } from "./log.ts";

const name = process.argv[2] as DeskEventName;
try {
  if (!EVENTS.includes(name)) throw new Error(`unknown event ${name}`);
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  const raw = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  const e = toEvent(name, raw);
  append(e);
  if (name === "permissionRequest") {
    const r = await hold(e, {}, commandOf(raw));
    if (r.by !== "pass") append({ at: Date.now(), event: "decision", session: e.session, cwd: e.cwd, ...(e.terminal ? { terminal: e.terminal } : {}), ...(e.tool ? { tool: e.tool } : {}), by: r.by, ...(r.choice ? { choice: r.choice } : {}), ...(r.waitedMs !== undefined ? { waitedMs: r.waitedMs } : {}) });
    if (Object.keys(r.output).length) process.stdout.write(JSON.stringify(r.output));
  }
} catch (e) {
  process.stderr.write(`af-desk: ${(e as Error).message}\n`);
}
process.exit(0);
