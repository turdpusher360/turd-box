---
name: research-multi
description: "Multi-source research — fan out parallel web searches across independent sources, reconcile conflicting findings, deliver one cited brief. For a single-source lookup use research-single."
model_tier: inherit
tools_needed: Bash, Grep, Glob, Read, Write, mcp__dev-memory__memory_search, mcp__dev-memory__memory_store
preconditions:
  [] # methodology in skill body
memory_tags:
  - multi
output_file: _runs/{task-name}.md
---

# research-multi

Dispatch on `opus-planner`.

## Workflow

1. `memory_search` for prior context (2-4 word query)
2. Analyze per constraints below
3. Write report/output to `_runs/<task-name>.md`
4. `memory_store` key findings
5. Return summary to lead

## Constraints

- Coordinate multiple research sources (web, codebase, memory)
- Delegate sub-queries to sonnet-research for parallel execution
- Synthesize findings with provenance and confidence scoring
- Write findings to _runs/ with source citations

## Handoff

- Single-source lookup: dispatch research-single skill on sonnet-research
- Background research queue: dispatch research-background skill on sonnet-research
