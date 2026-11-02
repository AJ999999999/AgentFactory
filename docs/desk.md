# The desk: all your Copilot CLI terminals as threads

This branch is a variant for one setup: a Windows PC where Copilot CLI is the only agent, with several PowerShell terminals open, each in a different repo, each running an interactive `copilot` session you work in by hand. The desk works the way a Claude project does: the main page lists every session as a thread, and the work happens in the thread itself, here the terminal. On top of Copilot it adds:

- **Every session as a thread.** Each is titled by what you first asked it, and grouped by what it needs from you: needs you, your turn, working, closed. A working thread says what it's doing now; each says what it changed. Its terminal sits on the right of the same page, so you switch terminals with one click instead of hunting for a tab.
- **Notes between threads.** You, or the session in one terminal, can send another session a note ("I renamed the API field you call"). It's read while that session works, marked with whose words it is, and a session can see what the others were asked to do.
- **What your sessions teach, kept.** Each finished session is read from Copilot's own session file, analysed, and what will still be true next time (how to run the tests, a rule you corrected Copilot on, a trap and its fix, how you like to work) goes into a git repo of shared memory. The next session in that repo is told it before your first prompt.
- **Asks on Teams while you're away.** Click "I'm away" and every terminal's permission asks reach your Teams chat as cards; tap Allow or Deny on your phone and Copilot goes on.

