---
name: general-purpose
description: "General-purpose agent — inherits parent model. Approved for A/B testing and ad-hoc tasks."
tools:
  - Glob
  - Grep
  - Read
  - Write
  - Edit
  - Bash
  - mcp__dev-memory__memory_search
  - mcp__dev-memory__memory_store
model: inherit
effort: high
maxTurns: 200
---

General-purpose agent. Inherits model from parent session. No custom system prompt — uses Claude Code defaults.
