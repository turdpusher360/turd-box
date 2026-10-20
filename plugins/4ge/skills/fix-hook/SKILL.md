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
2. Vocabulary doc is pre-loaded via CONTEXT_MAP injection only when dispatched as sonnet-execute (the Phase B precondition is then satisfied automatically); otherwise Read the doc first
3. Grep existing patterns in `.claude/hooks/` and `.claude/settings.json`
4. Implement using hook-utils patterns and exit code protocol from vocabulary doc
5. Verify wiring in settings.json -- add matcher block if new hook
6. Test: `node -c .claude/hooks/<hook>.cjs` for syntax
7. Write report to `_runs/<task-name>.md`
8. Store key decisions with `memory_store`

## Constraints

- CJS only (.cjs)
- Under 100ms per invocation (SessionStart exempt)
- Use `readStdinJson()` from `lib/hook-utils.cjs`
- PreToolUse blocks via stderr + exit(2); PostToolUse always exits 0
- PostToolUse stdin field is `tool_response`, NOT `tool_result`
- `process.env.CLAUDE_SESSION_ID` is UNSET -- use `input.session_id`
- `.claude/` writes may be refused by a project gate or Claude Code's file-state check. Follow the target repo's deliberate config-write procedure; staging/commit approval is separate.

## Handoff

- AISLE scanner internals: dispatch with fix-aisle skill on sonnet-execute
- Cross-package features: dispatch on sonnet-execute
- Test infrastructure: dispatch with run-test or write-test skill on sonnet-execute
- Gate/guard code touched (allow/deny hooks, settings and permissions, secret handling): say so in the report; the read-only audit (AGENTS.md › Model Routing) runs before the signed commit, launched by the author lane and checked by the lead
