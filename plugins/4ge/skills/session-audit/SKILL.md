---
name: session-audit
description: "Session quality audit — task hygiene, hook violations, uncommitted changes, verification gaps"
tools: Bash, Read, Glob, Grep
disable-model-invocation: true
---

# session-audit — Session Quality Auditor

Checks the current Claude Code session against quality gates and outputs a health scorecard.

## Step 1: Git Status Check

Run `git status --short` to identify uncommitted changes.

Classify findings:
- Modified tracked files → note count and file list
- Untracked files in `_runs/`, `.claude/`, `plugins/`, `lib/`, `claude-commander/` → flag as potential missing commits
- Nothing to commit → PASS

## Step 2: Task List Hygiene

Scan for any active task list (the plan mode task list or `_runs/` task files):

```bash
ls _runs/ 2>/dev/null | head -20
```

Check for tasks marked as in-progress that have no recent file modification evidence (more than 1 hour old based on file timestamps). Flag abandoned in-progress tasks.

If no task list exists, mark as N/A.

## Step 3: Memory Protocol Compliance

Check if `memory_store` was called during this session when code changes exist.

Heuristic: if git status shows modified `.cjs`, `.ts`, `.tsx`, `.js` files, memory store should have been called.

Look for the memory marker pattern:
```bash
grep -r "memory_store" _runs/ 2>/dev/null | tail -5
```

If code changes exist but no recent memory store evidence → WARN.

## Step 4: Verification Gate Status

Check if the verification triad (tsc + eslint + vitest) was run this session.

Look for the session marker file:
```bash
ls /tmp/claude-verified-* 2>/dev/null || ls $TMPDIR/claude-verified-* 2>/dev/null || echo "no marker found"
```

Also check if any `.ts`/`.tsx` files were modified without a subsequent typecheck:
```bash
git diff --name-only HEAD 2>/dev/null | grep -E '\.(ts|tsx)$' | head -10
```

If modified TypeScript files exist and no tsc run detected → WARN.

## Step 5: Agent Report Completeness

Scan `_runs/` for incomplete agent reports (files containing "PENDING" or "IN PROGRESS" headers):

```bash
grep -rl "^## PENDING\|^# PENDING\|status: pending\|STATUS: IN PROGRESS" _runs/ 2>/dev/null | head -10
```

Count incomplete reports and list them.

## Step 6: Output Session Health Scorecard

Present results as a formatted scorecard:

```
## SESSION HEALTH SCORECARD — [DATE]

| Category              | Status | Notes                              |
|-----------------------|--------|------------------------------------|
| Uncommitted Changes   | [PASS/WARN/FAIL] | [N files modified / clean] |
| Task List Hygiene     | [PASS/WARN/N/A]  | [N abandoned / clean]      |
| Memory Protocol       | [PASS/WARN]      | [stored / no evidence]     |
| Verification Gate     | [PASS/WARN]      | [ran / not detected]       |
| Agent Reports         | [PASS/WARN]      | [N incomplete / clean]     |

### Overall: [HEALTHY / NEEDS ATTENTION / ACTION REQUIRED]
```

**Overall verdict rules:**
- Any FAIL → ACTION REQUIRED
- 2+ WARN → NEEDS ATTENTION
- 0-1 WARN, no FAIL → HEALTHY

### Recommended Actions

List specific follow-up actions for each WARN or FAIL item:
- Uncommitted changes → `git add <files>` then commit with message
- Memory protocol → call `memory_store` with session summary
- Verification gate → run `npx tsc --noEmit && npx eslint . && npx vitest run`
- Incomplete reports → check agent output in `_runs/` and complete or discard
