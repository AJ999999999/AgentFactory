# A local panel for the desk, if remote control is off

Only if Copilot's remote control can't be turned on for the company seat, and the desk's report shows enough stops to be worth it.

- **Hold, don't race.** The `permissionRequest` hook writes the ask to `~/.af/desk/asks/`, then waits (long `timeoutSec`) for an answer file. The page offers Allow, Deny with a note, and "Answer in the terminal", which releases the hook so Copilot's own prompt appears. A timeout releases it too. Never both at once: while the hook holds, the terminal has no prompt to answer.
- **Pass through what your rules allow.** The hook runs before Copilot's own rules, so holding every call would stall reads. Read-only tools pass through at once; only shell, writes and URLs are held.
- **Standing answers from the panel.** "Allow this command in this terminal from now on" kept by the desk cuts repeats. It must be the person's answer on the page, never text from the session.
- **Jump to the terminal.** `copilot-here.ps1` names the window; the panel brings it forward by that title. Windows Terminal tabs can't be focused by title from outside, so one window per repo is the reliable layout.
- **Questions and next prompts stay in the terminal.** Answering `ask_user` from outside would mean denying the tool with the answer as its reason, and sending a new prompt to an idle session means holding `agentStop` (capped at 8 in a row). Both are hacks; show them as "waiting in billing" with a jump instead.
- Reuse the panel's server guards (127.0.0.1, Host, Origin, token) from `src/panel/server.ts`.
