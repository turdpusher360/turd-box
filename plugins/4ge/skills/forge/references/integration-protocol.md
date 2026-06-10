# Integration Protocol

Procedures for safely integrating teammate results into the main branch.

## Git Checkpoint

Before Phase 6 (integration), forge creates a safety checkpoint using a git tag:

```bash
git tag forge-checkpoint-{slug}-{timestamp}
```

Tags work across worktrees (unlike stash), are immutable, and provide a named reference point.

### Rollback

If integration fails or produces broken state:

```bash
git reset --hard forge-checkpoint-{slug}-{timestamp}
```

### Cleanup

After successful Phase 7, delete the checkpoint tag:

```bash
git tag -d forge-checkpoint-{slug}-{timestamp}
```

## Incremental Integration

Apply teammate results sequentially, not all at once. This prevents cascading merge conflicts where multiple teammates' changes interact badly.

### Procedure

For each completed teammate (in dependency order):

1. **Apply changes** -- merge worktree or apply diff
2. **Type-check** -- `npx tsc --noEmit`
3. **Evaluate errors:**
   - If type errors are related to the applied changes: pause, fix, then continue
   - If type errors are unrelated to the changes: log and continue
4. **Repeat** for next teammate

After all teammates applied:

5. **Full verification** -- `npx tsc --noEmit && npx eslint . && npx vitest run`
6. If verification fails: investigate, fix, re-run
7. If verification passes: proceed to Phase 7 (ship)

### Application Order

Apply in dependency order (same topo-sort as execution). If T3 depends on T1 and T2, apply T1 and T2 before T3. This ensures type references are available.

## Auto-Retry for BLOCKED Teammates

When a teammate reports BLOCKED, forge checks the reason against known patterns:

| Pattern | Detection | Auto-Action |
|---------|-----------|------------|
| Type error (TS2xxx) | Error message contains "TS2" | Extract error context, provide fix hint, retry once |
| Missing import | "Cannot find module" or "has no exported member" | Suggest import based on project exports, retry once |
| Missing dependency | "Cannot find package" or "MODULE_NOT_FOUND" | Run `npm install`, retry once |
| Other | No pattern match | Escalate to lead (no auto-retry) |

### Retry Rules

- Maximum 1 auto-retry per teammate per task
- If retry also fails: escalate to lead with both error messages (original + retry)
- Log all retries to `_runs/{date}/forge-retries.json`:

```json
{
  "retries": [
    {
      "teammate": "impl-1",
      "task": "T3",
      "original_error": "TS2304: Cannot find name 'ForgeConfig'",
      "action": "Provided type definition context",
      "retry_result": "DONE",
      "timestamp": "2026-03-15T12:30:00Z"
    }
  ]
}
```
