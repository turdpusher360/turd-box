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
| AI code review | DFE | opus |

**DFE review context:** When forge dispatches DFE for Phase 6 code review, pass `review_context: dual` in the prompt. This signals that `opus-review` is reviewing in parallel, enabling DFE to report findings at full confidence. When DFE is invoked outside forge (ad-hoc, pre-commit), it defaults to `review_context: solo` with reduced confidence penalties.

## Standard Checklist

1. **Scope compliance:** All changes within declared scope?
2. **Spec alignment:** Implementation matches spec requirements?
3. **Test coverage:** Tests exist for new functionality?
4. **Type safety:** `npx tsc --noEmit` passes?
5. **No regressions:** `npx vitest run` passes?
6. **No dead code:** Removed code has no remaining references?
7. **No secrets:** No hardcoded credentials or API keys?
8. **Documentation:** Changed behavior documented?

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
```
