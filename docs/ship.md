# Done work as pull requests on GitHub

A goal can send its done work to a GitHub repository as pull requests. The harness asks you first, once per piece of work, unless you've said "from now on" for that lane. Merging stays yours.

No turn can push, and that hasn't changed. The loop pushes, with an identity of its own that can open pull requests and can't merge them.

## What happens

1. **You're asked.** When a piece of work in a shipping goal is done and its checks have passed, and it changed files under the goal's `ship.dir`, you get a question: "Open a pull request for it?". It comes on the panel and, if it's set up, on Slack.
   - If you approve with "from now on", that lane's later work opens its pull requests without asking.
   - A change to more files than `ship.maxFiles` (30) is always asked (`rule:ship_large`).
2. **The pull request is opened.** The work's own commits in the engagement repo are found by their `Todo:` trailer. They're replayed on a branch `af/<todo>` taken from the repository's base branch, limited to `ship.dir`, which becomes the repository's root. The branch is pushed and the pull request opened.
   - If the work no longer applies, because the same lines changed on the base, the work goes back to be brought up to date.
   - Shipping the same work again pushes to the same branch, so the open pull request is updated rather than duplicated.
3. **Its checks are read back.** The head commit's check runs (GitHub Actions or any other checks) are polled like a job. A note in the log says how they went, with the pull request's address.
   - **Passed**: the work's evidence records how many checks passed.
   - **Failed**: the work goes back to its lane with the failing checks' names. When it's done again, you're asked again, and the same pull request is updated.
   - **No checks after two hours**: it counts as passed with none.
4. **Reviewed on another model.** Once the checks pass, the judge lane's seat reviews the change. That seat runs on a different model from the one that did the work, as every judge does. It reads the work's own commits (`git show <commit> -- <dir>`) and answers accept or reject, with why. The loop posts that on the pull request.
   - **Always as a comment, never as an approval.** An approval from this identity would count toward the approval your rules require, and that approval is yours to give. The comment says so.
   - **Rejected**: the work goes back with the review's reasons. When it's done again, you're asked again, the same pull request is updated, and it's reviewed again.
   - `"review": false` in the goal's `ship` turns the review off.
5. **The merge is watched.** Once the checks pass, the loop looks at the pull request every half hour. Merging stays a person's act.
   - **Merged**: noted with who merged it. If the goal's `ship.check` names a probe target, the loop checks it once and notes what it found (for example, an error rate after the release).
   - **Closed without merging**: noted, and the work stays as it is. That was a person's decision.

**The copy keeps in step.** Every `ship.syncMinutes` (60; `0` turns it off), the loop takes in what changed on the base branch since the last time, applying it to the engagement's copy under `dir`. The first look only notes where the base is: the copy is taken to match it. A change that clashes with work in the copy is noted (`ship_synced`, with why) and left; the next change on the base tries again. It's tried on its cadence, whatever comes of it, so a repository that can't be reached doesn't keep the loop awake.

## Set it up

**An identity of its own.** Use a GitHub App installed on the repository, or a machine user with a fine-grained token. Don't use your own token: its pull requests would be yours, you couldn't approve them, and it could merge wherever an admin may bypass the rules. Give it:
- **Repository contents:** read and write.
- **Pull requests:** read and write.
- **Checks** (or **Actions**): read.
- **Metadata:** read.
- Nothing else; certainly not administration.

**Rulesets on the repository**, in Settings, Rules:
- On the base branch: require a pull request, at least one approval and your required checks, with the App or machine user **not** on the bypass list.
- Optionally, restrict branch creation to `af/**` for that identity.

**The goal**, in `engagement.json`:

```json
"ship": { "repo": "acme/payments", "dir": "app", "base": "main", "lanes": ["fix"], "tokenEnv": "AF_GITHUB_TOKEN" }
```

For GitHub Enterprise Server, add `"api": "https://<your host>/api/v3"`.

**The engagement's copy.** `dir` in the engagement repo has to hold a copy of the repository, so the work changes real files. Copy it in with `open --seed` when you open the engagement, at the base's latest commit; from then on it keeps in step by itself.

**The token, where the loop runs:**

```powershell
$env:AF_GITHUB_TOKEN = "<the App's or machine user's token>"
npm run harness -- ship test          # can it push, is it not an admin, does main need a pull request
```

Set the token as a user environment variable for the scheduled task. It's read from the environment on each push and poll, and reaches git through git's own environment configuration, never on a command line.

**Which seats.** A seat whose work ships should run on Copilot or pi. Their tool limits keep a turn away from the place the token is kept. Codex can't limit a turn's commands.

## Not yet

Keeping the token in Windows Credential Manager, and the rest, are in [`docs/next/120-ci-loop.md`](next/120-ci-loop.md).
