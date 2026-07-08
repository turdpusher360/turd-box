# Changelog

All notable public changes to the 4ge Claude Code plugin are documented here.
Versions follow Semantic Versioning.

## [2.9.0] - 2026-07-07

### Added
- `scripts/rotate-continuity.cjs` — bounds TASKING.md and _runs/.decisions.jsonl by rotating overflow into gitignored archives (dry-run default, --apply, conservation-abort).
- `bin/rotate-continuity.cjs` — plugin-shipped continuity rotator used by `/signoff` when 4ge is installed from the public marketplace.

### Changed
- `/signoff` now rotates continuity files at closeout to keep them small — cuts closeout file-intake ~94% (~236k→~13k tokens).

## [2.8.4] - 2026-07-01

### Fixed
- Guarded `/forge` against pasted session/tool output being parsed as a forge task description (commit 132f5237).
- Restored the Fable rainbow model label in the statusline HUD (regression from the 2026-06-14 restricted-label scrub; Fable is available again).

### Changed
- Routed the `sonnet` model alias to Sonnet 5 and purged retired Sonnet 4.6 / Opus 4.6 pins from model routing (commits e55d086b, 6b366aee).

## [2.8.3] - 2026-06-21

### Changed
- Extended `/dfe`, `dfe-review`, and Forge DFE review doctrine with targeted failure sweeps for identifier-domain mismatches, artifact dependency/order gaps, and untrusted artifact instructions. No invocation topology, command flags, agents, hooks, runtime config, or output contract changed.
- Generalized `/reconcile` dev-memory scope guidance so the published plugin documents canonical repo slugs without naming the private source workspace.

## [2.8.2] - 2026-06-20

### Changed
- Added Forge capability-gain framing so distillation work names target surfaces, proof planes, secondary queues, and non-goals before moving into teammate execution.
- Tightened Forge teammate prompt templates with explicit file ownership, no-unrelated-revert discipline, proof-plane coverage, disk-first reporting, and skipped-surface/caps disclosure.

## [2.8.1] - 2026-06-20

### Fixed
- Tightened `/dfe` and `dfe-review` review doctrine so minion passes surface every named failure scenario, the adversarial pass verifies and deduplicates against all-seen candidates, and reports disclose skipped files, caps, and proof planes without changing the `/dfe` invocation topology.
- Corrected Forge review protocol wording to distinguish the full `/dfe` 5+1 runner from a single DFE reviewer, and to treat parallel `opus-review` as a separate lens rather than a hidden confidence override.
- Aligned DFE review docs around Claude/Codex parity boundaries and removed unsupported quick-mode wording.

## [2.8.0] - 2026-06-19

### Added
- New `/reconcile` command and skill: folds session handoffs into a single `BACKLOG.md` source-of-truth, re-ranks dormant "gold mine" items every cycle so built-but-unshipped value can't rot, and flags lane drift — backed by a commit-time staleness advisory when the backlog falls behind.
- `/signoff` now commits the session continuity (cartridge, tasking, and decision/constraint logs) at sign-off — signed and timeout-boxed, with a staged-and-reminded fallback when signing is unavailable — so a forgotten closeout can no longer leave continuity stranded and uncommitted.
- New overflow guard that prevents an Agent or Workflow dispatch from drowning a subagent in raw tool output (Agent/Workflow `PreToolUse`).

### Changed
- Workflow recommendations now route through Forge.

### Fixed
- HUD uptime and tool-count now anchor to the live session instead of process boot, so a long-lived process no longer reports a stale multi-hour uptime.
- Dependency audit fixes for transitive advisories (form-data, vite/launch-editor, @babel/core).

## [2.7.1] - 2026-06-15

### Fixed
- Hardened the secret-redaction hook so findings no longer include matching secret previews; the hook reports the secret class and location without echoing sensitive material.
- Wrapped DFE GitHub Action review prompts with explicit untrusted-diff boundaries before model review, reducing prompt-injection risk from PR content.
- Refreshed the vendored OS AISLE readiness path so the boot-status aggregate recomputes after capability recovery instead of leaving a stale `overall: degraded` once all capabilities are ready.
- Neutralized public HUD, screenshot, and `/ship` model-label surfaces so shipped package code uses supported public model families instead of consumer-restricted internal identifiers.

