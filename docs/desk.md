# The desk: one page for all your Copilot CLI terminals

This branch is a variant for one setup: a Windows PC where Copilot CLI is the only agent, with several PowerShell terminals open, each in a different repo, each running an interactive `copilot` session you drive by hand. The desk adds two things on top of Copilot:

- **One page for everything waiting on you.** It looks and works like the partner's panel: the permission asks from every terminal, Copilot's questions, sessions waiting for your next prompt, each terminal's live session, and a button to jump to its window. Every terminal stays yours to type in.
- **What your sessions teach, kept.** Each finished session is read from Copilot's own session file, analysed, and what will still be true next time (how to run the tests, a rule you corrected Copilot on, a trap and its fix, how you like to work) goes into a git repo of shared memory. The next session in that repo is told it before your first prompt.

(If your company allowed Copilot's own [remote control](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-remote-control), `/remote` would answer prompts from github.com. Jack's company seat doesn't allow it.)

## Start

```powershell
cd C:\workspace\AgentFactory
npm run desk -- install      # once: one file in %USERPROFILE%\.copilot\hooks; nothing goes into your repos
npm run desk                 # the page, on http://127.0.0.1:4710; keep this window open while you work
npm run desk -- --demo       # or first: three simulated terminals, nothing real touched
```

In each terminal, start Copilot with a name:

```powershell
C:\workspace\AgentFactory\scripts\windows\copilot-here.ps1 -Name billing   # any copilot flags after it
```

The name becomes the window title and the terminal's name on the page; without it the repo folder's name is used. Click "Notify me" once to get a system notification when a terminal asks while you're elsewhere.

## The page

**Left: what's waiting on you**, most blocking first.
- **A permission ask** (amber; red after five minutes): the command or tool, with Allow, Deny with a reason Copilot reads and works around, "Allow `npm run …` in billing from now on", and "Answer in the terminal". A standing answer for a command covers the same program and first word only, and is never offered for a line that chains, pipes, redirects or substitutes (`;`, `&`, `|`, `>`, `` ` ``, `$(`), so `npm run build; rm -rf ~` always asks.
- **A question from Copilot** (blue) and **an ask open in the terminal itself**: what it asked, and a button to go there.
- **Something learned, to check** (purple): what a session taught, why the analysis thinks so, and Right, Right in your own words, or Wrong (with what's wrong, optional).
- **Your turn** (green): a session finished and waits for your next prompt.

**Right: each terminal**, like an engagement on the panel: its state, the end of its session as it happens (read from Copilot's session file), where its asks are answered (here or in the terminal), Go to terminal, what's known about its repo (filled dots are confirmed, hollow ones are guesses), and its standing answers with × to take one back. At the bottom, what learning is doing and the last analyses.

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

## How the asks work, and their limits

Copilot CLI runs a `permissionRequest` hook before it would ask you, and takes what the hook prints as the answer. The desk's hook writes the ask under `%USERPROFILE%\.af\desk\asks\` and waits for your answer from the page.

- **One place at a time.** While an ask waits on the page, the terminal shows no prompt for it. That's why there's "answer in the terminal", and why nothing is held when the desk isn't running: stop `npm run desk` and every terminal asks for itself again within seconds. An ask nobody answers goes to the terminal after 20 minutes (`holdSec`).
- **Reads aren't held.** The hook runs before Copilot's own rules, so read-only tools (`view`, `grep`, `glob` and the like; `passThrough` in the config) go straight to them. Everything else is held, including tools your own Copilot settings would have allowed; answer those once with "from now on".
- **Questions and new prompts stay in the terminal.** Copilot's hooks can't answer its multiple-choice questions or type your next instruction into a waiting session without tricks that change what Copilot sees. The page shows them and takes you to the window. Go to terminal finds the window by the title `copilot-here.ps1` gave it, so keep one window per repo: Windows can't bring a particular Windows Terminal tab forward from outside.
- **If the hook breaks, Copilot goes on as usual.** It always exits cleanly; at worst Copilot asks in the terminal and the session starts without what's known.

## The record

Every event of every session goes to `%USERPROFILE%\.af\desk\events.jsonl`, with who settled each held ask and how long it waited. It stays on your PC.

```powershell
npm run desk -- report [--days 7]   # per repo: how often a session stopped for you, answered on the desk, settled by a standing answer, median wait
npm run desk -- tail                # the last events, to check the hook fires
npm run desk -- uninstall
```

## Checked against

Copilot CLI 1.0.105's [hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference). Neither the `permissionRequest` input nor the session file's format is documented in full: the hook reads `toolName`/`toolInput` and their snake_case forms, and the session reader follows the `{type, data}` lines `copilot --output-format json` prints (the same reader as the harness's turn logs). On the first day, check with `tail` that asks are recorded with their tool names, and with `learn --session <id>` that a real session's digest reads well (it's kept in `knowledge\sessions\`).
