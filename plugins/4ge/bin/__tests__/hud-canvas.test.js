import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);
const MODULE_PATH = path.resolve(__dirname, '../hud-canvas.cjs');

function requireFresh() {
  for (const key of Object.keys(_require.cache)) {
    if (key.includes('hud-canvas') || key.includes('hud-palette')) {
      delete _require.cache[key];
    }
  }
  return _require(MODULE_PATH);
}

describe('createCanvas', () => {
  it('creates a canvas with the specified dimensions', () => {
    const { createCanvas } = requireFresh();
    const palette = { bg: '\x1b[40m', reset: '\x1b[0m' };
    const canvas = createCanvas(5, 80, palette);
    expect(canvas.rows).toHaveLength(5);
    expect(canvas.width).toBe(80);
    expect(canvas.height).toBe(5);
  });

  it('fills every row with bg-colored content', () => {
    const { createCanvas, stripAnsi } = requireFresh();
    const palette = { bg: '\x1b[40m', reset: '\x1b[0m' };
    const canvas = createCanvas(3, 40, palette);
    for (const row of canvas.rows) {
      // Each row contains ANSI content — not empty
      expect(row.length).toBeGreaterThan(0);
      // Visible content is spaces (fill)
      const visible = stripAnsi(row);
      expect(visible).toBe(' '.repeat(40));
    }
  });

  it('fills with plain spaces when palette bg is empty', () => {
    const { createCanvas } = requireFresh();
    const palette = { bg: '', reset: '' };
    const canvas = createCanvas(2, 20, palette);
    for (const row of canvas.rows) {
      expect(row).toBe(' '.repeat(20));
    }
  });
});

describe('paintRow', () => {
  it('replaces a row with content', () => {
    const { createCanvas, paintRow, stripAnsi } = requireFresh();
    const palette = { bg: '\x1b[40m', reset: '\x1b[0m' };
    const canvas = createCanvas(3, 40, palette);
    paintRow(canvas, 1, 'Hello World');
    expect(stripAnsi(canvas.rows[1])).toContain('Hello World');
  });

  it('ignores out-of-bounds row indices', () => {
    const { createCanvas, paintRow } = requireFresh();
    const palette = { bg: '\x1b[40m', reset: '\x1b[0m' };
    const canvas = createCanvas(3, 40, palette);
    // Should not throw
    paintRow(canvas, -1, 'bad');
    paintRow(canvas, 99, 'bad');
    expect(canvas.rows).toHaveLength(3);
  });
});

describe('paintRows', () => {
  it('paints multiple rows starting from an offset', () => {
    const { createCanvas, paintRows, stripAnsi } = requireFresh();
    const palette = { bg: '\x1b[40m', reset: '\x1b[0m' };
    const canvas = createCanvas(5, 40, palette);
    paintRows(canvas, 1, ['Line A', 'Line B', 'Line C']);
    expect(stripAnsi(canvas.rows[1])).toContain('Line A');
    expect(stripAnsi(canvas.rows[2])).toContain('Line B');
    expect(stripAnsi(canvas.rows[3])).toContain('Line C');
  });

  it('clips lines that exceed canvas height', () => {
    const { createCanvas, paintRows } = requireFresh();
    const palette = { bg: '\x1b[40m', reset: '\x1b[0m' };
    const canvas = createCanvas(2, 40, palette);
    paintRows(canvas, 0, ['A', 'B', 'C', 'D']);
    expect(canvas.rows).toHaveLength(2);
  });
});

describe('allocateVerticalZones', () => {
  it('allocates rows by priority, highest first', () => {
    const { allocateVerticalZones } = requireFresh();
    const zones = [
      { key: 'face', priority: 10, minRows: 1, idealRows: 3 },
      { key: 'health', priority: 8, minRows: 1, idealRows: 1 },
      { key: 'caps', priority: 6, minRows: 2, idealRows: 6 },
    ];
    const alloc = allocateVerticalZones(zones, 10);
    // All zones fit: 3 + 1 + 6 = 10
    const face = alloc.find(a => a.key === 'face');
    const health = alloc.find(a => a.key === 'health');
    const caps = alloc.find(a => a.key === 'caps');
    expect(face.rows).toBe(3);
    expect(health.rows).toBe(1);
    expect(caps.rows).toBe(6);
    expect(face.dropped).toBe(false);
  });

  it('drops lowest-priority zone when space is tight', () => {
    const { allocateVerticalZones } = requireFresh();
    const zones = [
      { key: 'face', priority: 10, minRows: 3, idealRows: 3 },
      { key: 'health', priority: 8, minRows: 1, idealRows: 1 },
      { key: 'caps', priority: 6, minRows: 4, idealRows: 6 },
    ];
    // Only 5 rows available: face(3) + health(1) = 4, caps(4) would make 8. Caps dropped.
    const alloc = allocateVerticalZones(zones, 5);
    const caps = alloc.find(a => a.key === 'caps');
    expect(caps.dropped).toBe(true);
  });

  it('assigns startRow offsets sequentially', () => {
    const { allocateVerticalZones } = requireFresh();
    const zones = [
      { key: 'face', priority: 10, minRows: 2, idealRows: 2 },
      { key: 'health', priority: 8, minRows: 1, idealRows: 1 },
    ];
    const alloc = allocateVerticalZones(zones, 10);
    const face = alloc.find(a => a.key === 'face');
    const health = alloc.find(a => a.key === 'health');
    expect(face.startRow).toBe(0);
    expect(health.startRow).toBe(2);
  });
});

describe('render', () => {
  it('joins rows with newlines', () => {
    const { createCanvas, render } = requireFresh();
    const palette = { bg: '\x1b[40m', reset: '\x1b[0m' };
    const canvas = createCanvas(3, 20, palette);
    const output = render(canvas);
    const lines = output.split('\n');
    expect(lines).toHaveLength(3);
  });
});
