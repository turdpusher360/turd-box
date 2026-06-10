---
description: "Toggle or configure the OS HUD pane."
argument-hint: "[off | on | status | setup | remove | theme <name>]"
paths: ["_runs/os/**"]
---

Parse $ARGUMENTS:
- If empty: show status
- If `1`-`5`: report that numbered HUD views were retired; use `/4ge os`, `/4ge os health`, or `/4ge os scene`
- If `off`: mark HUD idle by running `node -e "require('${CLAUDE_PLUGIN_ROOT}/lib/hud-active-flag.cjs').setIdle(process.cwd())"`
- If `on`: mark HUD active by running `node -e "require('${CLAUDE_PLUGIN_ROOT}/lib/hud-active-flag.cjs').setActive(process.cwd())"`
- If `status`: show current HUD configuration
- If `setup`: install the statusline HUD into this project (see Statusline setup below)
- If `remove`: remove the statusline HUD from this project (see Statusline removal below)
- If `theme <name>`: set the HUD theme. Valid names: `forge`, `dark-ansi`, `tokyonight-dark`, `plain`, `catppuccin-mocha`, `dracula`, `nord`. Run: `node -e "require('${CLAUDE_PLUGIN_ROOT}/bin/hud-palette.cjs').setTheme('<name>')"` and confirm the result. Theme is persisted by `setTheme()` — do NOT write theme to `hud-view.json`.

Do not write `_runs/os/hud-view.json`; the current HUD engine does not read it.

## Statusline setup (`setup`)

Plugins cannot set the statusline declaratively — it is a `settings.json` key, and `${CLAUDE_PLUGIN_ROOT}` is NOT expanded inside `statusLine.command`. Setup therefore writes a resolved absolute path, with explicit user consent:

1. Read `.claude/settings.json` in the project root (treat a missing file as `{}`). If a `statusLine` key already exists, STOP and report: `HUD: statusline already configured — run /4ge:hud remove first to replace it.` Never overwrite someone's existing statusline.
2. Resolve the engine path: prefer `${CLAUDE_PLUGIN_DATA}/bin/hud-engine.cjs` (stable across plugin version bumps — this is why it is preferred); fall back to `${CLAUDE_PLUGIN_ROOT}/bin/hud-engine.cjs`. Verify the chosen file exists with `ls` before proceeding. If using the PLUGIN_ROOT fallback, warn that the path rotates on plugin updates and `setup` should be re-run after a version bump.
3. Show the user the EXACT JSON you will add and ask for confirmation before writing:
   ```json
   {
     "statusLine": {
       "type": "command",
       "command": "node \"<resolved-absolute-path>/bin/hud-engine.cjs\" --mode=statusline --max-rows=8",
       "refreshInterval": 2
     }
   }
   ```
4. On consent, merge the key into `.claude/settings.json` preserving all existing content (read, modify the parsed object, write back pretty-printed). If the write is refused by a project gate (some projects block `.claude/` writes), report the JSON block and ask the user to add it manually.
5. Confirm: `HUD: statusline installed — restart the session to see it.`

## Statusline removal (`remove`)

1. Read `.claude/settings.json`; if no `statusLine` key exists, report `HUD: no statusline configured` and stop.
2. If the existing `statusLine.command` does NOT reference `hud-engine.cjs`, STOP and report that a non-4ge statusline is configured — do not delete someone else's statusline.
3. After explicit confirmation, delete the `statusLine` key, preserving the rest of the file. Confirm: `HUD: statusline removed.`

Confirm changes with one line: `HUD: active`, `HUD: idle`, `HUD: theme set to <name>`, `HUD: statusline installed`, `HUD: statusline removed`, or `HUD: numbered views retired`.
