# The launch film: spec

A 41-second launch film for the top of the README. It borrows the structure of SenseNova Code2Video's launch film: a typed hook, three punch cards, a title, proof segments, a wall, an end card. Its proof is "terminal beside outcome": each segment shows a turn's log next to what it produced, the way that film shows code next to the frame it renders.

## Format

- 1920 × 1080, 30 fps, 41 s (1,230 frames), no loop.
- Stereo music and effects, synthesised from the film's own event list (`window.SOUND_EVENTS`). No voice.
- English cut first; the Chinese cut takes its copy from the same table (`COPY.zh`).
- Built by `python scripts/film/render.py en --film launch`, which writes `docs/film/launch.en.mp4` and `.gif`.

## Structure and cues (120 bpm, one bar = 2 s)

| Time | Section | What's on screen |
|---|---|---|
| 0–4 | Hook | One terminal, typing `npm run harness -- loop`, then the loop's first lines |
| 4–10 | Punch cards | "No standups." · "No babysitting." · "Just your calls." |
| 10–12 | Title | AgentFactory, and what it is in one line |
| 12–16 | Triage | A triage turn's log · the Jira ticket gets its service and status |
| 16–20 | Diagnose | The logs excerpt the job saved · the diagnosis, then the conductor's accept |
| 20–24 | Your call | The answer written to the event log · the Slack card, Send tapped, "from now on" ticked |
| 24–28 | Failing test first | `npm test` red with the new test, green on the base commit, green after the fix · the test file |
| 28–32 | Ship | The review on another model, posted as a comment · the pull request, its checks, Merge |
| 32–36 | Wall | A thousand engagements, and one partner |
| 36–41 | End card | The name, the line, `npm run demo:harness`, the repository |

Downbeats carry the cuts; the merge at 30 s and the end card at 36 s carry the two biggest hits.

## Exact copy

Only what the harness really does (see `docs/jira-bugs.md`, `docs/conductor.md`, `docs/ship.md`). The ticket, its id, names, file names and numbers are made up and say so in `docs/film.md`. Commands are the repository's own (`npm run harness -- loop`, `npm test`, `npm run demo:harness`). No logos of other products: the Jira, Slack and pull request cards are plain cards with a word for a label.

## Checks

- Text at 1080p: headings and copy at least 28 px; terminal text at least 20 px.
- Each line of copy holds at least `letters / 15 + 1.5` s after it lands.
- Contact sheet at 1 frame per second, read end to end; strips around the tap (22 s), the red-to-green (24–27 s) and the merge (30 s).
- Duration, frame count and audio length checked on the final file.
