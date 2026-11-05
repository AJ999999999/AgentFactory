# Intake: check the plan against what we know before anything is built

When any model can write good code, the plan decides most of what the product turns out to be. But a more detailed plan isn't a better one. In the second private engagement the spec was precise: four exact trading rules. Every step finished, every test passed, and the review agreed the code matched the rules. Then the first run on real data showed it almost never traded, because two of the rules almost never hold on the same day (see 200). The real data was there the whole time. Nothing at intake asked how often the rules would fire, and a query on the first day would have answered it.

So intake's job is to break the plan into the assumptions it rests on and settle each one the cheapest way it can. Only what nothing else can settle goes to the partner, and it gets there before the build starts.

## What intake does

1. **Gather what we already know.** Memory about the partner and the people the work is for (`docs/memory.md`), the facts the firm keeps about its systems (where a service lives, where its data is), the seeded repo, and any data the engagement can reach. Write down what's missing too. "Is there real data, and where is it?" is a question to check, not something to assume.
2. **Draft the spec and sort every claim in it.** Two or three models draft it independently. Each claim in the merged draft goes into one of four buckets:
   - **Already known.** It comes from memory, the facts or the code, so intake fills it in. Memory's rules still apply: an old or contested preference becomes a "still true?" question, never a silent default.
   - **Checkable now.** Data or code can answer it. It becomes a `job` before any build todo, and its result is measured evidence.
   - **Only the partner can decide.** Goals, taste, risk, money.
   - **Cheap to change later.** An agent decides, the choice is recorded, and the daily spot check samples these choices.

   Where the drafts disagree, look there first. Disagreement points to an assumption nobody stated.
3. **Run the checks.** The "checkable now" jobs run on the runner, with the runner's own access, the way the Jira bug playbook fetches logs.
4. **Ask once, with the evidence.** One decision packet of five questions at most, ranked by what a wrong answer would cost. Each question carries a recommendation, the evidence behind it, and what each choice would change. For the trading engagement, that's not "what should the entry rules be?" but: "Your rules all hold on about 3 days a year. Loosen rule B (about 40 trades a year), loosen rule C (about 25), or is rare on purpose?" The answers become decision files that every later packet links to (see 210).
5. **Gate the build with what exists.** Build todos `assumes` intake's load-bearing assumptions, so they wait until those are supported. The thresholds set at intake ("it acts at least N times on a year of real data") become the job that runs the result before it counts as done (200).

## Keep it from turning into a long upfront phase

- **Settle only what would force a rebuild.** Some questions can only be answered after a rough prototype. Leave those to the evidence the build produces.
- **The questions that are always the partner's stay theirs:** money, direction, and closing a goal. Any other kind of intake question earns its place the way other questions do: by how often the partner's answer changes something (`escalation`).

## How we know intake is working

Count what intake missed: decisions that come up after the build has started. These are the conductor's send-backs, the partner's corrections, changes of direction, and failures of the job that runs the result. Each one names a check intake could have run or a question it could have asked. As with the checks `open` runs, each miss becomes a new intake check, not only a note. `escalation` reports the count per engagement, and it should fall over time.

## Open questions

- **Whether this belongs in the foundation.** The foundation's challenge process already decides what to build and the assumptions it rests on. If the trading engagement skipped it and was opened straight into building, then part of this is a gap in how engagements are opened, and `open` should warn about a build goal with no intake.
- **As a playbook or inside `open`.** The Jira bug playbook gives a ready-made shape: intake becomes the playbook's head (gather, draft, check, ask), and its fork is "build", "needs data" or "stop".
- **Whether several drafting models are worth the tokens.** Add an eval arm: one model drafts the spec, against three models drafting and a judge merging. Compare scores and how many decisions still come up late.
