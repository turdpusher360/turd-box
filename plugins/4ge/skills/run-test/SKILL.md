---
name: run-test
description: "Test execution and pre-commit validation — tsc, eslint, vitest"
model_tier: inherit
tools_needed: Bash, Grep, Glob, Read, Write, mcp__dev-memory__memory_search, mcp__dev-memory__memory_store
preconditions:
  [] # methodology in skill body
memory_tags:
  - test
output_file: _runs/{task-name}.md
---

# run-test

Dispatch on `sonnet-execute`.

## Workflow

1. `memory_search` for prior context (2-4 word query)
2. Analyze per constraints below
3. Write report/output to `_runs/<task-name>.md`
4. `memory_store` key findings
5. Return summary to lead

## Constraints

- Run: npx tsc --noEmit, npx eslint ., npx vitest run
- On Windows: run tests in batches (avoid full suite at once)
- Report pass/fail with specific error details
- Vitest + pool-workers has known Windows issues

## Handoff

- Writing new tests: dispatch write-test skill on sonnet-execute
- Fixing test failures: dispatch debug-investigate skill on sonnet-execute
