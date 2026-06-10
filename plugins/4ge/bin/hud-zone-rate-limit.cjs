'use strict';

const { colorize, stripAnsi, RESET } = require('./hud-palette.cjs');

// --- Zone Metadata ---
const RATE_META = { key: 'rate', priority: 10, minRows: 1, idealRows: 2 };

// --- Visibility Predicate ---
// Zone appears only when any rate limit tier exceeds 80%.
function rateVisible(state) {
  const rl = state.session && state.session.rateLimits;
  if (!rl || rl === 'N/A' || typeof rl !== 'object') return false;
  return (rl.fiveHour > 80 || rl.sevenDay > 80);
}

// --- Renderer ---
function renderRateLimitZone(state, palette) {
  const rl = state.session.rateLimits || {};
  const tiers = [
    { name: '5-hour', pct: rl.fiveHour || 0 },
    { name: '7-day', pct: rl.sevenDay || 0 },
  ].sort((a, b) => b.pct - a.pct);

  const worst = tiers[0];
  const pct = Math.round(worst.pct);
  const role = pct > 95 ? 'error' : 'warn';

  const barWidth = 16;
  const filled = Math.round((pct / 100) * barWidth);
  const bar = colorize(palette, role, '\u2588'.repeat(filled))
    + colorize(palette, 'muted', '\u2500'.repeat(barWidth - filled));

  const label = colorize(palette, role, `rate limit ${pct}%`);
  const tierName = colorize(palette, 'muted', worst.name);

  return [
    `  ${label} ${tierName}`,
    `  ${bar}`,
  ];
}

module.exports = { renderRateLimitZone, RATE_META, rateVisible };
