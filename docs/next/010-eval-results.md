# The eval ran (2026-10-31); `worker` is now on, and `sessions` stays off

Results are in `.af/eval/full-copilot-2/report.md` and `.af/eval/full-codex-magpie/report.md`.
- **Copilot, all 80 case runs:** mean score A 0.96, B 0.99, C 0.99, D 0.98. The gap is multi-currency, where A left part of the feature undone in both runs.
- **Codex, 29 of 80 so far:** every arm scored 1.00. D used about two thirds more tokens than B.
- **Sessions never mattered:** todos finished in about one turn.
- **Codex stopped on the `magpie` gateway's 429.** Resume it with `npm run eval -- --run-id full-codex-magpie --arms A,B,C,D --runs 2 --models "model-a=codex:,model-c=codex:"` once the limit resets.
- **`usage-docs`'s check for `--page` and `--size` is stricter than its todo.** It wants both on one line, and every arm missed it in most runs. Loosen it or reword the todo.
