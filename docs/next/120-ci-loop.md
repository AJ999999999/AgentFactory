# Pull requests on GitHub: what's left

Done work goes to GitHub as a pull request once you approve it, and its checks come back as evidence ([docs/ship.md](../ship.md)). This is option B, decided on 2026-11-04: the loop pushes with a narrow identity of its own, after you say so. Still to do:

- **Your repository.** Create the App or machine user and the rulesets, then run `ship test` against the real repository. Done in the office.
- **Keep the copy in step.** The engagement's copy of the repository is set when the engagement opens. Fetch the base branch into it on a schedule, so turns work on what's current, and so the work's diff applies cleanly more often.
- **Review on the other model.** A review todo for the judge lane, its verdict posted as a pull request review. "Changes requested" reopens the work with the comments.
- **Merge and after.** See the merge (merging stays a person's act), then run the goal's production check (a monitor's probe), if it names one, and record what it found.
- **The token in Credential Manager.** Instead of a user environment variable: a small script that stores it, and the loop reading it from there.
- **Copilot coding agent, kept in reserve.** The work as an issue that the coding agent turns into a pull request in the cloud, with nothing able to push from this PC.
