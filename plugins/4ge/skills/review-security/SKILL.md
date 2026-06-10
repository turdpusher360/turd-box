---
name: review-security
description: "Per-PR security review — vulnerability scanning, secrets audit, OWASP review"
model_tier: inherit
tools_needed: Bash, Grep, Glob, Read, Write, mcp__dev-memory__memory_search, mcp__dev-memory__memory_store
preconditions:
  [] # methodology in skill body
memory_tags:
  - security
output_file: _runs/{task-name}.md
---

# review-security

Dispatch on `opus-review`.

## Workflow

1. `memory_search` for prior context (2-4 word query)
2. Analyze per constraints below
3. Write report/output to `_runs/<task-name>.md`
4. `memory_store` key findings
5. Return summary to lead

## Constraints

- Scan for hardcoded secrets, exposed tokens, credential patterns
- OWASP top 10 check at system boundaries
- Dependency vulnerability assessment
- Input validation at trust boundaries
- Read-only + Bash (git) + memory

## Handoff

- Full security audit: dispatch audit-security skill on opus-audit
- Implementation fixes: dispatch fix-* skill on sonnet-execute
