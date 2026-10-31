# The long-running harness

The foundation decides what to build and which assumptions the decision rests on. The harness keeps an engagement moving for weeks or months after that, with no human acting as the clock. It wakes, picks one bounded piece of work, hands it to the right agent, checks the result independently, records it in git, and says when to wake next. It brings a person in only for decisions that are theirs, for money, and for work only a person can do.

LoopX (an open-source control plane for long-running agents) showed the shape of the loop: a bounded turn, a "should I run" check that costs nothing, claims, writeback before spend, scheduler hints, and handoff through successor todos instead of a leader. The rest of the design came from walking six very different engagements from intake to an MVP, a change of direction and implementation, and from simulating each one through the real code. The simulations found ten design flaws, listed at the end.

```bash
npm run demo:harness                  # all six cases, simulated, with a timeline each
npm run demo:harness -- senior-meds   # one case
npm test                              # includes 44 harness tests (rules, team, cases, stress)
```

## The six cases

Three cases came from you; I added three to cover what those don't: production systems, pure research, and work that never ends. Each case is a real engagement definition with scripted agents, a simulated world (jobs, metric sources, feeds) and scripted people who answer late, or not at all. The tests assert behavior, not just that the run finished.

### 1. "Build an Unreal 6 game engine"

What makes it hard over a long run:
- The request is far out of proportion to any budget: engines on that scale took decades and hundreds of engineers.
- "Unreal" is Epic Games' trademark.
- The real technical risk is measured on GPUs that only some runners have.
- Competing approaches have to be tried in parallel and the losers dropped.
- The team should only grow once the contracts between workstreams exist.
- A competitor's announcement mid-way must not flip the direction on its own.

What happens in the simulation:
1. **Scope first.** The first turn is an outside-view estimate: about 60,000 turns against a budget of 400. Because that's more than 1.5 times the budget, the harness asks the partner before anything is built.
2. **Narrowing.** The partner narrows the goal to a wedge: a stylized renderer with a hot-reload editor. The original "build the core" todo assumed the old scope, so it's dropped.
3. **Demand before code.** The riskiest new assumption is demand, so the landing page and waitlist go first. The first landing page says "Unreal-class"; the trademark red line throws that turn away, and the second attempt is clean.
4. **Spikes on GPUs only.** Two renderer spikes run in parallel. Their benchmarks run only on the GPU runner, three runs each, against thresholds set before the data existed.
5. **The partner picks.** An agent turns the benchmark numbers into a decision for the partner (74 fps against 41), and the partner picks the meshlet renderer.
6. **Teams after contracts.** Contracts are written. The split into workstreams waits until the waitlist proves demand. Three workstreams are then spawned, with 150 turns carved out of the parent's budget; because that's more than a quarter of what's left, the partner approves it. Each workstream gets its own seats as its work appears (renderer, editor and assets each get a builder). The spikes run on the experimenter's model; synthesis runs on a third.
7. **The competitor news.** On day 45 a competitor ships a stylized preset. A monitor turns that into a research todo. The agent's web-sourced finding against the demand assumption is only a weak signal, so it earns a proper re-test (activation among waitlisted developers) instead of a pivot. Demand holds.

### 2. "SpaceX Starship 3D printing for kids"

What makes it hard:
- The brief is ambiguous: kits or lessons, parents or schools?
- The brand belongs to someone else.
- It's a children's product, so safety matters.
- Demand is the real unknown, but designing the rocket is the fun part, so everyone wants to start there.
- Market tests take weeks and cost money.
- Lawyers and people with printers have to do part of the work.
- The first market is likely the wrong one.

