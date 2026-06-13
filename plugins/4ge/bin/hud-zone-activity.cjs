'use strict';

const { colorize } = require('./hud-palette.cjs');

// --- Zone Metadata ---
// Lowest priority — only shows when transcript data is available and space permits.
const ZONE_META = { key: 'activity', priority: 1, minRows: 2, idealRows: 4 };

// --- Visibility Predicate ---
// Zone appears only when transcript data with recent events is available.
function activityVisible(state) {
  const t = state.transcript;
  if (!t || typeof t !== 'object') return false;
  const events = t.recentEvents;
  return Array.isArray(events) && events.length > 0;
}

// --- Renderer ---
// Shows recent tool calls with ok/error icons and optional timing.
function renderActivityZone(state, palette) {
  const lines = [];
  const t = state.transcript || {};
  const events = Array.isArray(t.recentEvents) ? t.recentEvents : [];
  const cols = (state.terminal && state.terminal.cols) || 79;

  // Header with aggregate counts
  const totalCalls = t.toolCallsTotal || 0;
  const totalErrors = t.toolErrorsTotal || 0;
  const errRate = totalCalls > 0 ? Math.round((totalErrors / totalCalls) * 100) : 0;
  const errColor = errRate > 10 ? 'error' : errRate > 0 ? 'warn' : 'ok';
  lines.push(
    '  ' +
    colorize(palette, 'muted', 'Activity') + ' ' +
    colorize(palette, 'text', String(totalCalls)) + ' ' +
    colorize(palette, 'muted', 'calls') +
    (totalErrors > 0 ? ' ' + colorize(palette, errColor, String(totalErrors) + ' err') : '')
  );

  // Recent events — show the last N that fit (up to idealRows - 1 for header)
  const maxEvents = Math.min(events.length, (ZONE_META.idealRows - 1));
  const recent = events.slice(-maxEvents);
  const maxSummaryLen = Math.max(20, cols - 28); // leave room for icon + name + padding

  for (const ev of recent) {
    if (ev.kind === 'tool_use') {
      const icon = colorize(palette, 'accent', '\u2192'); // →
      const name = colorize(palette, 'text', String(ev.name || '').slice(0, 14).padEnd(14));
      const summary = colorize(palette, 'muted', String(ev.summary || '').slice(0, maxSummaryLen));
      lines.push(`  ${icon} ${name} ${summary}`);
    } else if (ev.kind === 'tool_result') {
      const icon = ev.error
        ? colorize(palette, 'error', '\u2717') // x
        : colorize(palette, 'ok', '\u2713'); // checkmark
      const label = colorize(palette, 'muted', 'result'.padEnd(14));
      const summary = colorize(palette, ev.error ? 'error' : 'muted', String(ev.summary || '').slice(0, maxSummaryLen));
      lines.push(`  ${icon} ${label} ${summary}`);
    }
  }

  if (lines.length === 0) {
    lines.push('  ' + colorize(palette, 'muted', 'No activity'));
  }

  return lines;
}

module.exports = { renderActivityZone, ZONE_META, activityVisible };
