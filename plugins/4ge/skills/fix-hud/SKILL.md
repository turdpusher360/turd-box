---
name: fix-hud
description: "HUD engine rendering fixes — zones, expressions, themes, badges, canvas, boot screen, statusline"
model_tier: inherit
tools_needed: Bash, Grep, Glob, Read, Edit, Write, mcp__dev-memory__memory_search, mcp__dev-memory__memory_store
preconditions:
  - docs/reference/hud-vocabulary.md
memory_tags:
  - hud
  - rendering
output_file: _runs/{task-name}.md
---

# fix-hud

Dispatch on `sonnet-execute` for HUD engine work: zones, expressions, palette, statusline, boot screen.

## Workflow

1. `memory_search` for HUD engine context
2. Vocabulary doc is pre-loaded via CONTEXT_MAP injection
3. Glob/Grep for affected zone files in `plugins/4ge/bin/hud-*.cjs`
4. Implement following pipeline and zone patterns from vocabulary doc
5. Test: `npx vitest run plugins/4ge/bin/__tests__/` -- tests green
6. Write report to `_runs/<task-name>.md`

## Constraints

- Never mutate exported ZONE_META constants -- copy first
- Use PLAIN palette for text assertions in tests
- Filled-canvas invariant: every row must have ANSI content (bg + spaces + reset)
- Health bar: high=green (good). Context/rate bars: high=red (bad). Do not cross-apply.
- CJS only (.cjs)

## Handoff

- Ops/deploy: dispatch on sonnet-execute with ops skill
- Test infrastructure: dispatch with test skill on sonnet-execute
- Cross-package features: dispatch on sonnet-execute