What happens:
1. **Demand first.** The first turn is the landing page, because demand carries the highest risk times uncertainty. The CAD design assumes demand, so it never runs in the first version.
2. **Money right before it's needed.** The $200 for ads is requested only once it's the last thing in the way, and the ads start after approval.
3. **A frozen test.** While the ads run, the landing page is frozen. A todo to "tighten the copy" waits, and is dropped when the test settles the question.
4. **What counts as demand.** 80% of surveyed parents said they'd buy. That's stated interest, and it doesn't count: pre-orders are 1.1% of visitors.
5. **The lawyer decides the name.** The trademark question goes to the IP lawyer, whose answer counts as expert evidence. "No" drops the branded work at once, because the name isn't load-bearing.
6. **The pivot.** The pre-order conversion trips the kill criterion and refutes demand. The partner pivots once (the second, redundant question becomes moot) to classroom packs for teachers. The old plan's work is dropped.
7. **Roles nobody planned.** The firm's library has no role for CAD or for lesson plans, so both get roles generated for the lane, with the least access and on probation. The CAD role's work is vouched for by the printability checker. The lesson plans have no checker and no named reviewer, so an independent reviewer on another model reads them, sends the first draft back (the launch lesson had no safety rules for 8-year-olds) and accepts the second.
8. **The second version.** It runs a teacher-marketplace test ($150, approved), a print test by a teacher with a printer (three prints), and a toy-safety review. It closes as done after spending $350 of $500 and 9 model turns.

### 3. "A medicine and supplement AI assistant for seniors"

What makes it hard:
- Wrong advice can hurt someone.
- Whether it's regulated depends on what it does: reminders and label information, or patient-specific dosing.
- Only named experts can sign off on safety and regulation, and they're slow.
- The web is full of confident, wrong supplement advice, and some of it is written to steer AI agents.
- The drug data changes after launch.

What happens:
1. **Unrelated work keeps moving.** While the regulatory consultant takes five days, accessibility research and the voice-first app shell go ahead. The interaction rules, which assume the product isn't regulated device software, wait.
2. **Dosing is dropped.** The consultant says patient-specific dosing would make it a device, so the dosing feature is dropped without a turn ever being spent on it.
3. **Unsafe output is thrown away.** The first draft of the rules tells people to double a missed dose; the red line discards the whole turn.
4. **Blog "evidence" is refused.** The second draft cites a supplement blog as "expert" evidence. That's refused (agents can't record expert evidence), and the blog's content is marked untrusted.
5. **Expert and measured sign-off.** The rules come from a generated role (the library has no clinical-content role), and they go to the pharmacist, whose approval counts as expert evidence for the safety assumption. A named expert's review stands in for the agent review a role on probation would otherwise get. A red-team job (300 risky questions, 3 runs, 99.5% refusals) supports the refusal assumption, and a 4-week pilot supports demand.
6. **The labels change after launch.** On day 60 the drug label feed changes. The monitor bumps the versioned basis, the interaction rules (pinned to the old version) go stale, and a priority-0 rebuild goes back through the pharmacist. The partner gets an urgent notice.

### 4. Added: moving a legacy order system

None of the first three touch production. A migration has no market risk; its risks are correctness against a system people rely on, other teams who own contracts, change freezes, irreversible steps, and a finish line that has to stop the work.

What happens:
1. **Shadow testing doesn't wait.** Build and shadow testing run while the billing team takes 38 days to sign off the contract.
2. **"Fix and test again" keeps the plan.** The first shadow week matches 99.6% of orders, below the 99.9% bar. The partner chooses "fix and test again": the old evidence is reset and the cut-over plan survives. The second shadow week passes.
3. **The holiday freeze.** The final cut-over becomes ready inside the holiday freeze. The harness sleeps through it (no more than 3 full wakes after the first two days of the freeze) and starts the cut-over at 00:00 on January 5.
4. **People own the irreversible steps.** Go/no-go and decommissioning are actions for a person.
5. **Done means stop.** When traffic is fully moved and legacy is off, the goal closes and the runner stops.

### 5. Added: an open research question

"Can a 7B model fine-tuned on our repos beat our assistant on our own tickets?" There's no product until it's answered, a negative answer is a real result, experiments are expensive and noisy, and an agent can read papers forever.

