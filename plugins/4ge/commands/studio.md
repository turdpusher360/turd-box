---
description: "Activate Studio Mode — full HUD engine + reactive hooks + badge tracking"
argument-hint: "[on|off|status]"
paths: ["**"]
---

# /studio

Studio Mode activation. One command loads the full HUD terminal experience.

Parse $ARGUMENTS:
- `on` or empty: Activate studio mode
- `off`: Deactivate studio mode
- `status`: Show current studio mode state

## Activation (`on`)

1. **Check badges**: Run badge check to see current earned state
2. **Render full HUD**: Pipe current OS state through `hud-engine.cjs --mode=full`
3. **Show badge progress**: Display earned/locked badges
4. **Set environment marker**: Write `_runs/os/studio-mode.json` with `{ active: true, activatedAt: ISO }`
5. **Show activation message**: "Studio mode active. Anvil is watching. Reactive HUD enabled."

Build and pipe state to the engine:

```javascript
// Read current OS state
const bootStatus = require('fs').existsSync('_runs/os/boot-status.json')
  ? JSON.parse(require('fs').readFileSync('_runs/os/boot-status.json', 'utf8'))
  : {};
const health = require('fs').existsSync('_runs/os/health.json')
  ? JSON.parse(require('fs').readFileSync('_runs/os/health.json', 'utf8'))
  : {};

// Read badge state
const { getBadgeState, checkBadges } = require('${CLAUDE_PLUGIN_ROOT}/lib/badge-tracker.cjs');
const badgeResult = checkBadges({}, { dryRun: false });

// Build full state and pipe to engine
const state = {
  os: {
    overallHealth: bootStatus.overall || 'ready',
    bootTime: bootStatus.total_boot_ms || 0,
    capabilities: Object.assign({}, bootStatus.capabilities || {}, health),
  },
  badges: badgeResult.badgeState,
  memory: {
    lastSession: 'Studio mode activated',
    next: 'Full HUD experience loaded',
  },
  context: { trigger: 'studio', event: 'boot' },
  terminal: { cols: process.stdout.columns || 80, rows: process.stdout.rows || 30 },
};
```

Run: `echo '<state-json>' | node plugins/4ge/bin/hud-engine.cjs --mode=full`

Display the engine output verbatim.

## Deactivation (`off`)

1. Remove `_runs/os/studio-mode.json`
2. Show: "Studio mode deactivated."

## Status

Read `_runs/os/studio-mode.json`. Show:

```
  Studio Mode   {active/inactive}
  Activated     {timestamp or '--'}
  Badges        {earned}/{total}
  Zones         {count} active
  Expression    {current expression name}
```

## Badge Check

If studio activation earns the `studio-mode` badge (requires `zone-builder` + `companion-v2`), display:

```
  ★ NEW: studio-mode earned
```
