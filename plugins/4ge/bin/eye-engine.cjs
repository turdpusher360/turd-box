'use strict';
// eye-engine.cjs — Expression engine for the 4ge face system
//
// 15x12 pixel grid per eye, half-block renderer.
// Lid-based architecture: constant ellipse base eye, expression from lid positions.
//
// Design principles (S252):
//   1. Constant ellipse base — eyeball never changes shape
//   2. Active bottom lid — cheek push for joy, sag for sadness
//   3. Basic emotions symmetric, complex emotions asymmetric
//   4. Direction of travel: anger→nose, sad=soft outward
//   5. Gaze and emotion are independent composable layers
//   6. Tension model: bottom deflection via flat(), not arch() (S253 fix)
//   7. Expression honesty: show the real one, not the performed one

// ── CONSTANTS ──

const EYE_W = 15;
const EYE_H = 12;
const EYE_GAP = 3;
const DEFAULT_COLOR = 24; // 256-color: dim steel-blue (forge accent)

// ── BASE EYE (constant ellipse — generated once, never changes) ──

const BASE_EYE = (() => {
  const g = Array.from({length: EYE_H}, () => Array(EYE_W).fill(0));
  const cx = (EYE_W - 1) / 2;
  const cy = (EYE_H - 1) / 2;
  const rx = EYE_W / 2;
  const ry = EYE_H / 2;
  for (let c = 0; c < EYE_W; c++) {
    const dx = (c - cx) / rx;
    if (Math.abs(dx) > 1) continue;
    const span = ry * Math.sqrt(1 - dx * dx);
    const top = Math.max(0, Math.ceil(cy - span));
    const bot = Math.min(EYE_H - 1, Math.floor(cy + span));
    for (let r = top; r <= bot; r++) g[r][c] = 1;
  }
  return g;
})();

// ── LID GENERATORS ──
// Each returns an array of EYE_W values representing the lid row-position per column.
// applyLids() uses these to mask the base eye from top and bottom.

/** Flat lid at a constant row. */
function flat(row) {
  return Array(EYE_W).fill(row);
}

/** Linear tilt from start row (col 0) to end row (col EYE_W-1). */
function tilt(start, end) {
  return Array.from({length: EYE_W}, (_, c) =>
    start + (end - start) * c / (EYE_W - 1)
  );
}

/**
 * Parabolic arch centered at the middle column.
 * Positive curve = sag (center drops). Negative curve = push (center rises).
 * Used for: sad bottom sag. NOT for cheek push — use flat() tension model instead.
 */
function arch(row, curve) {
  const cx = (EYE_W - 1) / 2;
  return Array.from({length: EYE_W}, (_, c) => {
    const t = (c - cx) / cx;
    return row + curve * (1 - t * t);
  });
}

// ── LID APPLICATION ──

/**
 * Apply top and bottom lid lines to the base eye.
 * Top lid masks from row 0 down to topLid[c].
 * Bottom lid masks from row EYE_H-1 up to bottomLid[c].
 * Returns a 12x15 pixel grid (0 = empty, 1 = eye).
 */
function applyLids(topLid, bottomLid) {
  const g = BASE_EYE.map(r => [...r]);
  for (let c = 0; c < EYE_W; c++) {
    const topRow = Math.round(topLid[c]);
    const botRow = Math.round(bottomLid[c]);
    for (let r = 0; r <= topRow && r < EYE_H; r++) g[r][c] = 0;
    for (let r = EYE_H - 1; r >= botRow && r >= 0; r--) g[r][c] = 0;
  }
  return g;
}

// ── EXPRESSION DICTIONARY ──
// Each expression: { left: {top, bot}, right: {top, bot} }
// Left eye:  col 0 = temple/outer,  col 14 = nose/inner
// Right eye: mirrored (col 0 = nose/inner, col 14 = temple/outer)

