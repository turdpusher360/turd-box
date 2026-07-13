'use strict';

// hud-zone-board.cjs — the lead-authored board zone.
//
// Renders the board the lead pushed via `hud-board.cjs set`. The board is loaded
// off disk by hud-data-loader.cjs into `state.board`; this zone is PURE — it reads
// only `state.board` and returns string[] (Zone Interface Contract §4.3). The
// hud-data-loader already validated the schema + freshness, but this zone re-checks
// freshness defensively so a hand-built or slightly-stale state still fails invisible.

const { colorize, stripAnsi } = require('./hud-palette.cjs');
const { levelRole, isFresh, ageMs } = require('../lib/hud-board-store.cjs');

// priority 7: below the always-on essentials (face 10, rate 10, context 9,
// health 8) so the board never displaces them, above every other zone so a
// lead-pushed board shows prominently when present.
const ZONE_META = { key: 'board', priority: 7, minRows: 1, idealRows: 5 };

// Per-level glyph for quick visual scanning of a body line.
const LEVEL_GLYPH = { info: '·', ok: '✓', warn: '!', alert: '▲', accent: '▸' };

// Title-row marker.
const BOARD_MARK = '▐'; // ▐

function boardFromState(state) {
  return (state && state.board && typeof state.board === 'object') ? state.board : null;
}

// Visibility predicate: a fresh board with at least one line exists.
function boardVisible(state, now = Date.now()) {
  const board = boardFromState(state);
  return !!(board && Array.isArray(board.lines) && board.lines.length > 0 && isFresh(board, now));
}

function fmtAge(ms) {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

function truncate(text, max) {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + '…';
}

// renderBoardZone(state, palette, opts)
//   opts.maxRows — hard cap on emitted rows (statusline budget). default Infinity.
//   opts.gutter  — left indent string. default '  ' (matches composite zones).
//   opts.now     — injectable clock (tests).
// Returns string[]. Title row (marker + title + age) then body rows (level glyph +
// text). When body lines overflow the budget, the last slot becomes a "+N more"
// indicator (unless the budget is too tight to spare one).
function renderBoardZone(state, palette, opts = {}) {
  const now = opts.now || Date.now();
  const board = boardFromState(state);
  if (!board || !Array.isArray(board.lines) || board.lines.length === 0) return [];
  if (!isFresh(board, now)) return [];

  const gutter = typeof opts.gutter === 'string' ? opts.gutter : '  ';
  const maxRows = Number.isFinite(opts.maxRows) ? opts.maxRows : Infinity;
  if (maxRows <= 0) return [];
  const cols = (state && state.terminal && state.terminal.cols) || 79;

  const rows = [];

  // Title row: marker + title + age tag.
  const ageTag = colorize(palette, 'muted', ` (${fmtAge(ageMs(board, now))})`);
  const titleBudget = Math.max(6, cols - gutter.length - 2 - stripAnsi(ageTag).length);
  const titleText = truncate(board.title || 'BOARD', titleBudget);
  rows.push(gutter + colorize(palette, 'accent', `${BOARD_MARK} ${titleText}`) + ageTag);

  // Body budget = remaining rows after the title. Reserve one slot for the
  // "+N more" indicator only when there is room to spare AND lines overflow.
  const bodyBudget = maxRows === Infinity ? board.lines.length : Math.max(0, maxRows - 1);
  let showN;
  let more;
  if (board.lines.length <= bodyBudget) {
    showN = board.lines.length;
    more = 0;
  } else if (bodyBudget <= 1) {
    showN = bodyBudget; // too tight for an indicator — just show what fits
    more = 0;
  } else {
    showN = bodyBudget - 1;
    more = board.lines.length - showN;
  }

  const lineBudget = Math.max(6, cols - gutter.length - 2);
  for (let i = 0; i < showN; i++) {
    const line = board.lines[i];
    const glyph = LEVEL_GLYPH[line.level] || LEVEL_GLYPH.info;
    rows.push(gutter + colorize(palette, levelRole(line.level), `${glyph} ${truncate(line.text, lineBudget)}`));
  }
  if (more > 0) {
    rows.push(gutter + colorize(palette, 'muted', `… +${more} more`));
  }

  return maxRows === Infinity ? rows : rows.slice(0, maxRows);
}

module.exports = { renderBoardZone, ZONE_META, boardVisible, LEVEL_GLYPH, BOARD_MARK };
