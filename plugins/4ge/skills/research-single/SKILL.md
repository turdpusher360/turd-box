---
name: research-single
description: "Single-source research — web search, documentation lookup, error diagnosis"
model_tier: inherit
tools_needed: Bash, Grep, Glob, Read, Write, mcp__dev-memory__memory_search, mcp__dev-memory__memory_store
preconditions:
  [] # methodology in skill body
memory_tags:
  - single
output_file: _runs/{task-name}.md
---

# research-single

Dispatch on `sonnet-research`.

## Workflow

1. `memory_search` for prior context (2-4 word query)
2. Analyze per constraints below
3. Write report/output to `_runs/<task-name>.md`
4. `memory_store` key findings
5. Return summary to lead

## Constraints

- Focused single-source investigation
- Web search for documentation, error diagnosis, tool evaluation
- Write findings to _runs/ with provenance
- Keep scope narrow — escalate to research-multi for multi-source

## Handoff

- Multi-source investigation: escalate to research-multi skill on opus-planner
- Implementation from findings: dispatch fix-* skill on sonnet-execute
