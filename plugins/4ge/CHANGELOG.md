# Changelog

All notable changes to the 4ge plugin are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) —
level rules, the no-skip / no-milestone-major policy, and the sanctioned bump
path (`scripts/bump-plugin-version.cjs`) are defined in the project's
versioning guide.

---

## [2.3.0] - 2026-06-12

### Changed
- **Tier regrade: 24 → 12 Pro-gated commands (25 Free / 12 Pro / 0 Team).** An objective rubric pass over all 37 commands (`_runs/s410/tier-regrade.md`) freed 13 previously-gated commands and aligned all seven redirect stubs with their targets. **Not breaking, stays a minor:** the gate has zero `require_()` enforcement call sites in any command body — it prints an upgrade prompt at most (honest friction, not a hard block), so no public invocation is removed. `/maintain` and `/resp4wn` move *into* the gate, but both stubs continue to resolve and their *targets* (`/outhouse`, `/respawn`) were always Pro — this aligns the stubs with the rename-with-stub doctrine, it does not remove a public surface. Per `docs/plugin-versioning.md` §2, expanding the free public surface is feature-bearing Changed (free consumers can newly invoke 13 commands) ⇒ at least minor; per §5.4 (Released = committed) 2.2.2 is committed to main, so this is a new section, not a fold-in.
  - **Now Free (13):** `/ship`, `/commit`, `/pr` (commodity git wrappers — the delivery loop first-run already recommends to free users); `/decide`, `/constraint`, `/releases`, `/signoff`, `/lint` (file append/read utilities); `/studio`, `/substrate` (demo/charm assets, zero professional depth); `/blueprint` (bootstrap; reconciles the gate with the live /4ge page's free single-project bullet); `/infra` (health command for the local memory stack the free tier already includes); `/4ge` (the front door + first-run wizard); `/hitchhiker` (redirect → free `/recall`).
  - **Now Pro (added via redirect coherence):** `/maintain` (→ `/outhouse`), `/resp4wn` (→ `/respawn`).
  - **Stays Pro (the flagship line):** `/forge`, `/dfe`, `/audit`, `/aisle`, `/outhouse`, `/wizard`, `/autoresearch`, `/evolve`, `/export`, `/respawn`.
  - `DESCRIPTIONS` trimmed to the 12 gated commands (added `maintain` + `resp4wn` entries); README command table and pricing table updated in lockstep (37 rows, `/secret` + `/superdupersecret` added; the unimplementable "3-pass Pro / 6-pass Team" DFE split and the phantom Team rows — fleet Blueprint management, team-wide measurement, policy roadmap — removed). `docs/reference/plugin-vocabulary.md` per-command PRO_GATED mentions re-synced.

### Fixed
- **First-run setup no longer mis-sells hosted memory as Pro.** `lib/first-run.cjs` step 2 said hosted memory "requires Pro, $19/mo" — but hosted memory is a Team-tier capability (honesty package, S404 B1). Every new install's setup flow now correctly reads "requires Team, $39/seat/mo." The README pricing table's hosted-memory row already named Team; this aligns the in-product copy with it.

## [2.2.2] - 2026-06-11

### Fixed
- **Retired the dead legacy Pro upgrade CTA.** The old standalone 4ge domain was never registered; the 4ge web presence lives on `3sixtyco.dev`. The upgrade link printed by `tier-gate.cjs` (every Pro-gated command) and `first-run.cjs` (every new install), plus the plugin README, now point at `https://3sixtyco.dev/4ge`. Tests updated in lockstep.
- **License holder corrected to 3Sixty Co.** The FSL-1.1-MIT license (`LICENSE`) and the Blueprint output MIT license (`LICENSES/BLUEPRINT-OUTPUT-MIT.md`) now name **3Sixty Co.** (registered WA business — the same entity behind the Stripe billing rail and 3sixtyco.dev) as Licensor and copyright holder, replacing the `Turdpusher360` handle. Aligns the legal grant with the commerce entity customers actually buy from.
- **Plugin manifest URLs point at the public repo.** `plugin.json` `repository`/`homepage` previously pointed at the private source repository (underscore-named); corrected to the public `turd-box` marketplace home so installed-plugin metadata resolves for end users.

## [2.2.1] - 2026-06-09

### Changed
- **Privacy: genericized repo-config profiles** - renamed the bundled repo-config profiles to `repo-config-{monorepo,webapp,api}` (+ tests) and scrubbed private signal paths, memory scopes, and path comments so the shipped installer carries no project-specific architecture. `config-loader.cjs` + `migration-aliases.cjs` updated in lockstep; `sanitize.test.js` passes.
- **dfe-action `entrypoint.sh` fail-closed exit policy (BREAKING for CI consumers).** Exit codes: `0` clean, `1` real findings-based block, `2` could-not-complete (API outage / token truncation / ERROR/UNKNOWN verdict). Previously transient failures mapped to BLOCKED/exit 1, indistinguishable from a real block. Migration: consumers treating any non-zero as "blocked" should treat `2` as "review did not complete." (Versioned by the dfe-action's own release tags, not the plugin marketplace version — an internal-tool contract, not the plugin's public install API.)

### Removed
- **`/public-portfolio` command + skill** - internal control-plane surface; removed from the public plugin. Counts updated to 37 commands, 40 skills. (Internal control-plane surface, not public API — non-breaking removal.)
- **`ecosystem-additions` skill** - project-scoped ecosystem-recommendation surface removed from the public plugin.

## [2.2.0] - 2026-06-09

Claude Fable 5 enrollment. The HUD, /ship attribution, and OS boot all learn the new Mythos-class flagship — and the statusline model display becomes self-healing for every future model.

### Added
- **Fable 5 rainbow statusline label.** `claude-fable-*` renders its model label as a static per-glyph ROYGBIV gradient (`rainbowize()`/`FABLE_RAINBOW` in `hud-engine.cjs`) — the polychrome label is the Fable family identifier; opus/sonnet/haiku keep their solid spectrum colors. Static by design so idle renders stay byte-identical (mobile-terminal freeze invariant). Declared in `docs/reference/hud-vocabulary.md` §10/§32 (doc 1.1.0).
- **Fable model faces.** `claude-fable-5` + `claude-opus-4-8` enrolled in `MODEL_FACE` (determined/accent) with `claude-fable` prefix fallback, in both `hud-engine.cjs` and `companion-face.cjs`.
- **Single-part version fallback.** Model IDs without a `N-N` pair (e.g. `claude-fable-5[1m]` → `5`) now render a version instead of blank.
- **/ship attribution mapping** knows `fable-5` → `Claude Fable 5 (1M context)` + `fable` family fallback (`commands/ship.md`).

### Fixed
- **Statusline model label vanished on unknown families.** `claude-fable-5` rendered as an empty label because every family branch (label chain, color map, version regex, face map) was opus/sonnet/haiku-only. New families now resolve.
- **Boot-dashboard model staleness (self-healing).** `hud-data-loader.cjs` `mergeHarnessStdin()` now writes the live harness model back to `_runs/os/session-meta.json` on change (+`model_updated_at`). os-boot seeded the field from the settings.json pin and nothing ever corrected it — the boot HUD showed a stale model regardless of session model. Now heals within one 2s statusline tick of any `/model` switch, for all models. Also fixes /ship attribution reading the same field.

## [2.1.0] - 2026-06-08

> **Header restored 2026-06-09.** This release was real but the 2.2.0 changelog edit accidentally replaced this header line, absorbing the entry below into the 2.2.0 section. Content unchanged.

Naming-consolidation release. Disambiguates overlapping command and skill names. Nothing was removed — `/recon`, `/hitchhiker`, and `/map` remain as redirect stubs so existing references still resolve.

### Changed
- **`/recall` is now the canonical Knowledge hub and owns the memory-search implementation.** The dev-memory search, `--map`, `--budget`, and `--deep` mechanics are inlined into `/recall` (it previously forwarded to `/recon`). `/recon` and `/hitchhiker` become `[REDIRECT]` stubs into `/recall`; `/map` re-points to `/recall --map`. The `/recall` contract was updated across command + manifest + README + drift test in lockstep.
- **Renamed the local architecture-mapper skill `repo-intake` → `repo-map`** across the skill mirrors and the installer catalog — disambiguating it from the plugin grader `repo-onboard` (renamed in 2.0.0).
- Sharpened the `review-adversarial` / `dfe-review` / `DFE` descriptions along a depth/cost axis (single-pass vs heavyweight 6-pass fan-out) so semantic dispatch separates them.

## [2.0.0] - 2026-06-08

> **Versioning note (added 2026-06-09).** This was a milestone ("vanity") major: by its own description nothing was removed and no invocation changed, so it should have been 1.31.0. The released number stands — released versions are never renumbered — but majors now require an actual breaking change.

Guided-hub consolidation milestone. Every top-level command is now a guided hub, and two long-standing silently-inert bugs (the reactive HUD and a config-change security guard) are fixed. Nothing was removed — direct, query, flag, and subcommand invocations are unchanged.

### Added
- **Guided hubs.** Empty `/forge`, `/recall`, `/4ge`, `/outhouse`, and `/help` (joining `/ship`) now render a native `AskUserQuestion` menu behind a cheap HUD strip, routing into existing capabilities. Menu navigation costs ~0 model tokens; the model is spent only on the selected leaf.
- `/forge`'s hub lives in the forge skill's empty-args branch, keeping `forge.md` a thin dispatcher (the anti-double-invoke drift guard stays green).

### Changed
- **`/recall` promoted from a thin `/recon` alias to a Knowledge hub** (memory search · repo map · context budget · respawn · decisions). `/recall <query>` still forwards to `/recon` — nothing lost. Contract updated across manifest + README + command + drift test in lockstep.
- Renamed the plugin skill `repo-intake` → `repo-onboard`, disambiguating it from the architecture-mapper skill (which keeps `repo-intake`).

### Fixed
- **Reactive HUD read the wrong harness field.** `detectEvent` and the tool-ring read `input.tool_result` (undefined on every PostToolUse call) instead of `tool_response`. Test-pass/fail, output-pattern error-state, Agent/Task forge-phase events, and the tool-ring's anomaly error-detection were silently dead in production since inception. Now read `tool_response` coherently across the pipeline.
- **`config-change-audit` security guard was dead.** It read `data.config_type` / `data.config_path`; the harness sends `source` / `file_path`, so its block on unauthorized `user_settings` changes never fired. Fixed — the block now works (ConfigChange honors exit 2).
- Install-template hooks `dcd-nudge` and `webfetch-sanitize` corrected to read `tool_response`.
- De-flaked the `cswap formatExpiry` ">24h" boundary test (millisecond-boundary race).

### Docs
- `hooks-vocabulary.md` corrected: ConfigChange **can** block (was documented "No"); documented the `source`/`file_path` vs `config_type`/`config_path` field-name gotcha.

## [1.30.4] - 2026-06-07

### Fixed
- **Forge teammate dispatch now inherits runtime model selection.** Routine `/forge` teammate examples no longer pass explicit `model` values, so role-agent frontmatter and the active session model/effort can control dispatch. This patch bump forces Claude's plugin updater to replace the stale `1.30.3` cache that still contained hard-coded model arguments.

## [1.30.3] - 2026-06-07

### Fixed
- **Blueprint template rendering hardened.** The renderer now supports named conditional close tags, `{{else}}`, hyphenated hook-derived keys, and shared derived template context across hook, agent, skill, rule, and CLAUDE.md generation.
- **Generated Blueprint outputs no longer leak raw template tokens.** Settings generation now produces parseable JSON with `PROJECT_NAME_LOWER`, generated CLAUDE.md preserves memory guidance when `memory_mcp` is enabled, and default installed rules/agents/skills render metadata/example placeholders safely.
- **Template validator grammar aligned.** `settings.json.template` parity parsing now recognizes hyphenated conditional flags such as `HOOK_guard-git-scope`.

## [1.30.2] - 2026-06-07

### Fixed
- **`/4ge` run/resume/park routing corrected.** The command now dispatches to the installed `4ge:forge` skill namespace instead of the stale `forge:forge` namespace, with a command-contract regression test.
- **Task-completed verification defaults scoped.** Generated/default verify commands now use changed-file Vitest selection (`npx vitest run --changed HEAD`), treat ESLint as advisory, honor hook stdin `cwd`, and classify killed verification as inconclusive instead of blocking.
- **Forge brainstorm handoff consumes foreground clarifications.** The plugin agent mirror now expects lead-collected `Clarifying answers:` and returns `NEEDS_CONTEXT` when more user input is required, avoiding non-interactive subagent question dead ends.
- **HUD git-state refresh at SessionStart.** `smart-order-writer.cjs` now refreshes `_runs/os/git-state.json` on SessionStart using the hook payload's project root, and git probes suppress expected no-upstream stderr noise.
- **Context-budget zero-time forecast stabilized.** Sub-second session elapsed time now reports zero rate instead of producing absurd tokens-per-minute estimates from wall-clock jitter.
- **Claude hook workaround batch preserved.** Subagent summary output keeps the sync stderr compatibility floor, and session-reaper no-op signals stay out of user-visible stderr.

## [1.30.1] - 2026-06-06

### Fixed
- **`audit-panel` skill model pin removed.** Stripped the lone `model: opus` frontmatter pin so the skill inherits the operator's selected model instead of forcing one — aligns with the no-model-pin rule and preserves manual model choice via `/model`. It was the only skill still carrying a model pin.

## [1.30.0] - 2026-05-31

### Fixed
- **HUD statusline project-root resolution.** The statusline engine resolved its root from `CLAUDE_PROJECT_DIR` (unset in the statusLine subprocess) then fell back to `path.resolve(__dirname, '../../..')`, which points into the plugin *cache* dir for cache installs — rendering the cache basename as the repo label and reading `_runs/os` state from the wrong root (caps 0/0, blank zones). Now prefers the harness-provided `workspace.project_dir`/`cwd` from stdin before the `__dirname` fallback.

## [1.29.0] - 2026-05-29

Agent-roster hygiene, DFE Action hardening, and HUD multi-repo identity. The version bump forces a fresh plugin-cache download (prunes the stale 1.28.0 install that still bundled the retired A/B agents) and republishes the marketplace entry.

### Added
- HUD statusline now shows the repo-name label in the identity line, so concurrent sessions across repos and worktrees self-identify at a glance.

### Changed
- Approved-agent roster 19 -> 17 (see Removed).

### Fixed
- **DFE GitHub Action (P0):** `entrypoint.sh` no longer round-trips findings JSON through a shell variable interpolated into `node -e`. Any apostrophe in a finding (ubiquitous in review prose) produced a `SyntaxError` that silently dropped findings, and the report-writer block had no guard so it crashed the whole action under `set -e`; it was also an injection vector from fork-PR-derived finding text. Findings now accumulate in a file read via `readFileSync`, with only controlled paths/ids/counts passed as argv.
- **DFE GitHub Action:** inline PR review comments anchor via `line`+`side:'RIGHT'` with diff-aware line mapping (previously used GitHub's diff-relative `position`, which was rejected, collapsing every review to summary-only). Dropped the never-used `gh` CLI install from the Docker image and the dead `start` script.
- **HUD git-state:** `smart-order.cjs` resolves the repo root deterministically and isolates each git probe behind a raised 8s timeout — fixes the statusline showing `branch: unknown` on large WSL working trees.
- **opus-review agent:** corrected a stale skill reference in the runtime prompt (`audit-master` -> `review-adversarial`); no `audit-master` skill exists.

### Removed
- Retired two legacy A/B-test agent variants whose named base agents no longer existed after the agent-fleet consolidation. Removed the runtime, plugin-mirror, and Codex-mirror copies, plus all wiring (the read-only-agent warn set, the suspended `cross-model-review` autoresearch targets, the `master-auditor` Related ref) and the dead HUD color-map entries. `master-auditor-46` is retained (still an active A/B pin with a valid base agent).

---

## [1.28.0] - 2026-05-08

Bundle the approved agents into the plugin package — closes the long-standing portability gap where `/4ge:audit` and `/4ge:dfe` fell back to manual review in any project where the agent files were not present.

### Added
- `plugins/4ge/agents/` populated with all approved agents (was empty in v1.27.0): the audit team, the DFE team, the forge team, and the runtime agents.
- Cross-project parity: agent-dispatching commands now work in any project where the plugin is installed, not just the source repo.

### Fixed
- Release-packaging gap: agents existed in the source repo's `.claude/agents/` but were never copied into the plugin package, so the cached install shipped without an `agents/` directory.

---

## [1.27.0] - 2026-04-22

Website polish + marketplace screenshots + desktop-app architecture spec.

### Added
- 3 marketplace screenshots: forge-session, dfe-review, audit-dashboard (ANSI demo-render pipeline)
- Desktop-app architecture spec
- 5 research reports: auth, auto-update, bidirectional IPC, trademark, UI patterns
- Startup protocol locked: Flow A with B check-in (git status + HUD + handoff + brief)
- Decisions + constraints logged to DCD enrichment files
- `platform-gotchas.md` enriched for newer CC versions

### Changed
- Hero copy: punch-list format (CAPABILITIES / KERNEL / STATUSLINE)
- ExpressionShowcase: 8-state specimen sheet cycling every 2.3s
- Brand lock: asymmetric-eye `[█ ▄]` companion face = logo mark (diamond sigil retired)
- All agents set to `effort: max`

### Fixed
- Mobile responsive: 375px zero overflow (was +70px)
- 9 forge/DFE agent frontmatter refreshed (3 forge + 6 DFE)
- Deferred findings: PID reuse defense, Blueprint template split, `__dirname` paths

---

## [1.26.0] - 2026-04-20

Website production build + variant consolidation + plugin renames.

### Added
- `website/` production landing page — terminal aesthetic, tabbed live-HUD demo, bracketed-face companion
- 4 compiled JS modules via `esbuild --jsx=transform`: compact-faces, companion-creature, orb, terminal-app
- React production UMD with SRI integrity hashes
- Marketplace descriptions sharpened to value prop
- Multi-platform porting spec

### Removed
- `/sigil` aesthetic command — unused lattice vestige
- `/phoenix` renamed to `/resp4wn` (gaming metaphor, avoids `/respawn` collision)
- 7 website exploration variants — one chosen as canonical, promoted to `index.html`
- 14 orphaned JS/JSX bundles
- Babel standalone (~3.5MB) removed from page load
- Stale website handoff doc

### Fixed
- `hud-engine.cjs` cwd-contract drift — `path.resolve(__dirname)` replaces `process.cwd()`
- `os-boot.cjs` session-history model staleness — `modelDetected` flag prevents fallback overwrite on resume
- `hud-active-flag.test.js` TTL gap — asserts `expires_at >= DEFAULT_TTL_MS`
- `agent-installer.test.js` synced to current agent catalog
- Multi-platform spec targets corrected (Gemini/Codex/Copilot/Ollama)

---

## [1.25.0] - 2026-04-17

Agent fleet consolidation. The fleet was reduced from 46 agents to 19, with 29 new runtime-dispatched skills replacing the retired agents.

### Added
- 29 new runtime-dispatched skills in `plugins/4ge/skills/`:
  - Domain fixes (11): fix-{hook,aisle,hud,kernel,plugin,commander,wizard,cloudflare,d365,teams}, ops-infra
  - Audit (5): audit-{security,config,integration,implementation,bull}
  - Review (4): review-{adversarial,project,code,security}
  - Research/explain (5): plan-architecture, research-{multi,single,background}, explain-codebase
  - Test/debug/impl (4): debug-investigate, implement-feature, write-test, run-test
- Symlink traversal defense in `subagent-output-rescue.cjs` (fs.realpathSync)
- Train-tracks skill-composition spec (reference only; validation produced a YAGNI verdict)

### Changed
- Fleet reduced from 46 agents to 19. Deleted 27 agents now routed through skills on runtime agents (sonnet-execute, opus-review, opus-audit, opus-planner, sonnet-research)
- `sonnet-implement` merged into `sonnet-execute`. Single Sonnet runtime.
- `master-auditor` kept as orchestrator; now dispatches `audit-*` skills on `opus-audit`.
- HUD agent color map updated to consolidated 19-agent fleet
- CONTEXT_MAP now carries 8 vocabulary docs (added substrate-vocabulary.md)

### Fixed
- 4 hooks with stale agent references: agent-write-validate, subagent-start-inject, subagent-stop-verify, brainstorm-pattern-scan

### Documentation
- Project CLAUDE.md updated with consolidated fleet references
- Agent-selection routing table rewritten to skill-first

---

## [1.24.1] - 2026-04-17

Patch: HUD fixes, savant-proof Phase A, transcript tooling.

### Added
- CONTEXT_MAP injection for 7 domain-expert agents (savant-proof Phase A)
- 9 domain reference docs in docs/reference/
- SubagentStop output rescue hook
- PostToolUse secret warn hook (Scanner E gap closure)
- Transcript tools: dead-agent scan, secret scan, sanitizer
- 4 new secret patterns (GCP, Supabase, Cloudflare, DB URLs)
- A/B test agent variants
- general-purpose agent approved for ad-hoc tasks

### Fixed
- HUD cwd-contract drift (explicit cwd to isSessionActive/getFreezeTime)
- Braille orb epoch-0 misclassification (|| to ??)
- Session-history model field updated on resume
- Dead aisle-gate allowlist entries removed
- Session markers moved from os.tmpdir() to `_runs/os/.session/`
- Model picker: restrictive availableModels removed; a 1M-context default pinned

### Changed
- Agent frontmatter: researcher, research-lead, security-reviewer gained Write tool
- A/B agents use a 1M-context model

---

## [1.24.0] - 2026-04-16

GTM Sprint 2 + smart HUD polish + IO refactor.

### Added
- **`/tour` command** (`commands/tour.md`): 5-step guided walkthrough of `/help`, `/map`, `/recall`, `/forge`, `/ship`. Supports `--step N` flag for direct jump.
- **Marketplace-ready README** (`README.md`): rewritten for value props, pricing, 5 usage examples, FSL-1.1-MIT license.
- **Marketplace manifest fields**: added `homepage`, `screenshots`, `readme`, and `categories`.
- **Landing page** (`docs/site/index.html`): static HTML, Tailwind CDN, 7 sections. Deployable to GitHub Pages with no build step.
- **Context Phoenix CLI** (`bin/context-phoenix-cli.cjs`): standalone `compact()` invocation outside the hook system. Library at `lib/context-phoenix.cjs`.
- **Atomic-write helper** (`lib/atomic-write.cjs`): centralizes tmp+rename pattern with Windows EPERM resilience and direct-write fallback. Replaces 3 duplicated implementations.
- **First-run "What to do next"** (`lib/first-run.cjs`): context-aware suggestions after step 3. New `--tour` flag scaffolding.
- **Smart HUD pipeline integration test**: 7 suites exercising appendTool → readRing → detect* → compose → signal with real data shapes.

### Fixed
- **Anomaly escalation gate** (`hooks/hud-reactive.cjs`): extracted `_emitAnomalyIfWorthy()`. 70-80% rate-limit band now emits messages — previously gated on `>80%` event firing, causing critical anomalies in the 70-79% range to be silently swallowed.
- **Test debt sweep** (`hooks/__tests__/hud-reactive.test.js`): replaced 46 stale `tool_output:` test inputs with `tool_result:` after a production rename.
- **Companion-state PID-less tmp race** (`bin/companion-state.cjs`): old `STATE_PATH + '.tmp'` shared across concurrent statusLine ticks and reactive hooks — now PID-namespaced via atomic-write helper.
- **Landing page dead CTAs**: pro/team CTAs redirected to `#install` and GitHub issues (license server not yet live).

### Documentation
- **GTM decisions log** — alias fallback (turd-box canonical), GitHub Pages, defer screenshots, dual submission path.
- **Submission checklist** — Sprint 2 status and user-action queue.
- **Tool-ring location decision** — documents the per-project `_runs/os/` semantic vs cross-project `CLAUDE_PLUGIN_DATA`.

### Deferred
- Screenshots capture
- GitHub Pages activation
- `--tour` flag wiring at `/4ge` slash-command invocation layer
- License server (Cloudflare Worker + Stripe)
- Tier gates wired in commands
- Marketplace submission

---

## [1.23.0] - 2026-04-16

Smart HUD Wave 2: workflow intent detection wired into live messages, session-arc classifier, anomaly detection with tier escalation, race-safe tool-event ring buffer. Ships with a multi-reviewer audit pass.

### Added
- **Session-arc detector** (`lib/session-arc.cjs`): classifies session phase — warmup / locked-in / drift / winding-down / cold / unknown — from tool cadence + uptime. Feeds composer templates.
- **Anomaly flagger** (`lib/anomaly-flagger.cjs`): 6 anomaly types — rapid-error-cascade, stale-dirty-work, ctx-burn-rate-high, rate-limit-approaching, error-regression, long-idle. Dual five-hour/seven-day rate-limit window support, worst-offender picking, timestamp normalization.
- **Anomaly escalation** (`hooks/hud-reactive.cjs`): critical anomalies ALWAYS override event messages; signal-severity anomalies escalate on flash and signal-tier events. Per-anomaly-type 5-min throttle prevents re-spam.
- **Tool ring JSONL refactor** (`lib/tool-ring.cjs`): atomic `appendFileSync` replaces read-modify-write. Trim-on-overflow at 5× capacity. Captures `isError` flag + `tool_result` preview.
- **ANSI/control-char sanitization** (`bin/companion-state.cjs` signalMessage): strips CSI / OSC / C0 control sequences before persisting to statusline, closing injection amp latent in git-branch-name interpolation.
- **SessionStart ring clear**: prevents the previous session's event trail from misclassifying a new session as "locked-in" instead of "warmup".

### Fixed (from the multi-reviewer audit cycle)
- **P0** `hud-reactive.cjs` event detection read `input.tool_output` (undefined) instead of `input.tool_result`; test-pass / test-fail / session-end events silently dropped.
- **P0** `loadHudData()` was never called with `mergeHarnessStdin`; rate-limit-warn rich templates structurally could not fire.
- **P0** `anomaly-flagger.cjs` used fabricated `rl.usedPct` / `rl.resetsAt` fields; corrected to canonical `rl.fiveHour` / `rl.fiveHourResetsAt`.
- **P0** `tool-ring.normalizeEntry` dropped `isError` flag + tool output preview; error-cascade and error-regression anomalies dead on arrival.
- **P0** `hud-reactive.cjs` error-state regex matched bare word "error" in any tool output; narrowed to typed-error constructors + stack-frame patterns.
- **P1** `lastCommitTs` ISO-string passed through `Number(...)` → NaN; stale-dirty-work anomaly permanently suppressed. Prefer `commitAgeMs` pre-computed field.
- **P1** Anomaly escalation logic only handled critical-severity; signal-severity anomalies silently swallowed by same-tier event messages.
- **P1** Anomaly re-spam: tier-priority guard allowed `critical → critical` replacement. 5-min per-anomaly-type throttle added.
- **P1** `recordRender` non-atomic write could corrupt throttle-file state on concurrent hook invocations; tmp+rename added.
- **P1** `first-run.cjs` PLUGIN_VERSION stale; new installs recorded the wrong version in `.4ge/config.json`.

### Architecture
- **Composer context enrichment**: `buildComposerContext` now attaches `intent`, `arc`, and `anomalies` from three independent detectors. Each enricher is optional and fails open.
- **Tier-aware statusline color**: critical=223, signal=117, flash=241, fade to 241 after 10s regardless of tier.
- **UserPromptSubmit TTL refresh**: dedicated hook (`hud-message-refresh.cjs`) resets active-message timestamp on every prompt submit so decay pauses during palette interactions.

### Test coverage
- Full suite passing across 28 files
- New regression fixtures: ISO 8601 + epoch-seconds for all timestamp accessors; ANSI/control-char sanitization; isError + tool_result preservation; worst-offender rate-limit window selection

---

## [1.22.0] - 2026-04-16

Smart HUD release: state-aware companion messages, workflow intent detection, message priority tiers.

### Added
- **Message composer** (`lib/message-composer.cjs`): templates interpolate from HUD state. Messages carry information density (e.g., `"main +1 · 167 tools"`) instead of static phrases.
- **Intent detector** (`lib/intent-detector.cjs`): classifies recent tool activity into 7 workflow intents (shipping/testing/debugging/exploring/refactoring/reviewing/idle).
- **Tool ring buffer** (`lib/tool-ring.cjs`): captures last 30 tool events at `_runs/os/tool-ring.json` for intent detection.
- **Message priority tiers**: `flash` (8s), `signal` (30s), `critical` (2min) TTLs. Higher tiers cannot be overwritten by lower-tier messages while still active.
- **TTL refresh hook** (`hooks/hud-message-refresh.cjs`): UserPromptSubmit hook refreshes active-message timestamp so decay pauses during slash-palette/typing interactions.
- **Tier-aware statusline rendering**: critical/signal/flash colors in Braille field; width guard prevents overflow at narrow terminals.

### Fixed
- **`hud-reactive.cjs` event detection**: was reading `input.tool_output` (undefined) instead of `input.tool_result` — test-pass/test-fail/session-end events silently dropped.
- **Cold require in hook hot path**: `tool-ring`, `intent-detector`, `message-composer`, `companion-state` now hoisted to module scope.
- **Dead code**: unused `recentReads`/`recentGreps` in `scoreDebugging`.
- **Stale jsdoc**: `signalMessage` text limit was 50 in docs, 60 in implementation; aligned to 60.

### Architecture
- `loadHudData()` in `hud-reactive.cjs` now followed by `mergeHarnessStdin(state, input)` so live rate-limit/cost/model data from harness stdin reaches the composer.

---

## [1.21.0] - 2026-04-16

Reliability release: hook infrastructure hardening, validator robustness, blueprint template security coverage.

### Fixed
- All `hookSpecificOutput` emitters now include `hookEventName` discriminator field (was missing, caused harness to silently drop structured output from 8+ hooks)
- Commander key binding restored + `session_id` sanitized for filesystem-safe paths
- Plugin-version-guard escape hatch: allows `.claude/` edits when all 3 manifests already in sync
- Parallel sweep fixes: process isolation, stateDir race, validator exemption, RED hook schema mismatches, eslint `cause` chain fixes
- HUD-engine test flake resolved (timer-dependent assertion)

### Changed
- Blueprint template absorbs universal deny entries + KNOWN_DRIFT hook exemptions — new installs ship with full security baseline
- Validator gains PROJECT_SPECIFIC_DENY exemption set — project-local deny overrides no longer flag as drift
- Comprehensive hook + middleware sweep across plugin hooks — consistent error handling, stdin parsing, and exit code contracts

### Docs
- `docs/harness-internals.md` synced to current CC: hook contract updates, MCP reconnect behavior, `/tui` command reference
- TASKING refreshed

---

## [1.20.0] - 2026-04-14

Minor: AISLE delegation unblocked, Companion Catch-up Audit features shipped, statusline row-collapse reverted to always-3-rows.

### Added
- `/4ge os scene` subcommand — renders atmospheric idle/focused/alert scene with density gradients, Braille starfields, centered kaomoji face, math-monospace info line
- `--mode=scene` hud-engine mode — routes through `scene-compositor.composeScene()` with bounded `--max-rows`
- `eye-demo.cjs --compact` flag — renders the 9x6 downsampled quarter-block form via `renderCompactExpression`

### Changed
- `/4ge:4ge` command no longer delegates HUD render to a Sonnet subagent. Now inline in lead context. Eliminates double-billing.
- `renderStatusLine` now always renders all 3 rows regardless of companion-state mode. A prior mode-gated collapse dropped rows 2-3 during tool-running, which hid git/cost/rate info most of the session. Reactivity belongs in the orb body (spin/color), not in row visibility.

### Fixed
- AISLE gate-evaluator cache reader accepts production `cachedState` shape (previously only read legacy `state` field, causing every Agent()/Task() dispatch to falsely block with `[C:unapproved_agent_type]`). Regression tests added.
- `check-agent-staleness.cjs` + `restore-agent-files.cjs` cleanup expanded to remove zombie untracked hooks on SessionStart.
- 22 agent frontmatter files had an unexpanded `last-verified: {{DATE}}` blueprint placeholder. Replaced with a real date.
- `lattice-verify.cjs` module-level `_cachedKey` persisted across vitest runs on Windows. Exported `_resetCache()` helper; 12 flaky tests now green.

### Docs
- `docs/harness-internals.md` synced to current CC: event count updated, GrowthBook flags reframed as point-in-time.
- `.claude/rules/platform-gotchas.md` enriched with worktree isolation fix + keep-coding-instructions.

---

## [1.19.3] - 2026-04-14

Patch: 3 harness field mismatches + 5 DFE/audit fixes + 54 new tests.

### Fixed
- `detectState` context pressure read `context_window.used/total` (nonexistent). Harness sends `used_percentage` directly. Exhausted/sleepy faces never triggered. Now reads `used_percentage`.
- `detectState` rate limiting read `rate_limits.requests_remaining` (nonexistent). Harness sends `five_hour/seven_day.used_percentage`. Rate-limited state never triggered.
- `detectEvent` test-pass check was greedy: `"3 failed | 97 passed"` matched both "failed" and "passed". Reordered: failures checked first.
- Per-event throttle was global: commit event blocked context-high for 60s. Now stores per-event timestamps.
- `shouldThrottle` falsy-zero bug: `thresholdMs || DEFAULT` treated 0 as falsy. Fixed with `!= null` check.

### Added
- 48 tests for `detectEvent()`, `shouldThrottle`, `signalCompanion`
- 6 new tests for harness field paths in `detectState`
- Tone validation in config loader — rejects invalid `insights.tone`, falls back to `'warm'`

### Removed
- Dead `.claude/hooks/hud-reactive.cjs` (superseded by plugin copy)
- Dead `hook_event_name` branches in plugin `hud-reactive.cjs`

---

## [1.19.2] - 2026-04-14

Patch: activity detection was reading the wrong field from harness stdin.

### Fixed
- `detectState` checked `session.outputTokens` (canonical state) but `resolveExpression` receives raw harness JSON with `context_window.total_output_tokens`. Face never detected text generation. Now checks both paths.

---

## [1.19.1] - 2026-04-14

Patch: companion face fixes from a multi-pass review.

### Fixed
- Session boundary detection moved before idle time checks — face was stuck on idle across session restarts
- Config loading moved from module scope to per-call — changes to `.4ge/config.json` now apply within 10s without session restart
- Added clamp validation for 9 timing constants (prevents freeze/strobe from invalid config)
- Added `breathScaleMin > breathScaleMax` inversion guard

---

## [1.19.0] - 2026-04-14

Companion comes alive. The buddy's speech bubble shows contextual insights instead of static greetings. All 16 companion tuning knobs are now configurable via `.4ge/config.json`. HUD activity signaling ships as a plugin hook.

### Added
- **Companion insight engine** (`companion-insights.cjs`) — 22 contextual rules across 5 categories (session, context, git, nudge, ambient) with 45s rotation and tone filtering
- **Companion config surface** (`companion-config.cjs`) — 16 tuning knobs loadable from `.4ge/config.json` with fallback defaults
- **Plugin hud-reactive hook** — companion activity signaling shipped via plugin `hooks.json`
- **statusLine in template** — `settings.json.template` now includes the HUD engine statusline block
- 65 new tests

### Fixed
- 5 hooks with stale `./hook-utils.cjs` require path → `../../lib/hook-utils.cjs`
- 7 duplicate hud-reactive entries stripped from project settings.json (plugin owns it now)
- `export-pipeline.cjs` hardcoded project slug → dynamic `buildProjectSlug()`
- Hook catalog: hud-reactive registered as `optional/hud`

### Changed
- `companion-state.cjs` timing constants now read from config
- `hud-braille-orb.cjs` rendering params now configurable
- `hud-zone-cards.cjs` greeting slot tries insight engine before static GREETINGS map

---

## [1.18.0] - 2026-04-13

Plugin quality sprint. Fixed broken features, wired dead systems, improved portability.

### Added
- `lib/eject.cjs` + `lib/adopt.cjs` — component ejection/adoption lifecycle (7 tests)
- `/debug` command registered — systematic debugging with memory search
- `/recon` command registered — intelligence gathering
- `/signoff` command registered — session cartridge enrichment
- `/resp4wn` command registered — Context Respawn DCD management
- Trust score progression — checkpoint-buddy increments trust on successful sessions

### Fixed
- `studio.md` + `export.md` — cwd-relative requires replaced with `${CLAUDE_PLUGIN_ROOT}` (broke in worktrees)
- `first-run.cjs` PLUGIN_VERSION synced to match plugin.json
- `/4ge` HUD dispatch changed from Haiku to Sonnet
- `/4ge` dispatch hardcoded project paths replaced with relative paths (portability)
- `/lounge` description updated to match actual behavior
- `/4ge eject` + `/4ge adopt` — were referencing missing modules, now implemented

---

## [1.17.0] - 2026-04-10

HUD convergence complete. Legacy pipeline retired.

### Removed
- `hud-statusline.cjs` — 2,253 lines retired. Zero runtime callers. Legacy pipeline fully replaced by engine.
- `hud-statusline.test.js` — 249 tests for deleted module
- `boot-screen-v2.cjs` — absorbed into boot-screen.cjs
- Dead code: `hud-anim.json`, badge shadow functions

### Added — HUD Engine
- Model-specific strip variants: Opus→determined, Sonnet→thinking, Haiku→sleepy
- Agent-type compact card emphasis: audit→health color, implementation→accent
- `hud-zone-activity.cjs` — recent tool calls with error rate, visibility-gated
- `hud-zone-forge-progress.cjs` — live forge session progress from state file
- `hud-zone-git-status.cjs` — branch, ahead/behind, dirty count
- OSC 8 hyperlinks on capability names in caps zone
- 11 new test files
- HUD-STANDARDS.md bumped to v1.3.0

### Added — Companion System
- `renderCompactExpression()` — 9x3 compact eye renderer for statusLine mode
- Vector search recall improved 33%→90% via domain vocabulary + tag filtering
- Happy expression measurement approved (Duchenne fix confirmed)

### Added — Wizard Engine
- `wizard-session.cjs` — atomic state manager (create/update/read/end/isStale)
- DFE P1 fixes: phantom --json removed, CI threshold 75→70, gitignore entries, session pre-flight fixed
- `wizard-defaults.json` bumped to v1.2.0 with scan_exclude, thresholds, dfe, respawn keys
- Enhanced /fix feedback: inbox count + next action suggestion

### Added — Hooks
- `memory-search-gate.cjs` — PreToolUse Write|Edit warning if no memory_search called
- `memory-search-marker.cjs` — PostToolUse marker when memory_search fires

### Fixed
- boot-screen.cjs ported to engine primitives (hud-palette + hud-zone-face, no statusline)
- Face zone padding to idealRows (was under-filling by 2 rows)
- Command cards idle placeholder (was dropping silently)
- ctx:est. label conditional on actual estimation
- guard-git-scope positional regex (no more heredoc false positives)
- Session ID anti-pattern in 5 utility files + callers
- process-cap-gate: fail-closed on errors, hook-utils migration, cross-platform
- WorktreeCreate hook removed (was hijacking native git worktree creation)
- memory-protocol-check.cjs upgraded from console.log to process.stderr.write

---

## [1.16.0] - 2026-04-10

Companion system wiring, expression fixes, security hardening, Blueprint mirror.

### Added — Companion System

- **Boot animation wired** (`os-boot.cjs`): `startBoot(8)` triggers a 9-frame wakefulness sequence on session start (dead → proud joy).
- **Domain context loader** (`domain-context-loader.cjs`): New SessionStart hook pre-fetches measurement findings from the dev-memory hub into `_runs/os/.domain-context.json` for teammate dispatch priming.

### Fixed — Expressions

- **Sleepy/exhausted droop**: Replaced flat lids with `tilt()` for outer-corner droop. Sleepy is symmetric, exhausted is asymmetric (right eye barely open). No longer rectangular.

### Fixed — Security

- **CWE-1321** `wizard-config.cjs`: `UNSAFE_KEYS` guard blocks `__proto__`, `constructor`, `prototype` in `deepMerge()`.
- **CWE-78** `infra.cjs`: `assertSafeName`/`assertSafePath` validate all docker inputs before `bash -c` string interpolation.
- **CWE-22** `git.cjs`: Reject `..` traversal and absolute paths in commit files array.

### Fixed — Hooks

- **Rate-limit zone**: Imports `stripAnsi` from `hud-palette.cjs` instead of legacy `hud-statusline.cjs` (last non-boot-screen runtime dependency removed).
- **hook-health-validator**: Path corrected to `lib/hook-utils.cjs`.
- **scope-auto-scan**: Latency reduced from 9s to 3s max.
- **superpowers-remind**: Session ID from stdin instead of unset env var.

### Changed — Blueprint Templates

- Mirrored 6 hook files + 1 rule to `components/` so Blueprint installs get the security fixes: enforce-approved-agents, guard-git-scope, pre-write-check, superpowers-remind, context-economy-gate, hud-reactive, hud-standards-pointer.

---

## [1.15.1] - 2026-04-08

> **Retroactive entry (added 2026-06-09).** Released with no CHANGELOG section. Added the warm-dark `forge` HUD theme (cyan accent) to `hud-palette.cjs` and made it the default, plus a sanitize fix; existing explicit `setTheme()` choices unaffected. Note this shipped a feature in a *patch* bump — it would have been 1.16.0.

## [1.15.0] - 2026-04-08

> **Retroactive entry (added 2026-06-09).** Released as a version-only bump whose message said "CHANGELOG update deferred" — the entry was never written. Logged retroactively so the version chain is complete; the work it packaged is described by the surrounding commits of 2026-04-08.

## [1.14.0] - 2026-04-07

HUD Engine, AISLE hardening, and hook capabilities. This release packages 9 commits — the largest unreleased feature gap since v1.0.0. The HUD engine alone (13 CJS modules, 1030 tests) is bigger than most full releases. Also establishes a versioning cadence: feature-gated bumps with a 2-week ceiling.

### Added — HUD Engine Phase 1+2

**Why a rendering engine:** The HUD statusline (v1.6.0) was a single-line status bar. The engine is a full terminal rendering platform with zones, expressions, badges, and export — the foundation for Studio Mode.

- **HUD engine core** (`bin/hud-engine.cjs`): Full-mode and zone-mode rendering with ANSI output. Reads merged OS state from stdin and renders a multi-zone terminal display.
- **7 zone renderers**: header, capabilities, forge, badges, history, metrics, and footer zones. Each renderer is an independent CJS module.
- **Expression engine** (`lib/hud/expression-engine.cjs`): Pixel art face rendering with half-block characters, calmer expression set, and mood transitions.
- **Badge tracker** (`lib/hud/badge-tracker.cjs`): Achievement system tracking forge-master, audit-clean, full-deploy, zone-builder, test-green, export-ready, studio-mode, and all-zones milestones.
- **Export pipeline** (`lib/hud/export-pipeline.cjs`): Session snapshot export to `_runs/` for handoff documentation.
- **HUD state builder** (`bin/hud-state.cjs`): Merges boot-status.json and health.json into canonical state schema for engine consumption.

### Added — Hook Capabilities

- **5 new hooks**: `input-transform.cjs` (updatedInput), `watch-paths.cjs` (watchPaths), `mcp-output-enrich.cjs` (updatedMCPToolOutput), `bg-verify.cjs` (asyncRewake), and AISLE transform mode via `aisle-gate.cjs`.
- **Removed**: dead `post-compact-memory.cjs` (hook was unwired and unused).
- **New hook-utils exports**: `logCapabilityResponse`, `buildCapabilityOutput`.

### Added — Research & DFE Improvements

- **Research protocol** (`lib/research-protocol.cjs`): 18-op, 3-tier research framework (lite/standard/deep) for structured agent research.
- **Maintain thresholds** (`skills/wizard-engine/references/threshold-defaults.json`): 81 threshold entries for outhouse/maintain scoring.
- **DFE dual-model**: 5 Sonnet minions + 1 Opus adversarial pass with a confidence filter (0.3-0.95 band).

### Changed — AISLE Hardening

- AISLE gate scanners promoted from WARN to BLOCK tier.
- Plugin maturity fixes across security hooks.
- Transform mode enables `updatedInput` for safe command rewriting.

### Fixed

- Dead `sop-engine.test.js` deleted.
- Superseded `modes/maintain.md` removed — outhouse replaces maintain.
- Wizard module + DFE pre-flight fixes.

### Versioning

- **New cadence adopted**: Feature-gated minor bumps + 2-week ceiling patch. Prevents multi-session unreleased gaps.

---

## [1.13.1] - 2026-04-06

### Added
- Ghost reversion defense hooks as distributable components (`ghost-reversion-guard.cjs`, `shadow-guard.cjs`)
- Both hooks added to HOOK_CATALOG as `recommended` tier
- settings.json.template wiring for PreToolUse (restore) and PostToolUse (shadow + auto-commit)
- hooks-contract.md template documentation with Handlebars conditionals

### Changed
- TASKING slimmed to index-only, history in handoff files

---

## [1.13.0] - 2026-04-06

Tier 3 intelligence layer + previously unreleased Tier 2 power tools. This release adds self-tuning capabilities that let the plugin learn from its own telemetry, adapt model routing based on success rates, and surface actionable suggestions for config evolution. Three new user-facing commands and a full forge session management toolkit round out the biggest feature drop since 1.9.0.

### Added — Tier 3 Intelligence Modules

**Why Tier 3 exists:** Tiers 1-2 gave the plugin config-driven hooks, design toolkits, and telemetry collection. Tier 3 closes the loop — modules that _read_ telemetry and _act on it_, making the plugin self-improving without manual tuning.

- **Config loader** (`lib/config-loader.cjs`): Identifies which repository the plugin is running in using two-factor detection — filesystem signals (marker files like `wrangler.toml`, `docker-compose.yml`) combined with a `.4ge/repo-id` marker. This drives per-repo config selection so each project gets its own agent roster, capability set, and autoresearch domains without manual setup.
- **Telemetry collector enhancements** (`lib/telemetry-collector.cjs`): Five new data pipeline functions — `readJsonl`, `aggregateByField`, `filterByDateRange`, `topN`, and `mergeMultipleJsonl`. These power the `/evolve` and `/lint` commands by turning raw JSONL session logs into structured insights.
- **Autoresearch cron trigger** (`lib/autoresearch-cron.cjs`): Detects stale autoresearch domains and schedules priority-ordered re-measurement. Can be wired into SessionStart or cron hooks to keep domain scores fresh automatically.
- **Repository intelligence index** (`lib/repo-index.cjs`): Walks the repository tree and categorizes files by semantic role using path patterns and content heuristics. Output is a structured map used by the `/map` command.
- **Per-repo configs** (`lib/configs/`): Tailored configuration profiles selected per project — full-tier (all OS capabilities, broad agent roster, many autoresearch domains), a streaming/GPU-aware profile, and a conservative standard-tier profile with no OS kernel.
- **Migration alias registry** (`lib/migration-aliases.cjs`): Maps old agent/hook names to their current equivalents, with cycle detection to prevent alias chains that loop.
- **Config compiler** (`lib/config-compiler.cjs`): Reads telemetry to identify config entries that are never exercised. Outputs removal suggestions ranked by confidence.
- **Prompt linter tuner** (`lib/prompt-linter-tuner.cjs`): Tracks which CLAUDE.md rules are actually followed versus ignored across sessions. Rules with consistently low follow-through get flagged for demotion. Surfaces via `/lint`.
- **Adaptive model router** (`lib/model-router.cjs`): For each agent, queries telemetry for historical success rates by model. Routes to the cheapest model that maintains >= 90% success rate, falling back when success rate drops.
- **Implicit feedback harvester** (`lib/feedback-harvester.cjs`): Detects two signal patterns from git history — reverts shortly after a hook warning, and hook warnings never followed by a revert — scoring each hook's effectiveness ratio.
- **Security constants** (`lib/security-constants.cjs`): Centralizes credential patterns, file path exclusions, and risk thresholds used by AISLE scanners and the secret guard hook.

### Added — New Commands

- **`/map`**: Renders a semantic map of the repository — files grouped by role with counts and key paths. Powered by `repo-index.cjs`.
- **`/evolve`**: Analyzes telemetry and suggests concrete config changes. Each suggestion includes the evidence and a confidence score. Powered by `config-compiler.cjs` + `feedback-harvester.cjs`.
- **`/lint`**: Shows rule follow-through rates from CLAUDE.md and project rules. Powered by `prompt-linter-tuner.cjs`.

### Added — Tier 2 Power Tools

**Why these were held back:** these modules shipped to main but the version bump was deferred while Tier 3 planning was underway. They've been running in production — this release officially stamps them.

- **Trust score accumulator** (`lib/trust-score.cjs`): Tracks forge session outcomes and progresses through three autonomy levels: `guided`, `assisted`, `autonomous`. Score persists to disk. Exposed via `/4ge trust`.
- **Layout parser** (`lib/layout-parser.cjs`): Parses inline YAML topology definitions for forge teammate arrangement. Ships with 3 bundled layouts: `writer-reviewer`, `star-audit`, `pipeline-build`. Exposed via `/forge layout <name>`.
- **Session archaeology** (`lib/session-archaeology.cjs`): Indexes forge session state files and enables search by date or topic keyword. Exposed via `/forge resume <date|topic>`, `/forge sessions`, `/forge history`.
- **Checkpoint buddy** (`lib/checkpoint-buddy.cjs` + `hooks/checkpoint-buddy.cjs`): PostToolUse hook on `git commit` that extracts diff stats and logs them to `_runs/session-wins.jsonl`. The `/4ge wins` command renders an all-time summary.
- **Lounge engine** (`lib/lounge-engine.cjs`): Mouse-free minimal-effort coding mode. Every decision point is presented as numbered options. New `/lounge` command.
- **Design suite config**: The design suite now reads `.4ge/config.json` for mode allowlists, framework preferences, and cloud provider filtering.
- **Tier 2 E2E tests**: 2 integration suites validate all 16 Tier 2 modules load correctly and cross-module pipelines produce expected outputs.

### Added — Zombie Recovery

- **Zombie work-product recovery** (`lib/os/kernel/zombie-recovery.cjs`): When the zombie scanner force-kills a stuck agent, this module first attempts to salvage its partial work — captures the agent's uncommitted `git diff` as a `.patch` file, creates a stash or branch to preserve changes, detects orphaned worktrees, and writes a structured recovery report to `_runs/`. Wired into `zombie-scanner.cjs` cleanup phase after SIGKILL.

### Fixed

- **HUD BMP emoji rendering**: 28 supplementary-plane Unicode characters replaced with Basic Multilingual Plane equivalents across all 3 themes and MOON_PHASES. Windows Git Bash renders supplementary-plane chars as the replacement character, making the HUD unreadable.
- **Task counter session scoping**: HUD task counter now filters by `session_id` instead of counting all-time tasks.

---

## [1.12.0] - 2026-04-06

Boot Screen — a dedicated ANSI-colored renderer for `/4ge os` that replaces LLM-driven formatting with deterministic, personality-infused output.

### Added

**Why a dedicated renderer:** Previously, `/4ge os` read boot-status.json and asked the LLM to format it as a status table. This was slow, non-deterministic, and consumed context tokens. The boot screen renderer is a pure CJS function that produces identical output in <5ms.

- **Boot screen renderer** (`bin/boot-screen.cjs`, 253 lines, 11 exported functions): Reads `_runs/os/boot-status.json` and renders a personality-infused boot status display. Capabilities grouped by layer; a grade-aligned health bar and time-seeded face/quip selection add character. 29 tests.
- Updated `/4ge os` command routing to invoke `boot-screen.cjs` directly.
- Added ANSI Boot Screen Exception to `output-format.md`.

---

## [1.11.0] - 2026-04-06

Feature: Forge phase delegation + HUD DFE remediation. Bumped from 1.10.0 to disambiguate from a parallel session version collision.

### Added

- **Forge phase agents**: 3 new agents (forge-brainstorm, forge-planner, forge-shipper) enable forge to delegate skill-heavy phases to subagents. Reduces lead context skill burden ~76%.
- **Forge SKILL.md phase delegation**: Phases 2-3, 4, and 7 now prefer dispatching phase agents over inline skill invocation, with graceful fallback.
- **last-commit-writer hook**: PostToolUse hook writes epoch to `_runs/os/last-commit-ts.txt` after git commit, feeding HUD commit age display.
- **Phase 4 tests**: 17 new tests covering theme spec compliance, auto-expansion view routing, regression, expanded view rendering.
- **Skill chaining research**: Token optimization report. An Opus research agent measured all superpowers skill sizes and proposed 3 optimization patterns.
- **Adaptive skill intensity**: New behavioral model — skills run in 3 tiers (lite/full/S-tier) based on task weight.
- **Skill-to-hook compiler concept**: Captured in the /fix inbox.

### Fixed

- **[P0] rateLimitHigh**: `renderExpanded` now reads `rate_limits.five_hour` instead of `ctxPct` for rate limit face resolution. Re-applied after ghost reversion ate the initial fix between commit and push.
- **[P1] seven_day auto-expansion**: `resolveAutoExpansion` checks both `five_hour` and `seven_day` rate limits.
- **[P1] milestones initialization**: `loadDiskCache` always initializes `_state.milestones` so the centurion milestone fires at toolCount=100. Re-applied after ghost reversion.
- **Theme icons (23 corrections)**: All 4 themes now match the spec exactly.
- **Ghost reversion resilience**: P0+P1 fixes required 2 re-applications due to a CC file cache resync bug (anthropics/claude-code#42383).

### Changed

- BOOT_STATUS_FILE exported for test access.
- Total tests: 112 (was 95).

---

## [1.10.0] - 2026-04-06

> **Retracted number (annotated 2026-06-09).** Released and renumbered to 1.11.0 fourteen minutes later to resolve a parallel-session version collision; the full entry lives under [1.11.0] above. No artifact shipped as 1.10.0.

---

## [1.9.2] - 2026-04-06

Patch: HUD P0/P1 remediation + hook timeout resilience.

### Fixed

- **HUD P0/P1 DFE remediation**: rateLimitHigh rendering, theme icon alignment, Phase 4 test coverage.
- **Hook timeouts**: ollama-autostart bumped 10s -> 20s, check-docker-health bumped 10s -> 15s. Both hit intermittent timeouts from pwsh cold-start and WSL round-trips.
- **Hook diagnostic logging**: New `hook-diag.cjs` utility writes start/end/error events to `_runs/hook-diag.jsonl`. Retrofitted the 3 slowest SessionStart hooks. A "start" without matching "end" = timeout.

---

## [1.9.1] - 2026-04-06

Patch: fix output-format.md path resolution for marketplace plugin consumers.

### Fixed

- **Output format path resolution**: 12 command/skill files referenced `output-format.md` via relative paths that resolved against the user's project CWD instead of the plugin cache directory. Replaced with `${CLAUDE_PLUGIN_ROOT}/skills/wizard-engine/references/output-format.md`.

---

## [1.9.0] - 2026-04-06

4ge Power Tools Tier 2 Phase E + Forge Multi-Stream.

### Added

- **Design suite classifier** (`design-suite-classifier.cjs`): 4-mode context classification (visual/api/data/system) with confidence scoring. 23 tests.
- **Design suite visual toolkit** (`design-suite-visual.cjs`): Component analysis, style system detection, accessibility helpers. 7 tests.
- **Design suite API toolkit** (`design-suite-api.cjs`): Endpoint analysis, OpenAPI detection, framework-specific router patterns (Hono/Express/Fastify). 7 tests.
- **Design suite data+system toolkits** (`design-suite-data-system.cjs`): Schema analysis, migration detection, infra mapping, coupling metrics. 13 tests.
- **Design suite orchestrator skill** (`skills/design-suite/SKILL.md`): 4-mode contextual design assistant.
- **Dialect detector** (`dialect-detector.cjs`): Repo 4ge state fingerprinting, drift detection, recommended actions. 8 tests.
- **Hook auditor** (`hook-auditor.cjs`): Detect unwired hooks and orphaned settings.json entries. 6 tests.
- **Scope drift radar** (`forge-scope-check.cjs`): Cumulative drift counter with JSONL logging and escalation at 3 violations. 6 tests.
- **Rubber duck debugger** (`rubber-duck-debugger.cjs`): Socratic prompt after 3 consecutive same-errors within a 5min window. 6 tests.
- **Prompt scaffolder** (`prompt-scorer.cjs` + `prompt-scaffolder.cjs`): Score prompts 0-10 on action verbs, file paths, specificity, constraints. 10 tests.
- **Ambient telemetry** (`telemetry-collector.cjs` + `telemetry-session.cjs`): Session stats collection, JSONL persistence, trend computation. 7 tests.
- **Context budget forecast** (`context-budget.cjs`): Predict compact timing with rate-per-minute and urgency levels. 7 tests.
- **Causal attribution map** (`causal-map.cjs`): Map changed files to forge teammates by scope assignment. 5 tests.
- **Plugin hook utils v2** (`4ge-hook-utils-v2.cjs`): Config reader with safe defaults, JSONL append/read with 1MB size guard. 5 tests.
- **Runtime config schema v2.1**: design_suite, telemetry, trust, lounge sections with backwards-compatible optional validation. 10 tests.

### Changed

- `forge-scope-check.cjs` refactored from bare IIFE to `require.main` guard.
- `/4ge` command: added `status`, `stats`, `trust`, `wins` subcommands.
- `/recall` command: added `budget` subcommand.

### Added (Forge Multi-Stream)

- **Zombie scanner** (`lib/os/kernel/zombie-scanner.cjs`): Factory-based zombie process detection with 5-condition allowlist evaluation, 3-phase cleanup escalation (IPC -> SIGTERM -> SIGKILL), observability alert registration. 16 tests.
- **DFE eval harness** (`scripts/autoresearch/measures/dfe-eval.cjs`): Autoresearch domain for DFE detection rate. Parses labeled bug fixtures, runs toolkit modules, scores detection rate.

### Fixed

- DFE P0: Shell injection via osPid in `zombie-scanner.cjs` execSync — added integer validation guard.
- DFE P0: `markForKill` phase type mismatch — changed numeric 2/3 to string enum.
- DFE P1: `getSpeech()` dead code — recovery check moved before chill early-return.
- DFE M: IPC `from.pid` was same as `to.pid` — set to null for scanner identity.
- DFE M: `checkArtifactsCopyPasteViaScoer` typo corrected.
- Settings.json: shadow-guard hook entries restructured (flat command -> hooks array).
- DFE P1.1: Removed stale `secret_guard` from `PROTECTED_HOOKS`.
- DFE P2.2: Added 1MB file size guard to `readRecentJsonl`.
- DFE P3.2: `assembleDataToolkit` now uses config.detected for ORM hint.
- SYSTEM_PATTERNS regex now matches `docs/architecture.md`.

---

## [1.8.0] - 2026-04-06

4ge Power Tools Tier 1 Phase C+D + HUD v2 Phase 0+1.

### Added

- **Config-driven hook system** (`4ge-hook-utils.cjs`): Protected hook enforcement with JSON config reader and cache reset. 5 tests.
- **File content secret guard** (`file-content-secret-guard.cjs`): P0 pre-write secret detection scanning 16 credential patterns. 6 tests.
- **Progressive discovery** (`progressive-discovery.cjs`): SessionStart filesystem diff with update prompts for new plugin components. 3 tests.
- **Eject/adopt commands**: Eject components from plugin management or re-adopt them. Protected hooks cannot be ejected. 6 tests.
- **Tier 1 E2E integration test**: Full pipeline test covering detect->derive->validate->manifest->eject->encode. 6 tests.
- **HUD v2 core visual engine** (`hud-statusline.cjs`): ANSI color system, 10-char Unicode block bars, face engine, context-aware speech system, segment architecture with truncation priority.

### Changed

- **4 hooks rewritten for config-driven operation**: guard-git-scope, suggest-compact, post-edit-typecheck, console-log-stop-audit now read `.4ge-config.json`.
- **HUD Phase 0 bug fixes**: Async writeFile, stdin listener leak fix, hysteresis dedup with disk persistence.

---

## [1.7.1] - 2026-04-05

AISLE scanner activation — full boot with 9 armed scanners.

### Fixed

- **AISLE scanner auto-load**: Root cause — `aisle.cjs init()` never loaded scanners into registry before `boot()`. Added `fs.readdirSync` + `registry.load()` in init. All 9 scanners pass selfTest (30ms total).
- **AISLE config rewritten**: Proper `aisle-config.json` with all 9 tiers set to BLOCK, replacing boot-state blob. Missing state subdirs + HMAC secret created.

---

## [1.7.0] - 2026-04-05

Core agent team + plugin deploy automation.

### Added

- **10 distributable agent templates** (`components/agents/`): DFE, debugger, guide, implementer, ops, planner, researcher, reviewer, security-reviewer, tester. Each template includes routing keywords for the selection engine and MCP memory tools.
- **Agent catalog v2** (`lib/agent-installer.cjs`): Expanded catalog with all 10 templates. Backward-compatible.
- **Weighted keyword selection engine** (`lib/agent-selection.cjs`): Routes tasks to agents via phrase matching and keyword weights.
- **UTF-8 encoding validation** (`lib/encoding-check.cjs`): Validates agent `.md` files are valid UTF-8 before install.
- **Plugin marketplace sync hook** (`plugin-marketplace-sync.cjs`): PostToolUse hook on `git push` — auto-syncs marketplace cache after push.
- **Plugin cache cleanup hook** (`plugin-cache-cleanup.cjs`): SessionStart hook removes stale plugin cache version directories.
- **30 new tests** across 4 test files.

### Changed

- **`enforce-approved-agents.cjs`**: Migration aliases added — old agent names remap to approved agents instead of blocking.
- **`planner.md` and `security-reviewer.md` templates**: Trimmed to focused, distributable templates with standardized frontmatter.

### Fixed

- **Audit remediation**: `scoreAgent` double-counting in selection engine corrected. `maxTurns: 200` set on all templates. MCP memory tools added to agent templates that were missing them.

---

## [1.6.1] - 2026-04-05

Autoresearch sweep, AISLE gate operational, changelog infrastructure.

### Added

- **Autoresearch built-in sweep** (`scripts/autoresearch/harness.cjs`): `sweep()` runs all domain measures in parallel with a concurrency-limited promise pool. Per-domain timeouts from `budget_minutes`. CLI: `--sweep [--concurrency N]`. 11 tests.
- **`/releases` command**: Surfaces release notes from `_runs/RELEASE-*.md`. Added to `/help` delivery workflow.
- **What's-new SessionStart hook** (`whats-new.cjs`): Shows the changelog section on first session after a version bump. Truncates at 40 lines, points to `/releases` for full notes.
- **Comprehensive CHANGELOG.md**: covering v1.0.0 through v1.7.0 in Keep a Changelog format.

### Fixed

- **AISLE gate setup-mode bypass**: Gate passes through (exit 0) when config is missing OR state is `setup-required`, preventing total-deadlock.
- **AISLE gate operational**: State dir created with 9 scanner caches (ARMED, WARN tier) and HMAC secret. First operational deployment without deadlock.
- **Autoresearch bare-number tolerance**: Measures outputting raw numbers no longer error.
- **Autoresearch per-domain timeouts**: Replaced flat 30s with `budget_minutes` from domain config.

### Security

- AISLE gate now operational with all 9 scanners at WARN tier. Pass-through on setup-required prevents security-through-deadlock. Bridge hooks + prompt guard cover the transitional state.

### Removed

- 4 contaminated rules files (architecture.md, build-commands.md, integrations.md, terminology.md) — uncustomized `{{PLACEHOLDER}}` templates from blueprint.

---

## [1.6.0] - 2026-04-05

Display System. Full output format standardization, HUD statusline with collapsed and expanded modes, AISLE gate operationally wired, and three new session-workflow commands.

### Added

- **Output format library** (`plugins/4ge/skills/wizard-engine/references/output-format.md`): 10 components, 8 anti-patterns, and edge-case guidance. Canonical output reference for all plugin skills and commands.
- **`hud-statusline.cjs`** (379 lines): Zero-dependency statusline binary. Collapsed single-line render with context pressure indicator, TTL-cached OS state file reads, rate-limit display, workflow labels, and graceful degradation on missing data.
- **HUD expanded mode**: 5 views (health, agents, tasks, usage, inbox) with tab bar, truncation, and context-pressure auto-switch to Usage view at 70%.
- **HUD context writer**: `os-accounting.cjs` extended to write `hud-context.json` detecting the active workflow.
- **TeammateIdle hook**: `teammate-idle-verify.cjs` — writes `teammate-idle.json` on TeammateIdle events.
- **`/hud` command**: Toggle HUD on/off, select active view, query current status.
- **`/releases` command**: Surfaces release notes.
- **`/decide` command**: Appends structured decision entries to `_runs/.decisions.jsonl` for Decision Chain Document enrichment.
- **`/constraint` command**: Appends structured constraint entries to `_runs/.constraints.jsonl` for DCD enrichment.
- **AISLE gate operational wiring**: Gate wired into `PreToolUse` hooks with all 9 scanners at WARN tier. Setup-mode bypass prevents deadlock.
- **`.4ge-wizard.json` schema v1.1.0**: `execution_tiers` and `hud` config blocks added.

### Changed

- **5 commands rewritten as thin routers**: `/fix`, `/wizard`, `/dfe`, `/forge`, and `/maintain` now pre-parse args and suppress intermediate text.
- **Format directives wired** into forge, dfe-review, aisle, 4ge, and infra skills/commands.

---

## [1.5.2] - 2026-04-05

Security: template contamination guard. AISLE gate unwired (fourth deadlock incident).

### Added

- **`template-contamination-guard.cjs`**: Pre-commit hook blocks `git commit` if staged `.claude/` files contain `{{PLACEHOLDER}}` template patterns. Prevents Blueprint installer overwrites from landing in git. Fail-open on errors.

### Fixed

- Version mismatch: `marketplace.json` and root `.claude-plugin/plugin.json` were at 1.5.1 while `plugins/4ge/.claude-plugin/plugin.json` was at 1.5.2. All 3 manifests aligned to 1.5.2.
- AISLE gate removed from `settings.json` — deadlocked all tools on missing config (fourth recurrence). Gate remains off until v1.6.0 setup-mode bypass ships.

### Security

- Template contamination guard prevents `{{PLACEHOLDER}}` patterns from being committed to `.claude/` protected directories.

---

## [1.5.1] - 2026-04-05

Maintenance: console.log guard wired, ESLint fix, version tooling added.

### Added

- **`console-log-edit-warn.cjs`** PostToolUse hook: Warns with line numbers when `console.log` appears in edited `.ts/.tsx/.js/.jsx` files.
- **`scripts/bump-plugin-version.cjs`**: One-command version bump across all manifest files.

### Fixed

- ESLint `no-useless-escape` in `aisle-prompt-guard.cjs`.

---

## [1.5.0] - 2026-04-04

AISLE security capability, wizard suites engine, and Opus adversarial DFE tier.

### Added

- **AISLE security capability**:
  - 9 scanners: supply-chain integrity (A), database/terminology (B), privilege/agent control (C), file integrity (D), egress/credential detection (E), CVE monitoring (F), prompt injection (G), payload inspection (H), memory integrity (I)
  - Gate evaluator pipeline with policy engine and learning loop (tunes scanner sensitivity from false-positive feedback via `memory_feedback`)
  - 393 tests across 8 test suites in `lib/aisle/__tests__/`
  - A multi-agent adversarial review before merge
  - `aisle-prompt-guard.cjs` — UserPromptSubmit credential scanner (18 patterns, loaded from `secret-patterns.json`)
  - `/aisle` command: Setup, status, and enable/disable controls for the gate
- **`scripts/aisle-bootstrap.cjs`**: One-shot setup creates AISLE config, state dir, HMAC secret, boot marker, and regenerates pin manifest. Gate disabled at first boot; re-enable via `/aisle` after bootstrap completes.
- **Wizard suites engine**:
  - `wizard-engine` skill with 3 operational modes (maintain, wizard, fix)
  - `maintain` mode: 100-point repo health scorer, 5 categories
  - `wizard` mode: interactive session configuration
  - `fix` mode: targeted remediation with per-fix snapshot rollback
  - 6 reference files, security-floor enforcement in `wizard-defaults.json`
  - 23 tests
- **Opus adversarial tier for DFE**: `dfe-review` skill upgraded from 5-pass (Sonnet-only) to 6-pass (5 Sonnet + 1 Opus adversarial). The Opus adversarial pass runs after the Sonnet minions complete, receives their reports as context, catches cross-cutting issues, corrects false positives, and finds architectural smells.

### Changed

- Plugin help table updated to reflect new commands and hooks.

### Security

- AISLE gate replaces 12 individual security hooks with a unified enforcement pipeline. All scanners operate within a 50 ms budget.

---

## [1.4.3] - 2026-04-04

Zombie process prevention. Root cause: Windows `TerminateProcess` on teammate exit orphans grandchild hook processes.

### Fixed

- **`kill-orphan-processes.cjs`**: Replaced per-process `Get-CimInstance` loop (O(N) WMI queries, timed out at ~50 zombies) with single batch WMI query. PowerShell timeout bumped from 8 s to 15 s.
- **`plugins/4ge/hooks/hook-utils.cjs`**: Added 30-second self-destruct timer with `unref()` as a safety net for hooks orphaned when the parent CC process exits on Windows.

---

## [1.4.2] - 2026-04-04

OS runtime wiring stability.

### Fixed

- `os-accounting.cjs`: Drains stdin before early exit to prevent zombie node processes on Windows.
- 7 plugin agents (`dfe-*`, `implementation-expert`, `master-auditor`): `tools:` → `allowed-tools:` in agent frontmatter — DFE passes and `/audit` were silently losing tool access.
- `guard-git-scope.cjs` and `superpowers-remind.cjs`: Session tracking format unified from `.txt` to `.json` to match writers.
- Post-audit remediation pass across hooks and OS layer.

---

## [1.4.1] - 2026-04-04

### Fixed

- `/respawn` command and `respawn` skill: Added `/reload-plugins` step for sessions started via `--append-system-prompt-file`, where custom marketplace plugins may not load automatically.

---

## [1.4.0] - 2026-04-04

Context Phoenix — session continuity, token monitoring, and OS runtime wiring.

### Added

- **`/respawn` command**: Manual Decision Chain Document extraction and fresh Claude Code instance spawning for context continuity.
- **`respawn` skill**: Automates DCD extraction and re-spawn workflow.
- **`cswap respawn` subcommand**: CLI-based context continuation.
- **`context-usage-warn.cjs`** check module: O(1) transcript tail-read, 70%/85% threshold warnings, 5-call throttle.
- **Power mode documentation**: `DISABLE_AUTO_COMPACT` env var for 1M sessions and JSONL decision/constraint logging convention added to `CLAUDE.md`.
- **OS runtime accounting hooks**: `os-accounting.cjs` wired as PostToolUse hook; `pre-write-check.cjs` cost-savings JSONL tracking. 120+ new tests.

---

## [1.3.0] - 2026-04-03

DFE agent dispatch corrected. Agents were producing no output on dispatch.

### Fixed

- **DFE minion agents** (`dfe-artifacts`, `dfe-existence`, `dfe-logic`, `dfe-runtime`, `dfe-security`):
  - Switched from Bash heredoc to Write tool for report output — heredoc dispatch was silently discarding output.
  - Removed `disallowedTools`/`background` frontmatter that was preventing Write tool access.
- **`dfe-review` skill**: Changed to foreground dispatch for TUI visibility.

---

## [1.2.1] - 2026-04-03

DFE security remediation. 19 findings across 14 files fixed.

### Fixed

- **P0** — `diff-scoper.cjs`: `exec` defaulted to `null` instead of `execSync`, causing a crash on every `/dfe` invocation.
- **P1** — `forge-heartbeat.cjs`: Async write race condition.
- **P1** — `dfe-post-edit.cjs`: Path traversal (CWE-22) — input sanitized.
- **P1** — `history-aggregator.cjs`: Filter logic corrected.
- **P1** — `ast-analyzer.cjs`: 4 dead function declarations removed.
- **P2** — `SAFE_REF` regex hardened; scope-check guards added; Node 18+ check.
- **P2** — `hook-utils.cjs`: maxSize overshoot fixed; dead `reportTiming` removed.
- `marketplace.json` missed the 1.2.1 bump in the prior commit.

---

## [1.2.0] - 2026-04-03

DFE toolkit bundled into plugin. Template agents genericized for external installs.

### Added

- **DFE toolkit bundled**: `lib/dfe/` (6 CJS modules + config) copied into `plugins/4ge/lib/dfe/`. Toolkit paths in all DFE agent files updated to `${CLAUDE_PLUGIN_ROOT}/lib/dfe/` so the toolkit works in external installs.
- **`plugin-version-guard.cjs`** hook: Validates plugin version on load; warns when manifests are out of sync.

### Changed

- `implementation-expert` agent genericized: Removed environment-specific references; made memory optional for cross-repo portability.
- `master-auditor` agent genericized: Removed `mcp__dev-memory` from tools; made memory optional.
- `{{DATE}}` placeholder in agent files replaced with a real date.

### Fixed

- `plugin-version-guard.cjs` regex: Backslash escaping corrected.

---

## [1.1.0] - 2026-04-03

Agent bundling and install reliability.

### Added

- **7 agents bundled with the plugin**: `master-auditor`, `implementation-expert`, and the 5 DFE minion agents now ship inside `plugins/4ge/agents/`. Previously only existed repo-local, causing `/audit`, `/dfe`, and `/forge` to fail on external installs.
- Plugin `README.md` updated with full command list, agent inventory, and install instructions.

### Fixed

- Missing `plugins/4ge/.claude-plugin/plugin.json`: The plugin directory lacked its own manifest, causing Claude Code to always cache the version as 0.1.0 and skip `/plugin update` diffs.
- Stale fallback messages in several commands updated to reflect current routing.

---

## [1.0.0] - 2026-04-03

Initial unified plugin. Five predecessor plugins consolidated into a single 4ge entry with 11 slash commands and OS capability routing.

### Added

- **11 slash commands**: `/forge`, `/audit`, `/blueprint`, `/dfe`, `/fix`, `/hitchhiker`, `/infra`, `/autoresearch`, `/aisle`, `/4ge`, `/help`.
- **Forge skill** migrated from a retired predecessor plugin: 7-phase workflow (scope, brainstorm, spec, plan, execute, integrate, ship) with 11 reference files.
- **Forge hooks migrated**: `forge-heartbeat.cjs`, `forge-prompt-lint.cjs`, `forge-scope-check.cjs`, `hook-utils.cjs`.
- **3 maintenance skills**: `session-audit` (5-check session scorecard), `repo-intake` (structured onboarding scan, A–F grade), `repo-hygiene` (100-point scorer, 5 categories).
- **OS capability routing**: Commands delegate to Agentic OS capabilities — memory, git, forge, audit, blueprint, autoresearch, hitchhiker, infra, workflow-engine, capability-registry, sop-engine, llm.
- **Superpowers integration**: `paths:` frontmatter on all 11 commands for path-scoped CLAUDE.md routing.
- Hook optimizations: `if` filters on hooks saving ~1,050 process spawns per session; DNS exfiltration guard extracted to a standalone hook.
- Rate-limits statusline bridge via cswap; `effort:high` frontmatter on `/forge` and `/threat-model` skills.
- **Audit fixes**: 8 P1 findings addressed — `tools:` field corrected, README improved, personal data references removed, `forge-scope-check` exact-path matching fixed, `/autoresearch` routing corrected, graceful degradation for missing dependencies, sanitization tests added, numeric semver sort in marketplace recovery.

### Removed

- **5 predecessor plugins removed**: the prior autoresearch, hitchhiker, forge, audit, and blueprint plugins. All capabilities now route through the Agentic OS kernel.

---

## Pre-1.0 — Predecessor Plugins

Prior to 4ge v1.0.0, the ecosystem was split across five separate plugins (an audit plugin, a blueprint plugin, a forge plugin, a knowledge-search plugin, and an autoresearch plugin). The OS capability framework replaced all five with unified capabilities under the Agentic OS kernel; all five were removed and consolidated into 4ge on 2026-03-17.

---

[2.2.1]: https://github.com/turdpusher360/turd-box/releases/tag/v2.2.1
