# A check that fails on the starting commit too isn't the agent's fault

When a turn fails its check, run the same check on the commit the turn started from. If it fails there too:

- don't count the failure against the turn or the seat
- don't retry: the next try would fail the same way
- ask the operator, with the failing check and both commits

In the second private engagement, a test that needed a missing local cache threw away a good 19-minute turn. The turn's packet then told the retry it had failed (#19), but the retry couldn't have fixed it.