(If your company allowed Copilot's own [remote control](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-remote-control), `/remote` would answer prompts from github.com. Jack's company seat doesn't allow it.)

## Start

```powershell
cd C:\workspace\AgentFactory
npm run desk -- install      # once: a hooks file in %USERPROFILE%\.copilot\hooks; nothing goes into your repos, and no MCP server is needed
npm run desk                 # the page, on http://127.0.0.1:4710; keep this window open while you work
npm run desk -- --demo       # or first: five simulated threads, nothing real touched
```

Start each session with a name, in the repo's terminal:

```powershell
C:\workspace\AgentFactory\scripts\windows\copilot-here.ps1 -Name billing   # any copilot flags after it
```

or from the page: "New thread" starts the same thing in the folder you pick, in a terminal on the page itself (tick "In a window of its own instead" for a separate PowerShell window). You type your first prompt there. The name becomes the thread's name and the window title; without it the repo folder's name is used. Click "Notify me" once to get a system notification when a thread needs you while you're elsewhere.

## The page

**The top line** counts the threads that need you, that are your turn, and that are working.

The page has three parts. The left side is for keeping track: the list of threads on top, and under it the thread you picked. The right side is for working: one terminal, big, the one you chose to focus on.

**Top left: every thread, one line each**, grouped the way a Claude project groups its threads.
- **Needs you**, longest waiting first, with what it waits on in the row: the command it wants to run, drawn the way its PowerShell window shows it, or the question it asked.
- **Your turn** (green): it finished and waits for your next prompt, with the last thing it said.
- **Working** (grey), most recently active first: what Copilot says it's doing, and the command it's running. A terminal you just opened shows here as "Copilot is starting" until its session begins.
- **Closed today**, muted, with the files it edited.

Each row has the thread's name and branch, its title (the first sentence of your first prompt), how long it has waited or when it last moved, and a terminal button. A blue dot marks what changed since you last left the page (kept in your browser only). The tabs above the list switch to the notes between threads, and to what sessions taught, to check.

**Bottom left: the thread you picked.** Click a row's text to pick it. You see what it waits on with the answer buttons when its asks come to the desk, what it's doing now, what it did so far (prompts, files edited, commands run, failures), what its repo's sessions are told (filled dots are confirmed, hollow ones are guesses), its notes with a box to send one, where its permission asks are answered, and its standing answers with × to take one back.

**Right: one terminal.** Click a row's terminal button, or "Show its terminal" in the picked thread, to put that thread's terminal here. It stays until you choose another, so you can read one thread on the left while you work in another on the right. Until you choose, the right follows the thread you picked. Reloading the page keeps both.
- **A thread started from the page** runs in a terminal the desk holds: the same Copilot screen you'd see in Windows Terminal, and you type into it here. Close ends it, after one confirm, since Copilot stops with it. Closing the browser leaves it running. **Stopping `npm run desk` closes these terminals**, so keep the desk's window open while you work in them.
- **A thread in a terminal of your own** (started with `copilot-here.ps1` in Windows Terminal) is followed on the right from its session file: your prompts, what Copilot said, and each step with how it ended. To type into it, "Type in its tab ↗" selects its tab in Windows Terminal and brings that window forward.

**Permission asks are answered in the terminal**, where you work. The desk shows which thread is waiting and on what. For a terminal you'd rather answer from the desk (say, one you leave running in the background), open its thread and switch "Permission asks" to "here", or set `"asks": "desk"` in `%USERPROFILE%\.af\desk\config.json` for all of them; see below.

## Notes between threads

The sessions work the way threads in a Claude project do: each on its own, talking to another only when its work changes something the other depends on.

- **From you:** the box under each thread on the desk, or "Between threads" for any open one or all of them. Only the page sends notes as yours.
- **From a session**, with no MCP server (your company allows only the MCP servers it approved): when a session starts, the desk's hook tells it which other terminals are open, in which repo and on what, and the one command that reaches them, `node --no-warnings "C:\workspace\AgentFactory\src\desk\cli.ts" note <terminal|all|you> "<text>" --from billing` (and `threads` to look again). The hook lets exactly that command through without asking; one that chains, pipes, redirects or substitutes anything (`;`, `|`, `>`, `$`, parentheses) asks in the terminal like any other. A note from the command line is always from the terminal it runs in, never from you. A note to you shows on its thread and under "Between threads", with "Got it".
- If your company does approve it later, `npm run desk -- install --mcp` also gives every session the same two things as MCP tools, `list_terminals` and `send_note`.
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

**Type in its tab** finds the terminal by the title `copilot-here.ps1` gave it ("copilot: billing"). Windows Terminal shows each tab to Windows' accessibility interface (UI Automation) by its title, so the desk selects that tab, then brings its window forward. A plain PowerShell window is found by its title alone. If Copilot renames the tab while it runs, the desk can't find it; threads started on the page don't need this.
- **If the hook breaks, Copilot goes on as usual.** It always exits cleanly; at worst Copilot asks in the terminal and the session starts without what's known. The one exception is a hook whose script is gone: the hooks file points at this folder, so run `npm run desk -- uninstall` before you move or delete it.

## Asks on Teams while you're away

When you leave the PC, click **I'm away: send asks to Teams** at the top of the page (or run `npm run desk -- away on`). Until you click **I'm back**, every terminal's permission asks wait on the desk, and each goes to your Teams chat as a card: which terminal and thread, the command as it would run, its folder, and what it's doing. Tap **Allow**, **Allow … from now on**, **Deny…** (with a reason Copilot reads) or **Answer in the terminal**, and the terminal goes on as if you'd clicked on the page.

Teams can't reach your PC, and your company allows only the apps it approved, so the cards travel through a folder in your OneDrive, which syncs both ways by itself. The desk writes each card to the folder's `out`. A flow you build once in Teams' Workflows app posts it to your chat with the Workflows bot, waits for your tap, and writes the tap to `in`. The desk reads it from there. No public address, no app to register, no MCP server.

**Set up, once:**

1. In OneDrive, make a folder `af-desk`. On the PC, right-click it and choose "Always keep on this device".
2. Tell the desk where it is and who you are, in `%USERPROFILE%\.af\desk\config.json`:
   ```json
   { "teams": { "folder": "C:\\Users\\you\\OneDrive - Contoso\\af-desk", "me": "you@contoso.com" } }
   ```
   `me` is the account you sign in to Teams with; a tap from any other account is ignored.
3. In Teams, open **Workflows** (or make.powerautomate.com) and create an automated flow with four steps:
   1. **OneDrive for Business: When a file is created (properties only)**, folder `/af-desk/out`.
   2. **OneDrive for Business: Get file content**, file = the trigger's *Identifier*, *Infer content type* = No.
   3. **Microsoft Teams: Post adaptive card and wait for a response**. Post as *Flow bot*, post in *Chat with Flow bot*, recipient = your address. Message = the expression `base64ToString(body('Get_file_content')?['$content'])`. Update message = `Got it. A tap after the ask was settled changes nothing.`
   4. **OneDrive for Business: Create file**, folder `/af-desk/in`, file name = the trigger's *Name*, file content = the expression `string(body('Post_adaptive_card_and_wait_for_a_response'))`.

   In an expression, a step is named by its title with spaces as underscores; if you rename a step, use its new name. Both connectors are standard ones; your admin has to allow the Workflows app in Teams.
4. Run `npm run desk -- teams test` and tap any button on the card that arrives. It says "It works", or what to fix (most often: the last step must write the card's whole response, which carries who tapped).

**What to expect:**

- **A minute or a few each way.** OneDrive's trigger checks for new files every so often, and syncing takes a moment. At the desk, the page and the terminal are faster.
- **Away asks wait longer**: 50 minutes (`"holdSec"` under `teams`, at most 55, since Copilot stops a hook after an hour), then the terminal asks as usual. The desk has to keep running; stopping it sends every ask back to its terminal.
- **I'm back** sends the asks held only because you were away back to their terminals. A terminal you answer "here" keeps its asks on the page, and sends them to Teams too once they've waited 5 minutes (`"afterSec"`), away or not.
- **Only your tap on the card that was sent counts.** Each card carries its ask's id and a one-time code. A tap counts only when it carries both, comes from `me`, and the ask is still waiting: a tap after you answered on the page, an old card, or anyone else's changes nothing. A card for an ask settled before the flow picked it up isn't sent.
- **Questions and your next prompt still need the terminal**, as on the page.
- **What leaves the PC** is the card: terminal name, thread title, command, folder. It goes to your company's own OneDrive and Teams. The record of who answered (`report` counts Teams answers with the desk's) stays in `events.jsonl`.

## The record

Every event of every session goes to `%USERPROFILE%\.af\desk\events.jsonl`, with who settled each held ask and how long it waited. It stays on your PC.

```powershell
npm run desk -- report [--days 7]   # per repo: how often a session stopped for you, answered on the desk, settled by a standing answer, median wait
npm run desk -- tail                # the last events, to check the hook fires
npm run desk -- uninstall          # the hook (and the af-desk MCP tools, if you installed them); run it before you move or delete this folder
```

## Checked against

The Teams flow follows the [Microsoft Teams connector reference](https://learn.microsoft.com/en-us/connectors/teams/); the shape of the card's response (`responder`, `data`) isn't documented there, which is what `teams test` checks. Copilot CLI 1.0.105's [hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference). Neither the `permissionRequest` input nor the session file's format is documented in full: the hook reads `toolName`/`toolInput` and their snake_case forms, and the session reader follows the `{type, data}` lines `copilot --output-format json` prints (the same reader as the harness's turn logs). On the first day, check with `tail` that asks are recorded with their tool names, with `learn --session <id>` that a real session's digest reads well (it's kept in `knowledge\sessions\`), with a note from the desk's page that a working session mentions it after its next tool call (the `postToolUse` hook's `additionalContext`), and by asking a new session "which other terminals are open?" that it was told at its start (`sessionStart`'s `additionalContext`).

**Terminals on the page** use Windows' own pseudo-console (ConPTY, Windows 10 1809 or later), the same one Windows Terminal is built on, through `scripts\windows\conpty.ps1`. That script compiles a little C# when it starts, so nothing is installed, but it needs PowerShell's full language mode. On a PC locked to constrained mode the terminal on the page shows PowerShell's error instead; check with `$ExecutionContext.SessionState.LanguageMode` (it should say `FullLanguage`), and start threads in a window of their own if it doesn't. The page draws terminals with [xterm.js](https://xtermjs.org/), kept in `src/desk/vendor/` (MIT licence), so nothing is fetched from the internet. On Mac and Linux the desk uses python3's `pty` instead (`scripts/pty-bridge.py`).
