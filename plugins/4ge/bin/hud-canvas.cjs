'use strict';

const { stripAnsi: _stripAnsi } = require('./hud-palette.cjs');

// Re-export for convenience
function stripAnsi(str) { return _stripAnsi(str); }

// --- Canvas Creation ---
// Creates a filled canvas: array of N rows, each W characters wide.
// Every row is filled with bg-colored spaces — the uniform surface.
function createCanvas(height, width, palette) {
  const bg = (palette && palette.bg) || '';
  const reset = (palette && palette.reset) || '';
  const fillRow = bg ? `${bg}${' '.repeat(width)}${reset}` : ' '.repeat(width);
  const rows = [];
  for (let i = 0; i < height; i++) {
    rows.push(fillRow);
  }
  return { rows, width, height };
}

// --- Row Painting ---
// Replace a single row with content. The bg color is applied uniformly across the
// entire line — both content and padding — so the panel has no stripe artifacts.
// This works by prepending bg and re-applying it after every ANSI reset in the content.
function paintRow(canvas, rowIdx, content, palette) {
  if (rowIdx < 0 || rowIdx >= canvas.height) return;
  const visibleLen = stripAnsi(content).length;
  const pad = Math.max(0, canvas.width - visibleLen);
  const bg = (palette && palette.bg) || '';
  const reset = (palette && palette.reset) || '';
  if (bg) {
    // Uniform bg: prepend bg, re-apply after every reset so fg color changes
    // don't clear the background. Eliminates the stripe where content shows
    // the terminal's default bg while padding shows the palette bg.
    const bgContent = bg + content.replaceAll(reset, reset + bg);
    canvas.rows[rowIdx] = `${bgContent}${' '.repeat(pad)}${reset}`;
  } else {
    canvas.rows[rowIdx] = content + ' '.repeat(pad);
  }
}

// Paint multiple rows starting from startRow.
// Lines beyond canvas height are silently clipped.
function paintRows(canvas, startRow, lines, palette) {
  for (let i = 0; i < lines.length; i++) {
    const targetRow = startRow + i;
    if (targetRow >= canvas.height) break;
    paintRow(canvas, targetRow, lines[i], palette);
  }
}

// --- Vertical Zone Allocator ---
// Each zone: { key, priority, minRows, idealRows }
// Returns: [{ key, rows, startRow, dropped }]
function allocateVerticalZones(zones, maxRows) {
  const sorted = [...zones].sort((a, b) => b.priority - a.priority);
  let remaining = maxRows;

  const allocMap = new Map();

  for (const z of sorted) {
    if (remaining >= z.minRows) {
      allocMap.set(z.key, { key: z.key, rows: z.minRows, dropped: false });
      remaining -= z.minRows;
    } else {
      allocMap.set(z.key, { key: z.key, rows: 0, dropped: true, startRow: -1 });
    }
  }

  for (const z of sorted) {
    const alloc = allocMap.get(z.key);
    if (alloc.dropped) continue;
    const want = z.idealRows - alloc.rows;
    if (want > 0 && remaining > 0) {
      const give = Math.min(want, remaining);
      alloc.rows += give;
      remaining -= give;
    }
  }

  let cursor = 0;
  const result = [];
  for (const z of zones) {
    const alloc = allocMap.get(z.key);
    if (alloc.dropped) {
      result.push(alloc);
    } else {
      alloc.startRow = cursor;
      cursor += alloc.rows;
      result.push(alloc);
    }
  }

  return result;
}

// --- Render ---
function render(canvas) {
  return canvas.rows.join('\n');
}

module.exports = {
  createCanvas,
  paintRow,
  paintRows,
  allocateVerticalZones,
  render,
  stripAnsi,
};
