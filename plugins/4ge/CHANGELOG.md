# Changelog

All notable public changes to the 4ge Claude Code plugin are documented here.
Versions follow Semantic Versioning.

## [2.11.11] - 2026-10-07

The statusline now names Mythos sessions and gives Opus 5.5 its own label colors. Fable's label is unchanged.

### Fixed
- **A Mythos session's statusline showed only a gray version number.** `claude-mythos-*` ids matched no model family, so the label rendered as a bare " 5.1" in the fallback gray, and the companion had no model face for them. The label now reads "mythos" in the same static rainbow as Fable, with the version in solid red, and Mythos gets the Fable resting face in both `hud-engine.cjs` and `companion-face.cjs`.

### Changed
- **Opus 5.5 statusline label:** "opus 5.5" now renders as a static gold-to-amber gradient, one color per letter. Every other Opus version keeps its solid blue. Like the Fable rainbow, the colors never animate, so idle renders stay byte-identical.

## [2.11.10] - 2026-10-05

The DFE and review skills now check which model actually served each lane before its report counts. The plugin's agents and skills run at xhigh effort with no turn caps, and dispatch text no longer passes the ignored `mode:` setting.

### Fixed
- **A DFE lane that a fallback model finished could still be counted.** After a refusal, an in-process lane can finish on another model (`claude-opus-4-8`) with no notice in its report. `/4ge:dfe`, `dfe-review` and the forge spec gate now include a served-model gate. The lane must have been requested as Opus, every assistant record in its transcript must show `claude-opus-5-5`, and none may carry `"stop_reason":"refusal"`. Otherwise the lane is blocked and its report is not used. A refused security pass goes to the security-review fallback, and any other blocked lane goes to the lead. The gate finds in-process, workflow and tmux teammate transcripts, and the gated dispatch templates now name their lanes so the gate can find them.
- **Dispatch text passed `mode:`, which the Agent tool ignores, and left out `model:`.** forge (spec gate and its own dispatch templates), reconcile, prime, `/4ge:audit` and the GAMBIT battery reference now name `model:` where they dispatch and drop `mode:`. The forge skill no longer tells leads to omit `model`.
- **`audit-panel` called its single-context DFE a "6-pass" review.** It now says "adversarial (one context)" and points to `/4ge:dfe` for a lane-independent 6-pass. `review-adversarial` now hands off to `/4ge:dfe` instead of a "DFE orchestrator agent".
- **The forge-shipper agent deleted `_runs/os/heartbeats/`,** which the process-cap gate counts to enforce the active-agent ceiling. It now leaves that folder alone.
- **The `master-auditor` agents told the auditor to dispatch domain auditors and poll task tools it does not have.** TaskUpdate, TaskList and TaskGet are dropped. The lead dispatches the domain auditors and hands over each report path, and the auditor reads the reports from disk. `/4ge:audit full` now tells the lead to spawn the domain auditors itself and then hand their report paths to `@master-auditor`.
- **The `DFE` agent's `memory:` value was invalid.** It is now `project`, with `Write`, `Edit` and `NotebookEdit` disallowed as on the DFE minions. The agent writes its assigned report with a Bash heredoc.

### Changed
- **Agent and skill effort:** every plugin agent and skill now runs at `effort: xhigh` (it was `max`, `high` or `low`).
- **Turn caps removed:** `maxTurns:` is removed from the 12 plugin agents that had it, and the "Complete within 150 turns" line is removed from `dfe-review`.
- **Security skills:** `review-security` and `audit-security` now say that the in-session pass is a pre-check, not the gating security review.
- **Smaller fixes:** `session-tasking` names the current audit gate. The forge skill's `tools:` drops the task tools.

## [2.11.9] - 2026-10-04

The vendored heredoc stripper closes the two enclosing forms 2.11.8 left open, and two more forms in which bash runs a body the stripper treated as data.

