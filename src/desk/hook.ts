// The hook Copilot CLI runs on each session event: `node hook.ts <event>`, the event's
// JSON on stdin. It records the event and prints nothing, which Copilot reads as "go on
// as usual". It always exits 0: a hook that fails can deny a tool call, and recording
// must never change what the session does.
import { append, EVENTS, toEvent, type DeskEventName } from "./log.ts";

const name = process.argv[2] as DeskEventName;
try {
  if (!EVENTS.includes(name)) throw new Error(`unknown event ${name}`);
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  const raw = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  append(toEvent(name, raw));
} catch (e) {
  process.stderr.write(`af-desk: ${(e as Error).message}\n`);
}
process.exit(0);
