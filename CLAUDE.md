# AgentFactory: notes for Claude Code

AgentFactory mass-produces agents for a problem and runs them like a consulting firm with one human partner. Three layers:

- **Foundation:** a challenge process takes a hard problem to a tested MVP.
- **Long-running harness:** runs an engagement for weeks or months.
- **Panel:** the partner's view, plus typed memory about the people the firm serves.

The owner codes on Windows and uses GitHub Copilot CLI daily. The harness runs every agent turn through Copilot CLI.

## How you and Copilot split the work

- **You (Claude Code) are the developer and the operator.** You change this codebase, run the harness, read what Copilot turns did, and fix the harness, prompts and agent profiles when a turn goes wrong.
- **Copilot CLI is the worker.** The harness starts one headless `copilot -p` session per turn, in a git worktree, as the seat's role (`--agent af-<role>`). Seats whose model maps to `<cli>:<model>` run in that CLI instead: Claude Code (`claude:`, the judges by default), Codex (`codex:`), pi (`pi:`) or omp (`omp:`). Don't do an engagement's work yourself. When a turn fails, find out why from its record and its log in `.af/harness/<id>/turns/<turn>.log`, and fix the cause in the harness.
- **For a bounded job in this repo**, you can hand it to Copilot with the `copilot-worker` skill (`.claude/skills/copilot-worker/`), then review and keep or discard the result.

## Commands

No dependencies and no build step. Node 22.18 or later runs the TypeScript directly.

```bash
npm test                                   # node:test, about 2 minutes; runs on Ubuntu and Windows in CI
npm run harness -- doctor                  # node, git, copilot, agent profiles, models, remote, heartbeat, scheduled task
npm run harness -- agents install          # af-<role> profiles into ~/.copilot/agents
npm run harness -- open <engagement.json> [--world w.mjs] [--seed dir] [--memory dir]
npm run harness -- tick [--copilot <path>]   # one wake: maintenance, then at most one Copilot turn
npm run harness -- status --packet         # beliefs, open work and why it waits, questions for the partner
npm run harness -- answer <ask> --choice <id> [--result supports --metrics k=v --runs n --note ..]
npm run harness -- pause | resume | budget <goal> turns=N
npm run panel [-- --dir <folder> ...] [-- --demo]   # local page on 127.0.0.1:4700, over every folder `open` ran in: questions, live turns with Stop
npm run mcp:partner -- --dir <folder>      # the partner's tools over MCP (status, open_questions, answer, add_work, pause, stop_turn)
npm run memory -- add | view | render
npm run demo:harness                       # six simulated cases, months in seconds
npm run eval -- --check | --list | --arms A,B,C --runs 2   # compare ways of running turns on graded cases (eval/README.md)
```

State for an engagement lives under `.af/harness/<id>/` in the folder where it was opened. That folder is git-ignored. The scheduled task (`scripts/windows/install-harness-task.ps1`) runs `loop` from that same folder.

## Map

| Path | What |
|---|---|
| `src/harness/` | Harness core. Its pieces are listed in the next table. |
| `src/harness/cases/` | Six simulated engagements, used as tests and demos |
| `src/panel/` | `server.ts` (localhost, Host/Origin checks, per-run token), `view.ts` (pure projection), `page.html` (one file, no build) |
| `src/memory/` | Typed memory about principals: kinds, sources, decay, contested entries, what may be used and how |
| `src/git.ts` | Git CLI wrapper, worktrees, leases, and `repoLock`, a lock across processes |
| `src/proc.ts` | `resolveCommand`, `runCommand` and `spawnCommand` (streams output, stops, kills the whole process tree): never run a `.cmd` through `cmd.exe`; `sleepUntil` |
| `src/mcp-server.ts`, `src/mcp-rpc.ts` | The context layer as MCP tools for agents, role-scoped; the shared stdio JSON-RPC loop |
| `policy/` | Harness policy, role library (lanes to roles), permission catalog, harness agents (models, tool flags), memory policy |
| `integrations/copilot/` | Copilot hooks (lease guard, PowerShell guard) and `harness-agents/af-*.agent.md` profiles, which every CLI gets as the role's instructions |
| `integrations/pi/turn-gate.ts` | The permission gate pi and omp turns load: the seat's tools and commands, writes in scope, nothing outside the worktree |
| `scripts/windows/` | Task Scheduler install, run and uninstall, plus the CI smoke test |
| `eval/`, `src/eval/` | The eval: ten graded cases on a small project, the runner and the hidden-check grader (`eval/README.md`) |
| `docs/harness.md` | Design of the harness against the six cases. Read it before changing rules. |

The pieces of `src/harness/`:

