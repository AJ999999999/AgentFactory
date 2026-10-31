# Keep the owner's personal setup out of turns in Claude Code and omp too

Copilot's is done. Two leaks remain:
- Claude Code may load the user's `CLAUDE.md` and skills
- omp loads `~/.omp/agent/AGENTS.md`

Look for switches first. If there are none, use a separate home for turns (omp `--profile`), at the cost of a separate sign-in.
