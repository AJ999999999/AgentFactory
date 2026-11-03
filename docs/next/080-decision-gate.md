# Ask only what's new: a must-ask list and standing decisions

Before the harness opens a question for you, it checks only one thing: whether it already asked (event ids come from their cause). Two checks are missing, so you get the same kind of question again and again.

**Must ask.** Some calls are always yours, whatever you said before: closing or killing a goal, money, anything that can't be undone, and whatever you list in `policy/harness.json` under `mustAsk` (by origin, such as `rule:success`, or by event rule). The delivery engine's `never_auto` in `policy/escalation-policy.json` already means this; the harness should honour the same list.

**Decided before.** When you answer, you can tick "from now on". The answer is recorded as a standing decision for questions of the same shape: the same origin, and the same lane or event rule. The next question of that shape doesn't reach you. The harness records it as opened and answered with your earlier choice, `by` you and pointing at the answer it repeats, so the log shows whose decision it was. A standing decision:

- never covers a must-ask question or an option that can't be undone;
- ends when its goal's direction changes (a new goal version), after `standingDays` (default 30), or when you take it back on the panel;
- is counted by `harness escalation`, and the daily spot check draws from the questions it settled, so a standing answer that has gone wrong shows up.

**Done when** a test shows a second question of the same shape is settled by the standing answer with no ask left open, that a must-ask or irreversible one still reaches you, and that a new goal version ends it. The panel shows standing decisions per engagement with × to take one back.

Files: `src/harness/rules.ts` (the gate where `ask()` is called), `src/harness/answers.ts` (the "from now on" flag), `src/harness/project.ts` (standing decisions in state), the panel's answer card.
