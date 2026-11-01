// The desk's tools for your Copilot sessions, over MCP: see the other terminals, and
// send one of them (or you) a note. Registered once in your Copilot config by
// `npm run desk -- install`, so every interactive session has them.
//
// It serves nothing to the desk's own analysis runs or to harness turns: those aren't
// sessions you're driving, and shouldn't write to the ones you are.
import * as path from "node:path";
import { serveMcp, type McpTool } from "../mcp-rpc.ts";
import { readDriven } from "./driven.ts";
import { pending, terminalOf } from "./hold.ts";
import { deskHome, readLog } from "./log.ts";
import { send, YOU } from "./notes.ts";
import { deskView } from "./view.ts";

export const DESK_SERVER = "af-desk";

export type OpenTerminal = { name: string; cwd: string; state: string; since: number; said?: string };

// Every open session: the ones you type into (seen through hooks) and the ones the desk
// drives. A driven session's own hook rows, if any, are the same session.
export function terminals(home = deskHome(), now = Date.now()): OpenTerminal[] {
  const driven = readDriven(home).filter((d) => d.state !== "closed");
  const mine = new Set(driven.filter((d) => d.state !== "in its own screen").map((d) => d.session));
  const names = new Set(driven.map((d) => d.name));
  const hooked = deskView(readLog(home), pending(home), [], {}, now).filter((t) => t.state !== "closed" && !mine.has(t.session) && !names.has(t.name));
  return [
    ...hooked.map((t) => ({ name: t.name, cwd: t.cwd, state: t.state, since: t.since, ...(t.said ? { said: t.said } : {}) })),
    ...driven.map((d) => {
      const said = [...d.items].reverse().find((i) => i.type === "agent")?.text;
      return { name: d.name, cwd: d.cwd, state: d.state === "idle" || d.state === "done" ? "waiting for your next prompt" : d.state, since: d.since, ...(said ? { said: said.slice(-300) } : {}) };
    }),
  ];
}

export function deskTools(me: string, home = deskHome()): McpTool[] {
  return [
    {
      name: "list_terminals",
      description: "The other Copilot CLI sessions the user has open on this PC, one per terminal and repo: name, folder, what each is doing or waiting on.",
      inputSchema: { type: "object", properties: {} },
      call: () => {
        const ts = terminals(home);
        const now = Date.now();
        return {
          text: ts.length
            ? ts.map((t) => `- ${t.name}${t.name === me ? " (this terminal)" : ""}: ${t.cwd}; ${t.state} for ${Math.round((now - t.since) / 60_000)}m${t.said ? `; last said: ${t.said.slice(0, 160)}` : ""}`).join("\n")
            : "No terminal is open.",
          data: ts.map((t) => ({ name: t.name, cwd: t.cwd, state: t.state, since: t.since })),
        };
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
