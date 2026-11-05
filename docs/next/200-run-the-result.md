# Run what was built before calling it done

In the second private engagement every step finished, all tests passed and the review said the code matched the rules. Yet the first run of the result on real data showed it almost never did anything: two of its rules almost never hold on the same day. Nothing had run the result on real data. Builder turns can't run Python, and no job did.

- When a goal makes something runnable, nudge the engagement to include a `job` that runs it on real inputs, with a sanity threshold set beforehand (for example, it acts at least N times on a year of real inputs). Its result is evidence on the goal's assumptions.
- `open`, which already checks the setup (docs/harness.md), can warn about a goal whose build todos have no job that runs their output.

The partner's own try-out stays. This catches the obvious failures before they reach the partner.
