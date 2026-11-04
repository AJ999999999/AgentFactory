# One record to look back through

What happened lives in four places: the harness's event log in git (`.af/harness/<id>/`), each turn's log next to it, the desk's session record (`%USERPROFILE%\.af\desk\events.jsonl`, not in git), and what sessions taught (its own git repo). So "why did we decide this?" can be followed only inside the harness's own log.

**One envelope, one index.** Every record (an event, a turn, a session, a review, a CI run, a decision) gets the same header: what it is, where it came from, who wrote it, its evidence grade, when, and the record it answers or follows. The harness's log holds an index of headers that point at the full records where they are; big files aren't copied.

**Looking back.** `npm run harness -- trace <decision>` walks from a decision back to the question, the evidence behind it, the turns and sessions that produced that evidence, and the checks they passed; and forward to what the decision changed. The panel shows the same as a timeline on a question.

**Done when** a simulated case can be traced from a closed goal back to the measurements it rests on, through turns and answers, with a test.

Files: `src/harness/store.ts` (the index), `src/harness/trace.ts` (new), `src/desk/log.ts` (desk records indexed).
