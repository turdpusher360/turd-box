'use strict';

const { colorize } = require('./hud-palette.cjs');
const { sparkline } = require('../lib/substrate-render.cjs');

// --- Zone Metadata ---
const RATE_META = { key: 'rate', priority: 10, minRows: 1, idealRows: 2 };

// --- Visibility Predicate ---
// Zone appears only when any rate limit tier exceeds 80%.
function rateVisible(state) {
  const rl = state.session && state.session.rateLimits;
  if (!rl || rl === 'N/A' || typeof rl !== 'object') return false;
  return (rl.fiveHour > 80 || rl.sevenDay > 80);
}

function rateHistoryValues(session, key) {
  const history = session && Array.isArray(session.rateLimitHistory)
    ? session.rateLimitHistory
    : [];
  return history
    .map((sample) => sample && Number(sample[key]))
    .filter((value) => Number.isFinite(value));
}

function rateLimitTiers(session) {
  const rl = (session && session.rateLimits) || {};
  return [
    { key: 'fiveHour', name: '5-hour', pct: rl.fiveHour || 0 },
    { key: 'sevenDay', name: '7-day', pct: rl.sevenDay || 0 },
  ].sort((a, b) => b.pct - a.pct);
}

function worstRateTrend(session) {
  const worst = rateLimitTiers(session)[0];
  const pct = Math.round(worst.pct);
  const role = pct > 95 ? 'error' : 'warn';
  const history = rateHistoryValues(session, worst.key).slice(-24);
  return { worst, pct, role, history };
}

function renderRateTrend(session, palette, width = 8) {
  const { pct, role, history } = worstRateTrend(session);
  if (history.length < 2) return '';
  return colorize(palette, 'muted', 'rate trend ')
    + colorize(palette, role, `${pct}% `)
    + colorize(palette, role, sparkline(history, width));
}

function renderRateLimitCompact(state, palette) {
  if (!rateVisible(state)) return [];
  const trend = renderRateTrend((state && state.session) || {}, palette, 8);
  return trend ? [`  ${trend}`] : [];
}

// --- Renderer ---
function renderRateLimitZone(state, palette) {
  const session = state.session || {};
  const { worst, pct, role, history } = worstRateTrend(session);

  const barWidth = 16;
  const filled = Math.round((pct / 100) * barWidth);
  const bar = colorize(palette, role, '\u2588'.repeat(filled))
    + colorize(palette, 'muted', '\u2500'.repeat(barWidth - filled));

  const label = colorize(palette, role, `rate limit ${pct}%`);
  const tierName = colorize(palette, 'muted', worst.name);
  const trend = history.length >= 2
    ? colorize(palette, 'muted', ' trend ') + colorize(palette, role, sparkline(history, 8))
    : '';

  return [
    `  ${label} ${tierName}`,
    `  ${bar}${trend}`,
  ];
}

module.exports = {
  renderRateLimitZone,
  renderRateLimitCompact,
  RATE_META,
  rateVisible,
  rateHistoryValues,
  rateLimitTiers,
  worstRateTrend,
  renderRateTrend,
};
