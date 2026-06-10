---
name: research-background
description: "Background research worker — processes research queue items"
model_tier: inherit
tools_needed: Bash, Grep, Glob, Read, Write, mcp__dev-memory__memory_search, mcp__dev-memory__memory_store
preconditions:
  [] # methodology in skill body
memory_tags:
  - background
output_file: _runs/{task-name}.md
---

# research-background

Dispatch on `sonnet-research`.

## Workflow

1. `memory_search` for prior context (2-4 word query)
2. Analyze per constraints below
3. Write report/output to `_runs/<task-name>.md`
4. `memory_store` key findings
5. Return summary to lead

## Constraints

- Execute research per item from the research queue
- Lite-tier operations: core 8 ops per item
- Store findings with provenance and confidence scoring
- Write to _runs/ with source citations

## Handoff

- Complex findings: escalate to research-multi skill on opus-planner
