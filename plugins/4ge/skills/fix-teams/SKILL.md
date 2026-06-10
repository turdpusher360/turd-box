---
name: fix-teams
description: "Microsoft Teams integration fixes — Bot Framework, Adaptive Card design + snapshot testing, Teams manifest"
model_tier: inherit
tools_needed: Bash, Grep, Glob, Read, Edit, Write, mcp__dev-memory__memory_search, mcp__dev-memory__memory_store
preconditions:
  [] # no vocabulary doc for this domain
memory_tags:
  - teams
output_file: _runs/{task-name}.md
---

# fix-teams

Dispatch on `sonnet-execute` for teams domain work.

## Workflow

1. `memory_search` for domain context (2-4 word query)
2. Grep/Glob for affected files
3. Implement following domain patterns
4. Run tests if applicable
5. Write report to `_runs/<task-name>.md`

## Constraints

- Adaptive Cards: JSON schema v1.5 -- test with snapshot comparisons
- Bot Framework: activity handler pattern, turn context lifecycle
- Teams manifest: validate with Teams toolkit before deploy
- Messaging extensions: search/action command patterns

## Handoff

- Cloudflare Workers: dispatch with fix-cloudflare skill on sonnet-execute
- D365 integration: dispatch with fix-d365 skill on sonnet-execute
- Cross-package features: dispatch on sonnet-execute
