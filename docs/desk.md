# The desk: all your Copilot CLI terminals as threads

This branch is a variant for one setup: a Windows PC where Copilot CLI is the only agent, with several PowerShell terminals open, each in a different repo, each running an interactive `copilot` session you work in by hand. The desk works the way a Claude project does: the main page lists every session as a thread, and the work happens in the thread itself, here the terminal. On top of Copilot it adds:

- **Every session as a thread.** Each is titled by what you first asked it, and grouped by what it needs from you: needs you, your turn, working, closed. A working thread says what it's doing now; each says what it changed. One click takes you to its terminal.
- **Notes between threads.** You, or the session in one terminal, can send another session a note ("I renamed the API field you call"). It's read while that session works, marked with whose words it is, and a session can see what the others were asked to do.
- **What your sessions teach, kept.** Each finished session is read from Copilot's own session file, analysed, and what will still be true next time (how to run the tests, a rule you corrected Copilot on, a trap and its fix, how you like to work) goes into a git repo of shared memory. The next session in that repo is told it before your first prompt.

(If your company allowed Copilot's own [remote control](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-remote-control), `/remote` would answer prompts from github.com. Jack's company seat doesn't allow it.)

## Start

```powershell
cd C:\workspace\AgentFactory
npm run desk -- install      # once: a hooks file in %USERPROFILE%\.copilot\hooks and the af-desk tools in mcp-config.json; nothing goes into your repos
npm run desk                 # the page, on http://127.0.0.1:4710; keep this window open while you work
npm run desk -- --demo       # or first: five simulated threads, nothing real touched
```

Start each session with a name, in the repo's terminal:

```powershell
C:\workspace\AgentFactory\scripts\windows\copilot-here.ps1 -Name billing   # any copilot flags after it
```

or from the page: "New thread" opens a PowerShell window in the folder you pick, running the same thing; you type your first prompt there. The name becomes the window title and the thread's name; without it the repo folder's name is used. Click "Notify me" once to get a system notification when a thread needs you while you're elsewhere.

## The page

**The top line** counts the threads that need you, that are your turn, and that are working.

**Left: the threads**, grouped the way a Claude project groups its threads.
- **Needs you**, longest waiting first, each open so you see what it waits on without a click: the command it wants to run, drawn the way its PowerShell window shows it, or the question it asked (blue edge). "Go to billing ↗" brings its terminal forward; answer there. When nothing needs you, it says so.
- **Your turn** (green): it finished and waits for your next prompt, with the last thing it said.
- **Working** (grey), most recently active first: what it's doing now (what Copilot says it's doing, and the command it's running).
- **Closed today**, muted, with the files it edited.

Each row is one line: the thread's name and branch, its title (the first sentence of your first prompt), how long it has waited or when it last moved, and ↗ to go to its terminal. A blue dot marks what changed since you last left the page (kept in your browser only). Click a row for the rest: where its permission asks are answered, what it did so far (prompts, files edited, commands run, failures), the end of its session as it happens, what its repo's sessions are told (filled dots are confirmed, hollow ones are guesses), its notes, and its standing answers with × to take one back.

**Right:** the notes between threads, with a box to send one to any thread or all of them, and "Got it" for one sent to you; what sessions taught, to check (Right, Right in your own words, or Wrong); what learning is doing.

**Permission asks are answered in the terminal**, where you work. The desk shows which thread is waiting and on what. For a terminal you'd rather answer from the desk (say, one you leave running in the background), open its thread and switch "Permission asks" to "here", or set `"asks": "desk"` in `%USERPROFILE%\.af\desk\config.json` for all of them; see below.

## Notes between threads

The sessions work the way threads in a Claude project do: each on its own, talking to another only when its work changes something the other depends on.

- **From you:** the box under each terminal on the desk, "All terminals" for every open one, or `npm run desk -- note billing "use the finance schema"`.
- **From a session:** every session has the desk's MCP tools, `list_terminals` (who's open, in which repo, what each was asked to do, what it's doing) and `send_note` (to a terminal by name, to `all`, or to `you`). A note to you shows on its thread and under "Between threads", with "Got it".
- **Delivered while it works.** Copilot runs the desk's `postToolUse` hook after every tool call; the hook hands over the terminal's waiting notes as added context, once. A session that starts gets the notes that waited for it. The desk shows each note as waiting until then.
- **A note never starts work.** An idle session reads its notes only after you give it your next prompt, so two sessions can't keep each other busy by writing back and forth: nothing runs unless you set it going.
- **Whose words it is.** A note from you is marked as yours. A note from another terminal is marked as another agent's, to be weighed as a colleague's request against what you asked, the same rule Claude projects use between threads.
- Harness turns and the desk's own analysis runs get no notes and no tools.

## Learning from sessions

Copilot keeps every session in `%USERPROFILE%\.copilot\session-state\<session>\events.jsonl`. When a session ends, the desk:

1. **Reads it into a digest**: your prompts in full (they carry the corrections), what Copilot ran, what failed and what fixed it, what you refused on the desk and why. Copilot's long answers and tool output are cut; a long session loses its middle, never your prompts.
2. **Asks Copilot what will still hold** in a headless `copilot -p` run that can only read the digest: no shell, no writes, no MCP servers, no custom instructions, and outside the desk's own hook. It's told what's already known and what you marked wrong, so it proposes changes rather than repeats. One session at a time, each once.
3. **Keeps the answers as guesses.** Each is typed the way AgentFactory keeps memory about people (`src/memory/`): a fact, a constraint or a preference, about one repo (`repo.billing`) or about you (`you`), with the line that shows it. An agent can only record a guess ("inferred"); it becomes how things are when you confirm it, as stated by you. Wrong retracts it, and it won't be proposed again. Anything that looks like a token, key or password is dropped.
4. **Commits it** to the knowledge repo, with the digest and the analysis next to it.

**The next session in that repo** is told, through Copilot's `sessionStart` hook, what you confirmed ("How I work" and what's known about the repo) and what's still a guess ("ask me before relying on these"). `npm run desk -- knows <folder>` prints exactly what a session there would be told.