const EXPRESSIONS = {
  // ═══ BASIC (symmetric) ═══
  neutral:      { left: { top: flat(1),      bot: flat(10)       }, right: { top: flat(1),      bot: flat(10)       }},
  happy:        { left: { top: flat(1),      bot: flat(7)        }, right: { top: flat(1),      bot: flat(7)        }},
  sad:          { left: { top: tilt(2, 1),   bot: arch(10, 0.5)  }, right: { top: tilt(1, 2),   bot: arch(10, 0.5)  }},
  angry:        { left: { top: tilt(0, 4),   bot: tilt(11, 8)    }, right: { top: tilt(4, 0),   bot: tilt(8, 11)    }},
  surprised:    { left: { top: flat(-1),     bot: flat(12)       }, right: { top: flat(-1),     bot: flat(12)       }},
  fear:         { left: { top: flat(0),      bot: flat(10)       }, right: { top: flat(0),      bot: flat(10)       }},

  // ═══ COMPLEX (asymmetric) ═══
  worried:      { left: { top: tilt(3, 0),   bot: flat(10)       }, right: { top: tilt(0, 2),   bot: flat(10)       }},
  curious:      { left: { top: flat(1),      bot: flat(10)       }, right: { top: flat(3),      bot: flat(8)        }},
  thinking:     { left: { top: flat(3),      bot: flat(9)        }, right: { top: flat(1),      bot: flat(10)       }},
  suspicious:   { left: { top: tilt(1, 4),   bot: tilt(11, 8)    }, right: { top: flat(1),      bot: flat(10)       }},
  intrigued:    { left: { top: tilt(1, 0),   bot: flat(10)       }, right: { top: flat(2),      bot: flat(9)        }},
  determined:   { left: { top: tilt(1, 3),   bot: flat(9)        }, right: { top: tilt(3, 0),   bot: flat(9)        }},
  anxious:      { left: { top: tilt(4, 0),   bot: tilt(10, 11)   }, right: { top: tilt(0, 3),   bot: tilt(11, 10)   }},
  guilt:        { left: { top: tilt(3, 1),   bot: flat(8)        }, right: { top: tilt(1, 4),   bot: flat(8)        }},
  patient:      { left: { top: flat(3),      bot: flat(9)        }, right: { top: flat(3),      bot: flat(9)        }},

  // ═══ ENERGY ═══
  alert:        { left: { top: flat(0),      bot: flat(11)       }, right: { top: flat(0),      bot: flat(11)       }},
  excited:      { left: { top: flat(1),      bot: flat(8)        }, right: { top: flat(1),      bot: flat(8)        }},
  'proud joy':  { left: { top: flat(0),      bot: flat(9)        }, right: { top: flat(0),      bot: flat(9)        }},
  sleepy:       { left: { top: tilt(4, 2),    bot: flat(9)        }, right: { top: tilt(2, 4),    bot: flat(9)        }},
  exhausted:    { left: { top: tilt(5, 3),    bot: flat(8)        }, right: { top: tilt(3, 6),    bot: flat(8)        }},

  // ═══ ASYMMETRIC ENERGY ═══
  'neutral alive': { left: { top: flat(1),   bot: flat(10)       }, right: { top: flat(2),      bot: flat(10)       }},
  'nodding off':   { left: { top: flat(4),   bot: flat(8)        }, right: { top: flat(5),      bot: flat(7)        }},

  // ═══ SPECIAL ═══
  wink:         { left: { top: flat(1),      bot: flat(10)       }, right: { top: flat(5),      bot: flat(6)        }},
  blink:        { left: { top: flat(5),      bot: flat(6)        }, right: { top: flat(5),      bot: flat(6)        }},
  dead:         { left: { top: flat(5),      bot: flat(7)        }, right: { top: flat(5),      bot: flat(7)        }},
};

// ── GAZE COMPOSITION ──

/**
 * Apply gaze direction to an expression.
 * Shifts lid coverage to simulate eye direction.
 * Composes independently with any emotion.
 *
 * @param {object} expr - Expression definition {left: {top, bot}, right: {top, bot}}
 * @param {'forward'|'left'|'right'} direction
 * @returns {object} Modified expression
 */
