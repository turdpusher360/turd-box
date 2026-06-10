# Verify Protocol

Verification and shipping protocol for Stage 6.

## Full Verification Triad

All three must pass before offering the commit option:

```bash
npx tsc --noEmit        # Type checking
npx eslint .             # Linting
npx vitest run           # Test suite
```

## Post-Verification Cleanup

After successful verification, clean up the safety stash:
```bash
git stash drop ${safety_stash.ref}
```

This prevents stash accumulation across wizard runs.

## Score Comparison

Run a re-scan of all categories to compute after scores. Display:

```
=== SCORE COMPARISON ===

  Category       Before   After   Delta
  ------------------------------------
  <name>         NN/20    NN/20   +/-N
  ...

  Overall: NNN/180 -> NNN/180 | Weighted: NN -> NN (+/-N) -- Grade X -> Y
  Fixes applied: N | Fixes failed: N | Fixes skipped: N
```

## Grade Scale

Grade is derived from weighted_score (the canonical value):

| Grade | Weighted Score Range |
|-------|---------------------|
| A | 90-100 |
| B | 75-89 |
| C | 55-74 |
| D | 35-54 |
| F | Below 35 |

## Ship Menu

```
=== SHIP ===

  (c) Commit [default] -- auto-generated message, staged files only
  (p) Commit + push
  (d) Diff only -- show full diff, do not commit
  (m) Manual -- leave changes unstaged
  (s) Stash -- save to named stash
  (n) Notify team -- write report to _runs/ + TASKING entry

  Select: c/p/d/m/s/n | Help: ?
> _
```

## Auto-Generated Commit Message

```
chore(outhouse): repo health NN->NN (+N) -- N fixes applied

Categories improved: <list with deltas>
Fixes: <brief list>
Skipped: <brief list>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

Use `git add <specific-files>` only -- never `git add .` (blocked by guard-git-scope.cjs).

## Post-Ship Actions

1. `memory_store content="Outhouse [DATE]: weighted NN->NN (+N), grade X->Y. Top improvements: <list>. Fixes applied: N." importance=0.6 tags=["outhouse","health","scoring"]`

2. Write full report to `_runs/outhouse-YYYY-MM-DD.md`

3. Append JSONL to `_runs/outhouse/history.jsonl`:
   ```json
   {"ts":"<ISO>","repo":"<name>","total":N,"max":180,"pct":N,"weighted_score":N,"grade":"X","categories":{...},"fixes_applied":N,"fixes_failed":N,"fixes_skipped":N,"delta_total":N,"delta_categories":{...},"mode":"<mode>","duration_s":N,"research_depth":"<depth>"}
   ```

4. Delete `.outhouse-session.json`
