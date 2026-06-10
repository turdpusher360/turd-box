'use strict';

const { assignGrade, classifyCategory } = require('./wizard-scoring.cjs');

// ── ANSI color helpers ──────────────────────────────────────────────

const ESC = '\x1b[';
const RESET = `${ESC}0m`;

const COLORS = {
  dim: `${ESC}2m`,
  bold: `${ESC}1m`,
  green: `${ESC}38;5;65m`,
  greenBright: `${ESC}38;5;46m`,
  yellow: `${ESC}38;5;172m`,
  red: `${ESC}38;5;167m`,
  blue: `${ESC}38;5;24m`,
  cream: `${ESC}38;5;223m`,
  gray: `${ESC}38;5;241m`,
  bgDark: `${ESC}48;5;234m`,
  barFill: `${ESC}38;5;65m`,
  barEmpty: `${ESC}38;5;238m`,
};

let _colorEnabled = true;

function setColorEnabled(enabled) { _colorEnabled = enabled; }
function isColorEnabled() { return _colorEnabled; }

function c(color, text) {
  if (!_colorEnabled) return text;
  return `${COLORS[color] || ''}${text}${RESET}`;
}

function gradeColor(grade) {
  if (grade === 'A') return 'green';
  if (grade === 'B') return 'green';
  if (grade === 'C') return 'yellow';
  return 'red'; // D, F
}

function statusColor(status) {
  if (status === 'PASS') return 'green';
  if (status === 'WARN') return 'yellow';
  return 'red'; // FAIL
}

// ── Bar rendering ───────────────────────────────────────────────────

/**
 * Render a fixed-width fill bar using block elements.
 * Plain mode: = and - characters.
 * Color mode: block elements with status-aware color.
 * @param {string} [fillColor] - ANSI color name for the filled portion
 */
function renderBar(score, maxScore, width = 20, fillColor) {
  if (maxScore <= 0 || typeof score !== 'number') {
    return _colorEnabled
      ? c('barEmpty', '░'.repeat(width))
      : '-'.repeat(width);
  }

  const clamped = Math.max(0, Math.min(maxScore, score));
  const filled = Math.round((clamped / maxScore) * width);

  if (!_colorEnabled) {
    return '='.repeat(filled) + '-'.repeat(width - filled);
  }

  const color = fillColor || 'barFill';
  const filledStr = '▓'.repeat(filled);
  const emptyStr = '░'.repeat(width - filled);
  return c(color, filledStr) + c('barEmpty', emptyStr);
}

/**
 * Format the single-line health indicator.
 */
function formatScoreBar(score, grade, delta) {
  const deltaStr = delta !== undefined
    ? `  (${delta >= 0 ? '+' : ''}${delta})`
    : '';

  if (!_colorEnabled) {
    const bar = renderBar(score, 100, 20);
    return `Health: ${score}  ${grade}  [${bar}]${deltaStr}`;
  }

  const gc = gradeColor(grade);
  const coloredBar = renderBar(score, 100, 20, gc);
  return `  ${c('gray', 'Health:')} ${c('cream', String(score))}  ${c(gc, grade)}  ${coloredBar}${deltaStr ? c('gray', deltaStr) : ''}`;
}

/**
 * Format a category dashboard row with fixed-width columns.
 */
function formatCategoryRow(name, score, grade, status, findingCount) {
  if (!_colorEnabled) {
    const paddedName = name.padEnd(15);
    const scoreStr = String(score).padStart(2) + '/20';
    const statusStr = status.padEnd(4);
    const plainBar = renderBar(score, 20, 20);
    const findings = findingCount > 0 ? `${findingCount} findings` : '';
    return `  ${paddedName} ${scoreStr}  ${grade}  ${statusStr}  [${plainBar}]  ${findings}`;
  }

  const gc = gradeColor(grade);
  const sc = statusColor(status);
  const coloredBar = renderBar(score, 20, 20, sc);
  const paddedName = name.padEnd(15);
  const scoreStr = String(score).padStart(2) + '/20';
  const statusStr = status.padEnd(4);
  const findings = findingCount > 0 ? c('gray', `${findingCount} findings`) : '';

  return `  ${c(sc === 'green' ? 'gray' : sc, paddedName)} ${c('cream', scoreStr)}  ${c(gc, grade)}  ${c(sc, statusStr)}  ${coloredBar}  ${findings}`;
}

/**
 * Format an individual finding row.
 */
function formatFindingRow(num, tag, description, tier, confidence) {
  const numStr = String(num).padStart(3);

  if (!_colorEnabled) {
    const tagStr = `[${tag}]`.padEnd(15);
    return `  ${numStr}. ${tagStr}  ${description} (${tier})  ${confidence.toFixed(2).padStart(4)}`;
  }

  const tagColor = tag === 'recommended' ? 'green' : tag === 'suggested' ? 'yellow' : 'gray';
  const tagStr = `[${tag}]`.padEnd(15);
  return `  ${c('gray', numStr + '.')} ${c(tagColor, tagStr)}  ${description} ${c('gray', `(${tier})`)}  ${c('gray', confidence.toFixed(2))}`;
}

/**
 * Format a delta card showing changed categories only.
 */
