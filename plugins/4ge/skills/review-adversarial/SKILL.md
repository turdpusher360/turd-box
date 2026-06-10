---
name: review-adversarial
description: "Single-pass inline adversarial review for AI-generated code — catches hallucinated APIs, slopsquatting, logic errors. Lightweight, no subagent fan-out. For a deep multi-agent pass use dfe-review."
model_tier: inherit
tools_needed: Bash, Grep, Glob, Read, Write, mcp__dev-memory__memory_search, mcp__dev-memory__memory_store
preconditions:
  [] # methodology in skill body
memory_tags:
  - adversarial
output_file: _runs/{task-name}.md
---

# review-adversarial

Dispatch on `opus-review`.

## Workflow

1. `memory_search` for prior context (2-4 word query)
2. Analyze per constraints below
3. Write report/output to `_runs/<task-name>.md`
4. `memory_store` key findings
5. Return summary to lead

## Constraints

- 6-pass analysis: existence, security, logic, runtime, trust, artifacts
- Verify imports resolve, packages exist on npm, APIs are not deprecated
- Check for race conditions, off-by-one, inverted booleans, tautological tests
- Scan for prompt injection artifacts, copy-paste drift, excessive complexity
- Every finding needs evidence (file:line, reproduction steps)

## Handoff

- Implementation fixes: dispatch fix-* skill on sonnet-execute
- Full DFE 6-pass: use /dfe command (DFE orchestrator agent)
