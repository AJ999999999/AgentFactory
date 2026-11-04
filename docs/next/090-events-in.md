# Events in: what's left after Jira

Jira tickets come in and become work ([docs/events.md](../events.md)). Still to do:

- **Your Jira.** The JQL and rules for your projects, `events test` against the real server, and the token set where the scheduled task runs. Done in the office.
- **Feedback as evidence.** A rule can route an event onto an assumption instead of into a todo: a feedback ticket as `stated` evidence on a desirability assumption, at the grade its source has (a source's grade is set once, in the engagement, never by a rule or a ticket).
- **Production logs and metrics.** Goals' monitors take a probe that runs your log search or metrics query (`World.probe`). A metric read by a probe is a metric source and can carry `behavioral` or `measured` evidence. Needs your log and metrics tools; same office visit.
- **Events nobody handles.** When one source and type keep matching no rule, the weekly digest says so, and the role factory can propose a rule for them, on probation like a generated role.
- **Cloud sign-in.** Atlassian Cloud's email-and-token sign-in, if a Cloud Jira ever comes in.
