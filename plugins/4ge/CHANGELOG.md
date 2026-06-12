# Changelog

All notable public changes to the 4ge Claude Code plugin are documented here.
Versions follow Semantic Versioning.

## [2.3.0] - 2026-06-12

### Changed
- Rebalanced command tiers to 25 Free and 12 Pro commands across 37 total commands. The gate remains soft during launch: commands surface upgrade guidance instead of failing closed.
- Moved `/ship`, `/commit`, `/pr`, `/decide`, `/constraint`, `/releases`, `/signoff`, `/lint`, `/lounge`, `/studio`, `/substrate`, `/blueprint`, `/infra`, and `/hitchhiker` into the Free tier.
- Aligned legacy redirects with their target command tiers: `/maintain` follows `/outhouse`, and `/resp4wn` follows `/respawn`.
- Removed unsupported Team-only claims from the public pricing table. Hosted shared memory remains Team-tier; fleet Blueprint management and policy-roadmap claims are not part of this release.

### Fixed
- Corrected first-run setup copy so hosted/shared memory is described as Team-tier, not Pro-tier.
- Updated public command tables to include `/secret` and `/superdupersecret`.

## [2.2.2] - 2026-06-11

### Fixed
- Updated upgrade links to the 3SIXTYCO-hosted 4ge page.
- Corrected the license holder to 3Sixty Co.
- Updated plugin manifest URLs to the public `turd-box` marketplace repository.

## [2.2.1] - 2026-06-09

### Changed
- Scrubbed bundled repo-config profiles so shipped examples use neutral project shapes instead of private workspace assumptions.
- Removed project-only planning surfaces from the public plugin package.

## [2.2.0] - 2026-06-09

### Added
- Improved HUD/model-label handling for newer Claude model families.

### Fixed
- Made HUD model display self-heal when the active model changes.

## [2.1.0] - 2026-06-08

### Changed
- Made `/recall` the canonical Knowledge hub for memory search, repo mapping, context budget, respawn, and decisions. `/recon`, `/hitchhiker`, and `/map` remain redirects.

## [2.0.0] - 2026-06-08

### Added
- Added guided hub behavior for core commands.

### Fixed
- Fixed reactive HUD event handling and config-change guard field handling.

## [1.0.0] - 2026-04-03

### Added
- Published the initial unified 4ge plugin package for Claude Code.
- Consolidated the core command set under one plugin entry.

## Earlier History

Earlier private development history is intentionally omitted from the public changelog. The public package begins tracking clean release notes from the 2.x launch line.
