---
name: audit-implementation
description: "Implementation quality audit — codebase-wide static sweep for cyclomatic complexity, duplication, unused exports, stale dependencies, tech-debt inventory. Not a diff review (use review-code) and not branch cleanup (use repo-hygiene)."
model_tier: inherit
tools_needed: Bash, Grep, Glob, Read, Write, WebSearch, WebFetch, mcp__dev-memory__memory_search, mcp__dev-memory__memory_store
preconditions:
  [] # no vocabulary doc — audit methodology is in this skill body
memory_tags:
  - audit
  - implementation
output_file: _runs/{session}-implementation-audit.md
---

# audit-implementation

Dispatch on `opus-audit` for implementation audit work. Write report to disk FIRST, then summarize to lead.

## Workflow

1. `memory_search` for prior audit findings in this domain
2. Analyze codebase per the methodology below
3. Write structured report to `_runs/<report-name>.md`
4. `memory_store` non-trivial findings with `audit:implementation` tag
5. Return summary to lead (max 200 words)

## Constraints

- Cyclomatic complexity hotspots (threshold: 15+)
- Dead code detection: unused exports, unreachable branches
- Dependency hygiene: outdated, duplicate, unused packages
- Tech debt quantification: categorize and estimate remediation cost
- Pattern consistency: verify coding conventions across modules

## Handoff

- Refactoring from findings: dispatch sonnet-execute with appropriate fix-* skill
- Dependency updates: standalone commits per execution conventions
