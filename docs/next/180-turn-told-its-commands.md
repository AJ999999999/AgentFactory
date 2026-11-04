# Tell each turn which commands it may run

A turn isn't told what its seat may run. In the second private engagement a builder tried `python -m pytest` twice, plus inline scripts and PowerShell edits, was refused each time, and gave up on testing without trying `npm test`, the one command it had. The operator patched it in that engagement's brief.

Build one packet line from the seat's own grant (`policy/harness-agents.json`), for example "You can run: `npm test`, `git status`, `git diff`; nothing else", so the instructions can't drift from what's allowed. A refusal in a turn log then means a real mistake, not missing information.
