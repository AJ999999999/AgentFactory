# Events in: Jira tickets, user feedback, and scheduled checks of production

The harness today picks its own work from a goal's riskiest assumption. Work that starts outside it (a ticket, a complaint, an error spike) has no way in. This adds a front door without turning the harness into a ticket queue: each outside event either becomes work in a goal, or evidence on an assumption, or is only recorded.

**Where events come from.** Nothing on your PC can be called from outside, so the harness fetches them on its own schedule:

- **Jira**: a JQL query per source (`project = PAY AND updated >= -1d`), read with an API token from an environment variable, never from the repo. One event per ticket change: created, status changed, commented.
- **User feedback**: Jira tickets of a feedback type or label, through the same source; or a Slack workflow form that files them, read back the same way Slack answers are (`src/desk/slack.ts`).
- **Production logs and metrics**: the monitors goals already have (`MonitorDef`: a target, a cadence, what to do on change), with a probe that runs your query: a log search for new error signatures, a metrics query for a threshold. A metric read by a probe is a metric source, so it can carry `behavioral` or `measured` evidence; a turn reading the same numbers can only report them.

**One rule file.** `policy/event-rules.json` matches an event by source, type and labels, and says where it goes: which goal and lane (or which assumption it's evidence on, at what grade), the skill the seat gets, how many may run at once, and whether to tell you now, in the daily packet, or not at all. Rules route; permissions still come only from the permission catalog. Text in a ticket can raise a question but never grants access.

**Each event, in order:** checked against its source's token, deduplicated by `source + id + updated` (so polling twice writes once), matched, then queued as a todo in its goal, where the usual readiness and budget apply. An event no rule matches is recorded and nothing else. When the same source and type go unmatched often, the weekly digest says so, and the role factory can propose a rule for it, on probation like a generated role.

**Done when** a simulated case (a seventh in `src/harness/cases/`) runs Jira tickets, feedback and a metric probe through months of simulated time: duplicates written once, matched tickets worked within budget, a metric breach becoming measured evidence, unmatched events only recorded and counted.

Files: `src/harness/events.ts` (new: sources, dedupe, matching), `policy/event-rules.json` (new), `src/harness/world.ts` (a Jira source and a log/metric probe), `src/harness/harness.ts` (fetch in maintenance, before the rules run).
