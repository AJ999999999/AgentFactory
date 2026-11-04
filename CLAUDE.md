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
npm run setup                              # once per clone: JSON config merges by key
npm test                                   # node:test, about 2 minutes; runs on Ubuntu and Windows in CI
npm run harness -- doctor                  # node, git, copilot, agent profiles, models, remote, heartbeat, scheduled task
npm run harness -- agents install          # af-<role> profiles into ~/.copilot/agents
npm run harness -- open <engagement.json> [--world w.mjs] [--seed dir] [--memory dir]
npm run harness -- tick [--copilot <path>]   # one wake: maintenance, then at most one Copilot turn
npm run harness -- status --packet         # beliefs, open work and why it waits, questions for the partner
npm run harness -- escalation              # which questions changed anything, blind follow rate, spot-check miss rate
npm run harness -- answer <ask> --choice <id> [--result supports --metrics k=v --runs n --note ..]
npm run harness -- correct <ask> --note ..  # fix what an answer's note says; its choice stands
npm run harness -- pause | resume | budget <goal> turns=N
npm run panel [-- --dir <folder> ...] [-- --demo]   # local page on 127.0.0.1:4700, over every folder `open` ran in: questions, live turns with Stop
npm run mcp:partner [-- --dir <folder> ...]   # the partner's tools over MCP, over the panel's folders (status, open_questions, answer, add_work, pause, stop_turn)
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
| `docs/` | One page per feature, linked from the README; `docs/next/` is the next work, one file per item |
| `scripts/git/` | The JSON merge driver and `setup.mjs`, which points this clone at it |
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
- **Commits:** make them only when asked, and branch first from an up-to-date `main`; see Working alongside other sessions.
- **Private material stays out of this public repo:**
  - engagements about real people, such as a child's game brief
  - personal apps such as trademind
  - anything under `.af/`

  Keep them in a separate private folder.

## Working alongside other sessions

Several Claude Code sessions, Copilot turns and people change this repo at once. Most of the rework so far came from files every change has to touch, not from two changes to the same code. So:

- **Status lives outside the repo.** What's merged and what's open is on GitHub. Don't write branch or PR state into this file or the README.
- **One file per item.** The next work is `docs/next/`, one file per item, ordered by the number in its name. Add a file to add work; delete it when the work lands. Findings from real runs are in `docs/real-runs.md`.
- **The README is an index.** A new feature gets its own page under `docs/` and one line in the README's Guides list.
- **JSON config merges by key.** Run `npm run setup` once per clone. It points git at `scripts/git/json-merge.mjs` for `policy/*.json` and `package.json`, so two branches that each add a key don't conflict. Two different values for the same key still do.
- **Don't stack on another session's open PR.** Branch from the latest `main`. If you need its work, wait for it to merge.
- **Say which files you'll change before you start**, when another session may be working nearby, and stay inside them. Ask the coordinator before you change code another open PR changes.

## Next work

In `docs/next/`, in the order of the numbers in the file names. Read them before you pick something up.
