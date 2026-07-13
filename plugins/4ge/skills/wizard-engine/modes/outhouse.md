---
name: outhouse
description: "9-category repository health scan with interactive fix menu, research-backed recommendations, and full verification"
execution-model: scan-report
pipeline-stages: [scan, triage, research, fix-menu, execute, verify]
scan-sources:
  - repo-hygiene
  - autoresearch
  - aisle-health
  - inbox
research_defaults:
  depth: standard
  confidence_threshold: 0.80
  sources: [memory, codebase, web]  # Overrides plugin default (memory, codebase) to include web for Standard+ depth
  max_results_per_category: 5
defaults_version: "1.0.0"
categories:
  branches: { weight: 1.0, deep_dive_threshold: 50 }
  dependencies: { weight: 1.2, deep_dive_threshold: 50 }
  agents: { weight: 0.8, deep_dive_threshold: 50 }
  hooks: { weight: 1.0, deep_dive_threshold: 50 }
  tests: { weight: 1.0, deep_dive_threshold: 50 }
  config: { weight: 1.0, deep_dive_threshold: 50 }
  dead_code: { weight: 0.8, deep_dive_threshold: 50 }
  docs: { weight: 0.6, deep_dive_threshold: 50 }
  security: { weight: 1.5, deep_dive_threshold: 40 }
---

# Maintenance Wizard Mode

Before producing any output, read `${CLAUDE_PLUGIN_ROOT}/skills/wizard-engine/references/output-format.md` for formatting rules.

9-category repository health scanner with interactive fix menus, research-backed recommendations, and trending. Subsumes the existing `repo-hygiene` skill as its scan engine and adds research, interactive remediation, execution, and verification.

## Stage 1: SCAN (~30s)

**Output components:** 1 (Score Bar), 2 (Category Row), 5 (Progress Line)

Gather raw data across all configured categories.

### Data Sources

**0. CJS Orchestrator (pre-scan, ~1s):**

Before running inline scans, call the CJS orchestrator to pre-populate scores from cached data sources (autoresearch experiments, AISLE scanner cache, fix inbox, OS health):

**For --quick mode:** Use the CLI directly (renders the full quick report with ANSI color):
```bash
node plugins/4ge/bin/wizard-cli.cjs --quick
```

**For full pipeline (JSON output for further processing):**
```bash
node plugins/4ge/bin/wizard-cli.cjs --json
```

**Legacy inline call (equivalent to --json):**
```bash
node -e "
  const {scan} = require('./plugins/4ge/lib/wizard-scan.cjs');
  const td = require('./plugins/4ge/skills/wizard-engine/references/threshold-defaults.json');
  const cfg = (() => { try { return require('./.4ge-wizard.json'); } catch { return {}; } })();
  const r = scan(process.cwd(), cfg, td);
  process.stdout.write(JSON.stringify(r));
"
```

The returned `ScanResult` contains pre-scored categories, signals, staleness flags, and OS health. Use `result.categories` as the baseline — inline scans below supplement or override individual categories where live data is fresher than cached autoresearch data.

When `result.stale` contains domain names, those domains had data older than 7 days. Their scores are included but tagged as `detected` confidence, not `recommended`.

**1. Inline repo scan (supplements CJS scores for: branches, dependencies, tests):**

Run inline git/npm/vitest commands for categories where the CJS orchestrator has no cached data or where live data is more authoritative. Branches always runs inline (no autoresearch domains). Dependencies may run `npm audit` for a fresher vuln count. Tests may run `npx vitest run --reporter=json` for current pass/fail counts.

For categories already scored by the orchestrator (agents, hooks, config, dead_code, docs, security), use the CJS score unless inline data reveals a higher finding count — in that case, use the higher deduction.

**2. Autoresearch measures (handled by CJS orchestrator):**

The orchestrator reads `_runs/autoresearch/<domain>/experiments.jsonl` for all 32 mapped domains and translates metrics into findings via `domain-threshold-map.json`. Domain-to-category mapping:

