# The desk: one page for all your Copilot CLI terminals

This branch is a variant for one setup: a Windows PC where Copilot CLI is the only agent, with several PowerShell terminals open, each in a different repo. The desk adds four things on top of Copilot:

- **It runs Copilot for you.** A session the desk starts is driven entirely from the desk or from its PowerShell window: your prompts (queued while a turn runs), Stop, every permission Copilot asks with Copilot's own options, its mode and model, and closing it. Like Herdr (a terminal workspace for coding agents), the desk owns the session, so a window can come and go without stopping it. Copilot's own screen is one command away (`/tui`).
- **One page for everything waiting on you.** It looks and works like the partner's panel: every session's asks, the questions it ended on, sessions waiting for your next prompt, each session's conversation as it happens. Sessions you'd rather type into Copilot's own screen are on it too, seen through Copilot's hooks.
- **Notes between sessions.** You, or one session, can send another a note ("I renamed the API field you call"). It's read while that session works, marked with whose words it is.
- **What your sessions teach, kept.** Each finished session is read from Copilot's own session file, analysed, and what will still be true next time (how to run the tests, a rule you corrected Copilot on, a trap and its fix, how you like to work) goes into a git repo of shared memory. The next session in that repo is told it before your first prompt.

(If your company allowed Copilot's own [remote control](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-remote-control), `/remote` would answer prompts from github.com. Jack's company seat doesn't allow it.)

## Start

```powershell
cd C:\workspace\AgentFactory
npm run desk -- install      # once: a hooks file in %USERPROFILE%\.copilot\hooks and the af-desk tools in mcp-config.json; nothing goes into your repos
npm run desk                 # the page, on http://127.0.0.1:4710; keep this window open while you work
npm run desk -- --demo       # or first: simulated sessions, nothing real touched
```

In each repo's terminal:

```powershell
C:\workspace\AgentFactory\scripts\windows\copilot-here.ps1 -Name billing           # a session the desk drives, typed into here
C:\workspace\AgentFactory\scripts\windows\copilot-here.ps1 -Name billing -Native   # Copilot's own screen, seen through its hooks
```

The name becomes the window title and the session's name on the page; without it the repo folder's name is used. You can also start a session from the page ("Start a Copilot session": a folder, a name, a first prompt) and open a window on it later. Click "Notify me" once to get a system notification when a session asks while you're elsewhere.

## The page

**Left: what's waiting on you**, most blocking first.
- **A permission ask** (amber; red after five minutes): the command or tool, and the answers. For a session the desk drives they're Copilot's own ("Allow once", "Always allow", "Reject"), plus "Allow `npm run …` in billing from now on" and "Deny and tell it": Copilot's turn stops and your reason goes as your next prompt, the way Copilot's own screen takes feedback on a rejection. For a session in Copilot's own screen they're Allow, Deny with a reason, from now on, and "Answer in the terminal". A standing answer for a command covers the same program and first word only, and is never offered for a line that chains, pipes, redirects or substitutes (`;`, `&`, `|`, `>`, `` ` ``, `$(`), so `npm run build; rm -rf ~` always asks.
- **A question** (blue): when a driven session ends its turn on a question with numbered options, each option is a button, with a box to answer in your own words. For a session in Copilot's own screen, what it asked and a button to go there.
- **A note to you** (green), with "Got it" and Go to that session.
- **A finished turn** (green): what the session said and a box for your next prompt. It shows once, until you've seen it: send a prompt or click "Seen".
- **Something learned, to check** (purple): what a session taught, why the analysis thinks so, and Right, Right in your own words, or Wrong (with what's wrong, optional).

**Right: each session**, like an engagement on the panel. At the top, "Start a Copilot session". A driven session shows its state, its mode and model (change them there), Stop while it works, Open a window (or Go to its window when one is attached), Close (twice, to be sure), the conversation as it happens, and a prompt box: Enter sends, Shift+Enter is a new line, and a prompt sent while it works waits for the turn to end. A session in Copilot's own screen shows the end of its session file, where its asks are answered (here or in its terminal) and Go to terminal. Both show what's known about the repo (filled dots are confirmed, hollow ones are guesses), notes, and standing answers with × to take one back. At the bottom, what learning is doing and the last analyses.

## Sessions the desk drives

The desk starts Copilot as `copilot --acp --stdio`: the [Agent Client Protocol](https://docs.github.com/en/copilot/reference/acp-server), Copilot's own interface for programs that drive it. Every prompt, every streamed answer, every tool call and every permission ask goes through the desk, so whatever you'd do in Copilot's screen you can do from the page or the window.

**The window** (`copilot-here.ps1`, or `npm run desk -- attach <name>`) starts the session in its folder if there's none by that name, and attaches to it if there is. It shows the conversation and takes:

| You type | It does |
|---|---|
| a prompt | sends it (waits in line while a turn runs) |
| `1`, `2`, `3` … | picks that option of the open ask, or of the numbered list Copilot ended on |
| `a` | allows the open ask's command in this session from now on |
| `d <why>` | denies it and tells Copilot why |
| `/stop` | stops the turn |
| `/mode`, `/model` | shows them, or `/model <id>` changes it; `/set <setting> <value>` for any other |
| `/tui` | hands the session to Copilot's own screen in this window; quit it and the window takes the session back |
| `/close` | ends the session (learning reads it) |
| `/quit`, Ctrl+C | leaves; the session goes on, on the desk |

Any other `/command` Copilot offers over ACP (such as `/compact`) is passed to it.

**What it borrows from Herdr.** The desk owns the session and windows attach to it, so closing a window stops nothing and two windows can follow one session. A session is in one of a few states, said in plain words: starting, working, waiting on you, finished (and not yet seen), waiting for your prompt, asleep, failed, in Copilot's own screen, closed. "Finished" means finished and unseen, so a session asks for your look once, not forever.

**It outlives the desk.** Copilot saves every session. When the desk stops, each Copilot it runs stops with it, and the session is asleep; the next prompt starts Copilot again and reloads the session (ACP's `session/load`), without showing its history twice. A turn that won't stop within ten seconds of Stop is ended the same way. If Copilot exits on its own, the session shows why, and the next prompt tries again.

**What a driven session is told.** Its first prompt carries what's known about the repo and about you, marked as coming from your desk and not as part of your request; every prompt carries the notes that waited for it, and notes arriving mid-turn come through the same `postToolUse` hook as for any session. The hook otherwise steps aside for driven sessions: the desk itself records them and answers their asks.

**Limits** (ACP in Copilot is a public preview):
- **No question tool over ACP.** In Copilot 1.0.105 the model has no `ask_user` tool in ACP mode ([copilot-cli#2109](https://github.com/github/copilot-cli/issues/2109)); it ends its turn with the options as a numbered list instead, which the desk turns into buttons. The desk also answers ACP forms (`elicitation/create`), in case Copilot starts sending them.
- **Screen-only commands** (`/diff`, `/undo`, `/resume`, `/login`, `/theme`, …) don't run over ACP. Use `/tui` for those; the window takes the session back when you quit Copilot.
- **Tool and reasoning flags are fixed when Copilot starts.** Put them in `acpArgs` in `%USERPROFILE%\.af\desk\config.json`, e.g. `["--acp", "--stdio", "--effort=high"]`; `copilot` there points at another Copilot.
- **Opening a window from the page** uses PowerShell's `Start-Process`, which opens your default console. Go to its window finds it by the title `copilot: <name>`.

## Notes between sessions

The sessions work the way threads in a Claude project do: each on its own, talking to another only when its work changes something the other depends on.

- **From you:** the box under each terminal on the desk, "All terminals" for every open one, or `npm run desk -- note billing "use the finance schema"`.
- **From a session:** every session has the desk's MCP tools, `list_terminals` (who's open, in which repo, doing what) and `send_note` (to a terminal by name, to `all`, or to `you`). A note to you shows on the left of the desk with "Got it" and "Go to" that terminal.
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

**The next session in that repo** is told, through Copilot's `sessionStart` hook (a driven session: with its first prompt), what you confirmed ("How I work" and what's known about the repo) and what's still a guess ("ask me before relying on these"). `npm run desk -- knows <folder>` prints exactly what a session there would be told.

**The knowledge repo** is `%USERPROFILE%\.af\desk\knowledge` by default, a plain git repo: one file per event, never edited. Point `knowledgeDir` in `%USERPROFILE%\.af\desk\config.json` at a clone of your team's private repo and the desk pushes every change to it, so a teammate's desk learns from yours. It holds your company's paths, commands and code: **it must never be this repo**.

```powershell
npm run desk -- learn                    # learn from every ended session now
npm run desk -- learn --session <id>     # one session, again if it was already read
npm run desk -- knows C:\work\billing    # what a new session there is told
```

`config.json` takes `"learn": "off"` to stop analysing, `"model"` for the analysis's Copilot model, and `"timeoutSec"` (600).

## Sessions in Copilot's own screen: how their asks work

For a session you type into Copilot's own screen (`-Native`), the desk only sees it through Copilot's hooks. Copilot CLI runs a `permissionRequest` hook before it would ask you, and takes what the hook prints as the answer. The desk's hook writes the ask under `%USERPROFILE%\.af\desk\asks\` and waits for your answer from the page.

- **One place at a time.** While an ask waits on the page, the terminal shows no prompt for it. That's why there's "answer in the terminal", and why nothing is held when the desk isn't running: stop `npm run desk` and every terminal asks for itself again within seconds. An ask nobody answers goes to the terminal after 20 minutes (`holdSec`).
- **Reads aren't held.** The hook runs before Copilot's own rules, so read-only tools (`view`, `grep`, `glob` and the like; `passThrough` in the config) go straight to them. Everything else is held, including tools your own Copilot settings would have allowed; answer those once with "from now on".
- **Questions and new prompts stay in the terminal.** Copilot's hooks can't answer its multiple-choice questions or type your next instruction into a waiting session. The page shows them and takes you to the window. That's what driven sessions are for. Go to terminal finds the window by the title `copilot-here.ps1` gave it, so keep one window per repo: Windows can't bring a particular Windows Terminal tab forward from outside.
- **If the hook breaks, Copilot goes on as usual.** It always exits cleanly; at worst Copilot asks in the terminal and the session starts without what's known.

## The record

Every event of every session goes to `%USERPROFILE%\.af\desk\events.jsonl`, with who settled each held ask and how long it waited. It stays on your PC.

```powershell
npm run desk -- report [--days 7]   # per repo: how often a session stopped for you, answered on the desk, settled by a standing answer, median wait
npm run desk -- tail                # the last events, to check the hook fires
npm run desk -- uninstall          # the hook and the af-desk tools
```

## Checked against

Copilot CLI 1.0.105's [hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference) and [ACP server reference](https://docs.github.com/en/copilot/reference/acp-server), and the [ACP protocol](https://agentclientprotocol.com) (session config options, elicitation). The desk's tests drive a stand-in that speaks ACP (`src/desk/demo-copilot.mjs`), not Copilot itself. On the first day, start one session with `copilot-here.ps1` and check that it starts (if Copilot needs a sign-in, run `copilot` once in a terminal), that a command's permission ask reaches the window and the page with Copilot's options, that Stop stops it, that `/model` lists models, and that `/tui` opens Copilot's own screen on the same session and quitting it gives the session back.

For sessions in Copilot's own screen: neither the `permissionRequest` input nor the session file's format is documented in full: the hook reads `toolName`/`toolInput` and their snake_case forms, and the session reader follows the `{type, data}` lines `copilot --output-format json` prints (the same reader as the harness's turn logs). On the first day, check with `tail` that asks are recorded with their tool names, with `learn --session <id>` that a real session's digest reads well (it's kept in `knowledge\sessions\`), and with `npm run desk -- note <terminal> "say hi"` that a working session mentions the note after its next tool call (the `postToolUse` hook's `additionalContext`) and that `/mcp` in a session lists `af-desk`.
