# Security Policy

## Threat model

This action sends pull request diffs to the configured LLM provider for review analysis. The action should be used on repositories that do not expose sensitive secrets in patch diff or workflow logs.

## Secrets

- Store API credentials in GitHub Secrets (never hardcode).
- Do not log or print secret values.
- Rotate provider credentials on suspected leakage or suspicious actor activity.

## Permissions

Recommended workflow permissions:

- `contents: read`
- `pull-requests: write` (only if inline PR comment posting is required)

## Data handling

Diff data sent to the external review model should be treated as sensitive.
Do not call this action with `fetch-depth: 0` disabled in contexts where full context is required for your review policy unless you accept reduced visibility.

## Reporting

Report suspected vulnerabilities or security regressions in repo issues or owner-defined support channels.
