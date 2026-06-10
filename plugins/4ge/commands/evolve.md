---
name: evolve
description: Analyze usage telemetry and suggest config changes to evolve your .4ge/config.json
---

# /evolve

Reads session telemetry, counts hook trigger frequency, identifies unused hooks, and suggests config changes. Protected hooks are never suggested for removal.

## Usage

```
/evolve
/evolve --dry-run
/evolve --apply
```

## Arguments

| Argument | Description |
|----------|-------------|
| (none) | Show suggestions and ask for confirmation before applying |
| `--dry-run` | Show suggestions only, do not apply |
| `--apply` | Apply all suggestions without asking |

## What It Does

1. **Enumerate candidates:** parse `.claude/settings.json` and collect every wired hook basename (`node .claude/hooks/<name>.cjs` → `<name>`). You can only suggest removing something that is actually wired; an on-disk-but-unwired hook is never a candidate.
2. **Count real fires:** read `_runs/os/hook-timing.jsonl` (the auto-instrumented per-hook fire log; each line is `{hook, ms, ts}`) and build `fires[hook] = count`. Do **NOT** use `resource-ledger.jsonl` for this — it is tool/agent accounting and has no `hook_name`/`tool_name`/per-hook fields; aggregating it by `hook_name` was the original bug (it collapsed everything to `unknown`).
3. **Build the trigger map:** for each wired hook, `triggers[hook] = fires[hook] || 0`. A wired hook with 0 fires is the only removal candidate.
4. Pass to `require('${CLAUDE_PLUGIN_ROOT}/lib/config-compiler.cjs').generateSuggestions(triggers, PROTECTED_HOOKS)` — only `count === 0` entries become `[remove]` suggestions, and protected hooks are skipped.
5. **Instrumentation caveat (do not skip):** `hook-timing.jsonl` only records hooks that `require('lib/hook-utils.cjs')`. A wired hook that doesn't require hook-utils shows 0 fires even when live (e.g. dispatcher-folded members accrue timing to the dispatcher, not themselves). Treat every 0-fire result as a candidate to **verify**, never an auto-remove. Never `--apply` a removal without confirming the hook is genuinely unused and not folded into a dispatcher.
6. Displays suggestions with confidence + reason; asks for confirmation (unless `--apply`); updates `.4ge/config.json` with approved changes.

## Protected Hooks (Never Removed)

The following hooks are security-critical and will never be suggested for removal.
**Names MUST be hyphenated to match the live hook basenames — an underscored name silently
fails `protectedSet.has(hook)` and would let a security hook be flagged `[remove]`
(latent-bug fix):**
- `guard-git-scope`
- `guard-dns-exfil`
- `enforce-approved-agents`
- `file-content-secret-guard`
- `aisle-prompt-guard`
- `agent-config-readonly`

## Example Output

```
Analyzing 45 sessions...

Suggestions (2 found):

  [remove] hono_patterns — never triggered across 45 sessions. Confidence: 80%
  [remove] react_patterns — never triggered across 45 sessions. Confidence: 80%

Apply changes? (y/N)
```

## Notes

- Reads `_runs/os/hook-timing.jsonl` (auto-written by every hook that requires `lib/hook-utils.cjs`) for fire counts, and `.claude/settings.json` for the wired-hook roster. (Not `resource-ledger.jsonl` — that has no per-hook fields.)
- Changes are applied to `.4ge/config.json` in the current project root
- Removed hooks can be re-added manually if needed
