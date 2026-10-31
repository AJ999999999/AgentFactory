# The eval: which way of running turns does better work?

It compares ways of running an engagement's turns on graded cases, with the real CLIs. The question it answers: should the harness keep a role per lane, or run one worker with the lane's skill, and should that worker's session carry across turns? This follows Anthropic's "fold subagents into your main agent loop" advice, which says to settle it with an eval rather than by argument.

```bash
npm run eval -- --check                    # the checks themselves: each case's start fails them, its solution passes them
npm run eval -- --list                     # the cases and what each tests
npm run eval -- --arms A,B,C --runs 2      # the comparison (real CLIs, real usage)
npm run eval -- --run-id <id>              # pick up a run that stopped
npm run eval -- --cases multi-currency --arms A,C --models model-a=pi:   # a slice, on another CLI
```

## Arms

| Arm | Seats that do the work | Session |
|---|---|---|
| A | a role per lane (builder, researcher…), as today | fresh every turn |
| B | one worker, given the lane's skill (the role-specific part of that role's profile) | fresh every turn |
| C | one worker, as B | carried across the turns of a todo |
| D | one worker, as B | one across the whole goal |

In every arm, judges keep their roles and start fresh, and each seat's permissions come from the catalog the same way. B differs from A only in who the agent is. C and D differ from B only in what it remembers. So the gaps between arms are the effect of each.

Sessions carry over in Copilot and pi, which can resume a session by id from a new worktree. Claude Code, Codex and omp start fresh and say so in the turn log.

## Cases

`project/` is a small bookkeeping tool, `tally`, that starts correct. Each case in `cases/<id>/` holds:
- **`files/`:** the problem it plants, or the feature it lacks
- **`case.json`:** the engagement to run (a goal and its todos, in real lanes)
- **`grade.mjs`:** hidden checks the agents never see
- **`solution/`:** a reference solution, so the checks are tested too

The ten cases cover several kinds of work:
- **Bugs:** a rounding rule that has to be read from the docs; triage from a bug report
- **Features:** a JSON output contract; a four-file multi-currency feature
- **Data:** a CSV reader
- **Tests graded by mutation:** the agent's tests must catch four broken versions
- **Research then build:** a handoff between two seats, with a superseded draft as a trap
- **A refactor that must keep behaviour**
- **A security fix:** rules that can run code
- **Documentation:** every example in it is run

## What a run produces

Each case runs as a real engagement under `.af/eval/<run id>/<case>/<arm>-r<run>/`: its repo, worktrees, turn logs and the merged result. The harness ticks it until the work is done or stuck, then the result is graded.

`report.md` lists, per arm:
- the mean score and how many cases were fully solved
- turns per case, premium requests, Claude cost and minutes
- how many turns resumed a session

It then breaks scores down by case, lists the cases where the arms differ, tallies turn outcomes, and lists every check missed.

## Rules for the run

- **Run it more than once (`--runs 2` or more).** One run can hide a regression that shows in the next.
- **A usage limit stops the run instead of being waited out inside it.** Continue it with `--run-id` once the limit resets.
- **The default arms A, B and C cost about a premium request per turn.** That's roughly 30–60 per run of all ten cases on Copilot.
