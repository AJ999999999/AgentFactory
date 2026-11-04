# One record: what's left

`harness trace` walks the engagement's own log back and forward ([docs/harness.md](../harness.md#looking-back-why-did-this-happen)). Still to do:

- **On a goal, on the panel.** A question's card shows how it came about; a goal could show its own timeline the same way.
- **Records outside the log.** The desk's session record (`%USERPROFILE%\.af\desk\events.jsonl`) and, once the CI loop exists, reviews and CI runs: indexed by a pointer in the engagement's log, so a trace can reach the session a turn ran in and the CI run that checked it.
