---
name: fix-d365
description: "Dynamics 365 Web API fixes — OAuth2, OData queries, entity schemas, webhook HMAC, D365 mock testing"
model_tier: inherit
tools_needed: Bash, Grep, Glob, Read, Edit, Write, mcp__dev-memory__memory_search, mcp__dev-memory__memory_store
preconditions:
  [] # no vocabulary doc for this domain
memory_tags:
  - d365
output_file: _runs/{task-name}.md
---

# fix-d365

Dispatch on `sonnet-execute` for d365 domain work.

## Workflow

1. `memory_search` for domain context (2-4 word query)
2. Grep/Glob for affected files
3. Implement following domain patterns
4. Run tests if applicable
5. Write report to `_runs/<task-name>.md`

## Constraints

- OAuth2 token lifecycle: acquire/refresh/cache pattern
- OData query syntax: $filter, $expand, $select -- case-sensitive field names
- Webhook HMAC verification: timing-safe comparison required
- Mock testing: use D365 response fixtures, not live API calls

## Handoff

- Cloudflare Workers: dispatch with fix-cloudflare skill on sonnet-execute
- Teams integration: dispatch with fix-teams skill on sonnet-execute
- Cross-package features: dispatch on sonnet-execute