| Category | Autoresearch Domains |
|---|---|
| Branches | (inline scan -- no autoresearch domains) |
| Dependencies | `dep-vulnerability`, `dep-staleness`, `dep-count-budget` |
| Agents | `agent-staleness`, `agent-tool-coverage`, `agent-instruction-density`, `agent-tuning` |
| Hooks | `hook-perf`, `hook-exit-contract`, `hook-stdin-safety`, `hook-catch-safety`, `hook-size-budget`, `hook-early-exit`, `hook-wiring-freshness`, `hook-doc-sync` |
| Tests | `test-coverage-map`, `test-speed` |
| Config | `config-drift`, `config-schema-coverage`, `settings-event-coverage`, `command-frontmatter` |
| Dead Code | `todo-density`, `function-size-budget`, `service-size-budget`, `component-size-budget` |
| Docs | `rules-cross-reference`, `blueprint-template-completeness` |
| Security | `secret-guard-coverage`, `gitignore-safety`, `env-access-safety`, `xss-surface`, `input-validation-coverage` |

**3. AISLE health (handled by CJS orchestrator):**

The orchestrator reads scanner cache from `~/.claude/projects/<project>/aisle/scanner-cache/`. AISLE scanner state is stored in the user-local project directory, not in-repo. Scanner canary failures map to `pin_mismatch`; full-schema findings map to `gitignore_gap`. If AISLE is not installed, the security category scores from other sources only.

**4. /fix inbox (handled by CJS orchestrator):**

The orchestrator reads both `.4ge-wizard-inbox.jsonl` (wizard inbox) and `_runs/.fix-inbox.jsonl` (hook-health-validator output). Entries are deduplicated, sanitized, and counted per category. Each open inbox item is a -1 deduction to its tagged category (max -4 per category).

### Scoring Model

Each category is scored 0-20 points, starting at 20 with deductions. Raw total is 0-180 (9 categories x 20). Weighted score is normalized to 0-100:

```
weighted_score = sum(category_score * category_weight) / sum(20 * category_weight) * 100
```

Disabled categories (weight=0 or enabled=false) are excluded from both numerator and denominator.

The canonical score for thresholds, grade assignment, and CI gates is `weighted_score`. The raw `pct` (total/max * 100) is stored for transparency only.

### Per-Category Deductions

Deduction values are loaded from `references/threshold-defaults.json` at scan time and deep-merged with any project overrides in `.4ge-wizard.json` under `categories.<name>.thresholds`. The values below document the defaults; actual scoring uses the resolved config.

To override a threshold, add a `thresholds` object to the relevant category in `.4ge-wizard.json`. See `references/config-schema.md` for the ThresholdEntry shape and merge rules.

**Category 1: Branches (20 pts)**
- `merged_not_deleted`: merged local branches not deleted (per threshold-defaults.json)
- `gone_remote`: gone remote tracking branches (per threshold-defaults.json)
- `stale_30d`: branches older than 30 days with no recent commits (per threshold-defaults.json)

**Category 2: Dependencies (20 pts)**
- `high_vuln`: high severity vulnerabilities (per threshold-defaults.json)
- `critical_vuln`: critical severity vulnerabilities (per threshold-defaults.json)
- `major_outdated`: packages more than 2 major versions behind (per threshold-defaults.json)

**Category 3: Agents (20 pts)**
- `stale_verified`: `last-verified` older than `stale_days` (configurable via .4ge-wizard.json thresholds section; default 14 days)
- `missing_maxturns`: missing `maxTurns` in frontmatter (per threshold-defaults.json)
- `placeholder_values`: `{{PLACEHOLDER}}` values in agent files (per threshold-defaults.json)

**Category 4: Hooks (20 pts)**
- `file_missing`: hook wired in settings.json but file missing on disk (per threshold-defaults.json)
- `unwired`: hook file exists but not wired in settings.json (per threshold-defaults.json)
- `bad_exit`: PostToolUse hook using exit(2) instead of exit(0) (per threshold-defaults.json)

**Category 5: Tests (20 pts)**
- `new_failures`: new test failures vs baseline (per threshold-defaults.json)
- `count_decrease`: test count decrease from last run, applied per N tests (configurable via .4ge-wizard.json thresholds section; default per 10)
- `missing_imports`: missing vitest import declarations (per threshold-defaults.json)

