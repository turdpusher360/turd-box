---
name: fix-commander
description: "Electron tray app fixes — React 19 panels, Zustand stores, IPC bridge, Vite 7 build"
model_tier: inherit
tools_needed: Bash, Grep, Glob, Read, Edit, Write, mcp__dev-memory__memory_search, mcp__dev-memory__memory_store
preconditions:
  - docs/reference/commander-vocabulary.md
memory_tags:
  - commander
output_file: _runs/{task-name}.md
---

# fix-commander

Dispatch on `sonnet-execute` for commander domain work.

## Workflow

1. `memory_search` for domain context (2-4 word query)
2. Vocabulary doc is pre-loaded via CONTEXT_MAP injection
3. Grep/Glob for affected files per vocabulary doc enforce_paths
4. Implement following patterns from vocabulary doc
5. Run tests if applicable
6. Write report to `_runs/<task-name>.md`

## Constraints

- Two-window model: popover (400x500 frameless) and settings (900x650 framed)
- New IPC channels require BOTH preload allowlist AND main/ipc/ registration -- missing either causes silent failure
- Tailwind v4 conventions (not v3)
- Do not modify _runs/os/ state files -- kernel domain owns those
- Electron 41, React 19, Zustand 5, Vite 7

## Handoff

- OS state file changes: dispatch with fix-kernel skill on sonnet-execute
- HUD rendering: dispatch with fix-hud skill on sonnet-execute
- Deploy/infra: dispatch on ops-expert (pending migration)
