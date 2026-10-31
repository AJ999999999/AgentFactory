# What testing found

- **Worktree race:** parallel `git worktree add` in one repo can read another's half-written admin directory. Worktree add/remove is now serialized per repo; agent runs stay parallel.
- **Tracking-ref race:** `git push` rewrites the local `origin/main` tracking ref, which races with concurrent fetches. Push and fetch share the per-repo lock. This failed about 1 in 12 runs before the fix; it passed 25 of 25 after.
- **Tamper check miss:** trimming `git status --porcelain` output dropped the first file's status column, so the tamper check missed the edit. It now parses `-z` output untrimmed.
- **Replay noise is real:** a flaky candidate passed with 1 run per side and failed with 5 runs per side (40%). Use several runs per side, or let deterministic checks decide.
- **Returns are the wrong test for rule-following work:** in a private engagement, a config that ignored a rule earned 43% more on the backtest. A returns-based evaluator would have adopted it; the rule-fidelity checker refused it.
