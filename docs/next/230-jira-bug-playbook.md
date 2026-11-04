# Design: the Jira bug playbook

Steps 1 and 2 below are built, and so is the reporter's reply coming back in: [docs/jira-bugs.md](../jira-bugs.md) says how to set them up and what they don't do yet. Step 3 is still to do. Two things changed from this design while it was being built:
- **Reading logs is the runner's access, not a catalog permission.** The log job runs on the runner with the runner account's read access. No turn has that access.
- **The reporter's reply starts a follow-up round, not a reopened step.** A new comment that isn't ours starts a round whose first step, the main agent, chooses to look again, answer, or do nothing. Rounds have ids of their own, so a step can run again.

A user files "it doesn't work" in Jira. Today a rule turns that ticket into one todo in one lane ([events.md](../events.md)). But a bug ticket isn't one piece of work. It's a process with a fork in the middle, and nobody knows which way the fork goes until someone has looked:

```
ticket ─► triage ─► look (logs ∥ code) ─► diagnose ─┬─► user error ─► reply ─────────────────────────────► close
                                                    ├─► bug ─► failing test ─► fix ─► PR · CI · review ─► merge ─► check prod ─► reply ─► close
                                                    ├─► needs info ─► ask the reporter ─► (back to look)
                                                    └─► duplicate ─► link and reply ─► close
```

The back half, from the fix to the merge and the production check, already exists ([ship.md](../ship.md)). What's missing is the front half (triage, looking, diagnosing, choosing the branch) and the two ends: writing back to Jira and learning from the ticket once it's closed.

This design adds three things:
- **A playbook:** the process above, written once as a template the harness fills in for each ticket.
- **A main agent at the joints:** a strong model that triages, judges the diagnosis and checks finished work. The harness runs everything between those joints.
- **A place for what the firm learns about its systems:** which repo a service lives in, where its logs are. These facts are kept separate from both one ticket's working notes and what we know about people.

## 1. Where tickets go: one goal per service

Each service the firm supports is a perpetual goal. It never closes. It has the service's repository as its `ship`, a turn budget per week, and a cap on open tickets. Opening a goal is the partner's act, as it is today. So the triage turn never creates or widens a goal. It only routes a ticket to a goal that already exists.

The goals are seeded from a **service map** in the private folder, next to `events.json`. The map holds one entry per service:

```json
{
  "services": [
    {
      "id": "payments-api", "names": ["Payments", "PayAPI", "checkout"], "jiraComponents": ["Payments"],
      "repo": "contoso/payments-api", "dir": "payments-api",
      "logs": { "kind": "files", "where": "\\\\pay-prod-01\\logs\\PayApi-*.log", "sample": "samples/payments-api.log", "notes": "one file per day; exceptions span several lines" },
      "build": "dotnet build", "test": "dotnet test",
      "owners": ["pay-team"]
    }
  ]
}
```

One event rule sends every bug ticket to a single intake goal, in the `triage` lane. Triage reads the ticket and moves it into the right service goal. A ticket that names no known service becomes a question to the partner ("which service is this, or is it new?"), with the triage turn's guess as its recommendation.

## 1b. Logs: told where and shown a sample, never parsed by rules

Most of the firm's logs are written by its own applications: exceptions and a few important events, in a format each team chose. So a service's `logs` entry describes them instead of parsing them:
- **`kind`:** `files` (a path or share, with a wildcard), or a tool the company runs (`appinsights`, `splunk`, `elk`, …) with its query endpoint and token.
- **`sample`:** a short log file, with personal data removed, so the model sees the real format.
- **`notes`:** anything the sample doesn't show, such as the time zone, rotation, or where the user id is.

The harness fetches and the model reads:
- **The fetch is a job.** The `logs` step's job runs on the runner, with the harness's own read-only access. For a file it takes the window around the ticket's time and the lines that mention the ticket's user or error text, with a size cap. For a tool it runs the query the triage turn wrote. The raw lines come back as `measured` evidence. No turn reads production directly.
- **What the model makes of the lines is a `reported` finding**, citing the lines it used.

