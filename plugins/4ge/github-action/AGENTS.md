# 4ge DFE Action

Scope of this folder: the standalone candidate for the DFE GitHub Action community layout.

Do not make assumptions about parent-repo state in this folder; if you need parent-repo details, ask the owner first.

## Local checks

- `npx vitest run plugins/4ge/github-action/lib/*.test.js`
- `node scripts/public-portfolio/export-candidate.cjs dfe-action`

## Security defaults

- Never commit API keys, tokens, or secret material.
- Keep workflow permissions minimal in examples (`contents: read`, `pull-requests: write` only when review posting is needed).
- If a contributor requests private keys or credentials for testing, stop and escalate to the owner.

## Ownership gates

- Publication destination, release workflow, and license are owner-gated decisions.
- Community-facing claims should use neutral placeholders until the owner publishes the canonical repo/release details.
