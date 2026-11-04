# Jira bugs, triaged, diagnosed and answered

A user files "it doesn't work" in Jira. The harness takes the ticket through the steps a support engineer would follow:

```
ticket ─► triage ─► logs ∥ code ─► diagnose ─┬─► user error ─► reply
                                             ├─► needs info ──► reply
                                             └─► bug ─► reply ("confirmed")
                                                     └► failing test ─► fix ─► pull request ─► merged ─► reply ("fixed")
        (triage can also say) duplicate ──────────────────────────────────────► reply

        someone comments after our reply ─► follow-up ─► look again · answer · nothing
```

Every reply goes to you as a draft first. The loop posts it on the ticket once you say send, then moves the ticket's status. Every pull request is asked about first, and merging stays yours. No turn touches Jira, GitHub or production.

It follows the [design](next/230-jira-bug-playbook.md).

## How it works

The steps are a **playbook**, `policy/playbooks/jira-bug.json`. It's written once and filled in for each ticket:

- **Triage** runs on the judges' strong model. It reads the ticket and picks one of three outcomes: `route` to one of your services, `duplicate`, or `needs_info`. With each outcome it fills in what it found: the service, the words to search the logs for, the time window, a one-line summary.
- **Logs** is a job, not a turn. The runner reads the service's log files, takes the lines that mention those words (with a few lines before and the stack trace after), and saves the excerpt in the engagement's repo. Turns can read it but not change it. No rules parse the logs: the model reads them as they are.
- **Code** reads the part of the service's code the ticket is about, and says where it is.
- **Diagnose** puts the logs and the code together and picks `user_error`, `bug` or `needs_info`, with the evidence. Then [the conductor](conductor.md) reads it before the branch is taken, even if you haven't turned the conductor on elsewhere. A wrong call here costs the most.
- **Reply** drafts the answer to the reporter. You get it as a question: **Send**, **Send my text instead**, or **Don't send**.
  - A `user_error` reply is always yours to approve. Telling someone it was their mistake, when it was really our bug, is the worst error this path can make.
  - Other kinds, such as a duplicate's link, can be sent by a standing answer ("from now on").

The agent picks the outcome, but it never writes the next steps itself. The harness adds them from the playbook.

### When it's a bug

A `bug` diagnosis is still only an opinion. It becomes a fix only once a test shows it:

- **Failing test.** A turn writes one test in the service's own suite that fails because of the bug. It must not fix the bug. The harness runs the service's `test` command twice:
  - With the new test, it must fail.
  - On the commit the turn started from, it must pass. This happens in a separate checkout, so nothing in the turn's own folder moves.

  If the suite already fails on the starting commit, the turn is thrown away and told so. If no test can show the bug, the turn says why, and you decide. The conductor reads the test before the fix starts.
- **Fix.** The smallest change that makes the test pass. The whole suite must pass.
- **Pull request.** You're asked, as for any shipped work ([ship.md](ship.md)). The pull request carries both the fix and the failing test, says which ticket it's for, and goes through its checks and a review on another model. Merging is yours.
- **Fixed.** Once it's merged, the reply saying it's fixed is drafted, and after you send it, the ticket moves to `resolved`.

This needs the service's goal to ship to a repository (`ship` in the goal). Without that, a bug gets the "confirmed" reply and stops, with a note saying why.

Between the failing test and the fix, the service's tests are red in the engagement's copy. That's deliberate: it's the proof. Other work in the same service goal sees that failure in its checks until the fix lands.

### When someone answers on the ticket

Jira's comments come in with each change to the ticket. A new comment from anyone but us starts a **follow-up round**, once the round before it has finished. The main agent reads the comment, next to our last reply and what's known so far, and chooses:
- **`look`:** they gave something new (an order id, a time, steps), or say the advice or the fix didn't work. A new round of logs, code and diagnosis runs, searching for the new terms, and goes on from there as before.
- **`answer`:** they asked something we can answer from what's known. A reply is drafted, and you're asked as usual.
- **`none`:** a thank-you, or they say it's sorted.

How it tells which comments count:
- **Ours never count.** A comment is ours if it was written by the account in the source's `self`, or if it repeats a reply we sent.
- **Old ones don't count.** Comments from before the ticket's first run are ignored.
- **Each comment is read once.** Comments that come in while a round is under way wait for it to finish.

After `maxFollowUps` rounds (5) on one ticket, its new comments are yours to read, and you're told once.

