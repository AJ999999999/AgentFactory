# From your own Copilot or Claude Code session

The harness's tools are also an MCP server, so you can work the firm from the session you already have open. Its tools are `status`, `open_questions`, `answer`, `add_work`, `pause` and `stop_turn`. It reads and writes the same way the panel does, and covers the same engagements: every folder you've run `harness open` in, or only the folders you name with `--dir`.

```powershell
claude mcp add agentfactory --scope user -- node --no-warnings C:\workspace\AgentFactory\src\harness\mcp.ts
```

For Copilot, add the same command as a `local` server named `agentfactory` in `%USERPROFILE%\.copilot\mcp-config.json`.

These are the partner's tools, never an agent's: an agent that could answer your questions would be grading its own work. So:
- the server offers nothing inside a harness turn
- every Copilot turn switches it off by name
- Claude, Codex and pi turns load none of your MCP servers
- the gate refuses omp turns any tool outside the seat's list
