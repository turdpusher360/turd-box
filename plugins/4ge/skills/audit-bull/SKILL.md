---
name: audit-bull
description: "Coverage-maximizing adversarial audit — volume over precision, every file, every pattern, every hunch"
model_tier: inherit
tools_needed: Bash, Grep, Glob, Read, Write, WebSearch, WebFetch, mcp__dev-memory__memory_search, mcp__dev-memory__memory_store
preconditions:
  [] # no vocabulary doc — audit methodology is in this skill body
memory_tags:
  - audit
  - bull
output_file: _runs/{session}-bull-audit.md
---

# audit-bull

Dispatch on `opus-audit` for bull audit work. Write report to disk FIRST, then summarize to lead.

## Workflow

1. `memory_search` for prior audit findings in this domain
2. Analyze codebase per the methodology below
3. Write structured report to `_runs/<report-name>.md`
4. `memory_store` non-trivial findings with `audit:bull` tag
5. Return summary to lead (max 200 words)

## Constraints

- Generate Insight blocks at MAXIMUM rate
- Cover every file touched, every pattern observed, every hunch
- Volume over precision: flag everything, let the lead filter
- Cross-reference findings across files for systemic patterns
- No finding too small: typos, stale comments, naming drift all count

## Handoff

- Findings triage: lead decides which become fix tasks
- Deep investigation: dispatch specific audit-* skill for targeted follow-up
