import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

function requireFresh() {
  const resolved = _require.resolve(path.resolve(__dirname, '../eye-engine.cjs'));
  delete _require.cache[resolved];
  return _require(resolved);
}

describe('constants', () => {
  it('has expected grid dimensions', () => {
    const eye = requireFresh();
    expect(eye.EYE_W).toBe(15);
    expect(eye.EYE_H).toBe(12);
    expect(eye.EYE_GAP).toBe(3);
    expect(eye.DEFAULT_COLOR).toBe(24);
  });

  it('BASE_EYE is 12x15 grid', () => {
    const eye = requireFresh();
    expect(eye.BASE_EYE.length).toBe(12);
    expect(eye.BASE_EYE[0].length).toBe(15);
  });

  it('BASE_EYE is a filled ellipse (center row fully on)', () => {
    const eye = requireFresh();
    const midRow = eye.BASE_EYE[6];
    expect(midRow.every(v => v === 1)).toBe(true);
  });

  it('BASE_EYE corners are empty', () => {
    const eye = requireFresh();
    expect(eye.BASE_EYE[0][0]).toBe(0);
    expect(eye.BASE_EYE[0][14]).toBe(0);
    expect(eye.BASE_EYE[11][0]).toBe(0);
    expect(eye.BASE_EYE[11][14]).toBe(0);
  });
});

describe('lid generators', () => {
  it('flat returns uniform array', () => {
    const { flat, EYE_W } = requireFresh();
    const lid = flat(5);
    expect(lid.length).toBe(EYE_W);
    expect(lid.every(v => v === 5)).toBe(true);
  });

  it('tilt interpolates linearly', () => {
    const { tilt, EYE_W } = requireFresh();
    const lid = tilt(0, 14);
    expect(lid[0]).toBe(0);
    expect(lid[EYE_W - 1]).toBe(14);
    expect(lid[7]).toBeCloseTo(7, 0);
  });

  it('arch peaks at center', () => {
    const { arch, EYE_W } = requireFresh();
    const lid = arch(10, -2);
    expect(lid[0]).toBe(10);
    expect(lid[EYE_W - 1]).toBe(10);
    expect(lid[7]).toBe(8); // 10 + (-2) * (1 - 0) = 8
  });
});

describe('applyLids', () => {
  it('masks top rows', () => {
    const { applyLids, flat } = requireFresh();
    const grid = applyLids(flat(3), flat(12));
    // Rows 0-3 should be masked
    for (let r = 0; r <= 3; r++) {
      expect(grid[r].every(v => v === 0)).toBe(true);
    }
    // Row 4 should have some content (ellipse)
    expect(grid[4].some(v => v === 1)).toBe(true);
  });

  it('masks bottom rows', () => {
    const { applyLids, flat } = requireFresh();
    const grid = applyLids(flat(-1), flat(8));
    // Rows 8-11 should be masked
    for (let r = 8; r <= 11; r++) {
      expect(grid[r].every(v => v === 0)).toBe(true);
    }
  });

  it('does not mutate BASE_EYE', () => {
    const { applyLids, flat, BASE_EYE } = requireFresh();
    const before = JSON.stringify(BASE_EYE);
    applyLids(flat(3), flat(9));
    expect(JSON.stringify(BASE_EYE)).toBe(before);
  });
});

describe('expressions', () => {
  it('has 25 expressions', () => {
    const { getExpressionNames } = requireFresh();
    expect(getExpressionNames().length).toBe(25);
  });

  it('hasExpression returns true/false correctly', () => {
    const { hasExpression } = requireFresh();
    expect(hasExpression('neutral')).toBe(true);
    expect(hasExpression('proud joy')).toBe(true);
    expect(hasExpression('nonexistent')).toBe(false);
  });

  it('all expressions have left and right with top and bot', () => {
    const { EXPRESSIONS } = requireFresh();
    for (const [name, expr] of Object.entries(EXPRESSIONS)) {
      expect(expr.left, `${name} missing left`).toBeDefined();
      expect(expr.right, `${name} missing right`).toBeDefined();
      expect(expr.left.top, `${name} missing left.top`).toBeDefined();
      expect(expr.left.bot, `${name} missing left.bot`).toBeDefined();
      expect(expr.right.top, `${name} missing right.top`).toBeDefined();
      expect(expr.right.bot, `${name} missing right.bot`).toBeDefined();
    }
  });

  it('basic emotions are symmetric', () => {
    const { EXPRESSIONS } = requireFresh();
    const symmetric = ['neutral', 'happy', 'surprised', 'fear'];
    for (const name of symmetric) {
      const e = EXPRESSIONS[name];
      expect(e.left.top).toEqual(e.right.top);
      expect(e.left.bot).toEqual(e.right.bot);
    }
  });

  it('complex emotions have asymmetry', () => {
    const { EXPRESSIONS } = requireFresh();
    const asymmetric = ['worried', 'curious', 'thinking', 'suspicious'];
    for (const name of asymmetric) {
      const e = EXPRESSIONS[name];
      const topDiff = JSON.stringify(e.left.top) !== JSON.stringify(e.right.top);
      const botDiff = JSON.stringify(e.left.bot) !== JSON.stringify(e.right.bot);
      expect(topDiff || botDiff, `${name} should be asymmetric`).toBe(true);
    }
  });

  it('neutral alive has 1-texel asymmetry', () => {
    const { EXPRESSIONS } = requireFresh();
    const e = EXPRESSIONS['neutral alive'];
    expect(e.left.top).not.toEqual(e.right.top);
    expect(e.left.bot).toEqual(e.right.bot);
  });
});

