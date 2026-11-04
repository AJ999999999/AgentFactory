# The harness's questions on Slack

The loop sends each question that's yours to Slack as a card, and your tap comes back as a mail the loop reads from Outlook. It's the same way the desk's permission asks travel ([docs/desk.md](desk.md#asks-on-slack-while-youre-away)), because your company allows Slack workflows but no app that could call your PC. It's a second workflow, because these cards have their own fields.

## What you get

- **A card per question.** The card shows:
  - the one thing to decide, as its first line;
  - the whole question and the work it's about;
  - the recommendation and why;
  - the options as numbers, the recommended one marked.

  Urgent questions come at once. The rest come together at the digest hour (9 by default, this PC's time), so they reach you as one batch a day.
- **Your tap.** You pick 1 to 4 on the card's form, with a note if you like. That's recorded as your answer, so any evidence in it is graded as yours.
  - An option that can't be undone, or that needs words from you (a new goal, a new budget, what you observed), is marked "answer on the panel". A tap on it changes nothing.
  - "Open the panel" does nothing either: you answer there.
- **What it led to.** Once the work your answer was about has had a turn, a result card says what you chose and how the turn went. A question settled without you is followed up the same way: one that went moot, or one your standing answer covered.
- **Notices.** These need no answer:
  - a model service holding its seats for two hours or more;
  - an event whose rule says `"tell": "now"` ([docs/events.md](events.md)).

A tap counts only when it carries the card's question id and the one-time code that card had, comes from your own address, and the question is still open. A tap from anyone else, on an old card, or after you answered on the panel changes nothing, and the loop's log says why.

## Set it up, once

1. In Slack, open **Workflow Builder** and create a workflow that starts **From a webhook**. Add these variables, all text: `kind`, `engagement`, `goal`, `headline`, `what`, `why`, `options`, `ask`, `nonce`.
2. Add **Send a message to a person**, to yourself: `headline` in bold, then `goal`, `what`, `why` and `options`. Add a button to it, **Answer**. If your Workflow Builder can branch, show the button only when `kind` is `ask`; otherwise ignore it on notices and results.
3. After the button, add **Collect info in a form**, sent to the person who clicked, with two questions:
   - **Answer**: a drop-down with exactly `1`, `2`, `3`, `4`, `Open the panel`;
   - **Note**: short text, not required.
4. Then add **Outlook: Send an email** to your own address. Subject: `af-harness {ask} {nonce} {Answer}`, each one the variable inserted from the menu. Body: the form's **Note**.
5. Publish, copy the webhook address, and write `%USERPROFILE%\.af\harness\slack.json`:

   ```json
   { "webhook": "https://hooks.slack.com/triggers/...", "me": "you@company.com", "replies": "outlook", "digestHour": 9 }
   ```

   `me` is the address the Outlook step sends from. Leave out `replies` and `me` if you skip steps 3 and 4: cards then only tell you, and you answer on the panel.
6. Run `npm run harness -- slack test`. A test card reaches you; tap a number, and check that the mail arrives in Outlook with the subject above.

The loop posts and reads after each wake, at least every ten minutes (`loop --poll`). It reads Outlook only while some card waits for your tap, and it moves each `af-harness` mail it reads to Deleted Items. The desk's `af-desk` mails are left for the desk.

**What leaves the PC** is the card's fields: the engagement, the goal's title, the question, the recommendation and the options. They go to your company's own Slack and mailbox. The answer is recorded in the engagement's log like any other.
