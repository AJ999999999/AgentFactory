# A merge request for each change, on GitLab, after you say so

Today the harness checks a turn's output and merges it into the engagement's own repo. For your production code, a change should go the way people's changes go: a merge request, a review on another model, the full pipeline, then merge, release and a check in production. A failure at any step goes back to the same work.

**Decided (2026-11-04): the harness pushes with its own narrow token, and asks you first.**

- **No turn can push.** That stays: the turn's environment points the push URL nowhere.
- **The loop holds the token.** One GitLab project access token, held by the loop process only and kept in Windows Credential Manager, never in the repo or in a turn's environment. On GitLab it is the Developer role, and only branches under `af/` may be pushed; `main` is protected, so the token can't merge. Reading pipelines uses the same token, which only reads them.
- **It asks before it pushes.** When a todo in a goal with `ship` set is done and checked, the harness asks "open a merge request for this?" (`rule:ship`), on the panel and on Slack. Retry and approve can stand, so "from now on" for a lane lets that lane open its merge requests without asking. A merge request that would touch protected paths or more than the size limit is always asked.
- **The seats that may ship.** Seats whose work goes to production should run on Copilot or pi, whose tool limits keep a turn away from the credential store. A Codex seat (Codex can't limit commands) doesn't ship; `doctor` says so.

**The steps, each recorded in the log:**

1. **Keep in step.** The engagement's work tree holds a copy of the GitLab project under the goal's scope. Before a todo is shipped, its change is replayed on a fresh `af/<todo>` branch from GitLab's `main`, limited to the scope. A change that doesn't apply cleanly reopens the todo with the conflict.
2. **Open.** Push `af/<todo>`, open the merge request (title from the todo, description from the turn's notes and the evidence), and record its id and address.
3. **Review on the other model.** A review todo for the judge lane, whose verdict is posted on the merge request. Changes asked for reopen the work with the comments.
4. **Pipeline.** The pipeline's result is read back (polled like a job) as measured evidence on the work. A failed pipeline reopens the todo with the failing jobs' names and the end of their logs.
5. **Merge, release, check.** Merging stays a person's act on GitLab. The harness sees the merge and, if the goal names one, runs its production check (a monitor's probe) and records what it found.

**Done when** a simulated case runs a todo through all five steps against a fake GitLab: a failed pipeline reopening the work, a fixed one passing, an approval standing for a lane. `harness ship test` checks the token, the project and the protected branch against your GitLab, in the office.

Files: `src/harness/ship.ts` (new: the GitLab client and the five steps), `src/harness/rules.ts` (`rule:ship`), the goal's `ship` setting in `types.ts`, `scripts/windows/` (the token in Credential Manager).
