# The harness's questions on Slack, answered with one tap

The desk already sends Copilot's permission asks to Slack and takes your answer back by Outlook (`src/desk/slack.ts`, `docs/desk.md`), because your company allows no Slack app that could call your PC. The harness's own questions still reach you only on the panel and the command line.

**The card**, one per question: the one thing to decide as its first line; what happened, what it changes and the recommendation under it; the options with the recommended one first; and which option can't be undone. It's the panel's card, in Slack's words. Questions that can wait are batched into one message a day; urgent ones go at once.

**Your tap** comes back by mail with the question's id and a one-time code, from your own address, as the desk's do. The harness records it as an answer by you, so the grade of any evidence in it comes from who answered. A tap on a question already answered, an old card, or anyone else's changes nothing. An option that needs words from you (the revised goal, a number) opens the panel instead.

**After it acts**, the harness posts what your answer led to under the same card: the turn it ran and how it went.

**Small notices**, with no answer needed: three failed turns, a usage limit holding a vendor for hours, the loop not having woken when it should (from `doctor`'s heartbeat), a monitor that fired.

**Done when** `npm run harness -- slack test` posts a card and reads back a tap, a simulated case answers through the same path, and a tap from another address is ignored.

Files: `src/desk/slack.ts` (shared transport, moved where both can use it), `src/harness/notify.ts` (new: cards, batching, follow-ups), `src/harness/cli.ts`.