The sample is where the model starts, not the spec. On a service's first ticket, the diagnose turn writes what it learned about the format as a fact, for example "timestamps are UTC, the user id is the fourth field, a stack trace follows `ERROR` until a blank line". Later tickets use that fact and confirm it. When a reading stops matching the lines, the fact is marked as contested (see 4b).

## 2. The playbook

A playbook is a JSON file in `policy/playbooks/`. The generic shape of the process is public. The names of your services and systems stay in the private folder. Each step of a playbook becomes a todo template, wired to the steps before it with `after`. Each fork is a step whose turn must return an `outcome` from a fixed list. The harness, not the agent, then adds the todos of the branch that outcome names.

| Step | Lane and seat | What it does | Comes out as |
|---|---|---|---|
| **triage** | `triage`, the main agent | Reads the ticket, picks the service, checks for duplicates, fills in the slots (service, time window, user, error text), sets severity | outcome: `route`, `duplicate`, `needs_info` |
| **logs** | a `job` | Runs the service's log query for the window and the user. The harness runs it with its own token. No turn touches production. | measured evidence |
| **code** | `research` | Reads the code path the ticket describes, with the repo read-only | reported evidence |
| **diagnose** | `diagnose`, a worker | Puts the logs and the code together and names the cause, with the log lines and code lines it rests on | outcome: `user_error`, `bug`, `needs_info`; reproduction steps |
| | the conductor | Reads the diagnosis before the fork is taken ([conductor.md](../conductor.md)). This is the checkpoint where a wrong call costs the most. | accept, or send it back |
| **reply** | `support` | Drafts the answer to the reporter: how to use the feature, or what was fixed and when | a question to the partner, with the draft |
| **failing test** | `test-design` | A test that fails on the base because of the bug | its check must fail on the base and pass after the fix |
| **fix** | `build` | The smallest change that makes the failing test pass | then the conductor, then ship |
| **close** | `synthesis`, a judge | Looks back: what the cause was, how long each step took, what it learned about the service | proposed learnings (see 4) |

Two rules hold the fork honest:
- **"It's a bug" has to be shown.** A bug outcome is only an opinion until a test fails on the base for the reason the diagnosis gave. A fix can't start before that test exists. If no failing test can be written, the ticket goes back to diagnose with that fact. This is the playbook's version of [150](150-fails-on-base-too.md).
- **"It's the user's mistake" is checked by a person.** Telling a user they did something wrong, when it was really our bug, is the costliest error on this path. So a `user_error` reply always goes to the partner as a draft.

## 3. Writing back to Jira

Turns never write to Jira. The loop does, with its own token, in the same way it opens pull requests:
- **Every reply is asked first.** The partner gets the draft, with Send, Edit or Hold. If they choose Send with "from now on" for a kind of reply (for example `duplicate` links), that kind is sent without asking afterwards. A `user_error` reply can never be covered by "from now on" (`rule:jira_reply_user_error`, a must-ask).
- **Status changes follow the work.** When triage routes the ticket, it moves to "In progress". After a reply is sent, it moves to "Waiting for customer". After a fix is merged and production checked, it moves to "Resolved". The mapping from step to status lives in the source's config.
- **The reporter's reply comes back in.** The Jira source already fetches updates. A comment on a ticket in "Waiting for customer" reopens that ticket's `needs_info` or `reply` step, with the comment in the packet as data, never as instructions.

## 4. What it remembers, and where

There are three kinds of memory, and each has its own home and its own moment to be written:

| Kind | Example | Where | When |
|---|---|---|---|
| **This ticket's working state** | hypotheses, what was tried, the diagnosis | the engagement's event log (findings, notes) | as it happens; never anywhere else |
| **Facts about the systems** | "the refund flow lives in `RefundService.cs`", "pay-prod logs drop after 30 days" | a `facts` log next to the service map | right away, as `reported`, so other tickets can use it now. A fact becomes `confirmed` when a later turn's measured evidence agrees, or the partner confirms it. It goes stale when the code it points at changes. |
| **Lessons that generalise** | "tickets about export in Payments are usually user error", "the team wants replies under 100 words" | the memory layer, about the people, or the playbook's own stats | only at close, proposed by the close step, accepted by the partner |

