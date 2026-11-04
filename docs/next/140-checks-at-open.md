# Check the engagement before its first turn

In the second private engagement (a Python app), five of about eight operator interventions were setup problems, not agent mistakes. `open` could catch each one before a turn is spent:

- **The checks pass on the starting commit.** Run the engagement's checkers on the seeded repo. A failure there is the setup's problem. In the run, one test needed a local `cache/` the copy left out, and a 19-minute turn was thrown away for it.
- **The harness's own files are tracked.** After seeding, check that git doesn't ignore `.agents/` and `policy/`. The seeded app's `.gitignore` ignored `.agents/` and every `*.json`, which would have hidden the event log.
- **A seat can run the project's tests.** If a seat may only run `npm test`, the project needs one that works. For a Python project the operator had to add a `package.json` by hand.
- **The engagement file reads well on its own.** Lint todo text that points at other steps without naming them ("the build steps below" was invisible to the agent reading it).

The rule: every time the operator has to step in during a run, the result is a new check here or a new rule, not only a note.
