---
name: wizard-engine
description: "Pipeline orchestrator for /outhouse, /wizard, /fix — 6-stage scan/triage/research/fix/execute/verify"
tools: Bash, Read, Glob, Grep, Skill, Write, WebSearch, WebFetch, mcp__dev-memory__memory_search, mcp__dev-memory__memory_store
disable-model-invocation: true
---

# Wizard Engine -- Pipeline Orchestrator

Core engine for all wizard modes. Routes to mode files, executes the 6-stage pipeline, manages session state and configuration.

**Reference files live in `references/` (relative to this skill file).** Read each file on demand when its protocol is needed -- do not preload all references at once. Mode files live in `modes/`.

## Parse $ARGUMENTS

| Pattern | Action |
|---------|--------|
| `<mode> [flags]` | Load mode file from `modes/<mode>.md`, execute pipeline with flags |
| `list` or empty | List available modes by reading `modes/` directory |
| `resume` | Resume an interrupted wizard session (read `.outhouse-session.json`) |

**Extract mode and flags:**
1. First positional argument is the mode name (e.g., "outhouse", "wizard", "fix")
2. Remaining arguments are flags: `--quick`, `--ci`, `--auto-safe`, `--preflight`, `--report`, `--dry-run`, `--show-suppressed`, `--research-depth <level>`, `--category <name>`

If mode is empty or "list":
1. Read `modes/` directory via Glob
2. For each `.md` file, extract `name` and `description` from YAML frontmatter
3. Display available modes as a table and exit

## Pre-Flight

Before starting any pipeline stage:

1. Check for existing `.outhouse-session.json` at project root
   - If found and `updated_at` is within the last 10 minutes: warn "Another wizard session may be in progress" and abort
   - If found and `updated_at` is older than 10 minutes: session is stale — offer resume or fresh start (delete the stale file)
   - If not found: proceed normally
2. `memory_search query="outhouse score" limit=1` to retrieve prior run data for trending

## Configuration Merge

Resolve configuration by deep-merging three layers (later wins):

1. **Plugin defaults** -- Read `defaults/wizard-defaults.json` (relative to plugin root, located at `../../defaults/wizard-defaults.json` from this skill file)
2. **Project config** -- Read `.4ge-wizard.json` from project root (if exists)
3. **Mode frontmatter** -- YAML frontmatter from the loaded mode file

**Merge rules:**
- Objects merge recursively; project fields override at the leaf level
- Arrays replace (not append) -- follows ESLint flat config convention
- `null` in project config removes the field (opt-out)
- `custom_categories` are additive (never remove built-in categories)

**Security floors (non-overridable):**
- `security.enabled` cannot be `false` -- silently reset to `true`
- `security.pass_threshold` minimum is 30 -- lower values silently raised
- `suppress` entries matching category "security" with pattern ".*" are rejected
- `auto_promote_max_tier` is hard-coded to `"suggested"` -- cannot be overridden to `"recommended"`

**Suppress validation:**
- Each suppress entry requires `expires_at` (ISO date string or `null` for permanent)
- Expired entries (past `expires_at`) are auto-removed
- Critical-severity security findings are silently unsuppressed regardless of rules

## Pipeline Execution

After config merge, check flags to determine pipeline scope:

| Flag | Stages Executed | Notes |
|------|-----------------|-------|
| (none) | All 6 stages | Full interactive pipeline |
| `--quick` | 1 (SCAN) + 2 (TRIAGE) | Score summary only |
| `--ci` | 1 (SCAN) + 2 (TRIAGE) | JSON output, score-threshold exit code |
| `--auto-safe` | All 6 stages | Skip menus, Quick research, Safe-tier fixes only |
| `--preflight` | Fast subset of 1 (SCAN) | Fast categories only (<5s) |
| `--report` | 1 (SCAN) + 2 (TRIAGE) + 3 (RESEARCH) | Write report, no fixes |
| `--dry-run` | 1-4 (through FIX MENU) | Show fixes, do not execute |

**Flag precedence:** `--ci` takes priority for output format (JSON) and exit code semantics over all other flags, including `--auto-safe`. When `--auto-safe` is active without `--ci`, `--auto-safe` controls execution scope (Safe-tier only, Quick research) and exit code. When both are combined, `--auto-safe` controls execution scope but `--ci` controls output format and exit code.

Now read the mode file and execute:

1. Read `modes/<mode>.md`
2. Follow the mode file's instructions for each pipeline stage
3. For shared protocols, read reference files on demand:
   - `references/pipeline.md` for stage protocol details
   - `references/research-protocol.md` for Stage 3 research dispatch
   - `references/fix-menu-protocol.md` for Stage 4 menu UX
   - `references/verify-protocol.md` for Stage 6 verification
   - `references/config-schema.md` for config validation details
   - `references/context-budget.md` for token budget estimates

## Session State

Write `.outhouse-session.json` to project root at pipeline start. Update after each stage. Delete on successful ship or explicit abandon.

The session file enables crash recovery and resume. See `references/pipeline.md` for the full schema.

## Exit Codes

| Mode | Exit 0 | Exit 1 | Exit 2 |
|------|--------|--------|--------|
| `--quick` | All categories PASS | Any WARN | Any FAIL |
| `--ci` | weighted_score >= config.ci.score_threshold | weighted_score < config.ci.score_threshold | -- |
| `--auto-safe` | All fixes applied | Any fix failed | -- |
| `--preflight` | All checked >= 80% | Any below 80% | -- |
| `--report` | Always | -- | -- |

## Post-Pipeline

After the pipeline completes:

1. `memory_store` session summary with per-category scores, importance=0.6, tags=["outhouse","health","scoring"]
2. Write full report to `_runs/outhouse-YYYY-MM-DD.md`
3. Append structured score to `_runs/outhouse/history.jsonl`
4. Clean up `.outhouse-session.json`

## Known Limitations

1. `@references/` imports do not work in skill files -- only supported in CLAUDE.md and `.claude/rules/`. This skill uses explicit "read `references/X.md`" directives instead.
2. `/compact` cannot be triggered programmatically. Suggest compaction at stage boundaries; user executes.
3. Process environment variables are not available as substitution tokens in skill files. Use relative paths from this skill file.
4. Skill-invoking-Skill composition requires the `Skill` tool in this skill's frontmatter (present).
