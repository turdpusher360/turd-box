---
name: fix-wizard
description: "Debug the wizard/outhouse engine source when /outhouse or /wizard itself misbehaves — stage-transition defects, threshold math, score-merge bugs, scan-mode detection. To run the pipeline use wizard-engine."
model_tier: inherit
tools_needed: Bash, Grep, Glob, Read, Edit, Write, mcp__dev-memory__memory_search, mcp__dev-memory__memory_store
preconditions:
  - docs/reference/wizard-vocabulary.md
memory_tags:
  - wizard
output_file: _runs/{task-name}.md
---

# fix-wizard

Dispatch on `sonnet-execute` for wizard domain work.

## Workflow

1. `memory_search` for domain context (2-4 word query)
2. Vocabulary doc is pre-loaded via CONTEXT_MAP injection (only when dispatched as sonnet-execute; otherwise Read the doc first)
3. Grep/Glob for affected files per vocabulary doc enforce_paths
4. Implement following patterns from vocabulary doc
5. Run tests if applicable
6. Write report to `_runs/<task-name>.md`
7. Store key decisions with `memory_store`

## Constraints

- Security floors are non-negotiable (5 rules in vocabulary doc)
- wizard-output.cjs and wizard-scoring.cjs are coupled -- keep in sync
- Config merge: 4-layer (plugin defaults, vertical defaults, .4ge-wizard.json, mode frontmatter), null-as-delete, arrays REPLACE
- The max field is a FLOOR (most-negative limit), not a ceiling

## Handoff

- Plugin config loading: dispatch with fix-plugin skill on sonnet-execute
- Test infrastructure: dispatch on sonnet-execute
- Cross-package features: dispatch on sonnet-execute
