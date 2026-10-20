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
6. Store key decisions with `memory_store`

## Constraints

- Workers runtime: no Node.js fs/path/child_process -- use Web APIs only
- Wrangler config in wrangler.toml -- env-specific overrides via [env.NAME]
- Test with `npx vitest run` using @cloudflare/vitest-pool-workers when available
- Deploys (wrangler deploy), DNS and Cloudflare dashboard changes are owner-gated: implement and test locally, then stop for the operator's per-action approval; after approval, the owning lane runs the deploy and proves it live
- Never read or print secret values (API tokens, client secrets, signing keys, bot credentials); use fixtures and secret stores

## Handoff

- D365/Teams integration: dispatch with fix-d365 or fix-teams skill on sonnet-execute
- Cross-package features: dispatch on sonnet-execute
