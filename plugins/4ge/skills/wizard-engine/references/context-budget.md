# Context Budget

Token budget estimates for wizard pipeline execution. These estimates help the engine warn users before exceeding context window limits.

## Estimated Token Budgets by Mode

| Mode | Stages | Est. Tokens | Context Risk |
|------|--------|-------------|--------------|
| `--quick` | 1-2 | ~15K | Low |
| `--preflight` | Fast subset of 1 | ~5K | Low |
| `--ci` | 1-2 | ~15K | Low |
| Standard full sweep | 1-6 | ~100-110K | Medium-High |
| Deep all categories | 1-6 | ~210-230K | High |
| `--auto-safe` (forced Quick) | 1-6 | ~25-35K | Low |

## Per-Stage Estimates

| Stage | Quick Research | Standard Research | Deep Research |
|-------|---------------|-------------------|---------------|
| 1. SCAN | ~5K | ~5K | ~5K |
| 2. TRIAGE | ~2K | ~2K | ~2K |
| 3. RESEARCH | ~18K (9 x ~2K) | ~72K (9 x ~8K) | ~180K (9 x ~20K) |
| 4. FIX MENU | ~3K | ~5K | ~8K |
| 5. EXECUTE | ~10K | ~15K | ~20K |
| 6. VERIFY | ~5K | ~5K | ~5K |

## Warning Thresholds

At Stage 2 (TRIAGE), estimate the research token budget based on:
- Number of categories selected for deep dive
- Research depth setting
- Number of enabled sources

If estimated total exceeds 80K tokens, display a warning:

```
Context budget estimate: ~XXK tokens (may approach limits)
Consider:
  - Narrowing scope (fewer categories for deep dive)
  - Using --report mode (no fix execution, saves ~25K)
  - Using Quick research depth (~15K vs ~50K+ for Standard)
```

## Auto-Safe Override

When `--auto-safe` is active, research depth is forced to Quick (memory + codebase only) unless explicitly overridden with `--research-depth standard`. This ensures unattended runs complete within a single context window and avoids auto-compact mid-pipeline.

## Context Conservation Tips

- Use `--category <name>` to scan specific categories only
- Stage 3 deep dives on 2-3 categories instead of all 9
- Research depth Quick is sufficient for Safe-tier fix confidence
- Run `--quick` first to identify which categories need attention, then targeted deep dive
