'use strict';
/**
 * hud-state-clear.cjs — Stop hook.
 *
 * Marks the HUD as idle when Claude finishes a turn. This freezes orb
 * breathing + shimmer + color wave so subsequent statusLine polls produce
 * byte-stable output and CC's renderer skips repaints. On mobile terminals
 * (Termius) this stops the scroll-bounce that buries response text.
 *
 * Defensive: even if this hook never fires (crash, kill -9), the active
 * flag carries a TTL and falls back to idle automatically. This hook just
 * makes the transition immediate instead of TTL-delayed.
 *
 * Fail-safe: exits 0 on any error. Never blocks Stop event.
 */

const path = require('path');
const { readStdinJson } = require('./hook-utils.cjs');

const _pluginRoot = process.env.CLAUDE_PLUGIN_DATA || process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');

(async () => {
  try {
    const payload = await readStdinJson();
    const cwd = (payload && payload.cwd) || process.cwd();
    const hudState = require(path.join(_pluginRoot, 'lib', 'hud-active-flag.cjs'));
    hudState.setIdle(cwd);
  } catch { /* best-effort — never block */ }
  process.exit(0);
})();
