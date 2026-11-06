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

## The launch film

`film/launch.en.mp4` and `film/launch.zh.mp4` are a 41-second launch cut of the same ticket, made for the top of the README. Its structure follows the launch film of [SenseNova Code2Video](https://github.com/OpenSenseNova/SenseNova-6.8-Code2Video):

- a typed hook;
- three short cards: "No standups." "No babysitting." "Just your calls.";
- the title;
- five proof segments, each a turn's log beside what it produced: the triaged ticket, the diagnosis and the conductor's accept, your one tap kept as a rule, the test red on the bug and green with the fix, the pull request and its merge;
- a wall of a thousand engagements;
- an end card with `npm run demo:harness`.

Where that film shows each video's code next to the frame it renders, this one shows each turn's log next to its outcome. It shows the same steps as the story film above, and the same parts are real and illustrative.

It was made the way that project's `code-video` skill works:

- a spec first, `scripts/film/LAUNCH-SPEC.md`, with the copy, the cues and the checks;
- every frame a function of time;
- the music built from the film's own event list, so each hit lands on its frame;
- contact sheets and strips around the key moments, read before delivery;
- the final file checked for length, frame count and loudness.

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

```bash
python scripts/film/render.py en --film launch
```

The first renders the story film, the second the launch film. Use `zh` for the Chinese cut and `--workers N` to set how many browsers render in parallel. It takes about a minute and a half with four. To check a change without a full render, `--preview 12 28.5` writes those moments as stills to `scripts/film/.cache/preview/`. The Chinese font, Noto Sans SC (SIL Open Font License), is downloaded into that cache the first time.

## Checking a film

Two checks, both after [Code2Video](https://github.com/showlab/Code2Video): its layout critic, and its TeachQuiz, which measures what a viewer learned rather than how the film looks.

**Layout, from the frames.** This renders the film every 0.1 s and records where each piece of text really lands:

```bash
python scripts/film/check_layout.py en --film launch
```

It reports, as time ranges:

- text overlapping other text;
- text past the 3% safe area;
- copy under 26 px that stays on screen for 0.3 s or more.

It exits non-zero when it finds any. Both cuts of the launch film pass. The story film doesn't yet: many of its labels are 18 to 23 px, and its zoom-out keeps drawing labels after they shrink to a pixel.

**What a viewer learned.** `scripts/film/quiz/questions.md` has ten questions on what AgentFactory does. To run the quiz:

1. Give one frame a second of a film to a model that didn't make it. Tell it to answer from the frames alone, and to say NULL when the frames don't show the answer.
2. Give the same questions, with no film, to another fresh model. That's the baseline.
3. Score both:

   ```bash
   python scripts/film/quiz/score.py answers.txt baseline.txt
   ```

   It prints what the film taught.

The viewer also rates five things, out of 20 each, and names the hardest moment. That moment is what to fix next.

Results so far, with viewers on a different model from the one that made the films:

| | Quiz | Five ratings, out of 100 | Hardest moment |
|---|---|---|---|
| No film | 0/10 | | |
| Story film | 9/10 | 80 | the evidence bars, and a bare "review" dot that never says who reviews |
| Launch film, first cut | 10/10 | 87 | the conductor's stamp with no word on what it is; "from now on" cut off mid-word |
| Launch film, revised | 10/10 | 84 | the hook: "waiting on you" before the film has said what waits |

The launch film's later changes come from that last column: a line saying what the conductor does, a tag saying what "from now on" does, the event finished before the cut, and brighter secondary text.

The revised viewer cited the new conductor line and the "from now on" tag as its evidence for those two answers, which the first viewer could only infer. Its ratings came out three points lower. Ratings move that much from one viewer to the next, so they say less than the quiz and the hardest moment do.

The render pipeline and the music's instruments follow [motion-atlas](https://github.com/skylarzzzz/motion-atlas) (MIT, `scripts/film/LICENSE-motion-atlas`).