### Fixed
- **A heredoc inside a quoted script or under an outer heredoc was stripped as data.** `vendor/lib/hook-utils.cjs` `stripHeredocBodies` now leaves the body in place when the `<<` sits inside an open quote (`sh -c "true;cat <<'EOF' … EOF" | sh`, single quotes too) or follows an earlier heredoc operator (`bash <<OUTER | bash` with an inner `cat <<'EOF'`, including `<<\OUTER` and `<<'OUTER'`). The quote scan treats `#` as a comment only at the start of a token, as bash does, and an ANSI-C `$'…'` string anywhere earlier fails closed. Accepted over-blocks: a second sequential heredoc, a `<<` inside earlier quoted text and an earlier `$'…'` also keep their bodies.
- **A comment that ran into the `<<`, or a line continuation that hid an interpreter, was stripped.** `echo hi # ok; cat <<'EOF'` is all comment, so bash runs the "body" lines; `bash -s \` followed by `cat <<'EOF'` on the next line is `bash -s cat <<'EOF'`. A comment that reaches the `<<` now fails closed, and the sink word must hold on the raw segment and again with backslash-newlines joined, so an escaped backslash (`cat \\` then `bash -s <<'EOF'`) cannot make an interpreter read as `cat` either.

## [2.11.8] - 2026-10-03

The plugin's handoff-number helper stops counting mid-session wrap files, the vendored heredoc stripper leaves more executed bodies in place (a partial fix), and the vendored fast-git read path resolves a relative caller `-C` from the right directory.

### Fixed
- **A mid-session wrap or topic handoff file moved the session number.** `hooks/hook-utils.cjs` `deriveNextHandoffNumber` counted every `HANDOFF-S<N>*` name as a shipped handoff and had no pickup rule, so a `HANDOFF-S<N>-og-wrap.md` written while session N was open made it report N+1. A shipped handoff is now only `HANDOFF-S<N>.md` (optional letter suffix) or `HANDOFF-S<N>-<8 hex id>.md` (optional `-R<k>` round); a `-PICKUP.md` name counts as the session that reads it; any other name counts for nothing. The vendored `lib/hook-utils.cjs` takes the same rule.
- **The vendored heredoc stripper treated a body piped onward by an enclosing construct as data.** `vendor/lib/hook-utils.cjs` `stripHeredocBodies` judged a heredoc's sink from its own header segment, so `{ cat <<'EOF' … EOF` + `} | bash` (and subshells, functions, loops, if/else and case arms) had their bodies stripped. A `{` or `(` earlier in the command, or an earlier whole-word `if`, `while`, `until`, `do`, `then`, `else`, `elif` or `case` (which also covers if, while and until condition lists), now leaves the body in place. This is a partial fix. Two enclosing forms are still open: a heredoc inside a quoted script (`sh -c "true;cat <<'EOF' … EOF" | sh`) and one under an unquoted outer heredoc (`bash <<OUTER | bash` with the inner `cat <<'EOF'` in its body). The helper still strips both while bash runs the body. No hook calls the helper yet, and both forms must be fixed and audited before one does.
- **The vendored fast-git read path resolved a relative caller `-C` against the wrong directory.** `vendor/lib/fast-git.cjs` dropped its own cwd `-C` whenever the caller passed one, so on the git.exe route a relative `-C sub` resolved against the interop-translated process cwd. The cwd `-C` now always comes first, so a relative caller `-C` resolves against it and an absolute one still overrides it.

## [2.11.7] - 2026-10-02

The vendored check runner's `json-path-absent` check fails closed, and grep checks accept only safe flags.

### Fixed
- **The vendored check runner read an unreadable file as "path absent".** `vendor/lib/os/registry/check-runners.cjs` passed a `json-path-absent` check whenever it could not read or parse the file, so a moved, unreadable or corrupted file read as green. The check now passes only when the file reads, parses and lacks the path. A missing file, a directory, an unreadable file, invalid JSON or a JSON root that is not an object fails it, and the failure names the error code without quoting the file's bytes.
- **A grep check's `flags` could invert it.** The vendored runner spread a check's `flags` into grep's arguments unvalidated, so `-v` turned `grep-absent` (and `grep`) into its opposite, and an extra operand added a second file. Both grep check types now accept only `-i`, `-w` and `-x`; `register-loader.cjs` rejects any other flag when it loads a register, and the runner refuses it again before spawning grep. A `pattern` that starts with `-` (such as `-v` or `--help`) was read as a grep option the same way; the runner now ends options with `--`, so the pattern is always matched as text. No plugin command runs this evaluator; the copy ships with the vendored Agentic OS and stays in sync with the rig's runner.

## [2.11.6] - 2026-10-02

`/4ge:dfe` and the dfe-review skill gain six review checks, and the audit agents gain five evidence lenses.

### Added
- **Six DFE review checks.** The `/4ge:dfe` brief and the dfe-review skill give every minion and the synthesis pass six targeted sweeps: caller-chain trace, guards and tests that must bite, security finding evidence, reviewer input hygiene, claims bound to evidence, and rewrite fidelity. `/4ge:dfe` also pins the review target to an exact revision and specification source before it writes the brief, and its synthesis pass carries each minion's set-aside behaviors forward for the lead to rule on.
- **Five cross-domain evidence lenses for audits.** `master-auditor` and the `audit-implementation`, `audit-integration` and `audit-config` skills cover API and error contracts, measured performance, observability integrity, migration sequencing and ADR tradeoffs. The lenses enrich the existing domain auditors; they do not replace DFE or authorize implementation, migration or deploy.

## [2.11.5] - 2026-10-01

Plugin hooks load Agentic OS code only from the plugin's own copy.

### Security
- **Opening a repository could run that repository's code through the plugin's hooks.** Hooks that run at session start and on tool calls loaded Agentic OS modules from the opened project's `lib/os`: `file-integrity-guard`, `forge-heartbeat`, `forge-scope-check` and the HUD's expensive refresh loaded them only from there, and `os-boot` and `os-accounting` tried there before the plugin's own vendored copy. A repository carrying those paths had its code executed in the session with no prompt. Every hook now loads OS modules only from the plugin (`CLAUDE_PLUGIN_DATA`, then `CLAUDE_PLUGIN_ROOT`, then the install directory) and skips the feature when the plugin carries no OS tree. `file-integrity-guard`, `forge-heartbeat`, `forge-scope-check` and the HUD refresh still run only in projects that carry the matching `lib/os` file; they check that the file exists and never load it, so they stay inert in every other repository. Projects that run their own Agentic OS keep wiring their own `os-boot` and `os-accounting` hooks, and the plugin still defers to them.
- **The vendored autoresearch capability's health probe ran the project's harness.** The probe `require()`d the opened project's `scripts/autoresearch/harness.cjs`. It now compile-checks the harness without running it, so it reports syntax errors only. Load errors surface when the capability's `status` action loads the harness.
- **`forge-heartbeat` sends its IPC heartbeat only to the state directory `os-boot` writes**, `<project>/_runs/os` under a plain session id with no symlink along that path, so neither an edited `_runs/.os-state.json` nor a committed link can point its writes and cleanup deletes outside the project.

## [2.11.4] - 2026-10-01

The vendored check runner's `grep-absent` check fails closed.

### Fixed
- **The vendored check runner read "could not look" as "pattern absent".** `vendor/lib/os/registry/check-runners.cjs` counted a missing file as absent and inverted every grep failure, so a moved file, a bad pattern or an unreadable path read as green. Its `grep-absent` check now passes only when grep reads the file and finds no match (exit 1). A missing file, grep exit 2, a spawn error, a timeout or a signal fails it. No plugin command runs this evaluator; the copy ships with the vendored Agentic OS and stays in sync with the rig's runner.

## [2.11.3] - 2026-10-01

The maintenance wizards start again, and DFE spawns name their model.

### Fixed
- **`/outhouse`, `/fix` and `/wizard` could not start the wizard-engine pipeline.** The `wizard-engine` skill sets `disable-model-invocation: true`, so the commands' "invoke the wizard-engine skill" step was refused. Each command now reads `skills/wizard-engine/SKILL.md` in full and follows it, the same way `/forge` reaches its skill.
- **`/dfe` and the `dfe-review` skill passed `mode:` and no `model:` on their Agent templates.** The Agent tool ignores `mode:`, and every spawn should name its model. The DFE and five minion templates now pass `model: "opus"` and no `mode:`.

### Docs
- **forge skill, Phase 4.5:** names the recorded shape for the escalated 6-agent panel, `packet_review.panel` plus `packet_review.panel_reports`, which the repo's packet-review gate accepts in place of the DFE+GAMBIT pair (never in place of the spec-boundary DFE).

## [2.11.2] - 2026-09-22

The Cowork-only `session-tasking` skill joins the plugin.

### Added
- **`session-tasking` skill** — turns a broad "run everything relevant" intent into a decision surface, executes the approved run list with contained teammates, consolidates the deliverables under `_runs/<date>/session-tasking-<NN>/`, and always ends on the next decision. Ported from the operator's Claude Desktop (Cowork) custom-skill shelf (created 2026-07-25) and adapted to the rig: native AskUserQuestion pickers up to 16 items (the HTML picker above that, or whenever rows need per-item context), a one-line paste-back form for phone/Termius, a launch gate that takes the model, effort and concurrency from the operator before any wave (≤ 8 concurrent, operator-ruled), rig-approved teammate types only, a harvest/patch/cleanup procedure for worktree-isolated lanes, and the autonomy-charter gates as the stage-only line. Ships `assets/picker-template.html` (HTML-escapes row data, one-line paste-back with an async clipboard fallback, phone layout), `assets/render-picker.cjs` (fills the template safely: HTML-escapes title/subtitle, JS-escapes the data literal so a row can never close the script block, rejects delimiter-bearing ids) and `references/teammate-contract.md`. (Skill count 41 → 42.)

## [2.11.1] - 2026-09-19

Commands stop choosing the model; `/recompile` ships.

### Fixed
- **Every command pinned a model in the manifest.** `.claude-plugin/plugin.json` carried `"model"` on all 38 released commands (`opus` on forge, dfe, audit, aisle, blueprint, reconcile; `sonnet` on the rest), so invoking any `/4ge:*` command directed the harness to run that turn as the pinned alias instead of the model the user selected for the session. All 38 keys are removed; commands now inherit the session model. The pins dated from the early plugin-maturity work and survived later pin-removal sweeps because those only read markdown frontmatter. A contract test now fails if a manifest command, command file or skill frontmatter carries a `model` key.

### Added
- `/recompile` — rebuild the task lock from the user's recent messages: separate instruction / diagnosis / exploration / emphasis, return a compact MODE/TASK/KEEP/CHANGE/DO NOT/DONE WHEN lock, and continue. Recovery command for conversational drift or a heated correction. Free tier. (Command count 38 → 39.)

## [2.11.0] - 2026-07-13

Lead-writable color board on the live statusline.

### Added
- **HUD lead-board zone** — the session lead pushes a colored board to the operator's live statusline on demand: `bin/hud-board.cjs set --title <t> --line "<level>:<text>" (repeatable) [--ttl <sec>]`, plus `clear` and `show`. State at `_runs/os/hud-board.json` (atomic write, default TTL 900s, fail-invisible: missing/corrupt/expired state renders nothing and can never crash or slow the statusline). Line levels `info|ok|warn|alert|accent` map to palette roles. Rendered on the live statusline via a dedicated injection (after anomaly rows, before reactive/compact feeds, always yielding to the boot-pulse) and as a `board` zone (priority 7) in the composite HUD. HUD-STANDARDS §4.6.

## [2.10.0] - 2026-07-10

### Added
- `hooks/license-refresh.cjs` — SessionStart hook that refreshes paid-tier entitlements in a detached background process when the cached license is stale. Default-on for paid installs with an email configured; disable with `FORGE_LICENSE_REFRESH=0` or `licenseRefresh: false` in config.

### Changed
- `lib/tier-gate.cjs` — two-strike revocation wiring: entitlement checks now consume the refreshed cache; non-2xx worker responses are strike-free transport failures (never punish a network blip), and only two consecutive authoritative denials revoke a cached tier.

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
