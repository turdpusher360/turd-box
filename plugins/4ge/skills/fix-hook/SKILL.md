---
name: fix-hook
description: "Hook system bug fixing and development — hook-utils, settings.json wiring, stdin protocol, exit codes, capability patterns"
model_tier: inherit
tools_needed: Bash, Grep, Glob, Read, Edit, Write, mcp__dev-memory__memory_search, mcp__dev-memory__memory_store
preconditions:
  - docs/reference/hooks-vocabulary.md
memory_tags:
  - hooks
  - hook-system
output_file: _runs/{task-name}.md
---

# fix-hook

Dispatch on `sonnet-execute` for hook system work: fixing, modifying, or creating hooks.

## Workflow

1. `memory_search` for hook system context (2-4 word query)
2. Vocabulary doc is pre-loaded via CONTEXT_MAP injection (Phase B precondition satisfied automatically)
3. Grep existing patterns in `.claude/hooks/` and `.claude/settings.json`
4. Implement using hook-utils patterns and exit code protocol from vocabulary doc
5. Verify wiring in settings.json -- add matcher block if new hook
6. Test: `node -c .claude/hooks/<hook>.cjs` for syntax
7. Write report to `_runs/<task-name>.md`

## Constraints

- CJS only (.cjs)
- Under 100ms per invocation (SessionStart exempt)
- Use `readStdinJson()` from `lib/hook-utils.cjs`
- PreToolUse blocks via stderr + exit(2); PostToolUse always exits 0
- PostToolUse stdin field is `tool_response`, NOT `tool_result`
- `process.env.CLAUDE_SESSION_ID` is UNSET -- use `input.session_id`
- Ghost reversion: atomic heredoc for `.claude/` writes, or Read-before-Edit

## Handoff

- AISLE scanner internals: dispatch with fix-aisle skill on sonnet-execute
- Cross-package features: dispatch on sonnet-execute
- Test infrastructure: dispatch with test skill on sonnet-execute
