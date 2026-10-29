# AgentFactory

A git-native system for running a firm of AI agents with one human partner. It has a shared context layer; an Observator → Solver → Evaluator self-evolution loop; decision rights that route each decision to its owner (client, partner or lead); a role factory that staffs teams from a tested library; and an escalation policy that only brings key decisions to a human. The delivery loop is modeled on the RulTriX RSCL/Raee concept and built on plain git. The full design is in the "Agent firm design" doc.

This repo is the MVP. Zero dependencies. Node ≥ 22.18 (built-in TypeScript stripping, `node:sqlite`, `node:test`) and git ≥ 2.32.

```bash
npm test                     # units, hooks, MCP, factory, load test, end-to-end scenario
npm run demo                 # narrated end-to-end run (add --verbose for the event log)
```

## Components

| Component | File | What it does | Production swap |
|---|---|---|---|
| Git substrate | `src/git.ts` | Worktrees, commit trailers (`Agent`, `Basis`, `Config`, `Replay`, `Decision`), leases as refs under `refs/leases/<path>` acquired by one atomic push with `--force-with-lease=<ref>:` | GitHub Enterprise remote; same mechanics |
| Shared context layer | `src/context.ts` | Versioned task basis, content-addressed source snapshots, per-role context bundles, `context.lock.json` per artifact | Same files; snapshot importers per source system |
| Decision records | `src/decisions.ts` | Chosen + rejected options, bound paths, staleness when bound paths change | Same |
| Index | `src/store.ts` | SQLite index rebuilt from committed git objects; disposable | Postgres fed by webhooks |
| Observator | `src/observator.ts` | Breakpoints = artifacts pinned to a superseded basis. A query, no model call | Same, plus an LLM pass for unpinned artifacts |
| Solver | `src/solver.ts` | Context Portfolio from a breakpoint or config change; freezes the criteria hash before any candidate exists | `solver` custom agent for non-trivial revisions |
| Evaluator | `src/evaluator.ts` | Replays baseline vs candidate at a frozen commit, N runs per side in parallel; checks outcome, red lines, cost; rejects candidates that touch protected files; engagement-specific checkers plug in by name | Same, runs on CI runners |
| Fact-checker | `src/factcheck.ts` | Verifies claims by lookup (basis version, decision freshness, contract registry, CI result, file presence) | `fact-checker` agent maps free text to claim kinds |
| Policy | `src/policy.ts`, `policy/escalation-policy.json` | Triage (triggers, auto-resolve conditions, evolution rules, `never_auto` floor), decision rights and owner routing, engagement profiles, attention budget with backpressure | Same |
| Role factory | `src/factory.ts`, `policy/library.json`, `policy/permission-catalog.json` | Staffs a team from library templates, one agent per module; generated skills start on probation; permissions only from the catalog, so client text can raise a question but never grant access | Model-backed planner behind the same guardrails |
| Briefs | `src/brief.ts` | One-screen brief, blind variant | Same |
| Trust ledger | `src/ledger.ts` | Per-agent commits, revert rate, line survival (git blame), demotion | Same, plus missed-escalation counts |
| Coordinator | `src/orchestrator.ts` | Concurrency cap, lease → worktree → agent → lockfile → commit → merge queue → release | Temporal workflows (durable waits, retries) |
| Agent runners | `src/agents/` | `MockAgent` (deterministic, tests) and `CopilotCliRunner` (`copilot -p --agent --model --allow-tool --deny-tool`) | Copilot SDK |
| MCP server | `src/mcp-server.ts` | Context layer as MCP tools over stdio, role-scoped; hand-written JSON-RPC | Same, or the official SDK |
| Copilot CLI integration | `integrations/copilot/` | Custom agents, hooks (`preToolUse` lease enforcement, `sessionEnd` lockfile), MCP config | Copy into your repo |

## The test scenario

