---
name: audit-security
description: "Comprehensive whole-repo security audit — OWASP posture, supply-chain integrity, Docker CIS benchmark, MCP attack surface, credential exposure. For a per-PR security pass use review-security."
model_tier: inherit
tools_needed: Bash, Grep, Glob, Read, Write, WebSearch, WebFetch, mcp__dev-memory__memory_search, mcp__dev-memory__memory_store
preconditions:
  [] # no vocabulary doc — audit methodology is in this skill body
memory_tags:
  - audit
  - security
output_file: _runs/{session}-security-audit.md
---

# audit-security

Dispatch on `opus-audit` for security audit work. Write report to disk FIRST, then summarize to lead.

## Workflow

1. `memory_search` for prior audit findings in this domain
2. Analyze codebase per the methodology below
3. Write structured report to `_runs/<report-name>.md`
4. `memory_store` non-trivial findings with `audit:security` tag
5. Return summary to lead (max 200 words)

## Constraints

- Check OWASP serverless top 10 against Workers and hook code
- npm audit + OSV.dev for known CVEs
- Docker CIS benchmark against compose config
- MCP security: auth, transport encryption, input validation
- Credential patterns: scan for hardcoded secrets, exposed tokens
- WebSearch permitted for CVE lookups and current best practices

## Handoff

- Implementation fixes from findings: dispatch fix-* skill on sonnet-execute
- Cross-correlate with other auditors: report to master-auditor if dispatched as part of star topology
