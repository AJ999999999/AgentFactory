# A terminal animation of one engagement

`docs/cinetty/` holds a 15-second animation of AgentFactory that plays in a terminal. It's made with [cinetty](https://github.com/JosssphZhou/cinetty), a separate tool that turns one filled-in `project.yaml` into an animated diagram. Nothing in AgentFactory depends on it.

![The harness, the router, three seats and the partner, through one stretch of an engagement](cinetty/agentfactory.en.gif)

The same clip is in `cinetty/agentfactory.en.mp4`, with a Chinese version in `cinetty/agentfactory.zh.mp4` and `.gif`.

It shows when the partner is called, and why. [The architecture diagram](architecture.gif) maps the parts and follows one turn through them. This clip keeps the routing short and spends most of its 15 seconds on the three questions the harness brought to its one human in the simulated "Unreal 6 engine" case from `npm run demo:harness`:

1. **Over budget.** The estimate is about 60,000 turns against a budget of 400, so the harness asks whether to narrow the scope, raise the budget or stop. The partner narrows it: "pick a wedge we can win".
2. **Split the work.** The builder's page hits the trademark red line, a GPU job measures that meshlets hold 60 fps (FA) and that classic LOD doesn't (FB), and the strategist, a judge on Claude, writes the contracts. The harness then asks to spawn three workstreams (renderer, editor, assets) with part of the remaining budget. The partner approves.
3. **Criteria met.** Every success criterion is met. The harness never closes a goal by itself, so it asks. The partner keeps the goal open while the workstreams build.

The partner's column shows what the partner reads first: the status packet's beliefs, open work and why it waits, then the one question. The questions' wording comes from the rules (`src/harness/rules.ts`, `validate.ts`), and the answers and numbers come from the simulated case. The clock, the pacing, the turn counter and the "packet read" counter are illustrative. Each router bar is 1.00 where a rule decides and 0.00 where the call is the partner's. The harness doesn't use probabilities.

## Playing it

It needs Python 3.12 or newer, Bash and Make, on macOS or Linux, in a terminal of at least 90 × 46 cells.

```bash
git clone https://github.com/JosssphZhou/cinetty && cd cinetty && make setup
```

```bash
make play INPUT=/path/to/AgentFactory/docs/cinetty/project.en.yaml
```

Use `project.zh.yaml` for the Chinese version and `LOOP=1` to repeat it. `make once INPUT=... AT=7` prints one moment as text. After you change a file, `make check INPUT=... FORMAT=json` lists anything that won't fit. To keep a clip, record the terminal, or render one as below.

## How the clip was made

The GIF and MP4 aren't a screen recording. `scripts/render-cinetty-clip.py` asks cinetty's engine for every frame at 30 fps, draws each one the way a terminal would (JetBrains Mono, black background, block glyphs as boxes so the bars stay seamless), and ffmpeg joins them. So no frames are dropped, and the result is the same on any machine. Run it again after you change a `project.yaml`:

```bash
/path/to/cinetty/.venv/bin/python scripts/render-cinetty-clip.py /path/to/cinetty docs/cinetty/project.en.yaml
```

It runs with the Python in cinetty's `.venv`, which `make setup` gives Pillow. It also needs ffmpeg, and the JetBrains Mono and WenQuanYi Zen Hei fonts; set `CINETTY_FONT_DIR` and `CINETTY_CJK_FONT` if yours are elsewhere.
