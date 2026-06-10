---
name: review-code
description: "Code quality review — best practices, maintainability, constructive feedback"
model_tier: inherit
tools_needed: Bash, Grep, Glob, Read, Write, mcp__dev-memory__memory_search, mcp__dev-memory__memory_store
preconditions:
  [] # methodology in skill body
memory_tags:
  - code
output_file: _runs/{task-name}.md
---

# review-code

Dispatch on `opus-review`.

## Workflow

1. `memory_search` for prior context (2-4 word query)
2. Analyze per constraints below
3. Write report/output to `_runs/<task-name>.md`
4. `memory_store` key findings
5. Return summary to lead

## Constraints

- Focus on code quality, not style preferences
- Constructive feedback with specific improvement suggestions
- Check for OWASP top 10 at system boundaries
- Verify test coverage for changed code paths
- Read-only + Bash (git)

## Handoff

- Security-focused review: dispatch review-security skill on opus-review
- Implementation fixes: dispatch fix-* skill on sonnet-execute
