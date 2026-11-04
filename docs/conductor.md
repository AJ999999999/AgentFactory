# The conductor: a strong model that catches work going the wrong way

When a turn says its todo is done, the conductor reads what it did before the work counts. It runs on a strong model (Opus by default), different from the workers'. If the work went the wrong way, the conductor sends the todo back with specific directions, and the next turn reads them. Otherwise the todo is done.

It's off by default. Turn it on in `policy/harness.json`:

```json
"conductor": { "maxRedirects": 1 }
```

## Why it exists

In early runs, turns sometimes went the wrong way at the start: half a feature built, the wrong file changed, a contract misread. Checks pass, so nothing stops them. The work merges, later todos build on it, and the mistake costs several turns before anyone sees it. The harness had no one whose job was to notice.

The conductor is that someone, for as long as the harness needs it. Every time it sends work back, it records why. Those reasons show what to fix in the agent profiles, the contracts or the rules, so the same mistake stops happening. Once it rarely sends anything back, it can be turned down or off.

## What it does, step by step

1. **A worker finishes.** The turn says `"done": true`, its files pass the checks and they merge, as before.
2. **The todo waits in review.** Work that depends on it doesn't start yet. A `conduct` todo is added for the conductor, naming the todo, the files, and the worker's note.
3. **The conductor reads.** It gets a fresh checkout of main with the work in it, and read access only. It judges the work against the todo, the goal's objective, its contracts and the partner's answers.
4. **It gives a verdict.**
   - **`accept`:** the todo is done, and the work waiting on it can start.
   - **`reject`, with directions in `note`:** the todo is sent back. The next turn's packet starts with "Sent back:" and the directions. The merged work stays, so the next turn fixes it rather than starting over.
5. **It can also ask the partner** a question, like any agent. It can't close a goal, change a budget or grant access.

## Limits that keep it from getting in the way

- **One redirect per todo by default** (`maxRedirects`). After that, the todo's next finish goes straight to done. The conductor has had its say, and other checks still apply.
- **It only reviews finished work in work lanes.** Judge lanes, reviews and the conductor's own todos are never sent to it.
- **Other reviewers come first.** A todo a named person reviews, or a role on probation whose work goes to the blind reviewer, skips the conductor. They already have an independent check.
- **`lanes`** limits it to some lanes, for example `["build", "research"]`.
- **`skipChecked: true`** skips todos whose own checker passed. Off by default, because a checker that passes can still miss half a feature: in the eval, that's how part of the multi-currency feature went undone.
- **Its turns count against the goal's turn budget**, like any turn. A conductor that never sends anything back is costing turns for nothing, and its numbers will show that.
- **If its todo is dropped, the work is done.** The conductor gives advice; losing that advice shouldn't lose the work. This is the opposite of a probation review, where dropping the review drops the work.

## Which model runs it

The conductor's role is `conductor`, on the judges' placeholder `model-b`. That's `claude:opus` by default, so it runs in Claude Code. `checkLibrary` refuses to start if it shares a model with the work it judges.

To run it in Copilot CLI instead, set `model-b` in `policy/harness-agents.json` to the Copilot id of the model you want (run `copilot --help` or `/model` to see the ids your plan has). That moves the other judges too. Then make sure the workers' `model-a` is a different model.

## What it records, and how to read it

Each verdict is a `conduct_verdict` event: the todo, its lane and seat, the verdict and the directions. `npm run harness -- escalation` lists:

- how many finished todos it read, and how many it sent back, by lane
- its latest reasons for sending work back

A high send-back rate in one lane points at that lane's profile or its contracts. Fix the cause there, and check that the rate falls. That's how the conductor makes itself unnecessary.

## Is it worth it?

The eval answers that. Arm E is arm B with the conductor on:

```bash
npm run eval -- --arms B,E --runs 2
```

Compare the scores, the premium requests, and how many turns were thrown away or redone. Turn it on by default only if E scores better for a cost you accept.

## How it's built

- `validate.ts`: a finished todo in a work lane goes to review with a `conduct` todo, when the policy has `conductor`. The conductor's verdict sends the todo to done or back to open.
- `rules.ts`: a dropped conductor todo lets its work through.
- `project.ts`: counts each todo's redirects; a sent-back todo keeps its directions until its next turn.
- `packet.ts`: a sent-back todo's packet says why it was sent back. This applies to every send-back, including a person's and a probation review's, which before were never shown to the next turn.
- `policy/library.json`: the `conductor` role and the `conduct` lane, a judge lane.
- `integrations/copilot/harness-agents/af-conductor.agent.md`: its instructions.
- `src/eval/run.ts`: arm E.
