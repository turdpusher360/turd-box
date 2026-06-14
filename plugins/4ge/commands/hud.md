---
description: "Toggle, configure, or route the OS HUD surfaces."
argument-hint: "[off | on | status | setup | remove | theme <name> | face calm|lively|ok | zen [on|off] | messages all|major|off | dwell <seconds> | gemini | pane | substrate]"
paths: ["_runs/os/**", ".4ge/**"]
---

Parse $ARGUMENTS:
- If empty: show status
- If `1`-`5`: report that numbered HUD views were retired; use `/4ge os`, `/4ge os health`, or `/4ge os scene`
- If `off`: mark HUD idle by running `node -e "require('${CLAUDE_PLUGIN_ROOT}/lib/hud-active-flag.cjs').setIdle(process.cwd())"`
- If `on`: mark HUD active by running `node -e "require('${CLAUDE_PLUGIN_ROOT}/lib/hud-active-flag.cjs').setActive(process.cwd())"`
- If `status`: show current HUD configuration
- If `setup`: install the statusline HUD into this project (see Statusline setup below)
- If `remove`: remove the statusline HUD from this project (see Statusline removal below)
- If `face calm|lively|ok`: set companion face motion (see Companion settings below)
- If `zen [on|off]`: toggle zen quiet mode (see Companion settings below)
- If `messages all|major|off`: set companion message verbosity (see Companion settings below)
- If `dwell <seconds>`: set the non-critical message cooldown (see Companion settings below)
- If `gemini`: show the source-only Gemini/Antigravity statusline adapter snippet (see Gemini adapter below)
- If `pane`: show the source-only tmux pane launcher snippet (see Tmux pane below)
- If `substrate`: show the source-only substrate engine snippet (see Substrate mode below)
- If `theme <name>`: set the HUD theme. Valid names: `forge`, `dark-ansi`, `tokyonight-dark`, `plain`, `catppuccin-mocha`, `dracula`, `nord`. Run: `node -e "require('${CLAUDE_PLUGIN_ROOT}/bin/hud-palette.cjs').setTheme('<name>')"` and confirm the result. Theme is persisted by `setTheme()` — do NOT write theme to `hud-view.json`.

Do not write `_runs/os/hud-view.json`; the current HUD engine does not read it.

## Companion settings (`face` / `zen` / `messages` / `dwell`)

These write the `companion` block of `<project>/.4ge/config.json` via the read-merge-write writer (`bin/companion-config-writer.cjs`) — it preserves every other top-level key (`setupComplete`, `tier`, `version`, `hooks`). They take effect within the 10s config cache TTL; no session restart. Every companion-setting write also stamps the update-ack (`bin/companion-ack.cjs`) so the "settings may have changed" notice stays silent until the next plugin version bump.

`.4ge/config.json` is a project data file — it is NOT under the `.claude/` config gate, so these writes are direct (no consent prompt required), but always confirmed with a one-line echo.

- `face calm` → calm steady eyes (default). Run:
  ```bash
  node -e "const w=require('${CLAUDE_PLUGIN_ROOT}/bin/companion-config-writer.cjs');const a=require('${CLAUDE_PLUGIN_ROOT}/bin/companion-ack.cjs');w.setCompanionKeys({faceMotion:false},{projectRoot:process.cwd()});a.ackVersion();console.log('HUD: face calm');"
  ```
- `face lively` → per-tool eye motion (the thinking/exhausted glyph swap). Run:
  ```bash
  node -e "const w=require('${CLAUDE_PLUGIN_ROOT}/bin/companion-config-writer.cjs');const a=require('${CLAUDE_PLUGIN_ROOT}/bin/companion-ack.cjs');w.setCompanionKeys({faceMotion:true},{projectRoot:process.cwd()});a.ackVersion();console.log('HUD: face lively');"
  ```
- `face ok` → acknowledge the update notice WITHOUT changing settings (keeps your current face). Run:
  ```bash
  node -e "require('${CLAUDE_PLUGIN_ROOT}/bin/companion-ack.cjs').ackVersion();console.log('HUD: settings acknowledged');"
  ```
- `zen on` (or bare `zen`) → quiet mode: calm idle, MAJOR-only messages, face motion off. Run:
  ```bash
  node -e "const w=require('${CLAUDE_PLUGIN_ROOT}/bin/companion-config-writer.cjs');const a=require('${CLAUDE_PLUGIN_ROOT}/bin/companion-ack.cjs');w.setCompanionKeys({zen:true},{projectRoot:process.cwd()});a.ackVersion();console.log('HUD: zen on');"
  ```