## What you set up, once

Everything below names your systems, so it goes in `engagement.json` in your private folder, not in this repo.

**1. The services**, one entry each:

```json
"services": [
  {
    "id": "payments", "names": ["PayAPI", "checkout"], "jiraComponents": ["Payments"],
    "dir": "payments", "build": "dotnet build", "test": "dotnet test --no-restore",
    "logs": { "kind": "files", "where": "\\\\pay-prod-01\\logs\\PayApi-*.log", "notes": "one file per day, times in UTC" },
    "sample": "samples/payments.log",
    "sop": "https://wiki.example.com/payments/support"
  }
]
```

- **`dir`** is where the service's code is in the engagement's repo. Seed it with `open --seed`, or let a shipping goal keep it in step with GitHub ([ship.md](ship.md)).
- **`logs.where`** is a folder the runner can read, with `*` in the file name for files that roll over. Read-only access for the account the scheduled task runs as is enough.
- **`sample`** is a short log file, with personal data removed, so the model sees the real format. Put it in the seed.
- **`notes`** covers what the sample doesn't show.
- **`test`** is the command the harness runs for the failing test and the fix, in the service's `dir`, on the runner. The runner needs the service's toolchain (the .NET SDK, say).
- **Let the turns run it too.** The failing-test and fix seats may run only the commands their grant names: `npm test` and `npm run build` by default (`shell:test` in `policy/harness-agents.json`). Add yours, for example `"--allow-tool", "shell(dotnet test)"` (Copilot matches the command and subcommand, whatever the flags), so a turn can try its test before it finishes.

**2. The goals:** one intake goal for new tickets, and one perpetual goal per service with `"service"` set to the service's id:

```json
"goals": [
  { "id": "intake", "title": "New tickets", "objective": "Route each ticket to its service", "owner": "partner", "scope": ["intake"], "assumptions": [], "budget": { "turnsPerWeek": 100 }, "perpetual": true },
  { "id": "pay", "title": "Payments support", "objective": "Answer and fix Payments tickets", "owner": "partner", "service": "payments", "scope": ["payments"], "assumptions": [], "budget": { "turnsPerWeek": 200 }, "perpetual": true,
    "ship": { "repo": "contoso/payments-api", "dir": "payments" } }
]
```

**3. The Jira rule,** which names the playbook instead of a lane. The source's `statuses` say where a ticket moves when it's routed and after a reply is sent:

```json
"events": {
  "sources": [{ "id": "jira-pay", "kind": "jira", "url": "https://jira.example.com", "jql": "project = PAY AND issuetype = Bug", "tokenEnv": "AF_JIRA_TOKEN",
                "statuses": { "routed": "In Progress", "replied": "Waiting for customer", "resolved": "Resolved" },
                "self": ["af-support-bot"] }],
  "rules": [{ "id": "bugs", "match": { "source": "jira-pay", "types": ["Bug"] }, "goal": "intake", "playbook": "jira-bug", "maxOpen": 3 }]
}
```

The token in `AF_JIRA_TOKEN` now also has to comment and change status. Give it an account that can do only that. Each status is matched by the transition's name or the status it leads to. `self` names that account, by its user name, email or account id, so its comments are never taken for the reporter's.

**4. Check it before it runs:**

```powershell
npm run harness -- logs test payments --terms u-4417,9001 --from 2026-11-04   # the excerpt the log job would fetch; writes nothing
npm run harness -- events test jira-pay                                      # what Jira returns, and which rule each ticket meets
```

## What it learns, and how it stays current

When a service goal opens, it gets a **first look**: one turn reads the code, the log sample and the commands, and records what it finds as facts. Later turns add facts too, such as where the refund code is, or how a line in the logs is laid out. Each packet in that service's goal starts from them.

```powershell
npm run harness -- facts                          # what's known, by service
npm run harness -- facts confirm payments logs.format
```

- A fact is **unconfirmed** until you confirm it. The newest fact on a subject replaces the one before it.
- A fact learned under an older version of the playbook is shown as **recheck**. Change the playbook's `version` when you change its process, and the old facts get checked again rather than trusted.
- A ticket's own working notes (hypotheses, what was tried) stay in that ticket's record. Nothing a turn guesses halfway through becomes a fact.

## What's not here yet

- **Log tools** other than files, such as Application Insights or Splunk.
- **Learning across tickets:** the close step, lessons proposed to you, and numbers per playbook.
