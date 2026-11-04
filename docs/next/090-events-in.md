# Events in: what's left after Jira

Jira tickets come in and become work ([docs/events.md](../events.md)). Still to do:

- **Your Jira.** The JQL and rules for your projects, `events test` against the real server, and the token set where the scheduled task runs. Done in the office.
- **Production logs and metrics.** Goals' monitors take a probe that runs your log search or metrics query (`World.probe`). A metric read by a probe is a metric source and can carry `behavioral` or `measured` evidence. Needs your log and metrics tools; same office visit.
- **A rule for events nobody handles.** A notice already says when one source and type keep matching no rule. The role factory could propose a rule for them, on probation like a generated role.