function applyGaze(expr, direction) {
  if (!direction || direction === 'forward') return expr;
  const shift = direction === 'left' ? -1 : 1;
  return {
    left: {
      top: expr.left.top.map(v => v + (shift > 0 ? 1 : 0)),
      bot: expr.left.bot,
    },
    right: {
      top: expr.right.top.map(v => v + (shift < 0 ? 1 : 0)),
      bot: expr.right.bot,
    },
  };
}

// ── PIXEL GRID ACCESS ──

/**
 * Get the raw pixel grids for an expression.
 * @param {string} name - Expression name from EXPRESSIONS
 * @param {'forward'|'left'|'right'} [gaze='forward']
 * @returns {{left: number[][], right: number[][]}|null} Pixel grids or null if not found
 */
function getPixelGrid(name, gaze) {
  let expr = EXPRESSIONS[name];
  if (!expr) return null;
  if (gaze && gaze !== 'forward') expr = applyGaze(expr, gaze);
  return {
    left: applyLids(expr.left.top, expr.left.bot),
    right: applyLids(expr.right.top, expr.right.bot),
  };
}

// ── QUARTER-BLOCK RENDERER (Tier 2) ──

// Maps 4 sub-pixels (TL TR BL BR) to the corresponding Unicode quarter-block char.
// All 16 combinations of 2x2 on/off have a dedicated codepoint.
const QB_MAP = {
  '0000': ' ',      '1000': '\u2598', '0100': '\u259D', '1100': '\u2580',
  '0010': '\u2596', '1010': '\u258C', '0110': '\u259E', '1110': '\u259B',
  '0001': '\u2597', '1001': '\u259A', '0101': '\u2590', '1101': '\u259C',
  '0011': '\u2584', '1011': '\u2599', '0111': '\u259F', '1111': '\u2588',
};

/**
 * Determine quarter-block sub-pixels for a cell based on pixel value and neighbors.
 * Edge detection: if a pixel is ON but its horizontal neighbor is OFF,
 * only the half of the cell facing the filled interior gets filled.
 * This gives sub-cell precision at the ellipse's horizontal edges.
 *
 * @param {number} pixel - This cell's pixel value (0 or 1)
 * @param {number} leftN - Left neighbor pixel value
 * @param {number} rightN - Right neighbor pixel value
 * @returns {[number, number]} [leftHalf, rightHalf] — each 0 or 1
 */
function edgeSplit(pixel, leftN, rightN) {
  if (!pixel) return [0, 0];
  // Interior pixel: both neighbors on → fill full width
  if (leftN && rightN) return [1, 1];
  // Left edge: left neighbor off, right on → fill right half only
  if (!leftN && rightN) return [0, 1];
  // Right edge: right neighbor off, left on → fill left half only
  if (leftN && !rightN) return [1, 0];
  // Isolated or both neighbors off → fill full (don't shrink single pixels)
  return [1, 1];
}

/**
 * Render one eye's pixel grid as an array of quarter-block strings.
 * @param {number[][]} grid - EYE_H x EYE_W pixel grid
 * @param {string} colorCode - ANSI color escape
 * @returns {string[]}
 */
function renderEyeQB(grid, colorCode) {
  const R = '\x1b[0m';
  const rows = Math.ceil(EYE_H / 2);
  const lines = [];

  for (let r = 0; r < rows; r++) {
    let line = '';
    for (let c = 0; c < EYE_W; c++) {
      const t = grid[r * 2]?.[c] || 0;
      const b = grid[r * 2 + 1]?.[c] || 0;
      const tL = grid[r * 2]?.[c - 1] || 0;
      const tR = grid[r * 2]?.[c + 1] || 0;
      const bL = grid[r * 2 + 1]?.[c - 1] || 0;
      const bR = grid[r * 2 + 1]?.[c + 1] || 0;

      const [tLeft, tRight] = edgeSplit(t, tL, tR);
      const [bLeft, bRight] = edgeSplit(b, bL, bR);

      const key = `${tLeft}${tRight}${bLeft}${bRight}`;
      const ch = QB_MAP[key] || ' ';
      line += (ch === ' ') ? ' ' : colorCode + ch;
    }
    lines.push(line + R);
  }
  return lines;
}

