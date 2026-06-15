'use strict';

const { colorize, stripAnsi } = require('./hud-palette.cjs');
const { sparkline } = require('../lib/substrate-render.cjs');

const ZONE_META = { priority: 9, minRows: 1, idealRows: 3 };
const SUB_BLOCKS = [' ', '\u258F', '\u258E', '\u258D', '\u258C', '\u258B', '\u258A', '\u2589', '\u2588'];

function fmtTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'k';
  return String(n);
}

function renderTokenBreakdown(state, palette, barWidth) {
  const { session } = state;
  const input = session.inputTokens || 0;
  const output = session.outputTokens || 0;
  const cache = (session.cacheReadTokens || 0) + (session.cacheCreationTokens || 0);
  const remaining = session.remainingTokens || 0;
  const total = input + output + cache + remaining;
  if (total <= 0) return '';
  const segments = [['accent', input], ['ok', output], ['muted', cache]];
  let bar = '';
  let usedCols = 0;
  for (const [role, tokens] of segments) {
    if (usedCols >= barWidth) break;
    const exactCols = (tokens / total) * barWidth;
    const fullBlocks = Math.min(Math.floor(exactCols), barWidth - usedCols);
    const fraction = exactCols - Math.floor(exactCols);
    const subIdx = Math.round(fraction * 8);
    let segStr = '\u2588'.repeat(fullBlocks);
    if (subIdx > 0 && usedCols + fullBlocks < barWidth) segStr += SUB_BLOCKS[subIdx];
    bar += colorize(palette, role, segStr);
    usedCols += fullBlocks + (subIdx > 0 && usedCols + fullBlocks < barWidth ? 1 : 0);
  }
  const freeCount = barWidth - stripAnsi(bar).length;
  if (freeCount > 0) bar += ' '.repeat(freeCount);
  const legend = colorize(palette, 'muted', 'in:') + colorize(palette, 'accent', fmtTokens(input))
    + colorize(palette, 'muted', '  out:') + colorize(palette, 'ok', fmtTokens(output))
    + colorize(palette, 'muted', '  cache:') + colorize(palette, 'muted', fmtTokens(cache));
  return bar + '  ' + legend;
}

function renderBar(pct, width, palette, warnThreshold) {
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  const color = pct >= warnThreshold ? 'warn' : 'ok';
  return colorize(palette, color, '\u2588'.repeat(filled)) + colorize(palette, 'muted', '\u2591'.repeat(empty));
}

function coerceContextHistory(session) {
  const candidates = [
    session.contextPctHistory,
    session.contextHistory,
    session.context && session.context.pctHistory,
    session.context && session.context.history,
  ];
  const raw = candidates.find((value) => Array.isArray(value));
  if (!raw) return [];
  return raw
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .map((value) => Math.max(0, Math.min(100, value)));
}

function renderContextTrend(session, palette, opts = {}) {
  const values = coerceContextHistory(session);
  if (values.length < 2) return '';
  const recent = values.slice(-24);
  const line = sparkline(recent, 18);
  const latest = recent[recent.length - 1];
  const role = latest >= 40 ? 'warn' : 'ok';
  const parts = [
    '  ',
    colorize(palette, 'muted', 'ctx trend '),
    colorize(palette, role, line),
  ];
  if (opts.withMetric) {
    // Trajectory the header's bare `ctx: N%` lacks: current % + net direction
    // across the visible window (▲ climbing / ▼ easing / ▸ flat). Arrow is
    // window-slope (first vs last sample) so a single-sample dip won't flip it.
    const first = recent[0];
    const arrow = latest > first ? '▲' : latest < first ? '▼' : '▸';
    parts.push(
      colorize(palette, 'muted', ' '),
      colorize(palette, role, `${Math.round(latest)}%`),
      colorize(palette, 'muted', ` ${arrow}`),
    );
  }
  return parts.join('');
}

function renderContextCompact(state, palette) {
  const trend = renderContextTrend((state && state.session) || {}, palette, { withMetric: true });
  return trend ? [trend] : [];
}

// Map model name/id to a semantic color role.
// Opus = accent (brightest — high-capability), Sonnet = text (neutral), Haiku = muted (lightweight).
function resolveModelColor(model) {
  if (!model) return 'text';
  const m = model.toLowerCase();
  if (m.includes('opus'))   return 'accent';
  if (m.includes('haiku'))  return 'muted';
  return 'text';
}

function renderContextZone(state, palette) {
  const { session } = state;
  // Prefer full modelId for color resolution; fall back to short model label
  const modelId = session.modelId || session.model || 'unknown';
  const model = session.model || 'unknown';
  const modelColor = resolveModelColor(modelId);
  const ctx = Math.round(session.contextPct || 0);
  const ctxLabel = session.contextLabel ? ` ${session.contextLabel}` : '';
  const ctxBar = renderBar(ctx, 16, palette, 40);
  const ctxColor = ctx >= 40 ? 'warn' : 'text';
  // Show absolute remaining tokens when available (e.g., "45% 550K left" vs just "45%")
  const remaining = session.remainingTokens;
  const remLabel = remaining > 0 ? ` ${fmtTokens(remaining)} left` : '';
  const sessionNumber = session.sessionNumber || 0;
  const sessionPart = sessionNumber > 0
    ? [colorize(palette, 'muted', ' \u00B7 '), colorize(palette, 'accent', `S${sessionNumber}`)]
    : [];
  const parts = ['  ', colorize(palette, modelColor, model), ...sessionPart, colorize(palette, 'muted', '   ctx: '),
    colorize(palette, ctxColor, `${ctx}%${ctxLabel}`),
    remLabel ? colorize(palette, 'muted', remLabel) : '',
    '  ', ctxBar, colorize(palette, 'muted', ' | ')];
  if (session.rateLimits === 'N/A') {
    parts.push(colorize(palette, 'muted', 'rate: '), colorize(palette, 'muted', '--'));
  } else {
    const rate5h = Math.round((session.rateLimits && session.rateLimits.fiveHour) || 0);
    const rateBar = renderBar(rate5h, 10, palette, 70);
    const rateColor = rate5h >= 70 ? 'warn' : 'text';
    parts.push(colorize(palette, 'muted', 'rate: '), colorize(palette, rateColor, `${rate5h}%`), '  ', rateBar);
    // Countdown when rate-limited
    const resetsAt = session.rateLimits && (session.rateLimits.fiveHourResetsAt || session.rateLimits.sevenDayResetsAt);
    if (rate5h >= 80 && resetsAt) {
      const ms = new Date(resetsAt).getTime() - Date.now();
      if (ms > 0) {
        const min = Math.ceil(ms / 60000);
        const label = min > 60 ? `${Math.round(min / 60)}h` : `${min}m`;
        parts.push(' ', colorize(palette, 'muted', `resets ${label}`));
      }
    }
  }
  const lines = [parts.join('')];
  if (session.inputTokens && session.inputTokens > 0) {
    lines.push('  ' + renderTokenBreakdown(state, palette, 40));
  }
  const trend = renderContextTrend(session, palette);
  if (trend) lines.push(trend);
  return lines;
}

module.exports = {
  renderContextZone,
  renderBar,
  renderTokenBreakdown,
  fmtTokens,
  ZONE_META,
  resolveModelColor,
  coerceContextHistory,
  renderContextTrend,
  renderContextCompact,
};