function formatDeltaCard(deltaResult) {
  const lines = [];
  const changed = Object.entries(deltaResult.categories);

  if (changed.length > 0) {
    lines.push(_colorEnabled
      ? `  ${c('gray', 'Category         Before  After  Delta')}`
      : '  Category         Before  After  Delta');

    for (const [name, delta] of changed) {
      const arrow = delta.delta >= 0 ? '+' : '';
      const deltaColor = delta.delta > 0 ? 'green' : delta.delta < 0 ? 'red' : 'gray';
      const deltaText = `${arrow}${delta.delta}`;

      if (_colorEnabled) {
        lines.push(`  ${c('cream', name.padEnd(16))} ${c('gray', String(delta.before).padStart(2) + '/20')}   ${c('cream', String(delta.after).padStart(2) + '/20')}   ${c(deltaColor, deltaText)}`);
      } else {
        lines.push(`  ${name.padEnd(16)} ${String(delta.before).padStart(2)}/20   ${String(delta.after).padStart(2)}/20   ${deltaText}`);
      }
    }
  } else {
    lines.push('  No category changes.');
  }

  lines.push('');

  const dColor = deltaResult.delta >= 0 ? 'green' : 'red';
  const arrow = deltaResult.delta >= 0 ? '+' : '';
  if (_colorEnabled) {
    lines.push(`  ${c('gray', 'Overall')}  ${deltaResult.overallBefore} -> ${c('cream', String(deltaResult.overallAfter))}  ${c(dColor, `(${arrow}${deltaResult.delta})`)}  Grade ${c(gradeColor(deltaResult.gradeBefore), deltaResult.gradeBefore)} -> ${c(gradeColor(deltaResult.gradeAfter), deltaResult.gradeAfter)}`);
  } else {
    lines.push(`  Overall  ${deltaResult.overallBefore} -> ${deltaResult.overallAfter}  (${arrow}${deltaResult.delta})  Grade ${deltaResult.gradeBefore} -> ${deltaResult.gradeAfter}`);
  }

  return lines.join('\n');
}

/**
 * Format a progress indicator line.
 */
function formatProgressLine(verb, current, total, name, detail) {
  const detailStr = detail ? ` (${detail})` : '';
  if (!_colorEnabled) {
    return `  ${verb} [${current}/${total}] ${name}${detailStr} ...`;
  }
  return `  ${c('cream', verb)} ${c('gray', `[${current}/${total}]`)} ${name}${detailStr ? c('gray', detailStr) : ''} ${c('gray', '...')}`;
}

// ── Quick report ────────────────────────────────────────────────────

/**
 * Render a complete --quick report from a ScanResult.
 * Combines score bar, category rows, inbox summary, and data freshness.
 */
function renderQuickReport(scanResult) {
  const lines = [];
  const { categories, overall, inbox, stale, aisle } = scanResult;

  // Score bar
  lines.push(formatScoreBar(overall.weighted, overall.grade));
  lines.push('');

  // Category rows sorted by score ascending (worst first)
  const sorted = Object.entries(categories)
    .filter(([, cat]) => !cat.skipped)
    .sort((a, b) => a[1].raw - b[1].raw);

  for (const [name, cat] of sorted) {
    const grade = assignGrade(cat.raw / 20 * 100);
    const status = classifyCategory(cat.raw);
    const findingCount = (cat.deductions || []).length;
    lines.push(formatCategoryRow(name, cat.raw, grade, status, findingCount));
  }

  // Inbox summary
  if (inbox && inbox.total > 0) {
    lines.push('');
    const catBreakdown = Object.entries(inbox.categories)
      .map(([cat, count]) => `${count} ${cat}`)
      .join(', ');
    if (_colorEnabled) {
      lines.push(`  ${c('gray', 'Inbox:')} ${c('cream', String(inbox.total))} ${c('gray', `open items (${catBreakdown})`)}`);
    } else {
      lines.push(`  Inbox: ${inbox.total} open items (${catBreakdown})`);
    }
  }

  // Data freshness
  if (stale && stale.length > 0) {
    if (_colorEnabled) {
      lines.push(`  ${c('gray', `Stale data: ${stale.length} domains older than 7 days`)}`);
    } else {
      lines.push(`  Stale data: ${stale.length} domains older than 7 days`);
    }
  }

  // AISLE health
  if (aisle) {
    const scannerCount = aisle.scanners ? aisle.scanners.length : 0;
    const healthy = aisle.healthy;
    if (_colorEnabled) {
      const label = healthy ? c('green', 'healthy') : c('yellow', 'degraded');
      lines.push(`  ${c('gray', 'AISLE:')} ${c('gray', String(scannerCount) + ' scanners,')} ${label}`);
    } else {
      const label = healthy ? 'healthy' : 'degraded';
      lines.push(`  AISLE: ${scannerCount} scanners, ${label}`);
    }
  }

  return lines.join('\n');
}

module.exports = {
  renderBar,
  formatScoreBar,
  formatCategoryRow,
  formatFindingRow,
  formatDeltaCard,
  formatProgressLine,
  renderQuickReport,
  setColorEnabled,
  isColorEnabled,
};
