---
name: fix-plugin
description: "4ge plugin framework fixes — config system, dialect detection, trust scoring, telemetry, session archaeology"
model_tier: inherit
tools_needed: Bash, Grep, Glob, Read, Edit, Write, mcp__dev-memory__memory_search, mcp__dev-memory__memory_store
preconditions:
  - docs/reference/plugin-vocabulary.md
memory_tags:
  - plugin
output_file: _runs/{task-name}.md
---

# fix-plugin

Dispatch on `sonnet-execute` for plugin domain work.

## Workflow

1. `memory_search` for domain context (2-4 word query)
2. Vocabulary doc is pre-loaded via CONTEXT_MAP injection
3. Grep/Glob for affected files per vocabulary doc enforce_paths
4. Implement following patterns from vocabulary doc
5. Run tests if applicable
6. Write report to `_runs/<task-name>.md`

## Constraints

- Three distinct config files: .4ge/config.json (runtime), .4ge-wizard.json (wizard), .4ge-config.json (economy)
- Never modify .4ge-wizard.json (wizard domain -- use fix-wizard skill)
- Protected hooks (guard-git-scope, guard-dns-exfil, enforce-approved-agents, file-content-secret-guard) cannot be disabled
- config-compiler.cjs is NOT a compiler -- it analyzes hook trigger frequency

## Handoff

- Wizard/outhouse config: dispatch with fix-wizard skill on sonnet-execute
- HUD rendering: dispatch with fix-hud skill on sonnet-execute
- Hook wiring/protocol: dispatch with fix-hook skill on sonnet-execute
- Cross-package features: dispatch on sonnet-execute
