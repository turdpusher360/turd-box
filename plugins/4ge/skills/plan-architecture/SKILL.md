---
name: plan-architecture
description: "Architecture planning — phased breakdowns, STOP gates, judgment calls"
model_tier: inherit
tools_needed: Bash, Grep, Glob, Read, Write, mcp__dev-memory__memory_search, mcp__dev-memory__memory_store
preconditions:
  [] # methodology in skill body
memory_tags:
  - architecture
output_file: _runs/{task-name}.md
---

# plan-architecture

Dispatch on `opus-planner`.

## Workflow

1. `memory_search` for prior context (2-4 word query)
2. Analyze per constraints below
3. Write report/output to `_runs/<task-name>.md`
4. `memory_store` key findings
5. Return summary to lead

## Constraints

- Phased breakdown with explicit STOP gates between phases
- Identify dependencies and parallelization opportunities
- DAG structure for task ordering
- Each phase has acceptance criteria and rollback plan
- Read-only analysis

## Handoff

- Execution of plan: dispatch via /forge Phase 5
- Single-domain implementation: dispatch fix-* skill on sonnet-execute
