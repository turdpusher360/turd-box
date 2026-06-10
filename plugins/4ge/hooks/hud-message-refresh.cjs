'use strict';
/**
 * hud-message-refresh.cjs — UserPromptSubmit hook.
 *
 * Refreshes the active companion message's timestamp so the TTL doesn't
 * expire while the user is typing or has the slash-command palette open.
 *
 * Rationale: palette-open isn't a hook event in CC, but UserPromptSubmit
 * fires whenever the user submits anything (including slash commands).
 * By refreshing on every submit, we effectively pause decay during any
 * user interaction. Important messages (signal/critical tier) therefore
 * survive palette sessions and get read.
 *
 * Fail-safe: exits 0 on any error. Never blocks prompt submission.
 */

const { readStdinJson } = require('./hook-utils.cjs');
const path = require('path');

const _pluginRoot = process.env.CLAUDE_PLUGIN_DATA || process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');

(async () => {
  try {
    // Drain stdin so the harness doesn't complain about unread input
    const payload = await readStdinJson();
    const cwd = (payload && payload.cwd) || process.cwd();

    const cs = require(path.join(_pluginRoot, 'bin', 'companion-state.cjs'));
    if (typeof cs.refreshMessage === 'function') {
      cs.refreshMessage();
    }

    // Mark session active so the HUD's time-based animations (breath, shimmer,
    // color wave) can run. Flag is cleared on Stop or by TTL expiry — whichever
    // fires first. Default TTL is intentionally short; statusline polls should
    // freeze quickly after the last tool/prompt event.
    try {
      const flag = require(path.join(_pluginRoot, 'lib', 'hud-active-flag.cjs'));
      flag.setActive(cwd);
    } catch { /* best-effort */ }
  } catch { /* best-effort — never block */ }
  process.exit(0);
})();
