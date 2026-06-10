---
name: fix-kernel
description: "Agentic OS kernel fixes — boot sequence, capability registry, process registry, scheduler, services"
model_tier: inherit
tools_needed: Bash, Grep, Glob, Read, Edit, Write, mcp__dev-memory__memory_search, mcp__dev-memory__memory_store
preconditions:
  - docs/reference/os-vocabulary.md
memory_tags:
  - kernel
output_file: _runs/{task-name}.md
---

# fix-kernel

Dispatch on `sonnet-execute` for kernel domain work.

## Workflow

1. `memory_search` for domain context (2-4 word query)
2. Vocabulary doc is pre-loaded via CONTEXT_MAP injection
3. Grep/Glob for affected files per vocabulary doc enforce_paths
4. Implement following patterns from vocabulary doc
5. Run tests if applicable
6. Write report to `_runs/<task-name>.md`

## Constraints

- CJS only (.cjs) in lib/os/
- Step 3 (init:registry) is the only FATAL boot step -- all others degrade gracefully
- Capabilities must implement full interface: manifest, init, shutdown, actions
- observability.log takes 3 args (stream, event, data) -- not 2
- Two os-boot files: lib/os/os-boot.cjs (capability helper) vs .claude/hooks/os-boot.cjs (SessionStart hook)

## Handoff

- AISLE capability: dispatch with fix-aisle skill on sonnet-execute
- Commander state consumers: dispatch with fix-commander skill on sonnet-execute
- Ops/deploy: dispatch on ops-expert (pending migration)
- Cross-package features: dispatch on sonnet-execute
