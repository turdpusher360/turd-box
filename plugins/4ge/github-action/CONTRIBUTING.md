# Contributing

Contributions are welcome, but keep this folder scoped to standalone action concerns.

## Contributor workflow

- Use small, focused edits.
- Keep docs and code aligned with the scaffold purpose (no central control-plane claims).
- Run focused tests before proposing changes:
  - `npx vitest run plugins/4ge/github-action/lib/*.test.js`
  - `node scripts/public-portfolio/export-candidate.cjs dfe-action`

## PR expectations

- Explain functional impact.
- Note required owner-gated decisions that this PR still depends on.
- Keep changes to this directory unless explicitly requested to touch adjacent public-facing layout files.