Two rules sit underneath:
- **The main agent's context is a cache, not memory.** Anything it knows that matters is in the log or the facts. So a turn of it can crash, be compacted or run on another model without losing anything.
- **A guess made halfway is never promoted.** Wrong hypotheses are the normal way a diagnosis gets made. If they reached shared memory mid-ticket, the next ticket would inherit them. Only what survived to the close is proposed as a lesson.

Each packet gets the facts about its service that apply, up to a line budget. It gets confirmed facts first, then reported ones marked as unconfirmed.

## 4b. Keeping it up to date

The process changes too: the team moves to a new Jira workflow, or an SOP adds a step. Knowledge built up under the old way then contradicts the new one. Each kind of knowledge is kept current in its own way:
- **The process is the people's.** The playbook changes rarely and deliberately: each change is a commit with a reason and a new version. Where the company has an SOP, the playbook links to it rather than copying it, so there's one source of truth. A step's brief quotes the SOP's section, and the packet says which version.
- **Facts expire by themselves.** Each fact records the playbook version and the code commit it was learned under. A new playbook version marks the facts and lessons learned under the old one as "recheck", in the same way an artifact pinned to a basis goes stale when the basis changes. A change to the file a fact points at does the same. Rechecked facts aren't deleted. The next turn that uses one either confirms it or replaces it. Two facts that disagree become a question to the partner, never an average.
- **The harness notices when the process has drifted, and proposes the change.** For example:
  - Jira returns a status the playbook's mapping doesn't know, which means the workflow changed. That's a setup problem, and the partner is asked.
  - The partner edits drafted replies the same way three times. The harness proposes changing the reply step's brief.
  - The conductor keeps sending back the same step. The harness proposes changing that step's brief.

  Each is a proposed playbook change, shown with its evidence. Accepting it makes the commit and the new version.

So people set things up once and then answer occasional proposals. They don't keep a document up to date by hand.

**Setting up a service** takes the service map entry, the log sample and the repository. A first `onboard` turn reads all three and drafts the service's starting facts: the code map, the log format, and the build and test commands it found. The partner skims that draft and accepts it.

## 5. What the main agent may decide

The triage seat and the conductor are judge-lane seats, on a stronger model than the workers.
- **May:** choose the service, the playbook and the outcome of triage; fill in the slots; write each step's brief (the charter: the repo's build and test commands, where its logs are, what done means, the known pitfalls from facts); send work back; ask the partner.
- **May not:** open or close goals; grant access (the log job reads with the runner's own access, which no turn has); send anything outside the firm; merge.

A brief is a role prompt made specific. "You're a senior .NET engineer" goes in a brief at most once. The brief's force comes from the service's own facts and the step's check.

## 6. Learning across tickets

Each playbook keeps numbers per service, read with `npm run harness -- escalation`:
- tickets by outcome
- time per step
- the conductor's send-backs by step
- the partner's edits to drafted replies

A step the conductor often sends back points at that step's brief. A service whose tickets are mostly `user_error` points at its docs or its UI. That's a finding for the partner, not just more replies.

A new kind of ticket with no playbook gets a plan drafted by triage, on probation in the same way as a generated role. After three closes in a row with no partner override, the plan is proposed as a playbook.

## What gets built, in order

1. **Triage, look and diagnose, with the reply path only.** This covers the service map and goals, onboarding a service, the intake rule, playbook instantiation and the fork, the file log job, Jira write-back with asking first, and the `facts` log with its expiry. No code changes reach any repository yet. This alone answers most tickets and builds the facts.
2. **The bug branch.** The failing-test step and its check against the base, connected to the existing ship path. Then after the merge: the production check, the reply, the status change.
3. **Close and learning.** The close step, lessons into memory, playbook stats, proposed playbook changes from drift, and plans for new kinds of tickets on probation.

## Still to settle in the office

- **Each service's logs:** where they are, a sample with personal data removed, and read-only access for the runner. Most are the applications' own files, so `kind: files` comes first. A tool provider is added when a service needs one.
- **Where the SOPs live,** so playbooks can link to them.
- **Jira write access:** a service account that can comment and change status, and nothing more.
- **Where the service map comes from:** written by hand once, or read from a service catalog if the company has one.
- **Who approves replies**, if not the partner alone: for example a team lead for one service.
