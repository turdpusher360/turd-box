---
name: ops-infra
description: "Infrastructure operations — health checks, deploys, log analysis, MCP diagnostics, Docker, monitoring"
model_tier: inherit
tools_needed: Bash, Grep, Glob, Read, Edit, Write, mcp__dev-memory__memory_search, mcp__dev-memory__memory_store
preconditions:
  [] # no vocabulary doc for this domain
memory_tags:
  - ops-infra
output_file: _runs/{task-name}.md
---

# ops-infra

Dispatch on `sonnet-execute` for ops-infra domain work.

## Workflow

1. `memory_search` for domain context (2-4 word query)
2. Grep/Glob for affected files
3. Implement following domain patterns
4. Run tests if applicable
5. Write report to `_runs/<task-name>.md`

## Constraints

- Docker images pinned by digest -- update digests when bumping versions
- Never modify Docker stack or subscription tiers without user approval
- WebFetch/fetch cannot reach localhost -- use Docker logs or curl from Bash
- MCP diagnostics: check hub on port 8091, Streamable HTTP is stateless
- Platform gotchas: see .claude/rules/platform-gotchas.md (auto-loaded)

## Handoff

- OS kernel: dispatch with fix-kernel skill on sonnet-execute
- Hook system: dispatch with fix-hook skill on sonnet-execute
- Cross-package features: dispatch on sonnet-execute
