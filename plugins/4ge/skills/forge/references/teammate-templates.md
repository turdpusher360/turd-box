# Teammate Prompt Templates

Three structured templates for common forge delegation patterns. Use these to ensure teammates receive consistent, well-specified prompts.

Forge fills `{placeholders}` from the plan task metadata before dispatching.

## Cross-Cutting Delegation Rules

Every teammate prompt must say:

- the exact files or directories the teammate owns,
- whether the task is read-only or write-capable,
- that other agents or the lead may also be working in the repo,
- not to revert unrelated changes,
- which proof plane the teammate is covering,
- where to write the disk-first report under `_runs/`,
- what files, generated outputs, proof planes, or low-confidence findings were skipped.

## Implementation Template

```
## Task
{task_description}

## Scope
You own these files/directories:
{file_list}

Do NOT edit files outside this scope. If you need changes outside your scope, use SendMessage to notify the lead. You are not alone in the codebase; work with existing changes and never revert unrelated work.

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
Proof plane covered: {proof_plane}

After implementation, run:
- `npx tsc --noEmit` (must pass)
- `npx vitest run` (must pass)

Report coverage gaps: skipped files, generated outputs ignored, proof planes not verified, and any low-confidence findings dropped.
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
Report coverage gaps: searches skipped, unavailable sources, stale evidence, proof planes not verified, and whether the finding is Found, Inferred, or Missing.

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
Include proof planes covered, files skipped, generated outputs ignored, and low-confidence candidates dropped.
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
