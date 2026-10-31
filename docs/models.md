# Which CLI and model run a seat

The library gives each role a model placeholder, and `"models"` in `policy/harness-agents.json` says what runs it:
- **Empty:** Copilot CLI with its default model.
- **A Copilot model id:** that model. Some Copilot plans offer a single model and refuse `--model`.
- **`claude:<model>`**, such as `claude:opus`: Claude Code.
- **`codex:<model>`:** Codex CLI.
- **`pi:<provider/model>`:** pi.
- **`omp:<model>`:** omp.

`<cli>:` alone uses that CLI's default model. By default the judges' placeholder, `model-b`, is `claude:opus`, because judges must not run on the same model as the work they judge. `doctor` shows what each placeholder runs on and checks each CLI is installed. To try another CLI for one run without editing the policy, pass `--models model-a=pi:` to `tick`.

Every CLI gets the same prompt and the role's profile as its standing instructions. None of them loads your own settings, MCP servers, plugins, skills or saved sessions, where the CLI lets those be switched off. The `"cli"` section maps the permission catalog onto each one, as strictly as that CLI allows:

| CLI | How a seat is held to what the catalog grants |
|---|---|
| Copilot | `--allow-tool` and `--deny-tool` for each permission |
| Claude Code | allowed and disallowed tools; anything else is refused, never asked about |
| Codex | its sandbox: read-only for a seat that can't write, otherwise writes only inside the worktree with `.git` protected, and no network unless the seat may read the web. It runs any command inside that sandbox, so `doctor` warns that the catalog's command list isn't enforced. |
| pi, omp | a gate the harness loads into every turn (`integrations/pi/turn-gate.ts`). It allows the seat's tools only, and shell commands only from the seat's list, one at a time: no chaining, pipes or redirection. Writes stay inside the write scope and nothing outside the worktree can be touched. A broken or missing grant blocks everything. |

Whatever the CLI, a turn can't push: `git push` to the engagement's remote goes nowhere from inside a turn, and only the harness merges a turn's work, after checking it. Each CLI must be installed and signed in on the same PC.