1. Three agents build in parallel on basis v1 (enterprise + individual). The analyzer and a docs task overlap on `tools/`, so one waits for the lease.
2. Narrowing scope to enterprise-only is a basis change, so it escalates and the human gets a brief (and a blind variant). The human approves it, which writes basis v2 and decision D-0002.
3. agent-01 rebuilds the report on v2; agent-03 doesn't.
4. The Observator finds exactly one breakpoint: the analyzer is pinned to `scope@v1`.
5. The Solver proposes a portfolio and the Evaluator replays it 3 runs per side. The baseline passes 0% (individual records present). The candidate passes 100% at lower cost. All claims verify by lookup, the policy auto-resolves, the fix merges, and the breakpoints drop to zero.
6. The loop refuses what it should:
   - A config that leaks PII is revised once and then passes.
   - A cost regression (+150%) has no remedy, so it escalates.
   - A candidate that edits the frozen criteria is rejected.
   - A criteria-edit PR hits the `never_auto` floor.
   - A contract change with an unverifiable consumer claim plus dissent escalates, with both shown in the brief.
7. Trust ledger: reverting agent-04's commit demotes it, computed from git history alone. A decision goes stale when its bound path is edited.
8. Attention budget: 8 briefs a day are delivered, 2 are queued, interrupts bypass the cap, and backpressure turns on.
9. Lease atomicity: an overlapping lease is refused by the pre-check, and also by git itself when the pre-check is bypassed. Expired leases are reaped.

Plus a load test (12 agents, 4 slots, overlapping paths: no overlapping holders, every change merges, history is linear, every lease is released) and role-factory tests (one agent per module, injected access requests become questions, generated skills on probation, hand-edited plans rejected).

## Private engagements

An engagement that holds client-confidential material keeps its code in `src/<name>/`, its SOW and client files in `engagements/<name>/`, and its tests in `test/<name>.test.ts`. List those paths in `.git/info/exclude`, git's local-only ignore file, so they stay in your copy and the public repo never even names them. `npm test` runs their tests whenever they're present.

## What testing found

- **Worktree race:** parallel `git worktree add` in one repo can read another's half-written admin directory. Worktree add/remove is now serialized per repo; agent runs stay parallel.
- **Tracking-ref race:** `git push` rewrites the local `origin/main` tracking ref, which races with concurrent fetches. Push and fetch share the per-repo lock. This failed about 1 in 12 runs before the fix; it passed 25 of 25 after.
- **Tamper check miss:** trimming `git status --porcelain` output dropped the first file's status column, so the tamper check missed the edit. It now parses `-z` output untrimmed.
- **Replay noise is real:** a flaky candidate passed with 1 run per side and failed with 5 runs per side (40%). Use several runs per side, or let deterministic checks decide.
- **Returns are the wrong test for rule-following work:** in a private engagement, a config that ignored a rule earned 43% more on the backtest. A returns-based evaluator would have adopted it; the rule-fidelity checker refused it.

## Plugging into Copilot CLI

1. Put this project at `tools/agentfactory/` in your repo.
2. Copy `integrations/copilot/.github/*` and `integrations/copilot/.agents/hooks/` to the repo root, and append `.gitignore.snippet` to `.gitignore`.
3. Use `CopilotCliRunner` instead of `MockAgent` in the coordinator.

Check these against your CLI version before relying on them:
- **Tool names:** the hook matches `edit|create|write|str_replace*` for file writes and `bash|shell` for shell.
- **Hook output:** the hook prints `{"permissionDecision":"allow"|"deny"}`.
- **`model:` in agent frontmatter:** model IDs depend on what your org enables.
- **Programmatic flags:** `--output-format json` and `--no-ask-user`.

## Not real yet

- Agents are mocked; `CopilotCliRunner` is written but wasn't run, because Copilot CLI isn't available in the build sandbox.
- There's no real CI; replay checks stand in.
- The coordinator is in-process and not durable.
- The remote is a local bare repo standing in for GitHub.
- Firm-level pieces from the design are not built yet: the control repo with client walls, nested leases for spawned teams, the client channel, staffing and cost ledgers.
- Config is JSON rather than YAML, because there are no dependencies.
- The index runs one git process per file, which is fine for an MVP but slow for a large repo.
- Line survival via blame is O(repo size).
