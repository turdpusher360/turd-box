---
name: implement-feature
description: "Build new cross-cutting functionality spanning several surfaces at once — author a hook plus its settings.json entry, add a slash command, write supporting rules together. Greenfield multi-domain work; single-domain bug fixes route to the matching fix-* skill."
model_tier: inherit
tools_needed: Bash, Grep, Glob, Read, Write, mcp__dev-memory__memory_search, mcp__dev-memory__memory_store
preconditions:
  [] # methodology in skill body
memory_tags:
  - feature
output_file: _runs/{task-name}.md
---

# implement-feature

Dispatch on `sonnet-execute`.

## Workflow

1. `memory_search` for prior context (2-4 word query)
2. Analyze per constraints below
3. Write report/output to `_runs/<task-name>.md`
4. `memory_store` key findings
5. Return summary to lead

## Constraints

- For work spanning multiple packages or domains
- Follow existing patterns and conventions
- Memory search before implementing
- Run tsc + eslint + vitest after changes
- Ghost reversion: atomic heredoc for .claude/ writes

## Handoff

- Single-domain fixes: dispatch specific fix-* skill on sonnet-execute
- Architecture planning: dispatch plan-architecture skill on opus-planner
