# A 47-second film: today and next

`docs/film/` holds a short film about AgentFactory, in English and in Chinese. It follows one Jira ticket through the firm in a single camera move. Then the camera pulls back to show a thousand engagements running at once, and ends on the one decision left for you.

![One ticket through intake, routing, review, evidence, your one question and the pull request](film/agentfactory.en.gif)

The full films are `film/agentfactory.en.mp4` and `film/agentfactory.zh.mp4`: 1080p with music, about 6 MB each. The GIFs are the seven seconds from the reply waiting for your Send to the merge. `film/social-preview.png` (1280 × 640) is the title frame, for the repository's social preview in its settings.

## What it shows, and what's real

The ticket, its id, the code and the numbers are made up. It's a P1 bug, `ORION-1427 · Checkout webhooks time out (EU)`, in Project Orion, a made-up payments platform. Each step stands for something AgentFactory does today:

1. **Intake.** A ticket comes in from Jira, next to a support ticket and a production alert: [events from outside](events.md) and the probes in [harness design](harness.md).
2. **Log.** Each one is written once to the engagement's event log, which lives in git.
3. **Triage.** A playbook takes the ticket, and its first step runs on the judges' strong model: which service, what to search the logs for, which time window. See [Jira bugs, triaged, diagnosed and answered](jira-bugs.md).
4. **Diagnose.** The logs are a job, not a turn: the runner saves the lines around the search terms. The code step finds where the bug lives. The diagnosis puts them together, and [the conductor](conductor.md) reads it before the bug branch is taken.
5. **Decide.** Belief comes only from graded evidence: an agent's opinion, then something reported, then a measurement. The reply to the reporter is a draft until you say send, and "from now on" makes an answer a standing rule. See [the harness's questions on Slack](harness-slack.md).
6. **Ship.** A test that fails on the bug comes first, and it must pass on the commit before it, so it proves the bug. Then the fix, which the whole suite must pass, goes up as a pull request with its checks and a review on another model. It merges once you approve; the loop never approves or merges by itself. After the merge, the "fixed" reply is drafted and the ticket is resolved once you send it. See [done work as pull requests](ship.md).

The bug playbook and the conductor have run in the simulated cases and the tests, not yet against a real Jira.

The last two steps are where it's going, not what it does today:

7. **Scale.** A thousand engagements, each waking on its own timer, with a quiet wake costing almost nothing.
8. **Learn.** Every answer is kept, and a judge looks back on every finished ticket and proposes lessons for the next one, which you keep or drop. Where it's going is a firm that asks you less and less, down to the calls that are only yours.

The clock, the counts and the pacing are illustrative.

## Rendering it

The film is code: `scripts/film/film.js` draws every frame as a function of time, and `make_en.py` builds the English cut from it. `music.py` synthesises the score, with each accent on something that happens on screen. `render.py` puts the frames, the music and the encoding together.

It needs Python 3.10 or newer and ffmpeg.

```bash
pip install playwright numpy scipy
```

```bash
playwright install chromium
```

```bash
python scripts/film/render.py en
```

Use `zh` for the Chinese cut and `--workers N` to set how many browsers render in parallel. It takes about a minute and a half with four. To check a change without a full render, `--preview 12 28.5` writes those moments as stills to `scripts/film/.cache/preview/`. The Chinese font, Noto Sans SC (SIL Open Font License), is downloaded into that cache the first time.

The render pipeline and the music's instruments follow [motion-atlas](https://github.com/skylarzzzz/motion-atlas) (MIT, `scripts/film/LICENSE-motion-atlas`).