describe('getPixelGrid', () => {
  it('returns null for unknown expression', () => {
    const { getPixelGrid } = requireFresh();
    expect(getPixelGrid('nonexistent')).toBeNull();
  });

  it('returns left and right grids of correct dimensions', () => {
    const { getPixelGrid, EYE_W, EYE_H } = requireFresh();
    const px = getPixelGrid('neutral');
    expect(px.left.length).toBe(EYE_H);
    expect(px.left[0].length).toBe(EYE_W);
    expect(px.right.length).toBe(EYE_H);
    expect(px.right[0].length).toBe(EYE_W);
  });

  it('dead expression has minimal visible pixels', () => {
    const { getPixelGrid } = requireFresh();
    const px = getPixelGrid('dead');
    const totalOn = px.left.flat().reduce((s, v) => s + v, 0);
    expect(totalOn).toBeGreaterThan(0); // closed eyelid slit
    expect(totalOn).toBeLessThan(30);   // but very few
  });

  it('alert has more visible pixels than sleepy', () => {
    const { getPixelGrid } = requireFresh();
    const alert = getPixelGrid('alert');
    const sleepy = getPixelGrid('sleepy');
    const alertOn = alert.left.flat().reduce((s, v) => s + v, 0);
    const sleepyOn = sleepy.left.flat().reduce((s, v) => s + v, 0);
    expect(alertOn).toBeGreaterThan(sleepyOn);
  });
});

describe('applyGaze', () => {
  it('forward gaze returns expression unchanged', () => {
    const { EXPRESSIONS, applyGaze } = requireFresh();
    const expr = EXPRESSIONS.neutral;
    const result = applyGaze(expr, 'forward');
    expect(result).toBe(expr);
  });

  it('left/right gaze shifts top lids on the receiving eye', () => {
    const { EXPRESSIONS, applyGaze } = requireFresh();
    const expr = EXPRESSIONS.neutral;
    const left = applyGaze(expr, 'left');
    const right = applyGaze(expr, 'right');
    // Looking left: right eye top lid shifts (narrows toward gaze direction)
    expect(left.right.top).not.toEqual(expr.right.top);
    // Looking right: left eye top lid shifts
    expect(right.left.top).not.toEqual(expr.left.top);
  });
});

describe('edgeSplit', () => {
  it('empty pixel returns [0,0]', () => {
    const { edgeSplit } = requireFresh();
    expect(edgeSplit(0, 1, 1)).toEqual([0, 0]);
  });

  it('interior pixel returns [1,1]', () => {
    const { edgeSplit } = requireFresh();
    expect(edgeSplit(1, 1, 1)).toEqual([1, 1]);
  });

  it('left edge fills right half', () => {
    const { edgeSplit } = requireFresh();
    expect(edgeSplit(1, 0, 1)).toEqual([0, 1]);
  });

  it('right edge fills left half', () => {
    const { edgeSplit } = requireFresh();
    expect(edgeSplit(1, 1, 0)).toEqual([1, 0]);
  });

  it('isolated pixel fills full', () => {
    const { edgeSplit } = requireFresh();
    expect(edgeSplit(1, 0, 0)).toEqual([1, 1]);
  });
});

describe('QB_MAP', () => {
  it('has all 16 combinations', () => {
    const { QB_MAP } = requireFresh();
    expect(Object.keys(QB_MAP).length).toBe(16);
  });

  it('maps 0000 to space and 1111 to full block', () => {
    const { QB_MAP } = requireFresh();
    expect(QB_MAP['0000']).toBe(' ');
    expect(QB_MAP['1111']).toBe('\u2588');
  });
});

