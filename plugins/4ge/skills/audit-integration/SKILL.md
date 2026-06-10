---
name: audit-integration
description: "Integration audit — contract testing, service dependency mapping, failure mode analysis"
model_tier: inherit
tools_needed: Bash, Grep, Glob, Read, Write, WebSearch, WebFetch, mcp__dev-memory__memory_search, mcp__dev-memory__memory_store
preconditions:
  [] # no vocabulary doc — audit methodology is in this skill body
memory_tags:
  - audit
  - integration
output_file: _runs/{session}-integration-audit.md
---

# audit-integration

Dispatch on `opus-audit` for integration audit work. Write report to disk FIRST, then summarize to lead.

## Workflow

1. `memory_search` for prior audit findings in this domain
2. Analyze codebase per the methodology below
3. Write structured report to `_runs/<report-name>.md`
4. `memory_store` non-trivial findings with `audit:integration` tag
5. Return summary to lead (max 200 words)

## Constraints

- Map service dependencies (MCP hub, Ollama, Docker, Cloudflare)
- Verify contract compatibility at integration boundaries
- Identify single points of failure and cascading failure paths
- Check retry/timeout/circuit-breaker patterns
- Distributed tracing: verify correlation IDs propagate

## Handoff

- Infrastructure fixes: dispatch ops-infra skill on sonnet-execute
- Cloudflare fixes: dispatch fix-cloudflare skill on sonnet-execute
