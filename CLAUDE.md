# AgentFactory: notes for Claude Code

AgentFactory mass-produces agents for a problem and runs them like a consulting firm with one human partner. Three layers:

- **Foundation:** a challenge process takes a hard problem to a tested MVP.
- **Long-running harness:** runs an engagement for weeks or months.
- **Panel:** the partner's view, plus typed memory about the people the firm serves.

The owner codes on Windows and uses GitHub Copilot CLI daily. The harness runs every agent turn through Copilot CLI.

## How you and Copilot split the work

- **You (Claude Code) are the developer and the operator.** You change this codebase, run the harness, read what Copilot turns did, and fix the harness, prompts and agent profiles when a turn goes wrong.
- **Copilot CLI is the worker.** The harness starts one headless `copilot -p` session per turn, in a git worktree, as the seat's role (`--agent af-<role>`). Don't do an engagement's work yourself. When a turn fails, find out why from its record and fix the cause in the harness.
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
npm run panel [-- --dir <folder> ...] [-- --demo]   # local page on 127.0.0.1:4700, over every folder `open` ran in
npm run memory -- add | view | render
npm run demo:harness                       # six simulated cases, months in seconds
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
| `src/proc.ts` | `resolveCommand` and `runCommand`: never run a `.cmd` through `cmd.exe`; `sleepUntil` |
| `policy/` | Harness policy, role library (lanes to roles), permission catalog, harness agents (models, tool flags), memory policy |
| `integrations/copilot/` | Copilot hooks (lease guard, PowerShell guard) and `harness-agents/af-*.agent.md` profiles |
| `scripts/windows/` | Task Scheduler install, run and uninstall, plus the CI smoke test |
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
| `agents.ts` | `CopilotTurnAgent` |
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
- **Commits:** make them only when asked, and branch first. The PRs are stacked; see Status.
- **Private material stays out of this public repo:**
  - engagements about real people, such as a child's game brief
  - personal apps such as trademind
  - anything under `.af/`

  Keep them in a separate private folder.

## Status

**What's built.** The foundation; the harness with six simulated cases (all pass); Windows runner support (Task Scheduler, CI on Windows); typed memory; the local panel.

**The stacked PRs.** PRs #1 to #5 are open and stacked: foundation, then harness, then Windows, then memory, then panel. Branch `control-panel` contains all of them. Merge them in order with merge commits: retarget each next PR's base to `main` first, and don't squash, or the later PRs will conflict.

**Not real yet**
- **Copilot CLI hasn't been run.** `CopilotTurnAgent` was tested against a fake `copilot` binary only. The tool flags and model names in `policy/harness-agents.json` and the role library are placeholders.
- **No real providers.** Jobs, metric sources and probes are interfaces plus simulations.

## Next work, in order

1. **First real run against Copilot CLI on this machine.**
   - Run `doctor`, then `agents install`.
   - Map `models` in `policy/harness-agents.json` to models this Copilot plan offers. `model-a` and `model-b` should be different families.
   - Open a tiny engagement and run one `tick`.
   - Read the turn record and Copilot's output. Fix flags, the prompt, or JSON parsing until a turn completes and validates.
   - Then try the rhythm-runner engagement. It's kept outside this repo.
2. **Usage limits are capacity, not failure.** Recognise Copilot rate-limit or quota errors. Back off the whole runner until the reset, don't count it against the todo's failure streak, and optionally fall back to another model for that seat (keeping judges on a different model).
3. **Show running turns live.** Write each turn's Copilot output to `.af/harness/<id>/turns/<turn>.log`, show the tail of a running turn in the panel, and add a stop button.
4. **More agent CLIs.** Add a Claude Code `TurnAgent` (`claude -p`, allowed tools, JSON output) so judge lanes can use another vendor while Copilot builds.
5. **Harness tools in the MCP server** (`src/mcp-server.ts`): status, open questions, answer, add work. Then the partner can work the firm from a normal Copilot or Claude Code session.
