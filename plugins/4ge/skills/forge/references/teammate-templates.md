# Teammate Prompt Templates

Three structured templates for common forge delegation patterns. Use these to ensure teammates receive consistent, well-specified prompts.

Forge fills `{placeholders}` from the plan task metadata before dispatching.

## Implementation Template

```
## Task
{task_description}

## Scope
You own these files/directories:
{file_list}

Do NOT edit files outside this scope. If you need changes outside your scope, use SendMessage to notify the lead.

## Acceptance Criteria
{criteria_list}

## Context Budget
- Only read files within your assigned scope
- Use Glob/Grep to locate files before reading
- Maximum 3 file reads before starting implementation
- Compact at 65% context usage (or per-task override)
- Write output to _runs/ BEFORE sending summary to lead

## Output
Write your work summary to _runs/{date}/{slug}-{teammate}.md FIRST.
Then send a one-paragraph summary to the lead.

## Verification
After implementation, run:
- `npx tsc --noEmit` (must pass)
- `npx vitest run` (must pass)

Report status: DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
If BLOCKED, include the exact error message.
```

## Research Template

```
## Topic
{topic_description}

## Search Budget
- Web searches: {max_searches} (default 5-8)
- Memory searches: {max_memory} (default 3)

## Output
Write findings to _runs/{date}/research-{topic}.md
Store key facts to memory hub via memory_store (max {store_budget} memories, default 3)
Include source URLs for all claims.

## Report Format
### Key Findings (3-5 items)
1. [finding with source]

### Recommendations (prioritized)
1. [action -- rationale, effort]
```

## Review Template

```
## Review Target
{files_or_pr_description}

## Checklist
{review_checklist}

## Severity Levels
- CRITICAL: blocks merge, must fix
- HIGH: should fix before merge
- MEDIUM: fix in follow-up
- LOW: suggestion only

## Output
Write findings to _runs/{date}/review-{slug}.md
If any CRITICAL findings: report BLOCKED with details.
Otherwise: report DONE or DONE_WITH_CONCERNS.
```

## Template Selection Guide

| Task Type | Template | Typical Agent |
|-----------|----------|---------------|
| Feature implementation | Implementation | sonnet-execute |
| Hook/command creation | Implementation | sonnet-execute |
| Library evaluation | Research | sonnet-research |
| Code review | Review | opus-review |
| Security audit | Review | opus-review |
| Test writing | Implementation | sonnet-execute |
