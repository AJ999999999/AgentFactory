# Merge the fixes from real runs, and run from `main`

The second private engagement hit the same Windows bug as the first (`open --world` with a `C:\` path), because the fix had been waiting in open PR #15 since 2026-10-31. To run at all, the operator built a local branch that merged three open PRs and resolved their conflicts by hand. Both real runs so far have run on code nobody reviewed together.

- Merge or close the open fixes: #15, #19, #27, #28. Rebase #17, which conflicts with `main` in `answers.ts`, `cli.ts`, `project.ts` and `types.ts`.
- From now on, one fix per pull request, named after the run that found it. #15 bundles three changes, which is part of why it stalls.
- The scheduled task and every manual run use `main`. A `local/run-*` branch is a stopgap that gets deleted once its PRs merge.
