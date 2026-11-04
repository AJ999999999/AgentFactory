# Make reviews independent of the builders

Only the judge lanes (`replan`, `synthesis`, `probation-review`) must use a different model from the workers. In the second private engagement every turn, `verify` included, ran on the same model. "Independent review" was the same model marking its own work.

Extend `checkLibrary`'s rule to the review lanes (`verify`, `replicate`, `test-design`), or let an engagement mark a todo as needing a different model from the work it checks.
