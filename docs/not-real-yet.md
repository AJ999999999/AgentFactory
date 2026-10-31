# Not real yet

- **Turn agents have run for real only in smoke tests.** These ran on Windows: Copilot CLI 1.0.105, Claude Code 2.1.314, Codex CLI 0.166.0 and pi 1.4.0. The runs covered:
  - writing files in scope
  - a read-only judge turn
  - stopping a turn mid-run, for Copilot and Codex
  - the gate refusing out-of-scope writes, pushes, chained commands and reads outside the worktree inside pi

  They haven't run a real engagement yet.
- **Unverified pieces:**
  - omp has been tested only against a fake binary: its flags come from its help text
  - the wording of real usage-limit errors (the classifier reads the common forms)
  - Copilot's tool name for web reads, and Codex's web search setting
  - the challenge process's `CopilotCliRunner`
- The harness's jobs, metric sources and probes are interfaces with simulated implementations; the cases' agents and people are scripted.
- CI runs the tests on Ubuntu and Windows (`.github/workflows/tests.yml`), but replay checks stand in for an engagement's own CI.
- The coordinator is in-process and not durable.
- The remote is a local bare repo standing in for GitHub.
- Firm-level pieces from the design are not built yet: the control repo with client walls, nested leases for spawned teams, the client channel, staffing and cost ledgers.
- Config is JSON rather than YAML, because there are no dependencies.
- The index runs one git process per file, which is fine for an MVP but slow for a large repo.
- Line survival via blame is O(repo size).
