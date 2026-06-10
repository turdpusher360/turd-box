# Pipeline Protocol

The 6-stage pipeline protocol that every wizard mode follows. Modes can skip stages (declared in frontmatter `pipeline-stages`) but cannot reorder them.

## Stage Sequence

1. **SCAN** (~30s) -- Gather raw data across configured categories
2. **TRIAGE** (~5s) -- Classify PASS/WARN/FAIL, determine deep-dive scope
3. **RESEARCH** (configurable ~15-180s) -- Gather evidence for fix recommendations
4. **FIX MENU** (interactive) -- Present risk-tiered fix menu for selection
5. **EXECUTE** (autonomous) -- Apply selected fixes with per-fix rollback
6. **VERIFY + SHIP** -- Full verification, score comparison, commit/push

## Session State Schema

Write `.outhouse-session.json` to project root at pipeline start. This file enables crash recovery and resume.

**Lifecycle:**
1. Created at Stage 1 entry with initial flags and config hash
2. Updated after each stage completion with results
3. Read on resume to restore pipeline position
4. Deleted on successful ship or explicit abandon
5. Preserved on quit (for later resume) and on crash

**Required fields:**
- `version`: "1.0.0"
- `wizard_type`: mode name (e.g., "outhouse")
- `session_id`: unique identifier
- `started_at`: ISO 8601 timestamp
- `updated_at`: ISO 8601 timestamp (updated each stage)
- `current_stage`: integer (1-6)
- `stages_completed`: array of completed stage numbers
- `config_hash`: SHA-256 of merged config (detect config changes on resume)

**Stage result fields** (added as stages complete):
- `scan_results`: per-category scores, deductions, total, weighted_score, grade
- `triage_decisions`: research scope, skipped categories
- `research_results`: per-category findings with confidence scores
- `fix_selections`: array of selected fix IDs
- `fix_results`: applied, rolled_back, skipped, errors
- `prior_scores`: from memory_search for delta comparison

**Safety stash:**
- `safety_stash.name`: git stash name with session ID prefix
- `safety_stash.ref`: git stash ref (e.g., stash@{0})

## Resume Logic

When resume is invoked:
1. Read `.outhouse-session.json`
2. Verify `config_hash` matches current config (warn if changed)
3. Display last completed stage and summary
4. Resume from `current_stage`
5. If `current_stage` is 5 (EXECUTE) and `safety_stash` exists, verify stash is valid via `git stash list | grep "${safety_stash.name}"`. If not found, warn and require explicit user confirmation.

## Universal Hotkeys

Available at every menu in every wizard mode:

| Hotkey | Action |
|--------|--------|
| `?` | Show help for current menu |
| `q` | Quit wizard with save |
| `!` | Emergency rollback -- `git stash apply ${safety_stash.ref}` |
| `v` | Show current wizard state |
| `h` | Show history of decisions in this session |
| `e` | Export current state to `_runs/` |

## Menu Presentation Rules

1. Every menu shows the default option in brackets: `[default]`
2. Shortcuts use lowercase letters; numbers select items
3. Menus fit in 80 columns
4. The current stage is always shown in the header
5. Time estimates shown where applicable
6. Empty categories or stages with no items are skipped silently
