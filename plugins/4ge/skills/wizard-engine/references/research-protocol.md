# Research Protocol

Dispatch protocol for Stage 3 (RESEARCH). Gathers evidence to ground fix recommendations with confidence scores.

## Research Depths

| Depth | Time/Category | Sources | Token Estimate |
|-------|---------------|---------|----------------|
| Quick | ~15s | Memory + codebase | ~2K |
| Standard | ~45s | + web search | ~8K |
| Deep | ~120s | + context7 + OSV.dev + changelogs | ~20K |

## Per-Category Dispatch

For each category selected for deep dive:

1. **Memory search:** `memory_search query="<category> findings" limit=3`
2. **Codebase analysis:** Glob/Grep/Read for detailed inspection (varies by category)
3. **Web search:** (if enabled) Search for known issues, CVEs, changelogs
4. **context7:** (if enabled) Fetch library-specific documentation
5. **OSV.dev:** (if enabled) Query vulnerability database for dependency findings

## Confidence Scoring

Each finding receives a confidence score (0.0-1.0 float):

| Score Range | Tag | Evidence Level |
|-------------|-----|----------------|
| >= threshold | `[recommended]` | Version-aware or evidence-grounded research |
| >= threshold * 0.6 and < threshold | `[suggested]` | Heuristic match with partial research |
| < threshold * 0.6 | `[detected]` | Pattern matching without external validation |

Default threshold: 0.80. Configurable in `.4ge-wizard.json` research.confidence_threshold.

**Confidence values are always floats in [0.0, 1.0].** Integer percentages are for display only.

## Auto-Promote Rules

Recurring inbox issues (same category + similar description 3+ times) are auto-promoted to `[suggested]`. Auto-promote can never elevate to `[recommended]` -- that tier requires research-grounded confidence >= threshold by definition.

The `auto_promote_max_tier` is hard-coded to `"suggested"` and cannot be overridden.

## Research Summary

After research completes, display a summary checkpoint before proceeding to the fix menu:

```
=== RESEARCH SUMMARY ===

  <Category> (<depth>, <duration>):
    Sources consulted: <list>
    Findings: N (X recommended, Y suggested, Z detected)
    Confidence: X.XX avg

  Total: N findings across M categories

  (p) Proceed to fix menu [default]
  (a) Adjust -- re-run research with different settings
  (d) Export and exit -- save research to _runs/

  Select: p/a/d | Help: ?
> _
```

## Context Budget

- Quick mode: ~15K tokens total
- Standard full sweep: ~60-80K tokens
- Deep mode all categories: ~150-200K tokens

If estimated tokens exceed 80K, warn: "Estimated research tokens (~XK) may approach context limits. Consider narrowing scope or using --report mode."

For `--auto-safe` mode: research depth is forced to Quick unless explicitly overridden.
