---
name: lint
description: Show rule follow-through rates and suggest demotions for under-followed rules
---

# /lint

Show which CLAUDE.md rules are being followed and which are ignored, using recorded compliance history. Suggest archiving rules that fall below 20% compliance.

## Usage

```
/lint
/lint --rule <rule-name>
/lint --suggest-demotions
```

## Arguments

| Argument | Description |
|----------|-------------|
| (none) | Show all rule follow-through rates |
| `--rule <name>` | Show detailed history for a specific rule |
| `--suggest-demotions` | Show only rules below 20% compliance threshold (5+ data points required) |

## Steps

1. Read compliance history from `_runs/rule-compliance.jsonl`. If the file is absent, report "No rule-compliance history yet" and stop. Never fabricate rates.
2. Load `require('${CLAUDE_PLUGIN_ROOT}/lib/prompt-linter-tuner.cjs')`.
3. Call `computeFollowThroughRate(history, rule)` for each rule present in the history.
4. Call `suggestDemotions(history)` to identify rules below the 20% threshold.
5. Display a ranked table of rules by compliance rate, highest first. If `--rule <name>` was given, show that rule's individual session entries instead. If `--suggest-demotions` was given, show only the demotion candidates.

## Demotion Threshold

Suggest a rule for archival only when both conditions hold:
- At least 5 data points exist for that rule.
- The follow-through rate is below 20%.

Archiving a rule means moving it from `.claude/rules/` to `.claude/rules/archive/` — it remains accessible but stops loading automatically. Suggest the move; do not perform it without approval.

## Example Output

```
Rule Compliance Report (last 30 days)

| Rule | Follow-Through | Data Points | Status |
|------|---------------|-------------|--------|
| no-console-log | 92% | 48 | healthy |
| tdd-first | 71% | 22 | healthy |
| commit-after-test | 34% | 18 | watch |
| format-before-commit | 12% | 15 | demotion suggested |

Demotion candidates (below 20% threshold):
  - format-before-commit: 12% over 15 sessions. Consider archiving.
```

## Notes

- Verification-rule events are written to `_runs/rule-compliance.jsonl` by `superpowers-remind.cjs` on non-docs `git commit` attempts.
- Data points accumulate over sessions. New rules will not have enough history for demotion suggestions.
- Use `/lint --rule <name>` to inspect individual session entries when debugging false positives.
