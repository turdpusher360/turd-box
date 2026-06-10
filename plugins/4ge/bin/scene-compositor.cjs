'use strict';

// scene-compositor.cjs — Composites scenes from the scene library for Terminal OS flip-book rendering.
//
// composeScene(state) is the main entry point:
//   1. Reads companion state, boot status, git state, forge state
//   2. Selects scene by matching state to mood
//   3. Composes layers: background + character + info
//   4. Returns: array of strings, max 10 lines, 79 chars wide
//
// Uses substrate channel hierarchy:
//   Unicode density > typographic variants > colored emoji > whitespace
// No ANSI escape codes — response text canvas only.

const { selectScene, getScene, characterFace, infoLine, infoAlert, MAX_WIDTH, MAX_LINES } = require('./scene-library.cjs');
const { getExpressionName } = require('./hud-expressions.cjs');
const { toBold, toFraktur, inDiamond, BOX, FORGE_MARK } = require('./hud-zone-substrate.cjs');

// --- Width Enforcement ---

/**
 * Pad or trim a line to exactly `width` visible characters.
 * Preserves Unicode grapheme clusters as-is (no ANSI to strip).
 */
function fitLine(line, width) {
  // Count visible characters using Array.from for surrogate pair safety
  const chars = Array.from(line);
  if (chars.length >= width) {
    return chars.slice(0, width).join('');
  }
  return line + ' '.repeat(width - chars.length);
}

// --- Layer Composition ---

/**
 * Overlay a short string onto a background line at a given position.
 * Both strings are treated as Unicode character arrays.
 * The overlay replaces background characters at [startCol, startCol + overlayLen).
 */
function overlayOnLine(bgLine, overlay, startCol) {
  const bgChars = Array.from(bgLine);
  const olChars = Array.from(overlay);

  // Pad background if needed
  while (bgChars.length < startCol + olChars.length) {
    bgChars.push(' ');
  }

  for (let i = 0; i < olChars.length; i++) {
    const target = startCol + i;
    if (target < bgChars.length) {
      bgChars[target] = olChars[i];
    }
  }

  return bgChars.join('');
}

// --- Scene Header ---

/**
 * Build a scene header line with the scene name and the forge mark.
 * Format: ◆ scene-name (in Fraktur) + box-drawing separator
 */
function sceneHeader(sceneName) {
  const mark = FORGE_MARK || inDiamond('\u25C6');
  const label = toFraktur(sceneName);
  const sep = BOX.h.repeat(4);
  return mark + ' ' + label + ' ' + sep;
}

// --- Scene Footer ---

/**
 * Build a scene footer line with a box-drawing separator.
 */
function sceneFooter(width) {
  const sepLen = Math.min(width - 4, 40);
  return '  ' + BOX.h.repeat(Math.max(0, sepLen)) + '  ';
}

// --- Main Compositor ---

/**
 * Compose a scene from the current session state.
 *
 * @param {object} state - Canonical state from buildCanonicalState() or loadHudData()
 * @param {object} [opts] - Options
 * @param {number} [opts.width=79] - Target width
 * @param {number} [opts.maxLines=10] - Maximum output lines
 * @param {string} [opts.sceneOverride] - Force a specific scene name
 * @returns {string[]} Array of strings, one per line
 */
function composeScene(state, opts) {
  const options = opts || {};
  const width = Math.min(options.width || MAX_WIDTH, MAX_WIDTH);
  const maxLines = Math.min(options.maxLines || MAX_LINES, MAX_LINES);
  const safeState = (state && typeof state === 'object') ? state : {};

  // 1. Scene selection
  const sceneName = options.sceneOverride || selectScene(safeState);
  const scene = getScene(sceneName);

  // 2. Expression resolution
  let expressionName = 'neutral';
  try {
    expressionName = getExpressionName(safeState);
  } catch {
    // Expression engine unavailable — use neutral
  }

  // 3. Generate background layer
  const bgRows = scene.background(width);

  // 4. Generate character layer (compact face)
  const face = characterFace(expressionName);

  // 5. Generate info layer
  const info = infoLine(safeState, expressionName);

  // 6. Generate alert info (only for alert scenes)
  const alertLines = sceneName === 'alert' ? infoAlert(safeState) : [];

  // 7. Compose layers
  const output = [];

  // Line 0: scene header
  output.push(fitLine(sceneHeader(scene.name), width));

  // Lines 1-5: background with character overlay
  const faceRow = Math.min(1, bgRows.length - 1); // Place face near top
  const faceCol = Math.max(0, Math.floor((width - Array.from(face).length) / 2)); // Center

  for (let i = 0; i < bgRows.length && output.length < maxLines - 2; i++) {
    let line = bgRows[i];
    if (i === faceRow) {
      line = overlayOnLine(line, face, faceCol);
    }
    output.push(fitLine(line, width));
  }

  // Info line
  if (output.length < maxLines - 1) {
    output.push(fitLine(info, width));
  }

  // Alert lines (if applicable)
  for (const alertLine of alertLines) {
    if (output.length >= maxLines - 1) break;
    output.push(fitLine(alertLine, width));
  }

  // Footer
  if (output.length < maxLines) {
    output.push(fitLine(sceneFooter(width), width));
  }

  // Enforce max lines
  while (output.length > maxLines) {
    output.pop();
  }

  return output;
}

// --- Convenience: Compose and Join ---

/**
 * Compose a scene and return as a single string with newlines.
 */
function composeSceneText(state, opts) {
  return composeScene(state, opts).join('\n');
}

// --- Compose from Raw Data ---

/**
 * Compose a scene from raw disk data (calls loadHudData internally).
 * Convenience for callers that do not have pre-built state.
 */
function composeFromDisk(opts) {
  const options = opts || {};
  try {
    const { loadHudData } = require('./hud-data-loader.cjs');
    const { buildCanonicalState } = require('./hud-state.cjs');
    const raw = loadHudData({
      cwd: options.cwd || process.cwd(),
      runExpensiveProbes: false,
    });
    const state = buildCanonicalState(raw);
    return composeScene(state, options);
  } catch {
    // Fallback: compose with empty state
    return composeScene({}, options);
  }
}

module.exports = {
  composeScene,
  composeSceneText,
  composeFromDisk,
  // Layer utilities (exported for testing)
  fitLine,
  overlayOnLine,
  sceneHeader,
  sceneFooter,
};
