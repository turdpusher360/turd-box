---
description: "Fold handoffs since the last reconcile into BACKLOG.md — re-surface gold mines, flag drift, archive stale _runs/, regenerate INDEX.md. Run every 5 sessions or on pivot/release."
argument-hint: "[repo-path] (defaults to cwd)"
paths: ["plugins/4ge/**", "_runs/**", "BACKLOG.md"]
---

## /reconcile — Tasking Reconciliation

The periodic *fold* step that makes the portfolio's record-keeping reconcile-heavy instead of
write-only. Folds every handoff written since the last reconcile into the single, deletable,
current-state `BACKLOG.md` so:

- **Gold mines cannot rot** — every cycle re-reads and re-ranks dormant built/spec'd value.
- **Redundancy cannot recur** — the reconciled current-state lands, so the next session does
  not rediscover the same state.
- **Drift is caught the cycle it happens** — lane start/stop transitions are matched to
  `.decisions.jsonl`; unmatched ones are flagged (advisory).

`$ARGUMENTS` is an optional repo path. Empty → reconcile the current repo (cwd).
`/reconcile /absolute/path/to/sibling-repo` → reconcile a sibling repo.

**Invoke the `reconcile` skill** with the parsed repo path. The skill is a thin orchestrator:
it locates the reconcile inputs, dispatches an `opus-audit`-class agent (`model: opus`) to do
the fold in a fresh context, then archives stale `_runs/sNNN/` dirs (older than the last 10
sessions, after live gold mines are extracted), regenerates `_runs/INDEX.md`, and
`memory_store`s a one-line summary.

Do not output intermediate text before the skill activates.

### When to run

- Every 5 sessions per active repo, OR
- on any launch / release / pivot, OR
- on any `.decisions.jsonl` entry tagged `pivot`/`park`/`kill`/`defer`, OR
- when the On-Startup handoff read or the `handoff-record-check.cjs` commit advisory reports
  the latest handoff is ≥5 sessions ahead of `BACKLOG.md`'s "reconciled as of S<N>" marker.
