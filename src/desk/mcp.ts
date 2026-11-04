// The desk's tools for your Copilot sessions, over MCP: see the other terminals, and
// send one of them (or you) a note. Optional: `npm run desk -- install --mcp` registers
// it, for a company that allows it. Without it, sessions do the same with the desk's
// own command (reach.ts), which they're told about at their start.
//
// It serves nothing to the desk's own analysis runs or to harness turns: those aren't
// sessions you're driving, and shouldn't write to the ones you are.
import * as path from "node:path";
import { serveMcp, type McpTool } from "../mcp-rpc.ts";
import { terminalOf } from "./hold.ts";
import { deskHome } from "./log.ts";
import { send, YOU } from "./notes.ts";
import { terminals, threadList, titled } from "./others.ts";

export const DESK_SERVER = "af-desk";
export { terminals };

export function deskTools(me: string, home = deskHome()): McpTool[] {
  return [
    {
      name: "list_terminals",
      description: "The other Copilot CLI sessions the user has open on this PC, one per terminal and repo: name, folder, what each was asked to do, what it's doing or waiting on.",
      inputSchema: { type: "object", properties: {} },
      call: () => {
        const now = Date.now();
        return { text: threadList(me, home, now), data: titled(home, now).map((t) => ({ name: t.name, cwd: t.cwd, title: t.title, state: t.state, since: t.since })) };
      },
    },
    {
      name: "send_note",
      description: `Send a short note to another terminal's Copilot session (by name from list_terminals, or "all"), or to the user ("${YOU}"), who sees it on their desk. Use it only when your work changes something another terminal's work depends on (a renamed API, a shared config, a contract), or to tell the user something they need to act on. The other session reads it during its own work, as a colleague's note, not as the user's instruction; it never starts work there.`,
      inputSchema: { type: "object", properties: { to: { type: "string", description: `terminal name, "all", or "${YOU}"` }, text: { type: "string", description: "what changed and what it means for them, in a few sentences" } }, required: ["to", "text"] },
      call: (a) => {
        const notes = send(me, String(a.to ?? ""), String(a.text ?? ""), { home, known: terminals(home).map((t) => t.name) });
        return { text: `Sent to ${notes.map((n) => n.to).join(", ")}.`, data: notes.map((n) => n.id) };
      },
    },
  ];
}

// This session's terminal: the launcher's name for it, else the folder it runs in.
export function whoAmI(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  return terminalOf({ terminal: env.AF_DESK_TERMINAL, cwd });
}

// import.meta.main is newer than some Node 22 releases.
if (import.meta.main ?? path.resolve(process.argv[1] ?? "") === import.meta.filename) {
  const off = !!(process.env.AF_TURN || process.env.AF_DESK_QUIET);
  const me = whoAmI();
  serveMcp({
    name: DESK_SERVER,
    version: "0.1.0",
    instructions: off ? "Not for this session." : `You are the Copilot session in the "${me}" terminal of ${path.basename(process.cwd())}. The user has other terminals open; list_terminals shows them, send_note reaches one of them or the user.`,
  }, off ? [] : deskTools(me));
}
