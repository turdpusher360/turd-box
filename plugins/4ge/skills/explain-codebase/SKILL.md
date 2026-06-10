---
name: explain-codebase
description: "Codebase explanation and onboarding — architecture walkthroughs, how-does-X-work answers"
model_tier: inherit
tools_needed: Bash, Grep, Glob, Read, Write, mcp__dev-memory__memory_search, mcp__dev-memory__memory_store
preconditions:
  [] # methodology in skill body
memory_tags:
  - codebase
output_file: _runs/{task-name}.md
---

# explain-codebase

Dispatch on `sonnet-research`.

## Workflow

1. `memory_search` for prior context (2-4 word query)
2. Analyze per constraints below
3. Write report/output to `_runs/<task-name>.md`
4. `memory_store` key findings
5. Return summary to lead

## Constraints

- Read-only exploration and explanation
- Trace execution paths and map architecture layers
- Tailor explanations to user expertise level
- Cross-reference with memory for prior explanations
- No code changes — read-only

## Handoff

- Implementation from understanding: dispatch fix-* skill on sonnet-execute
- Architectural questions: dispatch plan-architecture skill on opus-planner
