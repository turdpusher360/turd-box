---
name: fix-cloudflare
description: "Cloudflare Workers fixes — Hono routes, Durable Objects, WebSocket hub, webhooks, wrangler deploys"
model_tier: inherit
tools_needed: Bash, Grep, Glob, Read, Edit, Write, mcp__dev-memory__memory_search, mcp__dev-memory__memory_store
preconditions:
  [] # no vocabulary doc for this domain
memory_tags:
  - cloudflare
output_file: _runs/{task-name}.md
---

# fix-cloudflare

Dispatch on `sonnet-execute` for cloudflare domain work.

## Workflow

1. `memory_search` for domain context (2-4 word query)
2. Grep/Glob for affected files
3. Implement following domain patterns
4. Run tests if applicable
5. Write report to `_runs/<task-name>.md`

## Constraints

- Workers runtime: no Node.js fs/path/child_process -- use Web APIs only
- Wrangler config in wrangler.toml -- env-specific overrides via [env.NAME]
- Docker images pinned by digest in docker-compose.yml
- Test with `npx vitest run` using @cloudflare/vitest-pool-workers when available

## Handoff

- D365/Teams integration: dispatch with fix-d365 or fix-teams skill on sonnet-execute
- Cross-package features: dispatch on sonnet-execute
