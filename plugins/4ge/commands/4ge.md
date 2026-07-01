---
description: "4ge ecosystem — forge orchestration + OS operations"
argument-hint: "run <task> | resume | park | os | eject <type> <name> | adopt <type> <name> | status | trust | mode [code|review|ship|maintain] | board [history|refresh] | projections [advisory|auto-at-stop-lines]"
paths: ["plugins/4ge/**"]
---

# /4ge Command

## First-Run Check

Before dispatching any subcommand, check if this is a first-time install:

```javascript
const { isFirstRun } = require('${CLAUDE_PLUGIN_ROOT}/lib/first-run.cjs');
```

If `isFirstRun()` returns true, run the guided setup instead of dispatching. Present each step from `getSetupSteps()` conversationally, ask the user for their choice at each step, then call `completeSetup({ tier, memory })` with their selections. After setup completes, call `firstRun.hasTourFlag()` — if true, call `firstRun.getTourStep1()` and display the output before proceeding. Then proceed with the original subcommand (or show the Operate hub menu if no arguments).

Skip the first-run check if `$ARGUMENTS` is `status` (allow status check before setup).

---

Parse $ARGUMENTS to determine the subcommand. Dispatch accordingly.

| Pattern | Dispatch |
|---------|----------|
| `run <task>` | Invoke the `4ge:forge` skill with `"run <task>"` |
| `resume` | Invoke the `4ge:forge` skill with `"resume"` |
| `park` | Invoke the `4ge:forge` skill with `"park"` |
| `os` | **Render HUD directly** — see Render Instructions below. Mode: `--mode=full` |
| `os health` | **Render HUD directly** — see Render Instructions below. Mode: `--mode=zone --zone=capabilities` |
| `os caps` | **Render HUD directly** — see Render Instructions below. Mode: `--mode=zone --zone=capabilities` |
| `os scene` | **Render HUD directly** — see Render Instructions below. Mode: `--mode=scene --max-rows=10` (atmospheric scene, auto-selects idle/focused/alert from state) |
| `eject <type> <name>` | Eject a component from plugin management. Types: hook, skill. Protected hooks cannot be ejected. Run `node ${CLAUDE_PLUGIN_ROOT}/bin/eject-cli.cjs <type> <name>` and display the JSON result. |
| `adopt <type> <name>` | Re-adopt an ejected component back to plugin management. Run `node ${CLAUDE_PLUGIN_ROOT}/bin/adopt-cli.cjs <type> <name>` and display the JSON result. |
| `status` | Run dialect detection. Show repo state (fresh/partial/configured), version, tier, drift status, and recommended next action. Uses `require('${CLAUDE_PLUGIN_ROOT}/lib/dialect-detector.cjs').detectDialect(process.cwd())`. Format output per Status Table (component 8) — read `${CLAUDE_PLUGIN_ROOT}/skills/wizard-engine/references/output-format.md` before rendering. |
| `stats` | Show ambient telemetry summary (requires Tier 2 telemetry) |
| `trust` | Show trust level, score, and progression. Load via `TrustScore.load('${CLAUDE_PLUGIN_DATA}/forge/trust-score.json')`. Display: level (guided/assisted/autonomous), score, next threshold, remaining successes needed |
| `trust reset` | Reset trust score to 0 (guided). Confirm before resetting |
| `trust set <level>` | Override trust level. Sets score to threshold: guided=0, assisted=10, autonomous=25 |
| `wins` | Show session wins history (requires Tier 2 checkpoint buddy) |
| `mode` | Read board state and show `mode`, `mode_status`, and recommended next mode from `${CLAUDE_PLUGIN_ROOT}/lib/forge-board.cjs`. |
| `mode code` `mode review` `mode ship` `mode maintain` | Read latest board (fallback create default), set mode, then write `_runs/forge-board/latest.json` + `current/<session-id>.json` |
| `board` | Read latest board and return compact state summary with path pointers for Anvil compatibility artifacts. |
| `board history` | Read `history/index.json` via `readHistoryIndex` and show latest 10 entries (if any). If missing, show empty fallback list. |
| `board refresh` | Re-read `latest.json` and `history/index.json` from `process.cwd()/_runs/forge-board/` and report whether board artifacts are current. |
| `projections` | Show board projection mode and whether auto-at-stop-lines is active from latest board. |
| `projections advisory` `projections auto-at-stop-lines` | Set projection mode and persist through `setProjectionMode()` to latest/current artifacts. |
| (empty) | **Show the Operate hub menu** — see "Empty Args: Operate Hub" below (cheap HUD strip + an `AskUserQuestion` menu; the "OS status" leaf renders the full HUD) |

Compatibility helper note for these rows:

