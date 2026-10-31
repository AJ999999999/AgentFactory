---
name: copilot-worker
description: Hand a bounded coding job in this repo to GitHub Copilot CLI (headless, in its own git worktree), then review its diff and keep or discard it. Use when the owner asks to have Copilot do something, or for well-specified, checkable work (a test, a small refactor, a doc fix) that Copilot can do while you keep the main thread.
---

# Delegating a job to Copilot CLI

Copilot works in a separate worktree, never in your checkout and never on `main`. You write the brief, run it, check the result, and decide. Copilot never commits, pushes or deletes.

## 1. Check Copilot once per session

```bash
copilot --version            # missing: npm install -g @github/copilot, then run `copilot` once to sign in
copilot --help | grep -E -- "-p|--allow-tool|--deny-tool|--model|--no-ask-user|-s"
```

The flags below match the ones the harness uses (`src/harness/agents.ts`). If `--help` shows different names, use those, and tell the owner, because the harness needs the same fix.

## 2. Give it its own worktree

```bash
name=copilot-$(date +%Y%m%d-%H%M%S)
git worktree add -b "$name" "../$name" HEAD
```

## 3. Write a brief that can be checked

- **Goal:** the change, in one or two sentences.
- **Scope:** the exact files or folders it may change.
- **Done when:** a command that proves it, usually `npm test` or one test file.
- **Don't:** commit, push, add dependencies, or touch `policy/`, `.github/` or `integrations/`.

## 4. Run it headless

The flags:
- `-s` prints only Copilot's final response.
- `--no-ask-user` stops it from waiting for input that never comes.
- `--allow-tool` and `--deny-tool` give the exact tools.

```bash
cd "../$name"
copilot -p "$BRIEF" -s --no-ask-user \
  --allow-tool write \
  --allow-tool "shell(npm test)" --allow-tool "shell(node:*)" \
  --allow-tool "shell(git status)" --allow-tool "shell(git diff:*)" \
  --deny-tool "shell(git push:*)" --deny-tool "shell(git commit:*)" --deny-tool "shell(rm:*)" \
  > ".copilot-run.log" 2>&1
echo "exit $?"
```

- Add `--model <id>` only if the owner asked for a specific model.
- Run it in the background and keep working if the job will take more than a few minutes.

## 5. Review before keeping anything

```bash
git -C "../$name" status --short
git -C "../$name" diff --stat
git -C "../$name" diff
(cd "../$name" && npm test)
```

**Keep it only if:**
- the diff stays inside the scope
- the "done when" check passes
- the change is correct, not just green

If it's close, fix the rest yourself in the worktree, or give Copilot one more round with what's wrong.

## 6. Finish

- **Keep:** commit in the worktree with a message that says Copilot wrote it and you reviewed it, then merge the branch or open a PR as the owner prefers.
- **Discard:** `git worktree remove --force "../$name" && git branch -D "$name"`.

Either way, tell the owner in one or two lines:
- what Copilot did
- what you changed or rejected
- anything Copilot got wrong that the harness's agent profiles should guard against
