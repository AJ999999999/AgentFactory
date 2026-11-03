# A real pull request for each change, reviewed on another model

Today the harness checks a turn's output itself and merges it into the engagement's repo. For a production codebase, a change should go the way people's changes go: a pull request, a review by a different model, the full CI, then merge, release and a check that it works in production, with any failure sent back to the same work.

The open question is who may push. No turn can push, and that stays: the turn's environment points the push URL nowhere. The harness itself would need to push branches and open pull requests, with a credential the turns never see. Decide that first.

Then: a review on the other model (the judge rule already requires it) as a PR review; CI's result read back as evidence on the work; a failed review or CI reopening the todo with what failed; merge, release and the production check as the last steps, each recorded.

Files: to be decided with the push question.
