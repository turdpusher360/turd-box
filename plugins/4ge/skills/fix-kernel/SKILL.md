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
2. Vocabulary doc is pre-loaded via CONTEXT_MAP injection (only when dispatched as sonnet-execute; otherwise Read the doc first)
3. Grep/Glob for affected files per vocabulary doc enforce_paths
4. Implement following patterns from vocabulary doc
5. Run tests if applicable
6. Write report to `_runs/<task-name>.md`
7. Store key decisions with `memory_store`

## Constraints

- CJS only (.cjs) in lib/os/
- Step 3 (init:registry) is the only FATAL boot step -- all others degrade gracefully
- Capabilities must implement full interface: manifest, init, shutdown, actions
- observability.log takes 3 args (stream, event, data) -- not 2
- Boot code is split: lib/os/kernel/boot-sequence.cjs (kernel boot steps) vs .claude/hooks/os-boot.cjs (SessionStart hook that calls boot.run)

## Handoff

- AISLE capability: dispatch with fix-aisle skill on sonnet-execute
- Commander state consumers: dispatch with fix-commander skill on sonnet-execute
- Ops/deploy: dispatch with ops-infra skill on sonnet-execute
- Cross-package features: dispatch on sonnet-execute
