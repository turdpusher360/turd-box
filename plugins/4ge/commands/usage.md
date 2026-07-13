---
description: "Local usage/cost analytics from Claude Code transcripts — 5h billing blocks, burn rate, daily/monthly/session rollups, pre-dispatch gate"
argument-hint: "[blocks --active | daily | monthly | session | gate] [--breakdown] [--json]"
paths: ["**"]
---

# /usage

Local, dependency-free usage analytics. Reads the Claude Code transcripts on this
machine (`~/.claude/projects/**/*.jsonl`, including nested subagent transcripts),
aggregates token usage, and prices it from the plugin's local pricing config. No
network, no external CLI — this replaced the external `ccusage` dependency after it
failed on a pre-dispatch burn gate.

## Step 1: Route the arguments

Run the bin with the user's arguments passed through (default to `blocks --active`
when no arguments given):

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/usage.cjs" $ARGUMENTS
```

Subcommands:

| Subcommand | What it shows |
|------------|---------------|
| `blocks [--active] [--limit N]` | 5-hour billing blocks; `--active` = current block with burn rate + projection |
| `daily [--since YYYYMMDD] [--until YYYYMMDD]` | Per-day rollup (default: last 14 days) |
| `monthly` | Per-month rollup (full history scan — a few seconds) |
| `session [--limit N] [--all]` | Per-session rollup, newest activity first |
| `gate` | One compact line for dispatch decisions (the burn gate) |

Global flags: `--breakdown` (per-model rows), `--json` (machine output).

## Step 2: Present the output

Relay the table or gate line as-is (it is plain monospace). Then add, in one line
each where relevant:

- **Costs are estimates.** They are computed from
  `plugins/4ge/lib/data/model-pricing.json` (USD per Mtoken, longest-prefix match on
  model id) — pricing is config, operator-verifiable, overridable via the
  `FORGE_USAGE_PRICING` env var pointing at an alternate JSON. On a Max subscription
  these numbers are API-equivalent burn, not billed dollars.
- If the output carries an `unpriced models` or `pricing unreadable` warning,
  surface it prominently — token counts stay correct, costs are undercounted.

## Step 3: Exit-code handling

- Exit `0` — data readable (including "NO ACTIVE BLOCK": an idle rig is not an error).
- Exit `1` — bad arguments; show the usage help the bin printed.
- Exit `2` — transcripts unreadable. Say so plainly; do NOT fabricate usage numbers.
  This is the fail-visible contract the forge Phase 5 burn gate relies on.
