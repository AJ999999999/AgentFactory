# Setting it up in the office: every file to fill in

A checklist for the office PC. Each part says which file to change, what goes in it, and the command that checks it. Below, `<workspace>` is the folder where you open engagements (for example `C:\workspace\engagements`), and `<id>` is the engagement's id. Nothing here goes into this repository: it all names your company's systems and lives in your own folders.

## Where everything lives

| What | Where | Holds |
|---|---|---|
| The engagement | `<workspace>\engagement.json` | goals, people, `events` (Jira) and each goal's `ship` (GitHub) |
| Its state | `<workspace>\.af\harness\<id>\` | the event log in git, turn logs; `config.json` written by `open` |
| Probes for production | `<workspace>\world.mjs` | `export const world = { probe: { check(target, now) {...} } }`, passed to `open --world` |
| Jira rules, set later | `<workspace>\events.json` | `sources` and `rules`, loaded with `events config` |
| The harness's Slack | `%USERPROFILE%\.af\harness\slack.json` | webhook, your address, digest hour |
| The desk | `%USERPROFILE%\.af\desk\config.json` | Teams or Slack for permission asks, where they're answered, the knowledge repo |
| Tokens | user environment variables | `AF_JIRA_TOKEN`, `AF_GITHUB_TOKEN` |
| Models and tools per seat | `policy\harness-agents.json` in this repo | which CLI and model each role runs on (or `loop --models`) |

Set tokens as **user** environment variables, so the scheduled task sees them (it runs as you). Then restart the task, or log off and on:

```powershell
[Environment]::SetEnvironmentVariable("AF_JIRA_TOKEN", "<Jira personal access token>", "User")
[Environment]::SetEnvironmentVariable("AF_GITHUB_TOKEN", "<the GitHub App's or machine user's token>", "User")
```

## 1. The machine

- [ ] `npm run setup` once in this repo (the JSON merge driver).
- [ ] `npm run harness -- agents install`: the `af-<role>` profiles go into `%USERPROFILE%\.copilot\agents`.
- [ ] `policy\harness-agents.json`, under `models`: the models your Copilot plan offers. Judges (`model-b`) on a different model from the workers. A seat whose work ships to GitHub should run on Copilot or pi, not Codex.
- [ ] Check: `npm run harness -- doctor`.

## 2. Jira: tickets into work ([docs/events.md](events.md))

- [ ] `AF_JIRA_TOKEN`: a personal access token from your Jira profile (Server or Data Center). For Atlassian Cloud, an API token from id.atlassian.com, plus `"cloud": {"email": ...}` on the source.
- [ ] `<workspace>\events.json`:
  - `sources`: `id`, `kind: "jira"`, `url` (`https://jira.yourcompany.com`), `jql`, `tokenEnv: "AF_JIRA_TOKEN"`, and optionally `everyMinutes`, plus `grade: "stated"` for feedback sources;
  - `rules`: `match` (source, types, labels), then `goal` with either `lane` (the ticket becomes work) or `evidence` (the ticket becomes evidence on an assumption), and optionally `maxOpen` and `tell`.
- [ ] Check before loading: `npm run harness -- events test <source> --hours 24`. It lists what Jira returns and which rule each ticket meets, and writes nothing. Tune the JQL until it's right.
- [ ] Load: `npm run harness -- events config events.json`.
- [ ] After a day: `npm run harness -- events`. Look at the "matched no rule" counts.

## 3. Production logs and metrics: probes ([docs/harness.md](harness.md))

- [ ] `<workspace>\world.mjs`: a `probe.check(target, now)` that runs your log search or metrics query and returns `{ fingerprint, summary }`. The fingerprint changes when what you watch changes.
- [ ] In `engagement.json`, each goal's `monitors`: `{ id, target, cadenceMinutes, onChange: { todo | ask } }`.
- [ ] A goal that ships can name a target in `ship.check`. It's checked once after each merge.
- [ ] Open with it: `npm run harness -- open engagement.json --world world.mjs` (it's saved with the engagement).

## 4. Slack: the harness's questions ([docs/harness-slack.md](harness-slack.md))

- [ ] In Slack's Workflow Builder, a workflow "From a webhook":
  - variables `kind`, `engagement`, `goal`, `headline`, `what`, `why`, `options`, `ask`, `nonce`;
  - a message to you, with an Answer button;
  - a form: Answer `1`–`4` or `Open the panel`, Keep `just this time` or `from now on`, and a Note;
  - an Outlook step mailing you `af-harness {ask} {nonce} {Answer} {Keep}`.
- [ ] `%USERPROFILE%\.af\harness\slack.json`: `{ "webhook": "https://hooks.slack.com/triggers/...", "me": "you@company.com", "replies": "outlook", "digestHour": 9 }`.
- [ ] Classic Outlook running on this PC. The new Outlook can't be read.
- [ ] Check: `npm run harness -- slack test`. Tap a number and see the mail arrive.

## 5. The desk: Copilot's permission asks ([docs/desk.md](desk.md))

- [ ] `npm run desk -- install`: one hooks file in `%USERPROFILE%\.copilot\hooks`.
- [ ] `npm run desk -- shortcut`: the Start menu entry, with Ctrl+Alt+D.
- [ ] `%USERPROFILE%\.af\desk\config.json`, as you need it:
  - `"teams": { "folder": "C:\\Users\\you\\OneDrive - <company>\\af-desk", "me": "you@company.com" }` and the four-step Teams flow; or
  - `"slack": { "webhook": "...", "replies": "outlook", "me": "you@company.com" }`, a desk workflow of its own (its fields differ from the harness's);
  - `"asks": "desk"` to answer every terminal's asks on the page;
  - `"knowledgeDir": "<a clone of your team's private repo>"`, never this repo.
- [ ] Check: `npm run desk -- teams test` or `npm run desk -- slack test`, then `npm run desk -- app`.

## 6. GitHub: done work as pull requests ([docs/ship.md](ship.md))

- [ ] A GitHub App or machine user, not your own token. Its permissions:
  - contents: read and write;
  - pull requests: read and write;
  - checks: read;
  - metadata: read;
  - nothing else.
- [ ] Rulesets on the repository:
  - the base branch needs a pull request, an approval and your checks, with that identity not on the bypass list;
  - optionally, it may only create `af/**` branches.
- [ ] `AF_GITHUB_TOKEN`: its token.
- [ ] In `engagement.json`, the goal's `ship`: `{ "repo": "owner/name", "dir": "app", "base": "main", "lanes": [...], "check": "<probe target>" }`. For GitHub Enterprise Server, add `"api": "https://<host>/api/v3"`.
- [ ] The repository's code under `dir` in the engagement, at the base's latest commit: `open --seed <a folder holding dir>`. It keeps in step by itself after that.
- [ ] Check: `npm run harness -- ship test`. It should say: can push, not an admin, and the base branch needs a pull request.

## 7. Keep it running

- [ ] From `<workspace>`:
  ```powershell
  powershell -ExecutionPolicy Bypass -File C:\workspace\AgentFactory\scripts\windows\install-harness-task.ps1 -Engagement <id>
  ```
- [ ] `npm run harness -- doctor` again: the heartbeat and the scheduled task.
- [ ] `npm run panel` or `npm run desk -- app`: answer the first questions, and watch the first turns.