- `zen off` → restore your individual settings (zen is a single short-circuit flag — toggling off does NOT clobber your other knobs). Run:
  ```bash
  node -e "const w=require('${CLAUDE_PLUGIN_ROOT}/bin/companion-config-writer.cjs');const a=require('${CLAUDE_PLUGIN_ROOT}/bin/companion-ack.cjs');w.setCompanionKeys({zen:false},{projectRoot:process.cwd()});a.ackVersion();console.log('HUD: zen off');"
  ```
- `messages all|major|off` → message verbosity. `off` suppresses all companion text bubbles (the face still reacts); `major` only commit/test/error/rate-limit; `all` is the default. Run (substitute `<level>`):
  ```bash
  node -e "const w=require('${CLAUDE_PLUGIN_ROOT}/bin/companion-config-writer.cjs');const a=require('${CLAUDE_PLUGIN_ROOT}/bin/companion-ack.cjs');w.setCompanionKeys({messages:'<level>'},{projectRoot:process.cwd()});a.ackVersion();console.log('HUD: messages <level>');"
  ```
- `dwell <seconds>` → minimum seconds between non-critical messages (clamped 0-600). Run (substitute `<seconds>`):
  ```bash
  node -e "const w=require('${CLAUDE_PLUGIN_ROOT}/bin/companion-config-writer.cjs');const a=require('${CLAUDE_PLUGIN_ROOT}/bin/companion-ack.cjs');w.setCompanionKeys({messageCooldownS:<seconds>},{projectRoot:process.cwd()});a.ackVersion();console.log('HUD: dwell <seconds>s');"
  ```

After any companion-setting write, echo the effective value by reading it back: `node -e "console.log(JSON.stringify(require('${CLAUDE_PLUGIN_ROOT}/bin/companion-config.cjs').loadCompanionConfig(process.cwd())))"` is available if the user wants to confirm clamping.

## Gemini adapter (`gemini`)

If `gemini`: report the current adapter path and show the exact Antigravity/Gemini statusline snippet for manual installation:

```json
{
  "statusLine": {
    "command": "node \"${CLAUDE_PLUGIN_ROOT}/bin/hud-gemini-adapter.cjs\"",
    "enabled": true
  }
}
```

Verify the adapter file exists before showing the snippet:

```bash
ls "${CLAUDE_PLUGIN_ROOT}/bin/hud-gemini-adapter.cjs"
```

Do not write Gemini settings automatically. Do not edit `~/.gemini/antigravity-cli/settings.json` from this command. Tell the operator this is source-only guidance and that manual install/restart is required in the Gemini/Antigravity CLI.

## Tmux pane (`pane`)

If `pane`: report the current launcher path and show the exact command the operator can run from inside an existing tmux session:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/bin/hud-tmux-launch.sh"
```

Verify the launcher file exists before showing the command:

```bash
ls "${CLAUDE_PLUGIN_ROOT}/bin/hud-tmux-launch.sh"
```

Do not launch tmux automatically. Do not start a long-running pane from this command. Tell the operator this is source-only guidance and that the launcher must be run manually from the shell.

## Substrate mode (`substrate`)

If `substrate`: report that substrate is an engine render mode and show the exact command the operator can run manually:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/hud-engine.cjs" --mode=substrate --max-rows=10
```

Verify the engine and substrate zone files exist before showing the command:

```bash
ls "${CLAUDE_PLUGIN_ROOT}/bin/hud-engine.cjs"
ls "${CLAUDE_PLUGIN_ROOT}/bin/hud-zone-substrate.cjs"
```

Do not run it automatically. Do not install, launch, watch, or write config from this command. Tell the operator this is source-only guidance and that the output is a response-text-safe Unicode substrate render.

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

Confirm changes with one line: `HUD: active`, `HUD: idle`, `HUD: theme set to <name>`, `HUD: statusline installed`, `HUD: statusline removed`, `HUD: face calm`, `HUD: face lively`, `HUD: settings acknowledged`, `HUD: zen on`, `HUD: zen off`, `HUD: messages <level>`, `HUD: dwell <seconds>s`, `HUD: gemini adapter snippet shown`, `HUD: tmux pane launcher shown`, `HUD: substrate snippet shown`, or `HUD: numbered views retired`.