/**
 * Render an expression as ANSI quarter-block strings.
 * Returns an array of terminal lines (one per row, 6 rows for 15x12 grid).
 * Each line contains both eyes side by side with EYE_GAP spaces between.
 *
 * @param {string} name - Expression name
 * @param {object} [options]
 * @param {'forward'|'left'|'right'} [options.gaze='forward']
 * @param {number} [options.color=24] - 256-color index for eye fill
 * @param {string} [options.colorCode] - Raw ANSI color code (overrides color index)
 * @returns {string[]} Array of ANSI-colored terminal lines, or empty array if not found
 */
function renderExpression(name, options) {
  const gaze = options?.gaze || 'forward';
  const colorCode = options?.colorCode || `\x1b[38;5;${options?.color || DEFAULT_COLOR}m`;

  const px = getPixelGrid(name, gaze);
  if (!px) return [];

  const leftLines = renderEyeQB(px.left, colorCode);
  const rightLines = renderEyeQB(px.right, colorCode);
  const R = '\x1b[0m';

  const lines = [];
  for (let i = 0; i < leftLines.length; i++) {
    lines.push(leftLines[i] + R + ' '.repeat(EYE_GAP) + rightLines[i]);
  }
  return lines;
}

// ── COMPACT RENDERER (9x3 terminal rows) ──
//
// Downsamples the 15x12 pixel grid to a 9x6 grid (9 wide x 3 terminal rows).
// Preserves key expression signals: open/closed, symmetric/asymmetric, gaze direction.
// Used by statusLine compact mode when terminal height is limited.
//
// Downsampling method: 2x2 max-pool (any pixel ON in a 2x2 source block → ON in compact).
// Column 14 (edge) in source is included in the final column pool to avoid clipping.
// Source columns 0-14 (15 cols) → 9 compact columns.
// Source rows 0-11 (12 rows) → 6 compact rows → 3 terminal rows via quarter-block.

const COMPACT_W = 9;
const COMPACT_H = 6;
const COMPACT_GAP = 1; // 1 space between compact eyes (vs 3 for full)

/**
 * Downsample a 12x15 pixel grid to a 6x9 compact grid using max-pooling.
 * Each compact cell is ON if any source pixel in its 2x2 (approx) source block is ON.
 *
 * Source columns: 15 → 9 compact. Step ≈ 15/9 ≈ 1.67 cols per compact col.
 * Source rows:    12 → 6 compact. Step = 12/6 = 2 rows per compact row.
 *
 * @param {number[][]} grid - EYE_H x EYE_W source pixel grid
 * @returns {number[][]} COMPACT_H x COMPACT_W compact grid
 */
function downsampleGrid(grid) {
  const result = Array.from({length: COMPACT_H}, () => Array(COMPACT_W).fill(0));
  const colStep = EYE_W / COMPACT_W;   // 15/9 ≈ 1.667
  const rowStep = EYE_H / COMPACT_H;   // 12/6 = 2.0

  for (let cy = 0; cy < COMPACT_H; cy++) {
    const srcRowStart = Math.floor(cy * rowStep);
    const srcRowEnd = Math.min(EYE_H - 1, Math.ceil((cy + 1) * rowStep) - 1);
    for (let cx = 0; cx < COMPACT_W; cx++) {
      const srcColStart = Math.floor(cx * colStep);
      const srcColEnd = Math.min(EYE_W - 1, Math.ceil((cx + 1) * colStep) - 1);
      // Max-pool: any source pixel ON → compact pixel ON
      outer: for (let r = srcRowStart; r <= srcRowEnd; r++) {
        for (let c = srcColStart; c <= srcColEnd; c++) {
          if (grid[r]?.[c]) { result[cy][cx] = 1; break outer; }
        }
      }
    }
  }
  return result;
}

