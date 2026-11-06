# The constitution: critical thinking and reflection, whichever model runs the turn

Every turn, on every CLI and every model, reads the same two principles before its role: think critically, and reflect. They live in one file, [`policy/constitution.md`](../policy/constitution.md), and `turnPrompt` puts it right after the handoff packet. A model swap, a new CLI or a generated role can't lose them.

## Why it exists

Models read "be careful" and "think critically" in their own ways. Some hedge everything. Some write a tidy "on the other hand" paragraph that changes nothing. A seat can move from one model to another with a line of config, so whatever quality the firm relies on can't depend on which one is running.

So the constitution asks for things a turn can do and a reader can check, not virtues:

- **Critical thinking:** name the assumption the work leans on most, check it or say it's unchecked, keep what was seen apart from what was inferred, and look for what would prove the work wrong before calling it done. Disagreeing with a reason is expected; quietly following a plan the turn doubts is the failure.
- **Reflection:** before finishing, compare what the turn expected with what happened. The note ends with `Doubt:` (the weakest point) and `Surprise:` (what didn't go as expected). A failed attempt isn't repeated a third time. A lesson stays an opinion until a person keeps it or the world bears it out.

## What it can't do

It changes how a turn works, never what it may do. Permissions still come only from the permission catalog, and evidence grades don't change: a turn that "thought critically" still records only opinions or sourced reports.

Text alone doesn't guarantee the behaviour. What holds it is that the output can be checked:

- The conductor and the reviewers read each note's doubt against the work.
- Every note is in the event log.

The next step is counting doubts and surprises across turns, along with send-backs and thrown-away turns, by cause. That's [docs/next/160](next/160-harness-findings.md).

## Changing it

Edit `policy/constitution.md`. Keep it short: every turn pays for it in tokens. Keep each line something a reader of the turn's output could check. It's the firm's, not a role's, so role-specific advice belongs in that role's profile under `integrations/copilot/harness-agents/`.
