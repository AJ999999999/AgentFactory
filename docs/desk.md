# The desk: your own Copilot CLI terminals

This branch is a variant for one setup: a Windows PC where Copilot CLI is the only agent, with several PowerShell terminals open, each in a different repo, each running an interactive `copilot` session that you drive by hand. The goal is one place where every decision those sessions wait on can be answered, while each terminal stays yours to type in.

## Answering from one place: use Copilot's own remote control first

Copilot CLI already does most of this. Type `/remote` in a session (or start it with `copilot --remote`) and the session appears on github.com and in GitHub Mobile, where you can approve or deny its permission requests, answer its questions, approve plans and send new prompts. The terminal keeps working: whichever side answers first wins. See GitHub's [About remote control of Copilot CLI sessions](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/about-remote-control).

On a company seat an administrator has to set the "Store local sessions in the Cloud" policy to "View and control" first; it's off until someone sets it. Session events, including your prompts and tool calls, go to GitHub.

## What the desk adds: knowing what the interruptions cost

Remote control answers one prompt at a time. It doesn't tell you which repo stops you most, for what, or how long sessions sat waiting. The desk records that, so any later change (a standing permission, a different instruction file, a panel) can be judged by whether the number went down.

```powershell
cd C:\workspace\AgentFactory
npm run desk -- install        # one file in %USERPROFILE%\.copilot\hooks; nothing goes into your repos
# work as usual for a day or two, in every terminal
npm run desk -- report         # per repo: how often a session stopped for you, for what, median wait
npm run desk -- tail           # the last events, to check the hook fires
npm run desk -- uninstall
```

`scripts\windows\copilot-here.ps1 [-Name billing] [copilot flags]` starts `copilot` with the terminal's title and the desk's records both named, so you can tell terminals apart.

The hook only records. It prints nothing and always exits cleanly, so each session behaves exactly as without it. The log is `%USERPROFILE%\.af\desk\events.jsonl` and stays on your PC: it holds your company's paths and commands (cut to 300 characters each), which must never be copied into this repo.

What a "stop" is: Copilot tells its hooks when it shows you a permission prompt, a question, or goes idle waiting for your next prompt. The wait ends at that session's next event. Idle time is counted apart, since that's you driving, not an interruption.

## If remote control is off at your company

Copilot's hooks allow a local panel instead. A `permissionRequest` hook runs before Copilot asks you and can answer allow or deny, so a hook that waits for an answer from a page on 127.0.0.1 can take the decision. The catch is that while the hook waits, the terminal shows no prompt: each ask is answered in the panel or in the terminal, not both at once. The plan for that is in [docs/next/080-desk-panel.md](next/080-desk-panel.md); it waits until the recorded numbers and the remote-control answer say it's needed.

## Checked against

Copilot CLI's [hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference) as of 1.0.105. The payload of `permissionRequest` isn't documented in full, so the hook reads both camelCase and snake_case names and the first real day of records should be checked with `tail`.
