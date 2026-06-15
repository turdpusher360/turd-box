---
description: "Guided delivery hub: commit, push, PR, release notes, export, signoff. Use /ship for the menu or /ship <message> to commit+push directly."
argument-hint: "[message | --no-push | --amend | (empty for menu)]"
paths: ["**"]
---

## /ship -- Guided Delivery Hub

**If `$ARGUMENTS` is empty, show the Guided Ship Hub menu (bottom of this file) — do not auto-commit.** Otherwise, treat `$ARGUMENTS` as the commit message and run the delivery pipeline below.

Parse `$ARGUMENTS` as the commit message. Check for flags:
- `--no-push`: Commit only, skip push step
- `--amend`: Amend the previous commit instead of creating a new one

If no commit message is provided, auto-generate one:
1. Run `git diff --cached` (or `git diff` if nothing staged) to see what changed
2. Run `git log --oneline -5` to match the repo's commit message style
3. Derive a concise message from the diff: summarize the "why" not the "what"
4. Use the generated message without asking. The diff is the source of truth.

**Steps:**

1. Run `git status` and `git diff HEAD` in parallel to understand the working tree
2. If no files are staged, stage the files that were modified in this session — never use `git add .` or `git add -A`
3. Run verification: `npx tsc --noEmit && npx eslint . && npx vitest run`
   - If any step fails, stop and show the error output. Do not commit on failure.
4. Store session context to memory: `mcp__dev-memory__memory_store` with a brief summary of what is being shipped
5. If `--amend` flag: run `git commit --amend` with the message; otherwise run `git commit -m "<message>"`. Always append a model-aware co-author line:
   - Read `_runs/os/session-meta.json` and extract the `model` field
   - Map to display name by detecting version first: `opus-4-8` → `Claude Opus 4.8 (1M context)`, `opus-4-7` → `Claude Opus 4.7 (1M context)`, `opus-4-6` → `Claude Opus 4.6 (1M context)`, `sonnet-4-6` → `Claude Sonnet 4.6`. Fall back by family: `opus` → `Claude Opus`, `sonnet` → `Claude Sonnet`, else → `Claude`.
   - Append: `Co-Authored-By: {display name} <noreply@anthropic.com>`
6. Show the commit hash and a summary of changed files
7. If `--no-push` flag: stop here — commit is done, no push
8. Run `git push` to push to remote. If push fails, show the error and suggest `git pull --rebase` then retry

Do NOT use `git push --force`. Use `git push --force-with-lease` only if the user explicitly requests it.

---

## Empty Args: Guided Ship Hub

When `$ARGUMENTS` is empty, do not commit immediately. Render a cheap status strip, then use `AskUserQuestion` as the native menu shell.

### HUD strip

Render one deterministic line before the menu. Do not summarize or reinterpret it.

1. If `_runs/os/boot-status.json` exists, read `_runs/os/boot-status.json` and `_runs/os/health.json`, merge them into `{ ...bootStatus, health: healthJson }`, then pipe the JSON to:

```bash
node plugins/4ge/bin/hud-engine.cjs --mode=strip
```

2. If the OS files are missing, print `Forge OS: not booted` and continue to the menu.

### Menu round 1

Call `AskUserQuestion` with one question:

```text
question: "What should Ship do?"
header: "Ship"
options:
- Commit + push (Recommended): run the delivery pipeline above (verify, commit, push);
  auto-generate the commit message from the diff if none is given.
- Commit only: run the pipeline above with --no-push (verify + commit, no push).
- Open a PR: route to /pr.
- Publish or hand off: ask a follow-up for release notes, export, or signoff.
```

### Menu round 2 (only if "Publish or hand off")

```text
question: "Which deliverable?"
header: "Publish"
options:
- Release notes (Recommended): route to /releases.
- Export deliverable: route to /export.
- Session signoff: route to /signoff.
```

After a selection, dispatch exactly as if the operator had typed the direct command. The menu is a router, not a new implementation path; preserve direct-command semantics. Do not ask extra confirmation when the selected action is unambiguous.
