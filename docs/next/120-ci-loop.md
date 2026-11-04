# A pull request for each change, on GitHub, after you say so

Today the harness checks a turn's output and merges it into the engagement's own repo. For your production code, a change should go the way people's changes go: a pull request, a review on another model, the full CI, then merge, release and a check in production. A failure at any step goes back to the same work.

**Decided (2026-11-04): the harness pushes with its own narrow identity on GitHub, and asks you first.**

- **No turn can push.** That stays: the turn's environment points the push URL nowhere.
- **Its own identity, not yours.** A GitHub App installed on the repository, or a machine user with a fine-grained token, with contents and pull requests write and nothing else. With your own token, its pull requests would be yours: you couldn't approve them, and it could merge wherever an admin may bypass. The token is held by the loop process only and kept in Windows Credential Manager, never in the repo or in a turn's environment.
- **GitHub's rulesets do the limiting.** On `main`: a pull request, one approval and the required checks, with the App or machine user not on the bypass list, so it can't merge. A second ruleset lets it create only `af/**` branches. The API address is configurable, for GitHub Enterprise Server (`https://<host>/api/v3`) as well as GitHub.com.
- **It asks before it pushes.** When a todo in a goal with `ship` set is done and checked, the harness asks "open a pull request for this?" (`rule:ship`), on the panel and on Slack. Approve can stand, so "from now on" for a lane lets that lane open its pull requests without asking. A pull request that would touch protected paths or more than the size limit is always asked.
- **The seats that may ship.** Seats whose work goes to production should run on Copilot or pi, whose tool limits keep a turn away from the credential store. A Codex seat (Codex can't limit commands) doesn't ship; `doctor` says so.

**The steps, each recorded in the log:**

1. **Keep in step.** The engagement's work tree holds a copy of the GitHub repository under the goal's scope. Before a todo is shipped, its change is replayed on a fresh `af/<todo>` branch from the repository's `main`, limited to the scope. A change that doesn't apply cleanly reopens the todo with the conflict.
2. **Open.** Push `af/<todo>`, open the pull request (title from the todo, description from the turn's notes and the evidence), and record its number and address.
3. **Review on the other model.** A review todo for the judge lane, whose verdict is posted as a pull request review. Changes asked for reopen the work with the comments.
4. **Checks.** The head commit's check runs (GitHub Actions) are read back, polled like a job, as measured evidence on the work. A failed check reopens the todo with the failing jobs' names and the end of their logs.
5. **Merge, release, check.** Merging stays a person's act on GitHub. The harness sees the merge and, if the goal names one, runs its production check (a monitor's probe) and records what it found.

**Another way, kept in reserve:** GitHub's Copilot coding agent can take the work as an issue and open the pull request from the cloud, with nothing able to push from this PC. Its work would then run outside the harness's turns, checks and permission catalog, which is why B was chosen.

**Done when** a simulated case runs a todo through all five steps against a fake GitHub: a failed check reopening the work, a fixed one passing, an approval standing for a lane. `harness ship test` checks the token, the repository and its rulesets against your GitHub, in the office.

Files: `src/harness/ship.ts` (new: the GitHub client and the five steps), `src/harness/rules.ts` (`rule:ship`), the goal's `ship` setting in `types.ts`, `scripts/windows/` (the token in Credential Manager).
