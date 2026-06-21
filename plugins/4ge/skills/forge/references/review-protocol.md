# Review Protocol

Standard review checklist for forge-dispatched reviews.

## Review Dispatch

Forge dispatches reviews at these points:
- After spec writing (Phase 3) -- spec review
- After integration (Phase 6) -- code review
- Optionally after individual teammate completion -- incremental review

## Reviewer Selection

| Review Type | Agent | Model |
|------------|-------|-------|
| Spec review | opus-review | opus |
| Code review | opus-review | opus |
| Security review | opus-review | opus |
| Adversarial code review | DFE or `/dfe` | opus |

**DFE dispatch boundary:** The Claude 4ge `/dfe` command is the full disk-first 5-minion + 1-adversarial runner. A direct `DFE` reviewer is a single adversarial lens, not runtime parity with `/dfe`. When Forge uses both `opus-review` and DFE, treat them as independent review lenses and merge evidence explicitly; do not use a hidden confidence mode or imply that one reviewer's presence makes another finding automatically higher-confidence.

## DFE Doctrine

Use this doctrine when Forge dispatches DFE or folds DFE output into a review verdict:

- **Recall-biased finders, precision-biased verifiers:** finder passes should report every candidate with a nameable failure scenario; the verifier culls false positives with evidence.
- **Distinct lenses:** do not send multiple reviewers the same vague instruction. Assign different lenses such as existence, logic, security, runtime, artifacts, integration, and adversarial rejection.
- **Targeted failure sweeps:** after the standard pass structure, sweep for identifier-domain mismatches, artifact dependency/order gaps, and untrusted artifact instructions.
- **All-seen dedup:** deduplicate against confirmed findings, rejected false positives, deferred candidates, and low-confidence candidates so a rejected issue does not reappear as new.
- **No silent caps:** record skipped files, generated outputs ignored, top-N limits, sampling, unavailable tools, and any severities omitted from the inline summary.
- **Separate proof planes:** source, CLI, API/server, GUI/browser, library/export, prompt/agent-config, CI, deploy/live, and operator signoff are separate evidence classes.

## Standard Checklist

1. **Scope compliance:** All changes within declared scope?
2. **Spec alignment:** Implementation matches spec requirements?
3. **Test coverage:** Tests exist for new functionality?
4. **Type safety:** `npx tsc --noEmit` passes?
5. **No regressions:** `npx vitest run` passes?
6. **No dead code:** Removed code has no remaining references?
7. **No secrets:** No hardcoded credentials or API keys?
8. **Documentation:** Changed behavior documented?
9. **Coverage/caps:** Review report names skipped files, unavailable proof planes, and any sampling/top-N limits?

## Severity Levels

- **CRITICAL:** Blocks merge. Security vulnerability, data loss risk, spec violation.
- **HIGH:** Should fix before merge. Test gap, type error, missing validation.
- **MEDIUM:** Fix in follow-up. Style issue, minor optimization, docs gap.
- **LOW:** Suggestion only. Naming preference, alternative approach.

## Review Output Format

```
## Review: [target] -- [PASS | ISSUES_FOUND | BLOCKED]

### Findings
- [SEVERITY]: [description] -- [file:line]

### Verdict
[PASS | ISSUES_FOUND | BLOCKED] -- [summary reason]

### Coverage and Proof Planes
[source/CLI/API/GUI/library/prompt-config/CI/deploy/live/signoff covered or not covered; caps and skips]
```
