# One record: what's left

`harness trace` walks the engagement's own log back and forward ([docs/harness.md](../harness.md#looking-back-why-did-this-happen)). Still to do:

- **On the panel.** The same trace as a timeline on a question's card and on a goal.
- **Workstreams to their approval.** A spawned goal links to its parent but not yet to the answer that approved the spawn (its events' ids come from the spawn, not the answer).
- **Records outside the log.** The desk's session record (`%USERPROFILE%\.af\desk\events.jsonl`) and, once the CI loop exists, reviews and CI runs: indexed by a pointer in the engagement's log, so a trace can reach the session a turn ran in and the CI run that checked it.
