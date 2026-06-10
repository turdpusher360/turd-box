# Session State

Schema and protocols for forge session persistence across context windows.

## State JSON Schema

Persisted to `${CLAUDE_PLUGIN_DATA}/forge/forge-state-{slug}.json` (falls back to `_runs/` if plugin data dir unavailable):

```json
{
  "slug": "forge-v2-upgrade",
  "state": "executing",
  "current_phase": 5,
  "completed_phases": [1, 2, 3, 4],
  "tasks": [
    {
      "id": "T1",
      "status": "completed",
      "owner": "impl-1",
      "started": "2026-03-15T12:01:00Z",
      "completed": "2026-03-15T12:15:00Z"
    },
    {
      "id": "T2",
      "status": "in_progress",
      "owner": "impl-2",
      "started": "2026-03-15T12:01:00Z",
      "completed": null
    },
    {
      "id": "T3",
      "status": "pending",
      "depends_on": ["T1", "T2"],
      "owner": null,
      "started": null,
      "completed": null
    }
  ],
  "key_decisions": [
    "Used tag-based checkpoint instead of stash",
    "Chose modular extraction for SKILL.md"
  ],
  "spec_path": "docs/superpowers/specs/2026-03-15-forge-v2-orchestration-design.md",
  "plan_path": "docs/superpowers/plans/2026-03-15-forge-v2.md",
  "sessions": [
    {
      "id": 1,
      "started": "2026-03-15T12:00:00Z",
      "ended": null,
      "phases": [1, 2, 3, 4, 5]
    }
  ],
  "last_updated": "2026-03-15T12:30:00Z"
}
```

### Session State Values (quad-state)

| State | Meaning | Set when |
|-------|---------|----------|
| `staged` | Plan complete, Phase 5 not yet entered | `create` action |
| `executing` | Phase 5 in progress | State updated on Phase 5 start |
| `parked` | Execution interrupted mid-session | `end` while executing, or timeout |
| `shipped` | Phase 7 complete (terminal) | `end` while staged/parked, or explicit ship |

**Transition rules:** `staged -> executing -> parked -> executing` (resume) or `-> shipped`. No transitions from `shipped`.

### Task Status Values

| Status | Meaning |
|--------|---------|
| `pending` | Not yet started (dependencies may be unsatisfied) |
| `ready` | Dependencies satisfied, can be dispatched |
| `in_progress` | Teammate actively working |
| `completed` | Teammate reported DONE |
| `blocked` | Teammate reported BLOCKED |
| `cancelled` | Task cancelled by lead |

## Park Protocol (`/forge park`)

User invokes at any phase boundary. Forge:

1. Write full state to `${CLAUDE_PLUGIN_DATA}/forge/forge-state-{slug}.json` (or `_runs/forge-state-{slug}.json` if no plugin data dir)
2. Update TASKING.md with current forge progress
3. `memory_store` session summary with key decisions
4. Update HANDOFF.md with forge context
5. Delete `.forge-session.json` (session is parked, not active)
6. Clean up heartbeat and retry files
7. Report: "Session parked. Resume with `/forge resume`."

## Resume Protocol (`/forge resume`)

On any `/forge resume` invocation, forge scans for resumable state files:

1. Scan `${CLAUDE_PLUGIN_DATA}/forge/` (then `_runs/`) for `forge-state-*.json` files.
2. Load `state` field from each. Classify:
   - `state === 'staged'` — Plan ready, not yet executing
   - `state === 'executing'` — Was running when context ended
   - `state === 'parked'` — User explicitly parked
   - `state === 'shipped'` — Terminal; skip (never show in resume list)
   - Missing `state` field — Default to `'parked'` (backward-compat)
3. If no resumable sessions (staged + executing + parked): report "No resumable sessions."
4. If one session: prompt with state-appropriate message (see table below).
5. If multiple: show list with state column, let user pick.

### State-specific resume prompts

| State | Prompt | Action on Resume |
|-------|--------|------------------|
| `staged` | "Found staged session '{slug}' from {date}. Plan complete. Skip to Phase 5?" | Load plan, begin Phase 5. Set state -> `executing`. |
| `executing` | "Found interrupted session '{slug}' from {date}. Phase {N}, {X}/{Y} tasks. Continue?" | Resume from last completed task. |
| `parked` | "Found parked session '{slug}' from {date}. Phase {N}. [Continue] [Re-plan] [Abandon]" | Continue: set state -> `executing`. Re-plan: set state -> `staged`. Abandon: set state -> `shipped`. |

### Context reconstruction on resume

Read state file for task status and key decisions, read spec and plan from persisted paths, read teammate outputs from `_runs/` for completed tasks, load only the context needed for the current phase, continue from the next pending task.

## Crash Recovery

Triggered by stale `.forge-session.json` (exists but no forge skill is active):

1. Forge skill preamble checks for `.forge-session.json` on every invocation
2. If found and no forge session is in progress: treat as crash recovery
3. Read the session file for last known state
4. Check for corresponding state file in `_runs/`
5. Prompt: "Found stale forge session '{slug}'. This may be from a crashed session. [Resume] [Discard]"
6. Resume follows the same protocol as park resume

## Phase-Specific Context Reconstruction

When resuming, load only what the current phase needs:

| Resuming Phase | Load |
|----------------|------|
| 1 (scope) | Task description only |
| 2 (brainstorm) | Task description + scope decisions |
| 3 (spec) | Spec path (read from disk) |
| 4 (plan) | Plan path (read from disk) + spec summary |
| 5 (execute) | Plan + task status + teammate outputs for deps |
| 6 (integrate) | All teammate outputs + verification results |
| 7 (ship) | Summary of completed work |