- `const forgeBoard = require('${CLAUDE_PLUGIN_ROOT}/lib/forge-board.cjs')`
- `setMode`, `setProjectionMode`, `writeBoard`, `readLatestBoard`, and `readHistoryIndex` are the only board surface writes/readers used here.
- Preserve every existing `/4ge` command semantics; these rows are compatibility writes only for Anvil-readable board state.

---

## Render Instructions (os subcommands and empty command)

Render the HUD directly in lead context. Do NOT spawn a subagent — subagent delegation pays double tax (Sonnet baseline ~25k + output bytes billed again as Opus input).

Steps:

1. Check `_runs/os/boot-status.json` exists via Glob. If missing, output `OS not booted. Check SessionStart hook.` and stop.
2. Read `_runs/os/boot-status.json` and `_runs/os/health.json` in parallel.
3. Merge into `{ ...bootStatus, health: {...healthJson} }`.
4. Pipe merged JSON via stdin to `node plugins/4ge/bin/hud-engine.cjs <MODE_FLAG>` (use `echo '<json>' |` from project root).
5. Return engine stdout VERBATIM — ANSI escape codes are expected, the terminal renders them. Do not strip, reformat, or summarize.
6. Add one plain-text line: capabilities ready/degraded count + health score.

Mode flag by subcommand:

| Subcommand | `<MODE_FLAG>` |
|------------|---------------|
| `os` / (empty) | `--mode=full` |
| `os health` / `os caps` | `--mode=zone --zone=capabilities` |
| `os scene` | `--mode=scene --max-rows=10` |

Do NOT read `output-format.md` — the engine owns its own formatting.

---

## Non-render subcommands

For `run`/`resume`/`park`: invoke the `4ge:forge` skill directly. `/4ge` itself is free (front door + first-run), but these three leaves dispatch the forge skill, which is Pro-gated — check `tier-gate.require('pro', 'forge')` semantics before dispatch so the free front door does not become a free side door into forge.

For `eject`/`adopt`: run the CLI wrappers shown in the dispatch table (`node ${CLAUDE_PLUGIN_ROOT}/bin/eject-cli.cjs` / `adopt-cli.cjs`).

For `status`: load the dialect detector, render output per Status Table formatting (component 8 in output-format.md). Also show current tier from `require('${CLAUDE_PLUGIN_ROOT}/lib/tier-gate.cjs').current()` and license info from `.info()`.

For `stats`/`trust`/`wins`: small state file reads, render inline.

None of these subcommands need to read `output-format.md` unless they produce formatted table output. The HUD delegation path specifically does NOT need it because the engine owns its own visual vocabulary (see the Conversation Canvas Exception in output-format.md).

---

## Empty Args: Operate Hub

When `$ARGUMENTS` is empty (and not first-run), show the Operate & observe hub. Render a cheap status strip, then use `AskUserQuestion` as the native menu shell. The strip gives at-a-glance OS state; the menu routes into existing operate surfaces over the dispatch table above. Menu navigation is native (~=0 model tokens); the full HUD is one click away (or type `/4ge os`).

### HUD strip

Render one deterministic line before the menu (the cheap strip, not the full dashboard):

1. If `_runs/os/boot-status.json` exists, read `_runs/os/boot-status.json` and `_runs/os/health.json`, merge into `{ ...bootStatus, health: healthJson }`, then pipe to `node plugins/4ge/bin/hud-engine.cjs --mode=strip`.
2. If the OS files are missing, print `OS not booted` and continue to the menu.

### Menu round 1

Call `AskUserQuestion` with one question:

```text
question: "What in the OS?"
header: "4ge OS"
options:
- Show OS status (full HUD) (Recommended): render the full HUD per Render Instructions above (--mode=full).
- Health & infra: Docker health, AISLE security, or dialect status.
- HUD & studio: HUD toggle/config, studio mode, or substrate render.
- Trust & stats: trust level, telemetry stats, or session wins.
```

### Menu round 2a (only if "Health & infra")

```text
question: "Health & infra?"
header: "Health"
options:
- Infra health (Recommended): route to /infra.
- AISLE security: route to /aisle.
- Dialect status: run /4ge status.
```

### Menu round 2b (only if "HUD & studio")

```text
question: "HUD & studio?"
header: "Display"
options:
- HUD toggle/config (Recommended): route to /hud.
- Studio mode: route to /studio.
- Substrate render: route to /substrate.
```

### Menu round 2c (only if "Trust & stats")

```text
question: "Trust & stats?"
header: "Status"
options:
- Trust level (Recommended): run /4ge trust.
- Telemetry stats: run /4ge stats.
- Session wins: run /4ge wins.
```

After a selection, dispatch exactly as if the operator had typed the direct command/subcommand. The menu is a router over the existing dispatch table, not a new implementation path; preserve direct-command semantics. Do not ask extra confirmation when the selected action is unambiguous.
