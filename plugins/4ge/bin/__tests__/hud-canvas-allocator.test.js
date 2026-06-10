import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

function requireFresh() {
  for (const key of Object.keys(_require.cache)) {
    if (key.includes('hud-canvas') || key.includes('hud-palette')) {
      delete _require.cache[key];
    }
  }
  return _require(path.resolve(__dirname, '../hud-canvas.cjs'));
}

describe('createCanvas', () => {
  it('creates canvas with correct dimensions', () => {
    const { createCanvas } = requireFresh();
    const palette = { bg: '\x1b[40m', reset: '\x1b[0m' };
    const canvas = createCanvas(5, 40, palette);
    expect(canvas.height).toBe(5);
    expect(canvas.width).toBe(40);
    expect(canvas.rows.length).toBe(5);
  });

  it('fills rows with bg-colored spaces', () => {
    const { createCanvas, stripAnsi } = requireFresh();
    const palette = { bg: '\x1b[40m', reset: '\x1b[0m' };
    const canvas = createCanvas(3, 20, palette);
    for (const row of canvas.rows) {
      expect(stripAnsi(row).length).toBe(20);
    }
  });

  it('works without palette', () => {
    const { createCanvas } = requireFresh();
    const canvas = createCanvas(2, 10, null);
    expect(canvas.rows.length).toBe(2);
    expect(canvas.rows[0].length).toBe(10);
  });
});

describe('paintRow', () => {
  it('replaces a canvas row with content', () => {
    const { createCanvas, paintRow, stripAnsi } = requireFresh();
    const palette = { bg: '\x1b[40m', reset: '\x1b[0m' };
    const canvas = createCanvas(3, 40, palette);
    paintRow(canvas, 1, 'hello world', palette);
    expect(stripAnsi(canvas.rows[1])).toContain('hello world');
  });

  it('pads content to canvas width', () => {
    const { createCanvas, paintRow, stripAnsi } = requireFresh();
    const palette = { bg: '', reset: '' };
    const canvas = createCanvas(2, 20, palette);
    paintRow(canvas, 0, 'short', palette);
    expect(stripAnsi(canvas.rows[0]).length).toBe(20);
  });

  it('ignores out-of-bounds row index', () => {
    const { createCanvas, paintRow } = requireFresh();
    const palette = { bg: '', reset: '' };
    const canvas = createCanvas(2, 10, palette);
    const original = [...canvas.rows];
    paintRow(canvas, 5, 'out of bounds', palette);
    expect(canvas.rows).toEqual(original);
  });

  it('ignores negative row index', () => {
    const { createCanvas, paintRow } = requireFresh();
    const palette = { bg: '', reset: '' };
    const canvas = createCanvas(2, 10, palette);
    const original = [...canvas.rows];
    paintRow(canvas, -1, 'negative', palette);
    expect(canvas.rows).toEqual(original);
  });
});

describe('paintRows', () => {
  it('paints multiple rows starting at offset', () => {
    const { createCanvas, paintRows, stripAnsi } = requireFresh();
    const palette = { bg: '', reset: '' };
    const canvas = createCanvas(5, 30, palette);
    paintRows(canvas, 1, ['line A', 'line B', 'line C'], palette);
    expect(stripAnsi(canvas.rows[1])).toContain('line A');
    expect(stripAnsi(canvas.rows[2])).toContain('line B');
    expect(stripAnsi(canvas.rows[3])).toContain('line C');
  });

  it('clips lines beyond canvas height', () => {
    const { createCanvas, paintRows, stripAnsi } = requireFresh();
    const palette = { bg: '', reset: '' };
    const canvas = createCanvas(3, 20, palette);
    paintRows(canvas, 1, ['a', 'b', 'c', 'd', 'e'], palette);
    // Only 2 lines should be painted (rows 1 and 2)
    expect(stripAnsi(canvas.rows[1])).toContain('a');
    expect(stripAnsi(canvas.rows[2])).toContain('b');
  });
});

describe('allocateVerticalZones', () => {
  it('allocates minRows to high-priority zones first', () => {
    const { allocateVerticalZones } = requireFresh();
    const zones = [
      { key: 'a', priority: 10, minRows: 2, idealRows: 4 },
      { key: 'b', priority: 5, minRows: 1, idealRows: 3 },
      { key: 'c', priority: 1, minRows: 1, idealRows: 2 },
    ];
    const result = allocateVerticalZones(zones, 4);
    const a = result.find(r => r.key === 'a');
    const b = result.find(r => r.key === 'b');
    const c = result.find(r => r.key === 'c');
    expect(a.dropped).toBe(false);
    expect(a.rows).toBeGreaterThanOrEqual(2);
    expect(b.dropped).toBe(false);
    expect(c.dropped).toBe(false);
  });

  it('drops low-priority zones when space is tight', () => {
    const { allocateVerticalZones } = requireFresh();
    const zones = [
      { key: 'high', priority: 10, minRows: 3, idealRows: 5 },
      { key: 'low', priority: 1, minRows: 3, idealRows: 4 },
    ];
    const result = allocateVerticalZones(zones, 4);
    const high = result.find(r => r.key === 'high');
    const low = result.find(r => r.key === 'low');
    expect(high.dropped).toBe(false);
    expect(low.dropped).toBe(true);
  });

  it('distributes surplus toward idealRows', () => {
    const { allocateVerticalZones } = requireFresh();
    const zones = [
      { key: 'a', priority: 10, minRows: 1, idealRows: 4 },
      { key: 'b', priority: 5, minRows: 1, idealRows: 2 },
    ];
    const result = allocateVerticalZones(zones, 10);
    const a = result.find(r => r.key === 'a');
    const b = result.find(r => r.key === 'b');
    expect(a.rows).toBe(4); // gets idealRows
    expect(b.rows).toBe(2); // gets idealRows
  });

  it('preserves visual order (declaration order)', () => {
    const { allocateVerticalZones } = requireFresh();
    const zones = [
      { key: 'first', priority: 1, minRows: 1, idealRows: 2 },
      { key: 'second', priority: 10, minRows: 1, idealRows: 2 },
    ];
    const result = allocateVerticalZones(zones, 10);
    const firstIdx = result.findIndex(r => r.key === 'first');
    const secondIdx = result.findIndex(r => r.key === 'second');
    expect(firstIdx).toBeLessThan(secondIdx);
  });

  it('zones with minRows 0 drop first', () => {
    const { allocateVerticalZones } = requireFresh();
    const zones = [
      { key: 'required', priority: 5, minRows: 2, idealRows: 3 },
      { key: 'optional', priority: 3, minRows: 0, idealRows: 4 },
    ];
    const result = allocateVerticalZones(zones, 2);
    const req = result.find(r => r.key === 'required');
    const opt = result.find(r => r.key === 'optional');
    expect(req.dropped).toBe(false);
    expect(opt.rows).toBe(0);
  });
});

describe('render', () => {
  it('joins canvas rows with newlines', () => {
    const { createCanvas, render } = requireFresh();
    const canvas = createCanvas(3, 5, null);
    const output = render(canvas);
    expect(output.split('\n').length).toBe(3);
  });
});
