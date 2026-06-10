---
name: audit-config
description: "Claude Code configuration audit — read-only health pass over agent frontmatter, hook wiring drift, slash-command registration, MCP server entries, memory setup. Audits what already exists; net-new builds belong to implement-feature, broken-hook repair to fix-hook."
model_tier: inherit
tools_needed: Bash, Grep, Glob, Read, Write, WebSearch, WebFetch, mcp__dev-memory__memory_search, mcp__dev-memory__memory_store
preconditions:
  [] # no vocabulary doc — audit methodology is in this skill body
memory_tags:
  - audit
  - config
output_file: _runs/{session}-config-audit.md
---

# audit-config

Dispatch on `opus-audit` for config audit work. Write report to disk FIRST, then summarize to lead.

## Workflow

1. `memory_search` for prior audit findings in this domain
2. Analyze codebase per the methodology below
3. Write structured report to `_runs/<report-name>.md`
4. `memory_store` non-trivial findings with `audit:config` tag
5. Return summary to lead (max 200 words)

## Constraints

- Audit hooks-contract.md vs settings.json for wiring drift
- Check agent frontmatter validity (required fields, model values)
- Verify MCP server configs (.mcp.json) match running services
- Memory protocol compliance: search-before-build, store-after-learn
- Rules files: path-scoping correctness, no contradictions

## Handoff

- Hook fixes from findings: dispatch fix-hook skill on sonnet-execute
- Plugin config fixes: dispatch fix-plugin skill on sonnet-execute
