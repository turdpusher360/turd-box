---
description: "Guided Knowledge hub: memory search, repo map, context budget, respawn, decisions. Use /recall for the menu or /recall <query> for dev-memory search."
argument-hint: "[query | --map | --budget | --deep | (empty for menu)]"
paths: ["**"]
---

## /recall -- Guided Knowledge Hub

**If `$ARGUMENTS` is empty, show the Guided Knowledge Hub menu (bottom of this file) -- do not search blindly.** Otherwise, `/recall` is the canonical intelligence-gathering path: parse `$ARGUMENTS` and run the matching mechanic directly.

**Parse arguments:** Extract the query from `$ARGUMENTS`. Check for flags:
- `--map`: repository map
- `--map --summary`: category counts only
- `--map --category <name>`: single category filter
- `--budget`: context budget forecast
- `--deep`: extended memory search + entity graph
- otherwise: treat `$ARGUMENTS` as a plain dev-memory query

### Default Mode (bare query)

When `$ARGUMENTS` is a plain query string (no flags):

1. Run `mcp__dev-memory__memory_search` with `query: "$ARGUMENTS"`, `limit: 5`
2. Display results with importance scores and tags
3. If results are sparse (< 2 results), suggest `--deep` or `--map` for broader exploration

### --map Mode

1. Get file list: run `git ls-files` in Bash
2. Load repo index: `const { buildIndex } = require('${CLAUDE_PLUGIN_ROOT}/lib/repo-index.cjs')`
3. Call `buildIndex(files)` with the file list
4. If `--summary`: display category counts only
5. If `--category <name>`: filter to that category
6. Otherwise: display full categorized index

### --budget Mode

1. Load budget module: `const { forecastBudget } = require('${CLAUDE_PLUGIN_ROOT}/lib/context-budget.cjs')`
2. Call `forecastBudget()` with current session context
3. Display token budget breakdown: used, remaining, estimated per-phase costs

### --deep Mode

1. Run `mcp__dev-memory__memory_search` with `query: "$ARGUMENTS"`, `limit: 15`
2. If the runtime exposes `mcp__dev-memory__memory_entities`, run it for entity graph context related to the query
3. If `memory_entities` is unavailable, do not fail the command; report "entity graph unavailable in this runtime" and continue with the expanded search results
4. Display combined results when graph context exists, otherwise display the expanded memory-search result set

---

## Empty Args: Guided Knowledge Hub

When `$ARGUMENTS` is empty, do not search blindly. Render a cheap status strip, then use `AskUserQuestion` as the native menu shell. The menu routes into the knowledge mechanics above -- it adds discoverability, not a new implementation path. Menu navigation is native (~=0 model tokens); the model is spent only on the leaf the operator selects.

### HUD strip

Render one deterministic line before the menu. Do not summarize or reinterpret it.

1. If `_runs/os/boot-status.json` exists, read `_runs/os/boot-status.json` and `_runs/os/health.json`, merge them into `{ ...bootStatus, health: healthJson }`, then pipe the JSON to:

```bash
node plugins/4ge/bin/hud-engine.cjs --mode=strip
```

2. If the OS files are missing, print `Knowledge: dev-memory` and continue to the menu.

### Menu round 1

Call `AskUserQuestion` with one question:

```text
question: "What do you want to recall?"
header: "Knowledge"
options:
- Search memory (Recommended): ask for a query, then run the Default Mode mechanic above (memory_search, limit 5).
- Repo map: run the --map Mode mechanic above (categorized repository index).
- Context budget: run the --budget Mode mechanic above (token budget forecast).
- Respawn or log: restore context, or log a decision/constraint.
```

### Menu round 2 (only if "Respawn or log")

```text
question: "Which knowledge action?"
header: "Context"
options:
- Respawn (Recommended): route to /respawn (extract decision chain, prep fresh context).
- Log a decision: route to /decide.
- Log a constraint: route to /constraint.
- Repo map: run the --map Mode mechanic above.
```

After a selection, dispatch exactly as if the operator had typed the direct command. For "Search memory", run the Default Mode mechanic with the supplied query. The menu is a router, not a new implementation path; preserve direct-command semantics. Do not ask extra confirmation when the selected action is unambiguous.
