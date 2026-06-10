---
name: audit-panel
description: "Tactical multi-angle parallel review of a target (diff range, file, or topic). Dispatches 2-4 reviewers with different perspectives (judgment, nitpick, DFE adversarial) and converges into a single verdict with agreement matrix. Use when: the user says 'review this', 'audit panel', 'get a second opinion', 'throw reviewers at this', 'multi-angle review', wants a quick tactical review that doesn't warrant a full /audit pipeline, or asks for parallel review perspectives on a specific scope. Also trigger when the user dispatches multiple review agents manually — offer to formalize via this skill."
tools: Agent, Read, Write, Glob, Grep, Bash, mcp__dev-memory__memory_search, mcp__dev-memory__memory_store
---

# audit-panel — Tactical Multi-Angle Review

A lightweight alternative to the full `/audit` pipeline. Dispatches 2-4 review agents in parallel against a focused target, then converges their findings into a single verdict. The intensity scales with the user's configured tier.

## Why this exists

Full audits (`/audit full`, `@master-auditor`) are thorough but heavy — they spawn 5-10 domain auditors across the entire codebase. Sometimes you need a quick tactical review of a specific diff, file, or topic: "did this agent's output actually work?" or "is this security fix correct?" This skill fills that gap by dispatching a focused review panel scoped to exactly what you point it at.

## Parse $ARGUMENTS

| Pattern | Target type | Example |
|---------|------------|---------|
| `<sha>..<sha>` | Git diff range | `audit-panel e4d2bf6..e25c5a7` |
| `<file-path>` | Single file or glob | `audit-panel lib/os/capabilities/*.cjs` |
| `<topic>` | Semantic keyword | `audit-panel security fixes` |
| (empty) | Auto-detect from unstaged changes | `audit-panel` |

## Step 1: Resolve the target (safe parsing only)

Based on the argument pattern:

