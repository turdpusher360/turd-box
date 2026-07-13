import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);
const { renderBoardZone, boardVisible, ZONE_META, LEVEL_GLYPH } =
  _require(path.resolve(__dirname, '../hud-zone-board.cjs'));

// Plain palette so assertions run on raw text.
const PLAIN = { ok: '', warn: '', error: '', accent: '', muted: '', text: '', reset: '' };

const NOW = 1_700_000_000_000;

function board(overrides = {}) {
  return {
    v: 1,
    title: 'Status',
    lines: [
      { level: 'ok', text: 'alpha' },
      { level: 'warn', text: 'beta' },
      { level: 'info', text: 'gamma' },
    ],
    ttlSec: 900,
    createdAt: NOW - 5000, // 5s old
    priority: null,
    ...overrides,
  };
}

function stateWith(b, cols = 120) {
  return { terminal: { cols }, board: b };
}

describe('hud-zone-board — ZONE_META', () => {
  it('priority is 7 (below face/rate/context/health, above the rest)', () => {
    expect(ZONE_META.priority).toBe(7);
  });
  it('has numeric minRows / idealRows', () => {
    expect(typeof ZONE_META.minRows).toBe('number');
    expect(typeof ZONE_META.idealRows).toBe('number');
  });
});

describe('hud-zone-board — boardVisible', () => {
  it('true for a fresh board with lines', () => {
    expect(boardVisible(stateWith(board()), NOW)).toBe(true);
  });
  it('false when no board present', () => {
    expect(boardVisible(stateWith(null), NOW)).toBe(false);
    expect(boardVisible({ terminal: { cols: 80 } }, NOW)).toBe(false);
  });
  it('false when the board has no lines', () => {
    expect(boardVisible(stateWith(board({ lines: [] })), NOW)).toBe(false);
  });
  it('false when the board has expired (defensive re-check)', () => {
    const expired = board({ createdAt: NOW - 1_000_000, ttlSec: 10 });
    expect(boardVisible(stateWith(expired), NOW)).toBe(false);
  });
});

describe('hud-zone-board — renderBoardZone', () => {
  it('returns [] when no board is present', () => {
    expect(renderBoardZone(stateWith(null), PLAIN, { now: NOW })).toEqual([]);
  });

  it('returns [] when the board has expired', () => {
    const expired = board({ createdAt: NOW - 1_000_000, ttlSec: 10 });
    expect(renderBoardZone(stateWith(expired), PLAIN, { now: NOW })).toEqual([]);
  });

  it('first row carries the title and an age indicator', () => {
    const rows = renderBoardZone(stateWith(board()), PLAIN, { now: NOW });
    expect(rows[0]).toContain('Status');
    expect(rows[0]).toContain('5s'); // 5 seconds old
  });

  it('renders one body row per line with a level glyph', () => {
    const rows = renderBoardZone(stateWith(board()), PLAIN, { now: NOW });
    const body = rows.slice(1).join('\n');
    expect(body).toContain('alpha');
    expect(body).toContain('beta');
    expect(body).toContain('gamma');
    expect(body).toContain(LEVEL_GLYPH.ok);
    expect(body).toContain(LEVEL_GLYPH.warn);
  });

  it('row count = title + one per line when budget is ample', () => {
    const b = board();
    const rows = renderBoardZone(stateWith(b), PLAIN, { now: NOW });
    expect(rows.length).toBe(1 + b.lines.length);
  });

  it('truncates a long line with an ellipsis at narrow width', () => {
    const b = board({ lines: [{ level: 'info', text: 'x'.repeat(300) }] });
    const rows = renderBoardZone(stateWith(b, 40), PLAIN, { now: NOW });
    const bodyLen = rows[1].replace(/^\s+/, '').length;
    expect(bodyLen).toBeLessThan(300);
    expect(rows[1]).toContain('…');
  });

  it('respects maxRows and shows a "+N more" indicator on overflow', () => {
    const b = board({
      lines: Array.from({ length: 6 }, (_, i) => ({ level: 'info', text: `line ${i}` })),
    });
    const rows = renderBoardZone(stateWith(b), PLAIN, { now: NOW, maxRows: 4 });
    expect(rows.length).toBeLessThanOrEqual(4);
    expect(rows[rows.length - 1]).toContain('more');
  });

  it('shows every line and no "+N more" when maxRows is unbounded (composite)', () => {
    const b = board({
      lines: Array.from({ length: 6 }, (_, i) => ({ level: 'info', text: `line ${i}` })),
    });
    const rows = renderBoardZone(stateWith(b), PLAIN, { now: NOW });
    expect(rows.length).toBe(1 + 6);
    expect(rows.join('\n')).not.toContain('more');
  });

  it('returns [] for a maxRows budget of 0', () => {
    expect(renderBoardZone(stateWith(board()), PLAIN, { now: NOW, maxRows: 0 })).toEqual([]);
  });
});
