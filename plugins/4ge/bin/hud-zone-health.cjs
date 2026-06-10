'use strict';

const { colorize, stripAnsi } = require('./hud-palette.cjs');

const BRAILLE_FILLS = [
  '\u2800', '\u2801', '\u2803', '\u2807', '\u280F', '\u281F', '\u28FF',
];
const SUBBLOCK_FILLS = [' ', '\u258F', '\u258E', '\u258D', '\u258C', '\u258B', '\u258A', '\u2589', '\u2588'];

function capMarker(ok, palette) {
  if (ok === true) return colorize(palette, 'ok', '\u25CF');
  if (ok === false) return colorize(palette, 'error', '\u25CF');
  return colorize(palette, 'warn', '\u25CF');
}

function computeHealthScore(caps) {
  const entries = Object.values(caps || {});
  if (entries.length === 0) return 0;
  const ready = entries.filter(c => c && c.ok).length;
  return Math.round((ready / entries.length) * 100);
}

function gradeForScore(score) {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 55) return 'C';
  if (score >= 35) return 'D';
  return 'F';
}

function renderHealthBar(score, barWidth, palette) {
  const fill = Math.round(score / 100 * barWidth);
  const bar = '='.repeat(fill) + '-'.repeat(barWidth - fill);
  const colorRole = score >= 75 ? 'ok' : score >= 35 ? 'warn' : 'error';
  return colorize(palette, colorRole, `[${bar}]`);
}

function renderBrailleGauge(score, barCells, palette) {
  const filled = (score / 100) * barCells;
  const fullCells = Math.floor(filled);
  const partial = filled - fullCells;
  const maxIdx = BRAILLE_FILLS.length - 1;
  let bar = BRAILLE_FILLS[maxIdx].repeat(fullCells);
  if (fullCells < barCells) {
    bar += BRAILLE_FILLS[Math.round(partial * maxIdx)];
    bar += BRAILLE_FILLS[0].repeat(barCells - fullCells - 1);
  }
  const colorRole = score >= 75 ? 'ok' : score >= 35 ? 'warn' : 'error';
  return colorize(palette, colorRole, bar);
}

function renderSubBlockBar(ms, barCells, maxMs, palette) {
  const ratio = Math.min(1, ms / maxMs);
  const filled = ratio * barCells;
  const fullCells = Math.floor(filled);
  const partial = filled - fullCells;
  let bar = SUBBLOCK_FILLS[8].repeat(fullCells);
  if (fullCells < barCells) {
    bar += SUBBLOCK_FILLS[Math.round(partial * 8)];
    bar += ' '.repeat(barCells - fullCells - 1);
  }
  const colorRole = ms < 100 ? 'ok' : ms < 250 ? 'warn' : 'error';
  return colorize(palette, colorRole, bar);
}

function renderHealthZone(state, palette, opts) {
  const detailed = !!(opts && opts.detailed);
  const caps = (state.os && state.os.capabilities) || {};
  const rows = (state.terminal && state.terminal.rows) || 24;
  const cols = (state.terminal && state.terminal.cols) || 79;
  const score = computeHealthScore(caps);
  const grade = gradeForScore(score);

  if (rows < 12) {
    const barWidth = Math.min(60, Math.max(10, Math.floor((cols - 25) * 0.5)));
    const bar = renderHealthBar(score, barWidth, palette);
    const scoreStr = colorize(palette, 'text', String(score));
    const gradeStr = colorize(palette, score >= 75 ? 'ok' : score >= 35 ? 'warn' : 'error', grade);
    return [`  ${colorize(palette, 'muted', 'Health:')} ${scoreStr}  ${gradeStr}  ${bar}`];
  }

  const capEntries = Object.entries(caps);
  const lines = [];

  if (capEntries.length > 0) {
    const markerRow = capEntries
      .map(([name, cap]) => {
        const ok = cap && cap.ok === true ? true : cap && cap.ok === false ? false : null;
        return capMarker(ok, palette) + ' ' + colorize(palette, 'muted', name.slice(0, 7));
      })
      .join(' ');
    lines.push('  ' + markerRow);
  }

  const brailleBar = renderBrailleGauge(score, 24, palette);
  const scoreStr = colorize(palette, 'text', String(score).padStart(3));
  const gradeStr = colorize(palette, score >= 75 ? 'ok' : score >= 35 ? 'warn' : 'error', grade);
  lines.push(`  ${colorize(palette, 'muted', 'Health:')} ${scoreStr}  ${gradeStr}  ${brailleBar}`);

  // Restraint: the per-capability boot-timing histogram + boot summary are
  // detail-only (shown by `/4ge os health`). The glance HUD keeps just the dot status
  // + grade + braille gauge above.
  if (detailed) {
    const bootCaps = capEntries.filter(([, cap]) => cap && cap.init_ms > 0);
    for (const [name, cap] of bootCaps) {
      const label = name.slice(0, 10).padEnd(10);
      const bar = renderSubBlockBar(cap.init_ms, 16, 500, palette);
      const msStr = colorize(palette, 'muted', `${cap.init_ms}ms`);
      lines.push(`  ${colorize(palette, 'muted', label)} ${bar} ${msStr}`);
    }

    const bootTime = (state.os && state.os.bootTime) || 0;
    const okCount = capEntries.filter(([, c]) => c && c.ok === true).length;
    const failCount = capEntries.filter(([, c]) => c && c.ok === false).length;
    const warnCount = capEntries.length - okCount - failCount;
    const fp = [];
    if (bootTime > 0) fp.push(`boot ${bootTime}ms`);
    fp.push(`ok:${okCount}  warn:${warnCount}  fail:${failCount}`);
    lines.push('  ' + colorize(palette, 'muted', fp.join('  ')));
  }

  return lines;
}

const ZONE_META = { key: 'health', priority: 8, minRows: 1, idealRows: 8 };

module.exports = {
  computeHealthScore, gradeForScore, renderHealthBar,
  renderBrailleGauge, renderSubBlockBar, capMarker,
  renderHealthZone, ZONE_META,
};
