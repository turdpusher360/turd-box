---
name: review-project
description: "Pre-commit project review — validates file operations, verifies claims, catches scope creep"
model_tier: inherit
tools_needed: Bash, Grep, Glob, Read, Write, mcp__dev-memory__memory_search, mcp__dev-memory__memory_store
preconditions:
  [] # methodology in skill body
memory_tags:
  - project
output_file: _runs/{task-name}.md
---

# review-project

Dispatch on `opus-review`.

## Workflow

1. `memory_search` for prior context (2-4 word query)
2. Analyze per constraints below
3. Write report/output to `_runs/<task-name>.md`
4. `memory_store` key findings
5. Return summary to lead

## Constraints

- Validate all file operations match claimed intent
- Verify claims against git log before acting
- Catch scope creep and terminology violations
- Check ghost reversion patterns on .claude/ files
- Read-only + Bash (git) + memory

## Handoff

- Adversarial review: dispatch review-adversarial skill on opus-review
- Implementation fixes: dispatch fix-* skill on sonnet-execute