| File | What |
|---|---|
| `store.ts` | Event log in git |
| `project.ts` | Fold the log into state |
| `rules.ts` | The harness's own decisions |
| `select.ts` | Readiness, ranking, next wake |
| `validate.ts` | Check a turn's output |
| `team.ts` | Seats and probation |
| `agents.ts` | `turnPrompt`, `turnEnv` (AF_TURN, no push), `CopilotTurnAgent`, `TurnRouter` (by the model's `<cli>:` prefix), `classifyCapacity` |
| `vendors.ts` | Claude Code, Codex, pi and omp turn agents on one base (log, stop, capacity, reply), and their stream readers |
| `live.ts` | Running turns' marker, log and stop request, shared by the runner and the panel |
| `mcp.ts` | The partner's MCP server; serves nothing inside a turn |
| `modes.ts` | Worker mode (one worker with the lane's skill) and session mode (a CLI session carried across a todo's or goal's turns) |
| `setup.ts` | Builds the turn agent from the policy: routing, worker and session modes. Shared by the CLI and the eval |
| `harness.ts` | `tick`, `answer`, `pause`, `setBudget` |
| `cli.ts` | Command line |

## Invariants: don't break these

**The event log**
- State is an append-only event log, one JSON file per event, committed to the engagement's git repo. Events are never edited.
- Everything else is computed by `project()`, which is pure.
- Rules emit events whose ids are derived from their cause, so running twice writes once.
- Writes go through `appendEvents` under `repoLock`. That lock is also a file in the git directory, because the loop, `answer` and the panel share one checkout.
- Event times never go backwards against what the writer read (`writeEventFiles` floors them).

**Evidence and decisions**
- Beliefs come only from graded evidence. Agents can produce only `opinion` or `reported`. Stronger grades come from jobs, metric sources and people. An answer's grade comes from who answered, never from the answer.
- The harness never closes a goal, pivots, or raises a budget by itself. It asks the partner.

**Roles and permissions**
- Permissions come only from `policy/permission-catalog.json`. Text from a client or the web can raise a question but never grant access.
- Judge lanes (`replan`, `synthesis`, `probation-review`) must use a different model from the workers. `checkLibrary` enforces this at startup.
- A generated role stays on probation until independent reviews accept its work.

**Agent turns**
- A usage or rate limit is capacity, not failure: a `capacity` event, nothing counted, and only the seats on that vendor wait (`capacity` in state is per vendor, with the model placeholders it holds up).
- A turn the partner stops is recorded as `stopped`: counted as spent, never as a failure, and the work waits on the partner's "try again or drop it".
- Every CLI is held to the permission catalog the strongest way it allows: Copilot's tool flags, Claude's allowed tools in `dontAsk`, Codex's sandbox (it can't limit commands; `doctor` warns), and the turn gate for pi and omp. No turn can push (`turnEnv` points the remote's push URL nowhere).
- The partner's MCP tools are never a turn's. Every turn's environment has `AF_TURN`, which makes that server serve nothing. Copilot turns pass `--disable-mcp-server agentfactory`. Claude turns run with `--strict-mcp-config --setting-sources ""`.

**The panel**
- The panel is a view of the log with no state of its own.
- It listens on 127.0.0.1 only. Requests need the right Host, a same-site Origin, and the token from the served page.

**Windows**
- Use `runCommand` and `resolveCommand`.
- Clones use `core.autocrlf=false` and `core.longpaths=true`.
- Hooks have PowerShell entries.

## Conventions

- **Code:** plain TypeScript run by Node, with no new dependencies unless there's no reasonable alternative. Comments say why, not what.
- **Tests:** add one per mechanism, named as a sentence about the behaviour (see `test/harness-rules.test.ts`). The harness rules have pure tests over projected state. Git-backed behaviour has tests through a real local bare repo.
- **Docs:** written in plain words a newcomer can follow. Name things by what they do for the person, not by internal names.
- **Commits:** make them only when asked, and branch first from an up-to-date `main`; see Status.
- **Private material stays out of this public repo:**
  - engagements about real people, such as a child's game brief
  - personal apps such as trademind
  - anything under `.af/`

  Keep them in a separate private folder.

## Status

**What's built.**
- The foundation.
- The harness, with six simulated cases (all pass).
- Windows runner support: Task Scheduler, CI on Windows.
- Typed memory.
- The local panel, with live turns and Stop.
- Usage limits waited out per vendor.
- Seats can run in Copilot, Claude Code, Codex, pi or omp, chosen by model; judges in Claude Code by default.
- The partner's MCP tools.

**Branches and PRs.** PRs #1 to #8 are merged into `main` (foundation, harness, Windows, memory, panel, then two from other sessions: answers count as the partner's own unless relayed, and an escalation log). The work on real CLIs, usage limits, live turns, Claude judges, partner tools, worker mode and the eval is on branch `real-clis-eval`, based on `main`, open as PR #10. #8 (panel across project folders, decision cards) is merged into `main`, and `main` is merged into this branch. #9 (an animated overview diagram, `docs/architecture.svg`) is stacked on this branch; the README shows it at the top and this branch's one-turn walk-through (`docs/architecture.gif`) in the harness section.

**What the first real runs showed (Windows, Copilot CLI 1.0.105, Claude Code 2.1.314, Codex CLI 0.166.0, pi 1.4.0)**
- **Copilot has one model on this plan.** Its router reports only `gpt-6-luna`, and `--model` refuses every name, that one included. So `model-a` and `model-c` stay empty (Copilot's default), and `model-b`, the judges, is `claude:opus`.
- **`copilot -p --output-format json` streams events.** The harness reads them for the log, the reply, the model and premium requests. The GitHub MCP server's instructions are in that stream, so capacity is read only from error events and stderr.
- **Copilot's npm loader starts a native `copilot.exe` as a child.** Stopping a turn kills the tree (taskkill /T).
- **Claude Code streams `rate_limit_event` with an exact reset time.** It also warns when the plan is near its weekly limit; the turn log shows that.
- **Codex's sandbox needs `windows.sandbox="elevated"` passed back in.** `--ignore-user-config` drops it, and without it `workspace-write` silently acts as read-only on Windows. Its sandbox keeps `.git` read-only, so commits fail, and stopping a turn kills the sandboxed commands too.
- **The owner's Codex and pi default to a custom provider** (`magpie`, `workbuddy-ai/deepseek-v4.1-flash`, a local gateway). pi keeps it. Codex turns ignore the user's config, so `cli.codex.userProvider` reads just the provider section and default model from it, with an inline token handed over in `AF_CODEX_PROVIDER_TOKEN`. Without that, Codex fell back to OpenAI on a ChatGPT plan whose Codex allowance was spent until November 17.
- **pi turns load the gate, and it holds.** It refused an out-of-scope write, `git push`, `git status; echo hi` and a read of `C:\Windows\win.ini`, and the model carried on within its grant.
- **The owner's personal Copilot skills took over turns.** 14 of 17 eval turns loaded one; `poteto-core` demanded "ownership confirmation" and refused to edit. Copilot turns now run with `--no-custom-instructions --excluded-tools skill`. A probe confirmed it can't load a skill then. Don't use `--dynamic-retrieval skills=off`: it persists into the owner's settings.

**Not real yet**
- **omp hasn't run a real turn.** Claude Code's safety check blocked a probe that ran it with approvals off, which is how unattended omp turns have to run, with the gate as the approval. It's tested against a fake binary only.
- **No real engagement has run.** Only smoke tests in `C:\workspace\engagements\smoke*`.
- **No real providers.** Jobs, metric sources and probes are interfaces plus simulations.
- **No real usage-limit message has been seen from any CLI.**

## Next work, in order

1. **The eval ran (2026-10-31); `worker` is now on, and `sessions` stays off.** Results are in `.af/eval/full-copilot-2/report.md` and `.af/eval/full-codex-magpie/report.md`.
   - **Copilot, all 80 case runs:** mean score A 0.96, B 0.99, C 0.99, D 0.98. The gap is multi-currency, where A left part of the feature undone in both runs.
   - **Codex, 29 of 80 so far:** every arm scored 1.00. D used about two thirds more tokens than B.
   - **Sessions never mattered:** todos finished in about one turn.
   - **Codex stopped on the `magpie` gateway's 429.** Resume it with `npm run eval -- --run-id full-codex-magpie --arms A,B,C,D --runs 2 --models "model-a=codex:,model-c=codex:"` once the limit resets.
   - **`usage-docs`'s check for `--page` and `--size` is stricter than its todo.** It wants both on one line, and every arm missed it in most runs. Loosen it or reword the todo.
2. **Run one real omp turn, once the owner approves it** (`tick --models model-a=omp:`). Check that the gate loads and blocks the way it does in pi, and that omp's JSON events match `PiStream`.
3. **Fix what the first judge turn showed in the prompt.** The validator dropped two parts of the reply:
   - a finding that cited `repo:handoff-packet`, which isn't a file
   - a proposed `job` with no spec

   Say in `turnPrompt` what a valid source is and what a job needs, or steer agents to propose a `task` or an `action` instead.
4. **Keep the owner's personal setup out of turns in Claude Code and omp too.** Copilot's is done. Two leaks remain:
   - Claude Code may load the user's `CLAUDE.md` and skills
   - omp loads `~/.omp/agent/AGENTS.md`

   Look for switches first. If there are none, use a separate home for turns (omp `--profile`), at the cost of a separate sign-in.
5. **Run the rhythm-runner engagement for a few days with the scheduled task.** It's kept outside this repo. Read the turn logs and fix what goes wrong.
6. **Check `classifyCapacity` against a real limit message from each CLI** when one shows up in a turn log.
   - **A usage limit reported mid-run now ends the turn at once, as a wait** (the CLI agents in `vendors.ts`). Codex, answered "429 Too Many Requests" by the `magpie` gateway, said it would reconnect and then hung for the full hour. Copilot's stream reader doesn't do this yet.
   - **A provider that can't be reached still wastes the whole turn timeout.** When the gateway stopped, Codex logged "Reconnecting... waiting for network" every 73 seconds for an hour, and the turn then counted as a failure. Repeated connection failures should end the turn early and record a wait for that vendor.
7. **Find the real web settings:** Copilot's tool name for web reads (`web_fetch` is a guess) and Codex's web search setting.
