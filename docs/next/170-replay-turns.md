# Prove a harness change helped: replay the turn that went wrong

The fixes from the second private engagement (#27, #28) are backed by unit tests, plus three later turns that didn't repeat the problem. That's anecdote, not evidence.

- **Keep each turn's exact prompt and packet** next to its log. Today the log has the output only.
- **Replay a failing turn** with the harness change applied: same packet, same frozen commit, several runs, since model runs vary. Keep the change only if the bad behaviour goes away and nothing else gets worse.
- **Changes to how turns run go through the eval** (`npm run eval`) as before and after arms.

The Evaluator already compares a baseline and a candidate on frozen inputs. Point it at harness changes, with a real turn as the case.