**Category 6: Config (20 pts)**
- `version_mismatch`: version mismatch across manifest files (per threshold-defaults.json)
- `schema_error`: JSON schema validation errors (per threshold-defaults.json)
- `env_missing`: required env keys documented in repo docs but missing from tracked env templates (per threshold-defaults.json). Do not read `.env` or `.env.*` secret files.

**Category 7: Dead Code (20 pts)**
- `todo_density`: TODO/FIXME/HACK/XXX comments, applied per N occurrences (configurable via .4ge-wizard.json thresholds section; default per 5)
- `dead_modules`: files with no exports (per threshold-defaults.json)
- `console_log`: console.log in production modules, applied per N occurrences (configurable via .4ge-wizard.json thresholds section; default per 3)
- Orphaned files from repo-hygiene (temp/backup/large tracked): mapped to this category

**Category 8: Docs (20 pts)**
- `stale_handoff`: handoff files older than 7 days with no follow-up (per threshold-defaults.json)
- `hooks_contract_drift`: hooks-contract.md out of sync with settings.json (per threshold-defaults.json)
- `claude_md_stale`: CLAUDE.md architecture section stale (per threshold-defaults.json)

**Category 9: Security (20 pts)**
Security thresholds are subject to security floors: this category cannot be disabled, points values cannot be weakened beyond -1, and pass_threshold cannot be set below 30. See `references/config-schema.md`.
- `pin_mismatch`: Docker image pin manifest mismatches (per threshold-defaults.json)
- `env_tracked`: .env file tracked by git — immediate FAIL (per threshold-defaults.json)
- `gitignore_gap`: gitignore missing common sensitive file patterns (per threshold-defaults.json)
- `wizard_file_tracked`: wizard runtime files tracked by git (.4ge-wizard-inbox.jsonl, .outhouse-session.json) (per threshold-defaults.json)

### Scan Configuration Menu

```
=== SCAN CONFIGURATION ===

  (a) Full sweep [default] -- all 9 categories, all sources
  (b) Quick check -- fast measures only (<5s per category)
  (c) Custom -- toggle categories individually

  Categories:
    1. [x] Branches         5. [x] Tests
    2. [x] Dependencies     6. [x] Config
    3. [x] Agents           7. [x] Dead Code
    4. [x] Hooks            8. [x] Docs
                            9. [x] Security

  Toggle: 1-9 | Scan: Enter | Help: ?
> _
```

Skip this menu for `--quick`, `--auto-safe`, `--ci`, `--preflight`, or `--report` flags (use full sweep or configured categories).

## Stage 2: TRIAGE (~5s)

**Output components:** 3 (Finding Row), 4 (Execution Tier Badges), 6 (Action Menu)

> **Delivery rule (HARD):** Component 6 in conversation is a native AskUserQuestion picker — options 1:1, recommended first, nothing on the menu executes before the operator's ruling. The text Action Menu with `> _` is bin/CLI stdout only, never the interactive surface.

Classify each category as PASS/WARN/FAIL:

| Score Range | Grade | Action |
|-------------|-------|--------|
| >= 80% (16-20/20) | PASS | No deep dive needed |
| 50-79% (10-15/20) | WARN | Optional deep dive |
| < 50% (0-9/20) | FAIL | Mandatory deep dive |

**Critical-Finding Override:** Any single finding with severity "critical" forces mandatory deep dive regardless of overall category score.

**Auto-selection:** Deep-dive includes all FAIL categories plus any WARN category with at least one open inbox item.

**Context budget check:** Read `references/context-budget.md`. If estimated research tokens exceed 80K, warn the user and suggest narrowing scope or using `--report` mode.

Display triage results with per-category scores, grades, deltas from prior run, and action recommendations. Then present the triage menu.

For `--quick` or `--ci` flags: skip triage menu, output results, and exit.

## Stage 3: RESEARCH (configurable ~15-180s)

Read `references/research-protocol.md` for the full dispatch protocol.

For each category selected for deep dive, gather evidence:
- Memory: `memory_search` for prior findings
- Codebase: Glob/Grep/Read for detailed analysis
- Web: WebSearch for known issues, CVEs, changelogs (if enabled)

