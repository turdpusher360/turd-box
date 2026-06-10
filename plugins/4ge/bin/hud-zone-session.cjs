'use strict';

const { colorize } = require('./hud-palette.cjs');

// --- Zone Metadata ---
// Low priority — only shows at session end or when space permits
const ZONE_META = { priority: 1, minRows: 1, idealRows: 4 };

// --- Zone Renderer ---
// Session summary: last session context, parked work, next action.
//
// This is the BOTTOM zone of the HUD panel. Per the vertical gradient spec
// (docs/superpowers/specs/2026-04-08-hud-color-vertical-gradient.md), the
// bottommost zone uses the brightest palette role: `glow`. The forge theme
// maps glow to ANSI index 230 (hot cream); other themes fall glow back to
// text. Do NOT replace `glow` with `text` here — the session zone is the
// brightness anchor for the whole panel and future drift would invert the
// gradient.
function renderSessionZone(state, palette) {
  const lines = [];
  const session = state.session || {};
  const memory = state.memory || {};

  // Last session recall
  if (memory.lastSession) {
    lines.push('  ' +
      colorize(palette, 'muted', 'Last session:') + ' ' +
      colorize(palette, 'glow', memory.lastSession));
  }

  // Parked forge session
  if (memory.parked) {
    lines.push('  ' +
      colorize(palette, 'muted', 'Parked:') + ' ' +
      colorize(palette, 'glow', memory.parked));
  }

  // Next action
  if (memory.next) {
    lines.push('  ' +
      colorize(palette, 'muted', 'Next:') + ' ' +
      colorize(palette, 'glow', memory.next));
  }

  // Session stats (when available)
  if (session.uptime > 0) {
    const mins = Math.floor(session.uptime / 60000);
    const hrs = Math.floor(mins / 60);
    const remMins = mins % 60;
    const duration = hrs > 0 ? `${hrs}h ${remMins}m` : `${mins}m`;
    lines.push('  ' +
      colorize(palette, 'muted', 'Uptime:') + ' ' +
      colorize(palette, 'glow', duration));
  }

  if (lines.length === 0) {
    lines.push('  ' + colorize(palette, 'muted', 'No session history loaded'));
  }

  return lines;
}

module.exports = { renderSessionZone, ZONE_META };
