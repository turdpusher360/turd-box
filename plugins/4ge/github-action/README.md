# 4ge DFE Review

Adversarial AI code review for GitHub Actions. Runs a configurable 3-pass or 6-pass review for existence, security, logic, runtime, artifact, and provenance risks.

## Quick Start

```yaml
# .github/workflows/dfe-review.yml
name: DFE Code Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  dfe-review:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
      contents: read

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: OWNER/4ge-dfe-action@v0
        with:
          api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

`OWNER/4ge-dfe-action@v0` is public v0 placeholder wording for this source candidate. Replace it with the owner-approved repository and release/tag after publication is authorized.

## Configuration

| Input | Default | Description |
|-------|---------|-------------|
| `api_key` | required | Anthropic API key |
| `model` | `claude-sonnet-4-6` | Base model for Sonnet passes (P1, P4, P5) |
| `opus_model` | `claude-opus-4-8` | Opus model for P2, P3, and P6. Use `claude-opus-4-7` for pinned-stability. |
| `passes` | `3` | Number of passes: `3` (free tier) or `6` (full review) |
| `base_branch` | `main` | Branch to diff against |
| `max_diff_kb` | `50` | Max diff size before truncation |
| `fail_on_severity` | `HIGH` | Exit non-zero on: `HIGH`, `CRITICAL`, or `NONE` (report only). Any other value fails the run immediately (fail-closed) |
| `post_review` | `true` | Post findings as GitHub PR review comments |

## Outputs

| Output | Description |
|--------|-------------|
| `findings_count` | Total findings across all passes |
| `critical_count` | CRITICAL severity findings |
| `high_count` | HIGH severity findings |
| `verdict` | Overall verdict: CLEAN, RISK, or BLOCKED |
| `report_path` | Path to the consolidated JSON report artifact |

## The 6 Passes

| Pass | Model | What It Checks |
|------|-------|----------------|
| P1: EXISTENCE | Sonnet | Imports resolve, npm packages real, no slopsquatting, no deprecated APIs |
| P2: SECURITY | Opus | OWASP LLM Top 10, CWE injection vectors, hardcoded secrets, IDOR |
| P3: LOGIC | Opus | Off-by-one, race conditions, inverted booleans, error swallowing |
| P4: RUNTIME | Sonnet | Env mismatches, Node APIs in wrong context, missing await, global state |
| P5: ARTIFACTS | Sonnet | Dead exports, copy-paste drift, orphaned vars, AI fingerprints |
| P6: PROVENANCE | Opus | Cross-pass synthesis, adversarial verdict, what passes 1-5 missed |

Pass 6 (PROVENANCE) uses `opus_model` regardless of the `model` input.
Passes 2 and 3 (SECURITY, LOGIC) also use Opus — adversarial reasoning needs the better model.

Model IDs are validated before the action attempts an Anthropic API call. Current defaults follow Anthropic's model overview: `claude-sonnet-4-6` for Sonnet-tier passes and `claude-opus-4-8` for Opus-tier passes. The `claude-opus-4-7` Opus override is documented for pinned-stability; Anthropic pricing lists Opus 4.8 and Opus 4.7 at the same standard rate, with Sonnet priced lower.

- Model overview: https://platform.claude.com/docs/en/about-claude/models/overview
- Pricing: https://platform.claude.com/docs/en/about-claude/pricing

## Quick vs Full Review

The `passes` input is a review-depth knob (cost/latency vs coverage), not a
license tier — both values are available to every user of this Action.

```yaml
# Quick (3 passes): EXISTENCE + SECURITY + LOGIC
- uses: OWNER/4ge-dfe-action@v0
  with:
    api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    passes: "3"

# Full review (6 passes): all passes including PROVENANCE
- uses: OWNER/4ge-dfe-action@v0
  with:
    api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    passes: "6"
```

## Report-Only Mode

```yaml
- uses: OWNER/4ge-dfe-action@v0
  with:
    api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    fail_on_severity: "NONE"  # Always exit 0 and post a COMMENT review
```

Report-only mode sets the GitHub review event to COMMENT. Without report-only mode, `BLOCKED` pass failures and configured severity thresholds can request changes or fail the action.

## Full Example with All Options

```yaml
- name: DFE adversarial review
  id: dfe
  uses: OWNER/4ge-dfe-action@v0
  with:
    api_key: ${{ secrets.ANTHROPIC_API_KEY }}
    model: "claude-sonnet-4-6"
    opus_model: "claude-opus-4-8"
    passes: "6"
    base_branch: "main"
    max_diff_kb: "100"
    fail_on_severity: "CRITICAL"  # Only block on P0s
    post_review: "true"

- name: Show DFE summary
  if: always()
  run: |
    echo "Verdict: ${{ steps.dfe.outputs.verdict }}"
    echo "Findings: ${{ steps.dfe.outputs.findings_count }}"
    echo "Critical: ${{ steps.dfe.outputs.critical_count }}"
```

## Positioning

The action is meant for maintainers who want a source-visible, pass-defined review workflow they can inspect and tune. It is not a benchmark claim against other review tools. Public comparisons need separate evidence before they belong in this README.

## Finding Format

Each finding in the PR review comment includes:

- **Severity:** CRITICAL / HIGH / MEDIUM / LOW
- **Pass:** Which pass caught it (P1-P6)
- **Evidence:** The exact code that is wrong
- **Reality:** Why it is wrong, with CWE reference if applicable
- **Fix:** Copy-pasteable corrected code
- **Confidence:** TP / Likely TP / Uncertain

Findings are model-generated review output and must be treated as review leads, not proof by themselves.

## API Cost Estimate

| Configuration | Estimated cost per PR |
|--------------|----------------------|
| 3-pass, 10KB diff | ~$0.05 |
| 3-pass, 50KB diff | ~$0.25 |
| 6-pass, 10KB diff | ~$0.15 |
| 6-pass, 50KB diff | ~$0.75 |

Costs vary with diff size and finding density. Truncation at `max_diff_kb` controls worst-case cost.

## Security

The action requires:
- `ANTHROPIC_API_KEY` — your Anthropic API key, stored as a GitHub secret
- `pull-requests: write` permission — to post review comments
- `contents: read` permission — to read the diff

The diff is sent to the Anthropic API. Do not use this action on repositories with secrets in source code.

## License

Public-layout TODO/waiver: no `LICENSE` file is included in this candidate surface because final licensing and publication terms are owner-gated. Add the selected license only after the owner explicitly chooses one for this public layout.
