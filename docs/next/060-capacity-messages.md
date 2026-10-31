# Check `classifyCapacity` against a real limit message from each CLI

when one shows up in a turn log.
- **A usage limit reported mid-run now ends the turn at once, as a wait** (the CLI agents in `vendors.ts`). Codex, answered "429 Too Many Requests" by the `magpie` gateway, said it would reconnect and then hung for the full hour. Copilot's stream reader does the same now.
- **A provider that can't be reached now ends the turn after three of the CLI's own connection errors**, as an `unreachable` wait (5 minutes, doubling). When the gateway stopped, Codex had logged "Reconnecting... waiting for network" every 73 seconds for an hour, and the turn counted as a failure. Check the patterns in `classifyUnreachable` against what each CLI prints when the network is really down.