- **Diff range**: Accept only exactly one `..` or `...` separator with non-empty left and right revs. Reject arguments containing shell metacharacters or whitespace. Validate each side with `git rev-parse --verify --end-of-options <rev>^{commit}` using argument arrays, not shell strings. When both sides validate, run `git diff --stat <left><separator><right>` using only the parsed revs (never raw `$ARGUMENTS`).
- **File path**: Reject arguments containing shell metacharacters (`;`, `|`, `&`, `` ` ``, `$`, `$(`, `${`, `)`, `<`, `>`), control characters, or newlines. Then glob-expand the path and read matching files. Never construct or execute a shell command from the raw path.
- **Topic keyword**: Search `git log --oneline -20` and `memory_search` for recent work matching the topic. Build a file list from matches.
- **Empty**: Run `git diff --stat HEAD` for unstaged changes. If clean, use `git diff --stat HEAD~1..HEAD` (last commit).

Store the resolved file list as `TARGET_FILES` and a human-readable scope description as `TARGET_DESCRIPTION`.

## Step 2: Read the tier

```javascript
// Read .4ge-config.json from project root
const config = JSON.parse(fs.readFileSync('.4ge-config.json', 'utf-8'));
const tier = config.economy?.tier ?? 'medium';
```

## Step 3: Compose the panel

The tier determines how many reviewers dispatch and at what model level. More angles catch more issues but cost more tokens.

| Tier | Panel composition | Typical use |
|------|-------------------|-------------|
| `low` | 1x focused reviewer | Quick sanity check |
| `medium` | 1x judgment reviewer + 1x implementation nitpicker | Standard review |
| `high` | 1x judgment reviewer + 1x implementation nitpicker + DFE 6-pass | Thorough review |
| `max` | 1x judgment reviewer + 1x implementation nitpicker + DFE 6-pass + 1x domain expert | Full panel |

For `max` tier, select the domain expert based on `TARGET_FILES`:
- Files in `claude-commander/` → `fix-commander` skill on `@sonnet-execute`
- Files in `lib/os/` → `fix-kernel` skill on `@sonnet-execute`
- Files in `website/` → `frontend-design` skill (read-only mode)
- Files in `.claude/hooks/` → `fix-hook` skill on `@sonnet-execute`
- Files in `lib/aisle/` → `fix-aisle` skill on `@sonnet-execute`
- Mixed → skip domain expert (judgment reviewer + nitpicker + DFE covers it)

## Step 4: Dispatch all reviewers in parallel

Create the output directory: `_runs/audit-panel/`

Dispatch ALL panel members in a SINGLE Agent tool call block (parallel, not sequential). Each agent gets:

1. **The target scope** — pass only a vetted `{leftSha,rightSha}` object for diff ranges or a file list for paths/topics. Do not pass a raw shell command string to subagents.
2. **A domain-specific checklist** — what to look for (see Step 4a)
3. **Output path** — write report to `_runs/audit-panel/<reviewer-name>.md`
4. **Format** — findings as: `**P0/P1/P2/P3** — <title>` with `file:line`, confidence, and 1-2 sentence description

### Step 4a: Reviewer-specific prompts

**Judgment reviewer** (`@opus-review`, background):
Focus on architectural correctness, cross-cutting concerns, design decisions that will cause problems downstream. Check: does the code do what the spec/plan says? Are there unmodeled dependencies? Security implications? Ask "what breaks if this ships?"

**Implementation nitpicker** (`@sonnet-execute` with review-code skill, background):
Focus on code quality, naming, edge cases, error handling, test coverage gaps. Check every function for: null/undefined paths, off-by-one, missing error handling, inconsistent naming, dead code introduced. Volume over judgment — flag everything, let the convergence step filter.

**DFE** (`@DFE`, background):
Standard 6-pass adversarial: existence (do imports resolve?), security (injection, secrets, OWASP), logic (race conditions, off-by-one, inverted booleans), runtime (missing await, env mismatch), trust (type assertions hiding), artifacts (dead exports, copy-paste drift). DFE minions return findings inline; the adversarial DFE writes the consolidated report to `_runs/s{NNN}-dfe-adversarial.md` when the `/dfe` command runs.

**Domain expert** (max tier only, `@sonnet-execute` with domain skill, background):
Deep domain knowledge check. "Would this code survive a week in production?" Focus on the specific framework/system conventions that general reviewers miss.

## Step 5: Converge findings

After all reviewers return, read their reports from `_runs/audit-panel/`. If DFE produced a consolidated disk report, include it in convergence. Only use memory if the runtime explicitly confirms a DFE memory artifact was stored.

Build the convergence:

### Agreement matrix

Create a table showing which reviewers flagged the same issue. Findings flagged by 2+ reviewers are high-confidence. Findings flagged by only 1 reviewer at low confidence can be deprioritized.

```markdown
| Finding | Judgment | Nitpick | DFE | Domain | Confidence |
|---------|----------|---------|-----|--------|------------|
| Race condition in counter | x | | x | | HIGH |
| Missing CORS header | x | x | x | | HIGH |
| Unused import | | x | | | LOW |
```

### Open conflicts

If two reviewers disagree (one says safe, another says bug), list both positions and your judgment call.

### Priority sort

Sort all unique findings by: P0 first, then by agreement count (more reviewers = higher priority within tier), then by confidence.

## Step 6: Write PANEL-VERDICT.md

Write to `_runs/audit-panel/PANEL-VERDICT.md`:

```markdown
# Panel Verdict — [TARGET_DESCRIPTION]

**Scope:** [file count] files, [line count] lines changed
**Panel:** [tier] — [list of reviewers dispatched]
**Date:** [ISO date]

## Verdict: [PROCEED / REVISE / BLOCK]

[1-3 sentence summary]

## Agreement Matrix

[table from Step 5]

## Findings by Priority

### P0 — Critical
[findings]

### P1 — High
[findings]

### P2 — Medium
[findings]

### P3 — Low (for reference)
[findings]

## Open Conflicts
[if any]

## Recommended Actions
[numbered list of specific fixes, ordered by priority]
```

### Verdict rules
- Any P0 with HIGH confidence → **BLOCK**
- 3+ P1s or any P0 with MEDIUM confidence → **REVISE**
- Only P2/P3 findings → **PROCEED**

## Step 7: Report to user

Output the verdict line + finding count + top 3 actionable items. Point to the full report path. Store a summary to memory with tags `audit-panel,<topic>`.