What happens:
1. **Private data waits for a person.** The dataset comes from the company's own tickets. The data engineer's seat needs access to private data, which the catalog says only the owner can grant, so the partner is asked once. Only the data lane waits; the literature review runs meanwhile.
2. **The going-nowhere review.** The literature review produces three turns of notes and no sources. That counts as spin: a replan (priority 0) drops it.
3. **Contradicting results.** Config A's evaluation refutes the hypothesis (−3 points) and config B's supports it (+2). The harness doesn't ask the partner about direction while B is still running. When the results contradict each other, an independent synthesis finds that 12% of B's evaluation tickets were in its training data and discounts it, with that reason.
4. **The negative result.** The refutation stands, and the partner turns it into the next question: does retrieval lift the assistant by 5 points? It does (+7, three runs), and the goal closes.

### 6. Added: keeping an open-source library healthy

The other cases end; this one doesn't. Most days nothing happens, and the failure modes are the opposite: busywork, polling costs, a "done" that shouldn't close, and an emergency that must jump the queue.

What happens over 45 days:
1. **Four events, four turns.** An issue, a dependency release, a security advisory and another issue: 4 model turns in total.
2. **Busywork refused.** The "improvements" the agent invented each time it triaged an issue (refactor the loader, rewrite the README) are refused because nothing motivated them.
3. **The advisory jumps the queue.** The security advisory becomes priority-0 work and is patched within one monitor interval. A person approves the release.
4. **Never "done".** The goal is perpetual, so nobody is asked whether it's done.

## Mechanisms

Each mechanism is here because at least one case needed it.

### Time and waiting

- **The wake.** Every wake starts from git, never from a transcript or memory. The steps are:
  1. Reap work left by dead runners.
  2. Check monitors that are due.
  3. Poll jobs and waits.
  4. Apply the rules.
  5. Commit.
  6. Start jobs.
  7. Run up to `slots` model turns.
  8. Say when to wake next.

  A quiet wake (main unchanged, no timer due) is one `git ls-remote`. A wake that finds nothing to do commits nothing.
- **Four kinds of waiting, none of them costing turns.** A *job* is an external run with a handle: a build, a benchmark, training. A *wait* is a calendar or metric window: a market test, a pilot. An *action* is work only a person can do: print a part, run usability sessions, decommission. An *ask* is a decision.
- **Polling.** Jobs that report an expected finish time aren't polled before it. Waits aren't judged before their minimum window, which is how tests avoid being stopped early on noise.
- **The calendar.** `notBefore` dates and blackout windows (per lane) hold work, and the wake time is set to when they end.
- **Monitors.** A monitor's first look is a baseline. A change adds work, asks someone, or bumps a versioned basis record. An expired monitor stops and never catches up.

### What we believe, and who decides direction

- **Belief is computed from evidence, never claimed.** An assumption is supported, refuted or contested only by findings of a grade its category accepts: behavior for demand, measurements or experts for feasibility, experts for compliance and safety. Each engagement can override this. Measured evidence needs three runs, and untrusted content never counts.
- **Grades come from the world, not from whoever writes the finding:**
  - Agents can only record opinion or reported (sourced) findings.
  - Jobs produce measured findings.
  - Metric sources have their own grade: a survey is stated, pre-orders are behavioral.
  - People listed as experts give expert evidence.
  - Anyone doing an action reports a measurement.
- **Pass lines are stated before the data exists.** An owner's pre-registered threshold binds every test of that metric. A test of another metric must state its own threshold when it's proposed.
- **`tests` and `assumes`.** A todo either produces evidence for an assumption or is only worth doing if the assumption holds. Work that assumes something waits until it's supported, and is dropped when it's refuted. For load-bearing assumptions, the owner decides first.
- **The phase is derived, never configured.** It's the category of the riskiest unsettled assumption, which is why the kids case starts with demand and the medicine case with regulation.
- **Asking about direction:**
  - A refuted load-bearing assumption, or a tripped kill criterion, asks the owner: pivot, fix and test again, stop, or continue without it.
  - The question waits while another test of the same assumption is still running.
  - Kill criteria are judged on world evidence gathered during the current version of the goal; an agent's numbers never trip them.
  - Questions about a direction the goal has already left become moot.
