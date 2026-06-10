---
name: debug-investigate
description: "Systematic bug investigation — error diagnosis, root cause analysis, fix verification"
model_tier: inherit
tools_needed: Bash, Grep, Glob, Read, Write, mcp__dev-memory__memory_search, mcp__dev-memory__memory_store
preconditions:
  [] # methodology in skill body
memory_tags:
  - investigate
output_file: _runs/{task-name}.md
---

# debug-investigate

Dispatch on `sonnet-execute`.

## Workflow

1. `memory_search` for prior context (2-4 word query)
2. Analyze per constraints below
3. Write report/output to `_runs/<task-name>.md`
4. `memory_store` key findings
5. Return summary to lead

## Constraints

- Systematic root cause analysis: reproduce, isolate, identify, fix, verify
- Memory search for prior incidents in same area
- Causal mapping before proposing fixes
- Verify fix with tests before claiming done
- Write investigation report to _runs/

## Handoff

- Architecture-level bugs: escalate to plan-architecture skill on opus-planner
- Security bugs: dispatch review-security skill on opus-review
