# The panel

```powershell
cd C:\workspace\engagements
node C:\workspace\AgentFactory\src\panel\cli.ts       # or, from the AgentFactory folder: npm run panel -- --dir C:\workspace\engagements
```

It opens a page on this PC (`http://127.0.0.1:4700`) with every engagement in that folder, and in every other folder you've run `harness open` in (the list is kept in `~/.af/panel-folders.json`), so three projects opened in three folders share one page. `--dir <folder>`, repeated as needed, shows only the folders you name. If two folders hold engagements with the same id, each is shown with its folder's name after it.
- **The left column is what's waiting on you**: urgent ones first, then the ones a whole goal is stopped on (their marks are red), then by how much work each holds up. Open a question to answer it. An agent's question carries its recommendation, what follows from each option and which options can't be undone, so most can be answered from the card. When the recommended option can't be undone or the evidence points both ways, the card says to look first and no option answers in one click. An option that needs something from you (a number, the revised goal, what you observed) or can't be undone asks for it first. An open card also shows how work is moving around the question: whether anything else in its goal can move without your answer (and how many other questions the goal also waits on), where the goal's work sits now and what changed in the last day, and how the last turns on this work went, with why each failed. That's what to weigh "try again" against "drop it" with. Your answer counts as yours unless you tick "I'm passing on what they told me", the same as `answer --by <role>`.
- **The right column is each engagement**:
  - when its loop last woke, and a pause button: paused, nothing new starts and running jobs still finish
  - a usage limit it's waiting out, and until when
  - each turn running on this PC: who's on what, the end of its log as it happens, and a Stop button. Stopping kills the agent and throws its changes away, then asks you whether to try that work again or drop it. Every turn's log is kept in `.af\harness\<engagement>\turns\`.
  - per goal, turns spent against the budget (click the total to change it), and how its work is moving: running, ready, held by questions, with a person, held by something else, and what was added, done and failed in the last day
  - one mark per assumption, with the riskiest open one spelled out
  - open work, running first
  - the team, with roles on probation dashed. Click it to open each agent: what it's doing now (running a turn here, waiting out a usage limit, waiting on your decision about a permission, or how much of its work is under way or not started), which CLI and model run it, whether it's a library role or a generated one on probation, what it may do and what still waits on you, and its last turns with why each failed. The CLI and model come from `policy/harness-agents.json`; a loop started with `--models` overrides them, and the panel can't see that.
  - the last turns, with failed and thrown-out ones in red

It reads the same event log as `status` and writes through the same code as `answer`, so it never holds state of its own. Writes from the loop, the command line and the panel go through one checkout under a lock shared across processes. It listens on 127.0.0.1 only, refuses requests addressed to any other host, and every call carries a token only the page it served knows. `npm run panel -- --demo` opens it on three simulated engagements.

The same controls are on the command line: `pause [--reason ..]`, `resume`, and `budget <goal> turns=300`.
