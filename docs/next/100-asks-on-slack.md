# Slack: what's left

The harness's questions reach you on Slack and your taps come back by mail ([docs/harness-slack.md](../harness-slack.md)). Still to do:

- **Set it up for real.** Build the workflow and run `slack test` against your workspace, on the office PC where Outlook runs.
- **The loop has gone quiet.** A notice when the loop hasn't woken when it should. The loop can't report its own death, so this needs `doctor`'s heartbeat check run by the scheduled task on its own.
- **One message a day.** Cards due at the digest hour still go one by one; a single digest message listing them, each with its own Answer button, if Workflow Builder can loop over a list.
