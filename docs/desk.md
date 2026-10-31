# The desk: one page for all your Copilot CLI terminals

This branch is a variant for one setup: a Windows PC where Copilot CLI is the only agent, with several PowerShell terminals open, each in a different repo, each running an interactive `copilot` session you drive by hand. The desk is one page where the permission asks from all of them wait for you, next to each terminal's state, while every terminal stays yours to type in.

(If your company allows Copilot's own [remote control](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-remote-control), `/remote` answers prompts from github.com without any of this. Jack's company seat doesn't allow it.)

## Start

```powershell
cd C:\workspace\AgentFactory
npm run desk -- install      # once: one file in %USERPROFILE%\.copilot\hooks; nothing goes into your repos
npm run desk                 # the page, on http://127.0.0.1:4710; keep this window open while you work
```

In each terminal, start Copilot with a name:

```powershell
C:\workspace\AgentFactory\scripts\windows\copilot-here.ps1 -Name billing   # any copilot flags after it
```

The name becomes the window title and the terminal's name on the page; without it the repo folder's name is used. Click "Notify me" once on the page to get a system notification when a terminal asks while you're elsewhere.

## What you see and do

Each terminal is a card, the ones waiting on you first: **waiting on the desk** (a permission ask held for you), **asking you** (Copilot's question, answered in the terminal), **waiting for permission** (a prompt in the terminal itself), **waiting for your next prompt**, **working**, **closed**. Each shows what Copilot last said when it stopped and how many times it stopped for you today.

A held ask shows the tool and what it would run, with:
- **Allow** or **Deny**. A reason typed next to Deny goes back to Copilot, so it can try another way.
- **Allow `npm run …` here from now on**: a standing answer for this terminal. For a command it covers the same program and first word only, and it's never offered for a line that chains, pipes, redirects or substitutes (`;`, `&`, `|`, `>`, `` ` ``, `$(`), so `npm run build; rm -rf ~` always asks. Standing answers are listed on the card with "ask again".
- **answer in the terminal**: lets the ask go, and Copilot shows its usual prompt in that terminal.

**Go to terminal** brings that window to the front. It finds the window by the title `copilot-here.ps1` gave it, so it works best with one window per repo: Windows can't bring a particular tab of Windows Terminal forward from outside.

Per terminal you can switch to "asks go to the terminal" when you're sitting in it, and back.

## How it works, and its limits

Copilot CLI runs a `permissionRequest` hook before it would ask you, and takes what the hook prints as the answer. The desk's hook writes the ask under `%USERPROFILE%\.af\desk\asks\` and waits for your answer from the page.

- **One place at a time.** While an ask waits on the page, the terminal shows no prompt for it. That's why there's "answer in the terminal", and why nothing is held when the desk isn't running: stop `npm run desk` (or close its window) and every terminal asks for itself again within seconds. An ask nobody answers goes to the terminal after 20 minutes (`holdSec` in `%USERPROFILE%\.af\desk\config.json`).
- **Reads aren't held.** The hook runs before Copilot's own rules, so it lets read-only tools (`view`, `grep`, `glob` and the like; `passThrough` in the config) go straight to them. Everything else is held, including tools your own Copilot settings would have allowed; answer those once with "from now on".
- **Questions and new prompts stay in the terminal.** Copilot's hooks can't answer its multiple-choice questions or type your next instruction into a waiting session without tricks that change what Copilot sees. The page shows them and takes you to the window.
- **If the hook breaks, Copilot goes on as usual.** It always exits cleanly; at worst Copilot asks in the terminal.

## The record

Every event of every session goes to `%USERPROFILE%\.af\desk\events.jsonl`, with who settled each held ask and how long it waited. It stays on your PC: it holds your company's paths and commands (cut to 300 characters each), which must never be copied into this repo.

```powershell
npm run desk -- report [--days 7]   # per repo: how often a session stopped for you, answered on the desk, settled by a standing answer, median wait
npm run desk -- tail                # the last events, to check the hook fires
npm run desk -- uninstall
```

## Checked against

Copilot CLI's [hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference) as of 1.0.105. It doesn't spell out the `permissionRequest` input in full; the hook reads `toolName`/`toolInput` and their snake_case forms. On the first day, check with `tail` that asks are recorded with their tool names, and add any read-only tool that gets held to `passThrough`.
