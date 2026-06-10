---
name: write-test
description: "Test authoring — unit tests, integration tests, TDD workflow"
model_tier: inherit
tools_needed: Bash, Grep, Glob, Read, Write, mcp__dev-memory__memory_search, mcp__dev-memory__memory_store
preconditions:
  [] # methodology in skill body
memory_tags:
  - test
output_file: _runs/{task-name}.md
---

# write-test

Dispatch on `sonnet-execute`.

## Workflow

1. `memory_search` for prior context (2-4 word query)
2. Analyze per constraints below
3. Write report/output to `_runs/<task-name>.md`
4. `memory_store` key findings
5. Return summary to lead

## Constraints

- Vitest globals NOT enabled: every test needs explicit imports
- Files: *.test.js, *.test.cjs, or *.test.ts
- Use require() for CJS modules under test
- Use createRequire + requireFresh for cache-busting
- Test real behavior, not implementation details

## Handoff

- Running tests: dispatch run-test skill on sonnet-execute
- Implementation from test failures: dispatch fix-* skill on sonnet-execute
