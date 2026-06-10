# Cancellation Protocol

Forge sessions can be cancelled at any point. Two modes based on urgency.

## Graceful Cancellation

Triggered by: user request at a natural boundary, or context approaching limits.

1. Signal all active teammates: "Wrap up current step and report status"
2. Wait for teammates to report (timeout: 60 seconds)
3. Collect partial results from `_runs/`
4. Write forge state to checkpoint: `_runs/{date}/forge-state-{slug}.json`
5. Triple-write: TASKING.md + memory_store + HANDOFF.md
6. Delete `.forge-session.json`
7. Clean up heartbeat and retry files
8. Report: "Forge session '{slug}' gracefully cancelled at Phase {N}. {X}/{Y} tasks complete. Resume with `/forge resume`."

## Abort Cancellation

Triggered by: user Ctrl+C or critical failure.

1. Kill all background teammates immediately
2. Do NOT wait for teammate output
3. Collect whatever partial results exist in `_runs/`
4. Write forge state to checkpoint (partial)
5. Triple-write with available state
6. Delete `.forge-session.json`
7. Clean up runtime files
8. Report: "Forge session '{slug}' aborted at Phase {N}. Partial state saved. Resume with `/forge resume`."

## Branch Cleanup

If forge created feature branches or worktrees:
- List all forge-created worktrees
- Offer to delete or keep each one
- Never auto-delete branches with uncommitted changes

## Post-Cancellation

After cancellation, the checkpoint file persists in `_runs/`. The next `/forge` invocation will detect it and offer to resume.
