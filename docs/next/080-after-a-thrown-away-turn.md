# What's left after a turn is thrown away

In the first private engagement, the game's build todos failed their checks five times. A retry is now told why the last try was thrown away, and every turn is told which checks it must pass. Still to do:

- **A failed attempt's work is thrown away**, so the retry writes everything again from nothing. Consider keeping it on a branch the retry can read or start from. Work is discarded so a red line (a shaming word, a trademark) never reaches `main`. A branch only the next attempt reads doesn't break that.
- **A turn can break checks that only other todos run.** The levels todo runs only the `levels` check. It merged five levels that broke two of the core's tests, and the next build todo used up its tries on them. Consider also running the checks of every todo whose scope covers the files a turn changed.
- **A seat may not be able to run the checks it's held to.**
  - **The build seat** may run `npm test` but not `node --test`, which the brief named. The engagement fixed that with a `package.json` whose test script runs the same files as the check.
  - **The levels seat**, a generated role, may run no tests at all.
  - **A possible fix:** tell the seat in its packet which commands it may run, so a brief that names another command is caught at the first refusal.
  - **What Copilot allows:** it matches a command by its name and subcommand and ignores flags. `shell(node --test:*)` doesn't allow `node --test x`. Only `shell(node:*)` does, and that allows any `node` command.