describe('renderExpression', () => {
  it('returns empty array for unknown expression', () => {
    const { renderExpression } = requireFresh();
    expect(renderExpression('nonexistent')).toEqual([]);
  });

  it('returns 6 lines for a standard expression', () => {
    const { renderExpression } = requireFresh();
    const lines = renderExpression('neutral');
    expect(lines.length).toBe(6);
  });

  it('lines contain ANSI color codes with default color', () => {
    const { renderExpression } = requireFresh();
    const lines = renderExpression('neutral');
    const hasColor = lines.some(l => l.includes('\x1b[38;5;24m'));
    expect(hasColor).toBe(true);
  });

  it('respects color override', () => {
    const { renderExpression } = requireFresh();
    const lines = renderExpression('neutral', { color: 196 });
    const hasRed = lines.some(l => l.includes('\x1b[38;5;196m'));
    expect(hasRed).toBe(true);
  });

  it('respects colorCode override', () => {
    const { renderExpression } = requireFresh();
    const custom = '\x1b[38;2;100;200;50m';
    const lines = renderExpression('neutral', { colorCode: custom });
    const hasCustom = lines.some(l => l.includes(custom));
    expect(hasCustom).toBe(true);
  });

  it('contains eye gap between left and right eye', () => {
    const { renderExpression, EYE_GAP } = requireFresh();
    const lines = renderExpression('neutral');
    const gap = ' '.repeat(EYE_GAP);
    const midLine = lines[2]; // widest row
    expect(midLine).toContain(gap);
  });
});

describe('tension model (S253 fix)', () => {
  it('happy uses flat bottom (no arch)', () => {
    const { EXPRESSIONS, flat } = requireFresh();
    const e = EXPRESSIONS.happy;
    // flat(7) produces uniform array of 7s — Duchenne bottom-only push
    expect(e.left.bot.every(v => v === 7)).toBe(true);
    expect(e.right.bot.every(v => v === 7)).toBe(true);
  });

  it('proud joy uses flat bottom (no arch)', () => {
    const { EXPRESSIONS } = requireFresh();
    const e = EXPRESSIONS['proud joy'];
    expect(e.left.bot.every(v => v === 9)).toBe(true);
  });

  it('sad still uses arch for sag (positive curve)', () => {
    const { EXPRESSIONS } = requireFresh();
    const e = EXPRESSIONS.sad;
    // arch(10, 0.5) produces varying values — not all the same
    const unique = new Set(e.left.bot.map(v => Math.round(v)));
    expect(unique.size).toBeGreaterThan(1);
  });
});

describe('wakefulness progression', () => {
  it('alert has wider opening than sleepy', () => {
    const { getPixelGrid } = requireFresh();
    const alert = getPixelGrid('alert');
    const sleepy = getPixelGrid('sleepy');
    // Count visible rows (rows with any pixel on)
    const alertRows = alert.left.filter(r => r.some(v => v)).length;
    const sleepyRows = sleepy.left.filter(r => r.some(v => v)).length;
    expect(alertRows).toBeGreaterThan(sleepyRows);
  });

  it('dead shows closed eyelid (minimal but nonzero pixels)', () => {
    const { getPixelGrid } = requireFresh();
    const dead = getPixelGrid('dead');
    const visibleRows = dead.left.filter(r => r.some(v => v)).length;
    expect(visibleRows).toBe(1); // single slit
  });

  it('blink shows fully closed (zero visible pixels)', () => {
    const { getPixelGrid } = requireFresh();
    const blink = getPixelGrid('blink');
    const totalOn = blink.left.flat().reduce((s, v) => s + v, 0);
    expect(totalOn).toBe(0);
  });
});

describe('compact renderer constants', () => {
  it('exports COMPACT_W, COMPACT_H, COMPACT_GAP', () => {
    const eye = requireFresh();
    expect(eye.COMPACT_W).toBe(9);
    expect(eye.COMPACT_H).toBe(6);
    expect(eye.COMPACT_GAP).toBe(1);
  });
});