/**
 * Render one compact eye grid as quarter-block strings (3 terminal rows).
 * @param {number[][]} grid - COMPACT_H x COMPACT_W pixel grid
 * @param {string} colorCode - ANSI color escape
 * @returns {string[]} 3 terminal rows
 */
function renderCompactEyeQB(grid, colorCode) {
  const R = '\x1b[0m';
  const rows = Math.ceil(COMPACT_H / 2);
  const lines = [];

  for (let r = 0; r < rows; r++) {
    let line = '';
    for (let c = 0; c < COMPACT_W; c++) {
      const t = grid[r * 2]?.[c] || 0;
      const b = grid[r * 2 + 1]?.[c] || 0;
      const tL = grid[r * 2]?.[c - 1] || 0;
      const tR = grid[r * 2]?.[c + 1] || 0;
      const bL = grid[r * 2 + 1]?.[c - 1] || 0;
      const bR = grid[r * 2 + 1]?.[c + 1] || 0;

      const [tLeft, tRight] = edgeSplit(t, tL, tR);
      const [bLeft, bRight] = edgeSplit(b, bL, bR);

      const key = `${tLeft}${tRight}${bLeft}${bRight}`;
      const ch = QB_MAP[key] || ' ';
      line += (ch === ' ') ? ' ' : colorCode + ch;
    }
    lines.push(line + R);
  }
  return lines;
}

/**
 * Render an expression as compact ANSI quarter-block strings.
 * Returns 3 terminal lines (one per row pair in the 9x6 compact grid).
 * Both eyes side by side with COMPACT_GAP space between.
 * Total width: 9 + COMPACT_GAP + 9 = 19 chars (before ANSI codes).
 *
 * @param {string} name - Expression name from EXPRESSIONS
 * @param {object} [options]
 * @param {'forward'|'left'|'right'} [options.gaze='forward']
 * @param {number} [options.color=24] - 256-color index
 * @param {string} [options.colorCode] - Raw ANSI color code (overrides color index)
 * @returns {string[]} 3-element array of ANSI-colored terminal lines, or [] if not found
 */
function renderCompactExpression(name, options) {
  const gaze = options?.gaze || 'forward';
  const colorCode = options?.colorCode || `\x1b[38;5;${options?.color || DEFAULT_COLOR}m`;

  const px = getPixelGrid(name, gaze);
  if (!px) return [];

  const leftCompact = downsampleGrid(px.left);
  const rightCompact = downsampleGrid(px.right);

  const leftLines = renderCompactEyeQB(leftCompact, colorCode);
  const rightLines = renderCompactEyeQB(rightCompact, colorCode);
  const R = '\x1b[0m';

  const lines = [];
  for (let i = 0; i < leftLines.length; i++) {
    lines.push(leftLines[i] + R + ' '.repeat(COMPACT_GAP) + rightLines[i]);
  }
  return lines;
}

/**
 * Get all available expression names.
 * @returns {string[]}
 */
function getExpressionNames() {
  return Object.keys(EXPRESSIONS);
}

/**
 * Check if an expression exists.
 * @param {string} name
 * @returns {boolean}
 */
function hasExpression(name) {
  return name in EXPRESSIONS;
}

// ── EXPORTS ──

module.exports = {
  // Constants
  EYE_W,
  EYE_H,
  EYE_GAP,
  DEFAULT_COLOR,
  BASE_EYE,
  QB_MAP,

  // Compact constants
  COMPACT_W,
  COMPACT_H,
  COMPACT_GAP,

  // Lid generators
  flat,
  tilt,
  arch,

  // Core engine
  applyLids,
  applyGaze,
  getPixelGrid,
  edgeSplit,
  renderEyeQB,
  renderExpression,

  // Compact engine
  downsampleGrid,
  renderCompactEyeQB,
  renderCompactExpression,

  // Expression data
  EXPRESSIONS,
  getExpressionNames,
  hasExpression,

  // Renderer
  renderExpression,
};