- **Weak signals and contradictions.** A weak signal against a load-bearing assumption (a blog post, a competitor's announcement) earns a proper re-test, not a pivot. Contradicting evidence gets an independent synthesis, which may discount a finding with a reason; synthesis can never discount its own evidence. If the conflict remains, the owner is asked.
- **Too many direction changes.** More than two pivots in 60 days asks the owner to hold a direction.

### Controlling the work

- **Claims, then leases.** A claim on a todo (an atomic ref push) comes first, so two wakes never do the same work. Path leases then guard the files. A turn that outlives its claim is thrown away at writeback, and the turn is recorded once.
- **Gates are scoped by the dependency graph, not by agent.** A question blocks only the todos that depend on it, or the whole goal when it's about the goal. Agents are ephemeral here, so blocking by agent identity would block nothing or everything.
- **Experiment freeze.** A running job or wait can freeze paths. No todo that writes there can run, and a turn that changes them is discarded. This keeps agents from "improving" the landing page halfway through the market test.
- **Spin is measured by outcome, not activity.**
  - A turn counts as substantive when it settles or produces evidence, finishes work someone planned, or passes a checker.
  - Three thin turns in a row force a replan that holds other work in that goal. A thin replan stops the goal and asks the owner.
  - Every todo has a turn cap (6 by default), because a model that keeps "making progress" without finishing is a loop too.
  - Three failures in a row stop retries and ask.
- **No busywork.** Every todo an agent proposes needs a reason to exist: the assumption it tests, or the finding, question or todo behind it. Agents can't propose urgent priority, survival across a pivot, a bigger turn cap, closing a goal, or a budget change.
- **Spawning workstreams.** Spawned workstreams need disjoint scopes inside the parent's. The contracts they build against must already exist. Their budgets are carved out of the parent's, and spawning needs the owner's approval above a quarter of the remaining budget. A parent closed as done leaves its workstreams running; a killed parent stops them.
- **Budgets and fair share:**
  - Turns are counted whether they succeed or fail. LoopX doesn't charge failed turns; that's fine for a scheduler, but with metered Copilot usage a flaky agent would loop for free.
  - Money is approved before it's spent, and asked for only when it's the last thing in the way.
  - GPU hours are checked before a job starts.
  - An agent's scope estimate far over budget asks before anything is built.
  - Among goals, urgent work goes first. Then the goal furthest below its compute share. Within a goal: priority, then risk × uncertainty, then age.

### Who does the work

The user's brief says what to achieve; it doesn't say who should work on it. The team is derived from the work, the way the phase is derived from the evidence:

- **A seat per lane, per goal.** The first open task in a lane of a goal staffs a seat for it. A spawned workstream gets its own seats. Jobs, waits and actions need no seat (they're machines and people).
- **From the library when it can.** `policy/library.json` maps lanes to roles: research to a researcher, build to a builder, experiments to an experimenter, private data to a data engineer, replan and synthesis to a strategist, and so on. A seat takes the role's model, skills and custom agent.
- **Permissions come only from the catalog.** A role's list is filtered through `policy/permission-catalog.json`: anything the factory can't grant is dropped, so a role edited to ask for more gets nothing more. A permission that needs a decision (reading the client's private data) asks the goal's owner once, and only that lane waits. Copilot CLI tool flags are built from the seat's permissions; a seat that can't write gets `--deny-tool write`.
- **Generated when it must, on probation.** A lane the library doesn't cover (CAD, lesson plans, clinical content) gets a role generated for it: the fallback agent, the least access (read, and write inside the todo's scope), and a charter in its prompt. Its finished work counts only after someone vouches for it: a passing checker, a named person's review, or else an independent reviewer on a different model, read-only, who must accept or reject. A rejection sends the work back with the reason. Three acceptances in a row end probation. Two rejections in a row ask the owner whether to keep trying or drop the lane's work, and only that lane waits. Dropping a review drops the work it was reviewing, so nothing slips through unreviewed.
- **Judges don't share the model they judge.** Replan and synthesis judge every lane, and probation reviews judge generated roles, so they run on a different model. The CLI refuses a library that breaks this.
- **Who did it is the seat, not the machine.** Every turn records its seat, and "you can't discount your own evidence" is checked by seat. A strategist and a researcher running on the same laptop are different agents; one runner identity used to make them the same.

### Continuity

- **State lives only in git.** Every event is a file on main, never edited. Claims and the "last checked" times live in refs; losing the latter costs one extra check. A fresh clone projects exactly the same state, which a test checks.
- **Rules can run anywhere.** Rule-generated events have ids derived from their cause, so two machines noticing the same thing write it once.
- **The handoff packet.** It's generated from state, never written by a model, and stays under 16 lines and 1,800 characters however long the engagement has run. The full record is one command away.
- **What the people it serves have told us arrives as defaults, never as permission.** An engagement that declares a principal and subjects gets that principal's current memory in its packets: the defaults that apply, and what to check first. Lapsed plans, other subjects and guesses we made ourselves never pass as preferences. See the README's memory section.
- **Time follows cause and effect.** The log is ordered by time, and machines' clocks disagree. A writer never stamps an event earlier than the latest event it has read: the stamp is the wall clock, nudged forward by a millisecond only when the clock would contradict what the writer saw.

## What the simulations caught

Each of these was a flaw in the design, found by running a case, and fixed before the tests were written:

1. **Closing a parent stranded its workstreams.** When the engine's discovery goal closed as "done", the three workstreams it had just spawned were blocked for good. Now only a killed parent stops its children.
2. **Research on an assumption the goal had dropped kept running**, and its evidence settled the new goal's key question by accident.
3. **A synthesis with no output ran hundreds of times in one simulated morning.** Each turn wrote a note, and a note was counted as progress. Now a note alone is thin work, and every todo has a turn cap.
4. **A direction question was asked while the second experiment was still running.** The partner pivoted on half the evidence. Now direction questions wait for tests already in flight.
5. **A refuted load-bearing assumption deleted the cut-over plan** before the partner could choose "fix and test again". Now the owner decides first.
6. **Two questions about the same refutation produced two pivots.** Now questions about a direction the goal has left become moot.
7. **"Is this goal idle?" was asked on top of "every success criterion is met".**
8. **A competitor-triggered review was dropped as "question already settled"**, which defeated its purpose. Work triggered by a new event is now exempt.
9. **Quiet wakes cost about 15 git calls.** Now it's one `ls-remote` when nothing has changed. The stewardship case went from 73 to 26 seconds of simulation.
10. **A review that landed in the same millisecond as the work it reviewed was replayed first.** The log was ordered by each machine's clock with ties broken by id, so "sent back" was applied before "sent for review", and the lesson plans were stuck in review forever. A runner whose clock is a few seconds behind would do the same. Writers now never stamp before what they've read.

## Running it

```bash
npm run harness -- open case:kids-rockets            # or your own engagement JSON
npm run harness -- tick --world case:kids-rockets    # one wake
npm run harness -- loop --runner laptop --caps shell # keep waking; sleeps as told
npm run harness -- status --packet                   # beliefs, open work, what it's waiting on, questions for you
npm run harness -- answer ask-spend-ads --choice approve
npm run harness -- answer ask-action-playtest --choice done --result supports --metrics attempts_to_clear=9 --note "finished on attempt 9"
npm run harness -- pause --reason "away this week"  # nothing new starts; running jobs still finish
npm run harness -- resume
npm run harness -- budget kids turns=300             # answers the budget question if one is open
npm run panel                                        # all of the above, in a page on this PC
```

`open` also takes `--world <module>` (checkers and providers, saved with the engagement) and `--seed <dir>` (files committed into the engagement repo first, such as a brief). An answer is recorded as the role the question was addressed to unless you pass `--by`, because the grade of what you report depends on who you are. Agents see the answers their work depends on, directly or through earlier work, in their handoff packet.

You can run it in two ways:
- **Long-running (the default on Windows).** `scripts/windows/install-harness-task.ps1` registers a Task Scheduler task that keeps `loop` alive: it starts at logon and is retried every 15 minutes (ignored while the loop runs). The loop sleeps by the wall clock, rechecks every `--poll` minutes so answers get noticed, backs off on network errors, and writes a log and a heartbeat. The README's Windows section has the steps.
- **One wake per process.** `tick` for cron or a CI schedule. It keeps its quiet-wake memory on disk, so an unchanged engagement still costs one `git ls-remote`.

`doctor` checks a machine end to end: node, git, Copilot CLI, the control repo and remote, the heartbeat and the scheduled task.

The panel (`npm run panel`, `src/panel/`) is a page on this PC over every engagement in the folders where `open` has run (or the ones named with `--dir`). It's another view of the log, like `status`: what's waiting on you, answered in place (an agent's question carries its recommendation and each option's consequences, an opinion like any agent's; the card asks you to look first when the recommended option can't be undone or the evidence conflicts), and each engagement's beliefs, budget, open work, team, recent turns and last wake, with pause and budget controls. Pausing is an event like any other. While paused, nothing new starts (turns, jobs, waits, people's tasks); running jobs and waits are still polled, so no result is lost. A budget set from the panel or with `budget` answers the harness's open question about the budget, if there is one, so it doesn't linger.

The loop, `answer` and the panel share one checkout. A `reset --hard` from one process between another's event write and its commit would drop an answer without a trace, so the lock around those steps is also a file in the repository's git directory. A lock left by a process that died is taken over at once on the same machine, and after ten minutes otherwise.

Turns run in Copilot CLI, one headless session per turn in the turn's worktree, with the handoff packet and the seat's role as the prompt. The seat picks the custom agent and model; `policy/harness-agents.json` turns its permissions into tool flags. `status` shows each goal's team.

Jobs, metric sources, monitor probes and checkers come from a module you pass as `--world`. A red line or checker that isn't registered fails the turn rather than being skipped.

## Not real yet

- **The cases test the harness's rules, not agent judgment.** The agents and people in them are scripted, and one author wrote all six.
- **Copilot CLI hasn't been run.** `CopilotTurnAgent` was tested against a fake `copilot` binary (process, worktree, flags, packet in the prompt, JSON parsing), not the real CLI.
- **There are no real providers.** Jobs, metrics and probes exist only as interfaces plus simulations. The next step is a GitHub Actions job provider and a webhook-fed metric source.
- **Pivots don't cancel running jobs.** Their results still arrive as findings.
- **One engagement per harness instance.** Scheduling across engagements belongs to the firm layer and isn't built. The panel shows several engagements side by side, but each runs on its own.
- **The panel is local to one PC.** Reaching it from a phone needs a sign-in in front of it; it has none.
- **People answer everything.** Questions go to people. Workstream leads that are agents answering the questions their decision rights cover isn't wired yet.
- **Generated roles are templates, not designs.** A generated role's charter is written by deterministic code from the lane and its todos. A model-backed factory would write a better one, behind the same limits (catalog permissions, probation). Probation ends only through independent reviews; checker passes don't count toward it.
- **Tool and model names are placeholders.** The flags in `policy/harness-agents.json` and the model names in the library have to match your Copilot CLI version and plan.
- **Windows is tested in CI, not on your machine.** The suite and a scheduled-task smoke test (install, one turn through an npm-style `copilot.cmd`, doctor, a quiet tick, uninstall) run on a GitHub Windows runner with a fake Copilot CLI. The task there runs as S4U, because the CI user has no interactive logon; on your machine it runs Interactive.

## How well the harness chooses when to ask

`npm run harness -- escalation` reads the log and reports, for each kind of question (each rule, monitors, agents' questions), how often your answer changed nothing: you picked an option that only acknowledges or approves. Questions the harness must ask whatever the numbers say (money, access, a refuted or killing assumption, scope far over budget, people's tasks, reviews) are counted apart. With k = 10 in `policy/harness.json` (`escalation.missCostRatio`), a kind of question is worth asking while you change course more than 1 time in 10.

Two things keep that number honest:
- **Blind questions.** A fifth of agents' questions (`escalation.blindShare`) hide the recommendation until you answer. If you follow the recommendation much more often when you can see it, the rate of questions that changed nothing is partly you going along.
- **Daily spot check.** Once a day, one decision the harness made without asking (dropping or reopening work, discounting a finding, resetting an assumption) comes back to the goal's owner: same, would differ, or wanted to be asked. It holds no work and agents never see it. The answers estimate how often the harness should have asked.