Assign confidence scores (0.0-1.0 float) to each finding:
- Score >= threshold: `[recommended]`
- Score >= threshold * 0.6 and < threshold: `[suggested]`
- Score < threshold * 0.6: `[detected]`

For `--auto-safe` mode: research depth is forced to Quick (memory + codebase only, ~15K tokens) unless explicitly overridden with `--research-depth standard`.

## Stage 4: FIX MENU (interactive)

**Tier mapping:** Use execution tier names from output-format.md Component 4: Safe→auto, Medium→guided, Risky→manual, Informational→noted, Inbox-sourced→queued. Present findings grouped by execution tier, not risk tier.

Read `references/fix-menu-protocol.md` for the full menu protocol.

Present findings as a numbered, risk-tiered menu:
- **Safe** -- no code changes; deletions, config additions, patch updates
- **Medium** -- likely safe but verify; minor updates, config migrations
- **Risky** -- may break builds; major updates, structural changes
- **Informational** -- no automated fix; display only
- **Inbox-sourced** -- from `/fix` collector; risk tier assigned by research

Suppressed items are excluded from both the menu and scoring. Use `--show-suppressed` to view.

For `--auto-safe`: auto-select all Safe-tier fixes, skip menu.
For `--dry-run`: display menu, do not proceed to Stage 5.

## Stage 5: EXECUTE (autonomous)

**Output components:** 5 (Progress Line), 9 (Delta Card)

Read `references/fix-menu-protocol.md` for execution protocol.

1. Create git stash rollback point with session ID prefix
2. Build dependency graph; detect cycles (break at lowest-priority edge)
3. Execute fixes sequentially -- each attempted once
4. Per-fix rollback: snapshot affected files before each fix; restore from snapshot on failure (not git checkout HEAD)
5. Dependency updates are standalone commits (per CLAUDE.md non-negotiable)

## Stage 6: VERIFY + SHIP

**Output components:** 1 (Score Bar), 9 (Delta Card)

Read `references/verify-protocol.md` for full procedure.

1. Run verification triad: `npx tsc --noEmit && npx eslint . && npx vitest run`
2. Clean up safety stash after successful verification
3. Compute score comparison (before vs after)
4. Present ship menu: commit, push, diff, manual, stash, notify
5. Auto-generate commit message with score delta
6. `memory_store` session summary
7. Write report and JSONL history

### Grade Scale

| Grade | Weighted Score Range |
|-------|---------------------|
| A | 90-100 |
| B | 75-89 |
| C | 55-74 |
| D | 35-54 |
| F | Below 35 |

### Per-Category Research Defaults

| Category | Default Depth | Key Sources |
|----------|---------------|-------------|
| Dependencies | deep | npm audit, OSV.dev, changelogs |
| Security | deep | AISLE health, OSV.dev, web |
| Agents | quick | Codebase only (frontmatter analysis) |
| Hooks | standard | Codebase + memory |
| Tests | standard | Codebase + vitest JSON report |
| Config | standard | Codebase + schema validation |
| Dead Code | quick | Codebase only (import tracing) |
| Docs | quick | Codebase + cross-reference checks |
| Branches | quick | Git commands only |

### Fix Types by Category

| Category | Safe | Medium | Risky | Info |
|----------|------|--------|-------|------|
| Branches | Delete merged, prune remote | -- | -- | Stale unmerged |
| Dependencies | npm override (patch) | Minor updates, new overrides | Major updates | Held majors |
| Agents | Update last-verified | Set missing maxTurns | -- | Ghost agents |
| Hooks | Wire unwired hooks | Fix exit codes, add try/catch | -- | Perf warnings |
| Tests | Add missing vitest imports | Fix config issues | -- | Flaky tests, gaps |
| Config | Sync versions, update tracked env templates | Fix schema violations | -- | -- |
| Dead Code | -- | Remove dead modules | Remove ghost capabilities | TODOs, console.logs |
| Docs | Update hooks-contract.md | -- | -- | Stale handoffs |
| Security | Regenerate pin manifest | Add gitignore patterns | -- | AISLE status |
