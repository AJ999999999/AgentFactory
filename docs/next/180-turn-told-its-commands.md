# Tell each turn which commands it may run

A turn isn't told what its seat may run. In the second private engagement a builder tried `python -m pytest` twice, plus inline scripts and PowerShell edits, was refused each time, and gave up on testing without trying `npm test`, the one command it had. The operator patched it in that engagement's brief.

Build one packet line from the seat's own grant (`policy/harness-agents.json`), for example "You can run: `npm test`, `git status`, `git diff`; nothing else", so the instructions can't drift from what's allowed. A refusal in a turn log then means a real mistake, not missing information.

The first private engagement hit the same gap from the other side: a seat held to checks it couldn't run.
- **The build seat** could run `npm test` but not `node --test`, which the brief named. The engagement worked around it with a `package.json` whose test script ran the same files as the check.
- **The levels seat**, a generated role, could run no tests at all. Its packet should say so, so the brief can be fixed before the turn rather than after a refusal.
- **How Copilot matches a command:** by its name and subcommand, ignoring flags. `shell(node --test:*)` doesn't allow `node --test x`; only `shell(node:*)` does, and that allows any `node` command. The packet line has to describe what the grant really allows, not what it looks like.
