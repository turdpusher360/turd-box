---
description: "Systematic debugging -- guided root-cause analysis with memory search, causal mapping, and fix verification"
argument-hint: "<symptom description> [--trace] [--bisect] [--hypothesis <text>]"
paths: ["**"]
---

## /debug -- Systematic Debugging

**Parse arguments:** Extract symptom description from `$ARGUMENTS`. Check for flags:
- `--trace`: Include stack trace collection step
- `--bisect`: Include `git bisect` workflow
- `--hypothesis <text>`: Seed the debugging flow with a starting hypothesis

**Step 1: Context gathering**

Run `mcp__dev-memory__memory_search` with `query` set to the 2-4 most specific keywords from the symptom description, `limit: 5`. Display any relevant prior context found.

**Step 2: Invoke 4ge debug investigation**

INVOKE debug-investigate with:
- The symptom description as the primary input
- Any memory search results as prior context
- If `--trace` flag: add "collect and analyze stack traces" to the investigation steps
- If `--bisect` flag: add "use git bisect to find the regression commit" to the investigation steps
- If `--hypothesis` flag: seed the hypothesis list with the provided text

Superpowers systematic debugging may remain an internal sub-protocol/fallback when the
debug investigation needs stricter root-cause discipline, but `/debug` is the top-level
Forge/4ge route and should not tell users to invoke Superpowers directly.

**Step 3: Resolution**

After the debugging flow completes:
1. Store the root cause and fix summary to memory: `mcp__dev-memory__memory_store` with `importance: 0.7` and tags `["debug", "fix"]`
2. If a fix was applied, suggest running verification: `npx tsc --noEmit && npx eslint . && npx vitest run`