describe('downsampleGrid', () => {
  it('returns COMPACT_H x COMPACT_W grid', () => {
    const { downsampleGrid, getPixelGrid, COMPACT_W, COMPACT_H } = requireFresh();
    const px = getPixelGrid('neutral');
    const compact = downsampleGrid(px.left);
    expect(compact.length).toBe(COMPACT_H);
    expect(compact[0].length).toBe(COMPACT_W);
  });

  it('neutral eye has pixels on in the compact grid (non-zero)', () => {
    const { downsampleGrid, getPixelGrid } = requireFresh();
    const px = getPixelGrid('neutral');
    const compact = downsampleGrid(px.left);
    const total = compact.flat().reduce((s, v) => s + v, 0);
    expect(total).toBeGreaterThan(0);
  });

  it('blink (fully closed) downsamples to all zeros', () => {
    const { downsampleGrid, getPixelGrid } = requireFresh();
    const px = getPixelGrid('blink');
    const compact = downsampleGrid(px.left);
    const total = compact.flat().reduce((s, v) => s + v, 0);
    expect(total).toBe(0);
  });

  it('alert has more compact pixels than sleepy (openness preserved)', () => {
    const { downsampleGrid, getPixelGrid } = requireFresh();
    const alertPx = getPixelGrid('alert');
    const sleepyPx = getPixelGrid('sleepy');
    const alertOn = downsampleGrid(alertPx.left).flat().reduce((s, v) => s + v, 0);
    const sleepyOn = downsampleGrid(sleepyPx.left).flat().reduce((s, v) => s + v, 0);
    expect(alertOn).toBeGreaterThan(sleepyOn);
  });

  it('curious left eye differs from right eye after downsampling (asymmetry preserved)', () => {
    const { downsampleGrid, getPixelGrid } = requireFresh();
    const px = getPixelGrid('curious');
    const leftCompact = downsampleGrid(px.left);
    const rightCompact = downsampleGrid(px.right);
    expect(JSON.stringify(leftCompact)).not.toBe(JSON.stringify(rightCompact));
  });

  it('does not mutate source pixel grid', () => {
    const { downsampleGrid, getPixelGrid } = requireFresh();
    const px = getPixelGrid('neutral');
    const before = JSON.stringify(px.left);
    downsampleGrid(px.left);
    expect(JSON.stringify(px.left)).toBe(before);
  });
});

describe('renderCompactExpression', () => {
  it('returns empty array for unknown expression', () => {
    const { renderCompactExpression } = requireFresh();
    expect(renderCompactExpression('nonexistent')).toEqual([]);
  });

  it('returns exactly 3 lines', () => {
    const { renderCompactExpression } = requireFresh();
    const lines = renderCompactExpression('neutral');
    expect(lines.length).toBe(3);
  });

  it('lines are shorter than full renderExpression (compact is smaller)', () => {
    const { renderExpression, renderCompactExpression } = requireFresh();
    const stripAnsi = str => str.replace(/\x1b\[[0-9;]*m/g, '');
    const fullLen = stripAnsi(renderExpression('neutral')[2]).length;
    const compactLen = stripAnsi(renderCompactExpression('neutral')[1]).length;
    expect(compactLen).toBeLessThan(fullLen);
  });

  it('lines contain ANSI color codes with default color', () => {
    const { renderCompactExpression } = requireFresh();
    const lines = renderCompactExpression('neutral');
    const hasColor = lines.some(l => l.includes('\x1b[38;5;24m'));
    expect(hasColor).toBe(true);
  });

  it('respects color override', () => {
    const { renderCompactExpression } = requireFresh();
    const lines = renderCompactExpression('neutral', { color: 196 });
    const hasRed = lines.some(l => l.includes('\x1b[38;5;196m'));
    expect(hasRed).toBe(true);
  });

  it('respects colorCode override', () => {
    const { renderCompactExpression } = requireFresh();
    const custom = '\x1b[38;2;100;200;50m';
    const lines = renderCompactExpression('neutral', { colorCode: custom });
    const hasCustom = lines.some(l => l.includes(custom));
    expect(hasCustom).toBe(true);
  });

  it('blink produces lines with no quarter-block characters (all spaces)', () => {
    const { renderCompactExpression } = requireFresh();
    const stripAnsi = str => str.replace(/\x1b\[[0-9;]*m/g, '');
    const lines = renderCompactExpression('blink');
    const text = lines.map(l => stripAnsi(l)).join('');
    expect(text.trim()).toBe('');
  });

  it('open expressions produce non-empty visible content', () => {
    const { renderCompactExpression } = requireFresh();
    const stripAnsi = str => str.replace(/\x1b\[[0-9;]*m/g, '');
    const lines = renderCompactExpression('alert');
    const text = lines.map(l => stripAnsi(l)).join('');
    expect(text.trim()).not.toBe('');
  });

  it('gaze option is accepted without error', () => {
    const { renderCompactExpression } = requireFresh();
    expect(() => renderCompactExpression('curious', { gaze: 'left' })).not.toThrow();
    const lines = renderCompactExpression('curious', { gaze: 'left' });
    expect(lines.length).toBe(3);
  });

  it('all 25 expressions render without error', () => {
    const { renderCompactExpression, getExpressionNames } = requireFresh();
    for (const name of getExpressionNames()) {
      const lines = renderCompactExpression(name);
      expect(lines.length, `${name} should return 3 lines`).toBe(3);
    }
  });
});
