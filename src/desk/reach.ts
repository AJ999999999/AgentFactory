// How a Copilot session reaches the other threads without an MCP server: a company
// that allows only approved MCP servers still runs hooks and shell commands. The
// session is told at its start to run the desk's own command, and the desk's hook
// lets exactly that command through without asking, never with anything chained on.
//
// No imports beyond `path`: the hook loads this on every permission request.
import * as path from "node:path";

export const DESK_CLI = path.join(import.meta.dirname, "cli.ts");
const HEAD = `node --no-warnings "${DESK_CLI}" `;
export const deskCommand = (...args: string[]): string => HEAD + args.join(" ");

// Nothing a shell would expand, chain, redirect or run: no `$`, backtick, `;`, `&`, `|`,
// `<`, `>`, parentheses or braces (PowerShell runs `(...)` in an argument), no new line.
const PLAIN = /^[^$`;&|<>(){}\r\n]*$/;

export function isDeskCommand(command: string | undefined): boolean {
  const c = command?.trim();
  if (!c || !c.startsWith(HEAD)) return false;
  const rest = c.slice(HEAD.length);
  return /^(note|threads)(\s|$)/.test(rest) && PLAIN.test(rest);
}

// Who a note from the command line is from: the terminal it runs in. Never you: a note
// marked as yours is read as your instruction, so yours come only from the desk's page.
export function senderOf(env: NodeJS.ProcessEnv, from: string | undefined): string {
  const me = env.AF_DESK_TERMINAL?.trim() || from?.trim();
  if (!me) throw new Error("say which terminal this is with --from <name>. To send a note yourself, use the box on the desk's page.");
  if (me === "you" || me === "all") throw new Error(`--from is this terminal's name, not "${me}"`);
  return me;
}
