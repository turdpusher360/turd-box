# DERIVED_FROM — usage-meter.cjs (+ bin/usage.cjs)

> Attribution manifest under the implementation-diversity credit policy: behavioral
> lineage is part of the provenance trail, not something to launder. This file is
> **append-only** — regenerations add entries below, never remove them.

## Lineage entry 1 — initial replication

- **Behavior derived from:** `ccusage` v20.0.17 (versions current at verification;
  registry metadata verified via `npm view ccusage` on 2026-07-11)
- **Original author:** ryoppippi and ccusage contributors
- **Repository:** https://github.com/ccusage/ccusage (monorepo, `apps/ccusage`;
  historically published from `ryoppippi/ccusage`)
- **License inheritance:** MIT — **behavioral derivation, no code copied.** This
  module was written against (a) a stated parity spec of ccusage's observable
  behavior and (b) empirical inspection of local Claude Code transcripts. Its
  author did not read ccusage source during implementation.
- **Replication date:** 2026-07-10
- **Reason:** the external `ccusage` CLI failed (`command not found`) on a hard
  pre-dispatch burn gate; dispatch workflows need this capability plugin-native,
  dependency-free (node core only), with a purpose-built gate mode and an
  operator-verifiable local pricing config.

### Derived surface (honest accounting)

| Surface | Provenance |
|---|---|
| 5-hour billing-block algorithm (UTC hour-floor start, >=5h-gap block boundary, active-window definition) | **Derived** — ccusage parity by design |
| Report taxonomy concept (`blocks` / `daily` / `monthly` / `session`) | **Derived** — concept follows ccusage's report set |
| Transcript schema handling (nested `subagents/` discovery, `(message.id, requestId)` streaming dedup, `cache_creation` 5m/1h split, `<synthetic>` exclusion) | **Independent** — derived empirically from real transcripts on this machine, not from ccusage docs or source |
| Pricing (local JSON config, longest-prefix match, per-row validation, `FORGE_USAGE_PRICING` override, all-rates-are-estimates labeling) | **Independent** — ccusage fetches LiteLLM rates; this module deliberately uses operator-verifiable local config instead |
| `gate` subcommand (one-line pre-dispatch burn gate, fail-visible exit contract, degraded-scan detection) | **Original** — no ccusage equivalent |
| Metadata-injection quarantine (charset validation, render sanitization) | **Original** |

### Policy status note

The credit doctrine's full ship-order (enforcement hook, funding config field,
upstream-drift job, replicated-dir README) is program-level machinery explicitly
deferred by lead ruling pending an operator revival call on the implementation-
diversity program; this manifest is the attribution leg shipping with the module
itself. If a funding loop is activated later, ryoppippi / ccusage is the upstream
beneficiary of record for this module.
