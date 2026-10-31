# Running the harness on Windows

The harness runs as you, on your machine, through Task Scheduler: your Copilot CLI sign-in, your git credentials, and the engagement's code never leave it. Needs Node 22.18 or later, Git for Windows, and Copilot CLI (`npm install -g @github/copilot` or WinGet) signed in once with `copilot`.

```powershell
git clone https://github.com/AJ999999999/AgentFactory C:\workspace\AgentFactory
cd C:\workspace\AgentFactory; npm test          # the suite runs on Windows in CI too
npm run harness -- agents install                 # Copilot agent profiles for the library roles, in %USERPROFILE%\.copilot\agents

# A folder for engagements (state lives in each engagement's own git repo)
mkdir C:\workspace\engagements; cd C:\workspace\engagements
node C:\workspace\AgentFactory\src\harness\cli.ts open my-engagement\engagement.json --world my-engagement\world.mjs --seed my-engagement\seed
node C:\workspace\AgentFactory\src\harness\cli.ts doctor
powershell -ExecutionPolicy Bypass -File C:\workspace\AgentFactory\scripts\windows\install-harness-task.ps1 -Engagement my-engagement
```

What the task does:
- **It keeps one `harness loop` alive.** It starts at logon and is retried every 15 minutes. A retry while the loop is running is ignored, so a crashed loop is back within 15 minutes.
- **It runs only while you're logged on** (a locked screen is fine). That's what lets it use your stored credentials. Nothing runs while the machine sleeps; the loop sleeps by the wall clock and catches up on wake.
- **Quiet rechecks are cheap.** The loop rechecks every 10 minutes (`-PollMinutes`) so your answers are picked up, and a recheck with nothing new is one `git ls-remote`. It runs on battery, hidden, and logs to `.af\harness\<engagement>\loop.log`.
- **It rides out network drops.** Offline or off the VPN, it backs off and retries instead of exiting.

`open` takes the engagement's world module (its checkers, saved so the scheduled loop uses them too) and a folder of files to seed into the engagement repo, such as a brief the agents read. Without `--remote`, state lives in a local git repo under `.af\harness\`. You answer questions with `answer <ask> --choice <id>`, adding `--result supports|refutes --metrics name=value` when you're reporting what you observed. An answer counts as yours; add `--by <role>` only when you're passing on what that person (the parent, the lawyer) told you, so it counts as theirs.

`doctor` checks node, git, Copilot CLI, the agent profiles, the engagement's repo and remote, when the loop last woke, and the task. Each seat runs Copilot as the profile `af-<role>` (`integrations/copilot/harness-agents/`); a profile that isn't installed is skipped rather than failing the turn, with the role in the prompt instead. To stop: `scripts\windows\uninstall-harness-task.ps1 -Engagement my-engagement`; the state stays in git and a reinstall carries on.

Windows-specific handling, each found by reading the code and checked on a Windows CI runner:
- **Copilot's `.cmd` shim is never run through `cmd.exe`.** Prompts carry text from web pages and agents, and `&`, `|` or `%` in them would run commands there. The shim's JavaScript entry is run with node instead.
- **Clones turn off line-ending conversion and turn on long paths.**
- **Worktree removal retries while antivirus or the indexer holds a file.**
- **The Copilot hooks have `powershell` entries, and guard PowerShell's recursive deletes too.**

The rest of running it: [which CLI and model run a seat](models.md), [usage limits](usage-limits.md), [the panel](panel.md) and [the partner's tools in your own session](partner-tools.md).
