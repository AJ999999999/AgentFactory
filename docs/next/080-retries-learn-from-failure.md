# A retry should start from what the last attempt got wrong

In the first private engagement, the game's build todo failed its checks twice. Each retry knew less than it could have.

- **The retry isn't told why the last attempt failed.** The turn record keeps the checks' messages (`reasons`), but the packet's "Recent" line shows only `core validation_failed/none`, and that line is in the part of the packet that can be cut. The second attempt found the failing assertion only by reading the event files itself. Put the reasons from this todo's last failed attempt next to the todo in the packet, where they can't be cut.
- **A failed attempt's work is thrown away**, so the retry writes everything again from nothing. Consider keeping it on a branch the retry can read or start from. Work is discarded so a red line (a shaming word, a trademark) never reaches `main`. A branch only the next attempt reads doesn't break that.
- **The build seat couldn't run the project's own tests.** `shell:test` allows `npm test` and `npm run build`. The brief said to run `node --test`, and Copilot refused it every time, so both attempts handed in code they had never run.
  - **This engagement:** the owner chose to add a `package.json` whose test script runs the same files as the check.
  - **For the harness:** tell the seat in its packet which commands it may run, so a brief that names another command is caught at the first refusal.
  - **Permissions:** Copilot matches a command by its name and subcommand and ignores flags. `shell(node --test:*)` doesn't allow `node --test x`. Only `shell(node:*)` does, and that allows any `node` command.