## [2.7.0] - 2026-06-14

### Changed
- The always-on context-trend statusline row now lines up with the header text feed (it was previously indented further left than the rows above it), and it shows the current context percentage plus a trend arrow (▲ climbing / ▼ easing / ▸ steady) next to the sparkline — so the row conveys both where context sits and which way it's heading, not just its shape. The transient anomaly and reactive feed rows share the same alignment.

## [2.6.1] - 2026-06-14

### Fixed
- Genericized two absolute-path examples in code comments (the `hud-gemini-adapter.cjs` statusLine wiring snippet and the `weasley-utils.cjs` project-id doc example) so the published plugin no longer embeds a developer-machine path. No runtime behavior change — the comments now read as portable placeholders.

## [2.6.0] - 2026-06-14

### Added
- Added companion calm controls: `faceMotion` (per-tool eye motion, off by default), `zen` (master quiet mode), and `messages` (`all`/`major`/`off`) config toggles, with matching `/hud` setters.
- Added a persistent anomaly statusline row so detected anomalies surface in the always-on HUD instead of only as a transient companion message.
- Added compact statusline trend rows (context burn and rate-limit) that render within the existing row budget.
- Added file-backed anomaly signals for low VRAM cache, reaped runaway processes, and process bloat.
- Added a `/4ge hud substrate` command door that surfaces the manual substrate render mode.

### Changed
- Context burn-rate anomaly now prefers the recent context-history slope over the uptime heuristic, reducing early-session false positives.
- Git statusline state now refreshes off the reactive hook after write-capable tools (throttled), so the branch / ahead-behind / dirty row reflects live state without slowing the render path.
- Tiered companion message dwell floors (flash / signal / critical) so a higher-priority message can no longer be swallowed before its minimum visible time.

### Fixed
- Fixed the `animate:false` mobile escape hatch so the statusline renders byte-identically across polls. The orb color wave, orb breath/shimmer, and the companion face expression now all honor the freeze flag, eliminating mobile-terminal scroll-bounce.

## [2.5.0] - 2026-06-14

### Added
- Added a `companion.animate` config toggle for the HUD companion orb. Animation remains on by default and can be disabled without turning off the companion.
- Added live statusline polish for the companion: statusline voice now falls back to contextual companion insights when no active message is present, and the compact bracket face reflects companion gaze.
- Added boot-pulse statusline expansion so a fresh OS boot briefly surfaces capability health in the persistent HUD instead of only in one-shot full-mode output.

### Changed
- Hydrated the session zone from the session cartridge so it can show last-session and parked-work context instead of an empty memory placeholder.
- Pruned retired internal HUD implementation paths: Clawd mascot payloads, block-art expression builders, zero-producer companion state keys, and the stale hud-frame watcher. These were internal surfaces, not public plugin commands, skills, hooks, or install contracts.
- Tightened HUD staleness handling so old forge-progress and boot-state data stops leaking into the persistent statusline.

### Fixed
- Fixed companion eye drift across live and full HUD modes by routing face/orb rendering through the companion-state expression resolver and passing the same freeze/animation inputs to the full-mode orb.

## [2.4.0] - 2026-06-13

### Added
- Added `/design`, `/onboard`, and `/ps` as Free commands: contextual design assistance, first-time repository onboarding, and a read-only process dashboard.
- Added HUD support for the Gemini Antigravity statusline adapter, the opt-in moon-phase context zone, and the Weasley multi-agent clock/conflict view.
- Added feedback-queue capture for Bash tool failures so repeated operational failures can feed the autoresearch loop.

### Changed
- Retired unwired internal prototype modules and their tests from the shipped plugin package. These were not public command, skill, hook, or install contracts.
- Updated public package counts and command docs to match disk truth: 40 commands and 40 skills.

## [2.3.1] - 2026-06-12

### Fixed
- Companion idle eyes now render the asymmetric "alive" identity (`[▅ ▄]`): the idle default expression routes to `neutral alive`, with the expression alias, big-eye map entry, and failure-fallback face updated to match.

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
- Updated upgrade links to the 3Sixty Co. hosted 4ge page.
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
