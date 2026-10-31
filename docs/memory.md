# Memory about the people you serve

Remembering more isn't understanding more. "I like red-eye flights" (said three months ago) and "maybe Tokyo this weekend" (said yesterday) differ in how long they hold, how sure we are, and what they let an agent do. `src/memory/` keeps what a principal (you, a client) has said and done as a log of evidence. What we currently believe about them is computed when it's read, the way the harness computes beliefs from graded evidence.

Each entry records five things:
- **What kind of thing it is:** a preference, an intention, a fact or a constraint.
- **How we know it:** stated or chosen by them, or, recorded by an agent, inferred or accepted.
- **When it holds:** a condition, such as "on short business trips".
- **Why,** when known.
- **Until when.**

The rules:
- **Memory never grants permission.** An item's use is `default` (fill in or rank what you were asked to do), `mention` (worth a question when relevant) or `ask` (check first). There's no "act". Text that reads like a permission ("always book the cheapest without asking") is kept as a default and flagged.
- **Agents can't make things true about you.** They record guesses ("inferred") and acceptances of their suggestions ("accepted"). Only you state or choose.
- **Our own influence isn't evidence.** Accepting a suggestion we made adds nothing to the preference behind it, so recommendations can't feed on themselves.
- **Things expire.** Intentions lapse at their date (14 days if none is given), preferences fade unless repeated (half-life 180 days, `policy/memory.json`), and an old guess goes stale.
- **A condition narrows a preference instead of overwriting it.** "Red-eye on business trips" and "daytime with the kids" are two answers.
- **Two things that disagree become a question, not an average.** Saying that one replaces the other settles it, and forgetting the replacement brings the old one back.

```bash
npm run memory -- add --as principal --kind preference --subject travel.flight-time --value red-eye --text "I like red-eye flights" --condition "short business trips" --because "it saves a hotel night"
npm run memory -- add --as principal --kind intention --subject travel.trip --text "Maybe Tokyo this weekend" --until 2026-11-01
npm run memory -- view                                   # what we believe now, how we know it, what it may be used for
npm run memory -- render --subjects "work.*" --out profile.md   # a self-profile for your coding agents, regenerated, never stale
```

An engagement opts in with `"memory": { "principal": "partner", "subjects": ["work.*"] }` and `open --memory <dir>`. Its agents then get, in their packet, the defaults that apply on those subjects and what to check with you first. Lapsed plans and other subjects are left out.