**The knowledge repo** is `%USERPROFILE%\.af\desk\knowledge` by default, a plain git repo: one file per event, never edited. Point `knowledgeDir` in `%USERPROFILE%\.af\desk\config.json` at a clone of your team's private repo and the desk pushes every change to it, so a teammate's desk learns from yours. It holds your company's paths, commands and code: **it must never be this repo**.

```powershell
npm run desk -- learn                    # learn from every ended session now
npm run desk -- learn --session <id>     # one session, again if it was already read
npm run desk -- knows C:\work\billing    # what a new session there is told
```

`config.json` takes `"learn": "off"` to stop analysing, `"model"` for the analysis's Copilot model, and `"timeoutSec"` (600).

## Asks answered on the desk

For a terminal whose asks are answered "here", Copilot CLI runs a `permissionRequest` hook before it would ask you, and takes what the hook prints as the answer. The desk's hook writes the ask under `%USERPROFILE%\.af\desk\asks\` and waits for your answer from the page.

- **One place at a time.** While an ask waits on the page, the terminal shows no prompt for it. That's why there's "answer in the terminal", and why nothing is held when the desk isn't running: stop `npm run desk` and every terminal asks for itself again within seconds. An ask nobody answers goes to the terminal after 20 minutes (`holdSec`).
- **Reads aren't held.** The hook runs before Copilot's own rules, so read-only tools (`view`, `grep`, `glob` and the like; `passThrough` in the config) go straight to them. Everything else is held, including tools your own Copilot settings would have allowed; answer those once with "from now on".
- **Questions and new prompts stay in the terminal.** Copilot's hooks can't answer its multiple-choice questions or type your next instruction into a waiting session. The page shows them and takes you to the window.

**Go to** finds a terminal's window by the title `copilot-here.ps1` gave it ("copilot: billing"), so keep one window per repo: Windows can't bring a particular Windows Terminal tab forward from outside.
- **If the hook breaks, Copilot goes on as usual.** It always exits cleanly; at worst Copilot asks in the terminal and the session starts without what's known.

## The record

Every event of every session goes to `%USERPROFILE%\.af\desk\events.jsonl`, with who settled each held ask and how long it waited. It stays on your PC.

```powershell
npm run desk -- report [--days 7]   # per repo: how often a session stopped for you, answered on the desk, settled by a standing answer, median wait
npm run desk -- tail                # the last events, to check the hook fires
npm run desk -- uninstall          # the hook and the af-desk tools
```

## Checked against

Copilot CLI 1.0.105's [hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference). Neither the `permissionRequest` input nor the session file's format is documented in full: the hook reads `toolName`/`toolInput` and their snake_case forms, and the session reader follows the `{type, data}` lines `copilot --output-format json` prints (the same reader as the harness's turn logs). On the first day, check with `tail` that asks are recorded with their tool names, with `learn --session <id>` that a real session's digest reads well (it's kept in `knowledge\sessions\`), and with `npm run desk -- note <terminal> "say hi"` that a working session mentions the note after its next tool call (the `postToolUse` hook's `additionalContext`) and that `/mcp` in a session lists `af-desk`.
