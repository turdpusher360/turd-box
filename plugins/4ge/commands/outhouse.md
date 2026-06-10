---
description: "Repository maintenance hub: health wizard, fix-collector, evolve, lint, blueprint, wizard suite. Use /outhouse for the menu or /outhouse --quick for a fast score."
argument-hint: "[--quick | --auto-safe | --report | --dry-run | (empty for menu) | ...]"
paths: ["plugins/4ge/**", ".claude/**", "_runs/**"]
---

## /outhouse -- Repository Maintenance Hub

**If `$ARGUMENTS` is empty, show the Guided Maintenance Hub menu (bottom of this file) -- do not run a full scan blindly.** If any flag is present, run the maintenance wizard directly (below).

Parse $ARGUMENTS for flags (all optional, can combine):
- `--quick`: score-only mode (no triage, no fixes)
- `--ci`: CI mode (JSON output, exit code reflects score)
- `--auto-safe`: unattended mode (apply auto-tier fixes without prompting)
- `--preflight`: pre-commit check mode
- `--report`: generate full report to _runs/
- `--dry-run`: show what would change without applying
- `--show-suppressed`: include suppressed findings in output
- `--research-depth <quick|standard|deep>`: control research thoroughness
- `--category <name>`: scan only the named category

Before producing any output, read `${CLAUDE_PLUGIN_ROOT}/skills/wizard-engine/references/output-format.md` for formatting rules.

Invoke the wizard-engine skill with mode=outhouse and all parsed flags. Do not output any intermediate text before the skill activates.

---

## Empty Args: Guided Maintenance Hub

When `$ARGUMENTS` is empty, do not run a full scan blindly. Render a cheap status strip, then use `AskUserQuestion` as the native menu shell. The menu routes into existing maintenance capabilities -- it adds discoverability, not a new implementation path. Menu navigation is native (~=0 model tokens); the model is spent only on the leaf the operator selects.

### HUD strip

Render one deterministic line before the menu. Do not summarize or reinterpret it.

1. If `_runs/os/boot-status.json` exists, read `_runs/os/boot-status.json` and `_runs/os/health.json`, merge them into `{ ...bootStatus, health: healthJson }`, then pipe the JSON to:

```bash
node plugins/4ge/bin/hud-engine.cjs --mode=strip
```

2. If the OS files are missing, print `Forge OS: not booted` and continue to the menu.

### Menu round 1

Call `AskUserQuestion` with one question:

```text
question: "What maintenance?"
header: "Outhouse"
options:
- Run the health wizard (Recommended): invoke the wizard-engine skill with
  mode=outhouse (full scan + triage + fix menu).
- Capture an issue: route to /fix.
- Evolve config: route to /evolve.
- More tools: lint rules, blueprint, or wizard suite.
```

### Menu round 2 (only if "More tools")

```text
question: "Which tool?"
header: "Tools"
options:
- Lint rule follow-through (Recommended): route to /lint.
- Blueprint setup/update: route to /blueprint.
- Wizard suite: route to /wizard.
- Quick score: run /outhouse --quick.
```

After a selection, dispatch exactly as if the operator had typed the direct command. For "Run the health wizard", invoke the wizard-engine skill with mode=outhouse. The menu is a router, not a new implementation path; preserve direct-command semantics. Do not ask extra confirmation when the selected action is unambiguous.
