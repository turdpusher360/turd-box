'use strict';

// scene-library.cjs — Scene definitions for the Terminal OS flip-book renderer.
//
// Each scene is a named composition with:
//   mood  — what session state triggers it
//   layers — { background, character, info } render functions
//
// Background layers use Unicode density gradients (block elements, braille).
// Character layer reads companion-state expression for the face.
// Info layer renders session status as a compact text row.
//
// No ANSI escapes — response text canvas only.
// Width budget: 79 chars. Height budget: 10 lines max per scene.

const {
  toBold, toFraktur, toMono,
  blockBar, gradedBlockBar,
  inCircle, inSquare, inDiamond, inKeycap,
  capEmoji,
  BLOCK, BOX, COMBINING_LATIN, palimpsest,
} = require('./hud-zone-substrate.cjs');

// --- Constants ---
const MAX_WIDTH = 79;
const MAX_LINES = 10;

// --- Density Characters ---
// Graduated density from lightest to heaviest
const DENSITY = [' ', '\u2581', '\u2582', '\u2583', '\u2584', '\u2585', '\u2586', '\u2587', '\u2588'];
//               space  ▁        ▂        ▃        ▄        ▅        ▆        ▇        █

// Braille dot patterns for texture
const BRAILLE = {
  empty:  '\u2800', // ⠀
  dot1:   '\u2801', // ⠁
  dot12:  '\u2803', // ⠃
  dot14:  '\u2809', // ⠉
  dot123: '\u2807', // ⠇
  full:   '\u28FF', // ⣿
  sparse: '\u2812', // ⠒
  mid:    '\u2836', // ⠶
};

// --- Background Layer Builders ---

/**
 * Atmospheric idle background: gentle density wave with sparse braille texture.
 * Reads like a calm workshop at rest — embers low, air still.
 */
function bgIdle(width) {
  const rows = [];
  // Row 0-1: empty space (breathing room)
  rows.push(' '.repeat(width));
  rows.push(' '.repeat(width));

  // Row 2: sparse braille texture line
  const brailleRow = [];
  for (let i = 0; i < width; i++) {
    const pick = (i * 7 + 3) % 5;
    brailleRow.push(pick < 2 ? BRAILLE.dot1 : pick < 3 ? BRAILLE.sparse : BRAILLE.empty);
  }
  rows.push(brailleRow.join(''));

  // Row 3-4: rising density gradient (ground heat)
  const heatRow3 = [];
  const heatRow4 = [];
  for (let i = 0; i < width; i++) {
    // Sinusoidal variation across the width
    const phase = (i / width) * Math.PI * 2;
    const wave = Math.sin(phase) * 0.3 + 0.3;
    const level3 = Math.max(0, Math.min(8, Math.floor(wave * 4)));
    const level4 = Math.max(0, Math.min(8, Math.floor(wave * 6)));
    heatRow3.push(DENSITY[level3]);
    heatRow4.push(DENSITY[level4]);
  }
  rows.push(heatRow3.join(''));
  rows.push(heatRow4.join(''));

  return rows;
}

/**
 * Focused/busy background: denser texture, activity implied by braille patterns.
 * The workshop is alive — hammers ringing, sparks flying.
 */
function bgFocused(width) {
  const rows = [];

  // Row 0: tight braille activity band
  const activityRow = [];
  for (let i = 0; i < width; i++) {
    const pick = (i * 13 + 5) % 7;
    activityRow.push(
      pick < 2 ? BRAILLE.mid
      : pick < 4 ? BRAILLE.dot123
      : pick < 5 ? BRAILLE.dot12
      : BRAILLE.sparse
    );
  }
  rows.push(activityRow.join(''));

  // Row 1: dense block gradient (active)
  const denseRow = [];
  for (let i = 0; i < width; i++) {
    const center = width / 2;
    const dist = Math.abs(i - center) / center;
    const level = Math.max(0, Math.min(8, Math.floor((1 - dist) * 7)));
    denseRow.push(DENSITY[level]);
  }
  rows.push(denseRow.join(''));

  // Row 2: mid-density with braille overlay
  const midRow = [];
  for (let i = 0; i < width; i++) {
    const phase = (i / width) * Math.PI * 4;
    const wave = Math.sin(phase) * 0.5 + 0.5;
    midRow.push(wave > 0.6 ? BLOCK.dark : wave > 0.3 ? BLOCK.med : BLOCK.light);
  }
  rows.push(midRow.join(''));

  // Row 3-4: gradient floor
  const floor3 = [];
  const floor4 = [];
  for (let i = 0; i < width; i++) {
    const phase = (i / width) * Math.PI * 3;
    const wave = Math.sin(phase) * 0.4 + 0.6;
    floor3.push(DENSITY[Math.min(8, Math.floor(wave * 6))]);
    floor4.push(DENSITY[Math.min(8, Math.floor(wave * 8))]);
  }
  rows.push(floor3.join(''));
  rows.push(floor4.join(''));

  return rows;
}

/**
 * Error/alert background: jagged high-contrast blocks with braille noise.
 * Alarm state — sharp transitions, no calm gradients.
 */
function bgAlert(width) {
  const rows = [];

  // Row 0: alternating heavy/light blocks (warning stripe)
  const stripeRow = [];
  for (let i = 0; i < width; i++) {
    stripeRow.push(i % 4 < 2 ? BLOCK.full : BLOCK.light);
  }
  rows.push(stripeRow.join(''));

  // Row 1: noisy braille (static/interference)
  const noiseRow = [];
  for (let i = 0; i < width; i++) {
    const pick = (i * 17 + 11) % 6;
    noiseRow.push(
      pick < 1 ? BRAILLE.full
      : pick < 2 ? BRAILLE.mid
      : pick < 3 ? BRAILLE.dot123
      : pick < 5 ? BRAILLE.sparse
      : BRAILLE.dot1
    );
  }
  rows.push(noiseRow.join(''));

  // Row 2: heavy band
  rows.push(BLOCK.dark.repeat(width));

  // Row 3: jagged density
  const jaggedRow = [];
  for (let i = 0; i < width; i++) {
    const level = ((i * 23) % 9);
    jaggedRow.push(DENSITY[level]);
  }
  rows.push(jaggedRow.join(''));

  // Row 4: solid floor
  rows.push(BLOCK.med.repeat(width));

  return rows;
}

// --- Character Layer Builders ---

/**
 * Build a compact face representation from expression name.
 * Uses the COMPACT_FACES map from hud-engine or a local fallback.
 */
const SCENE_FACES = {
  neutral:    '[\u2585 \u2585]',
  'neutral alive': '[\u2585 \u2584]', // idle identity \u2014 asymmetric, matches COMPACT_FACES
  happy:      '[\u25E0 \u25E0]',
  focused:    '[\u2500 \u2500]',
  sad:        '[\u2584 \u2584]',
  excited:    '[\u2605 \u2605]',
  surprised:  '[\u25CB \u25CB]',
  determined: '[\u2501 \u2501]',
  sleepy:     '[\u2500 \u2500]',
  winking:    '[\u2585 \u2500]',
  curious:    '[\u25CB \u2585]',
  angry:      '[\u2501 \u2501]',
  blinking:   '[\u2500 \u2500]',
  suspicious: '[\u2585 \u2500]',
  thinking:   '[\u2500 \u2585]',
};

function characterFace(expressionName) {
  return SCENE_FACES[expressionName] || SCENE_FACES.neutral;
}

// --- Info Layer Builders ---

/**
 * Build a session info line from state.
 * Format: [face] model ctx% health [forge-status]
 */
function infoLine(state, expressionName) {
  const session = state.session || {};
  const forge = state.forge || {};
  const caps = (state.os && state.os.capabilities) || {};

  const face = characterFace(expressionName);
  const model = String(session.model || 'unknown').slice(0, 12);
  const ctxPct = typeof session.contextPct === 'number' ? session.contextPct : 0;

  // Health score
  const entries = Object.values(caps);
  const total = entries.length || 1;
  const ready = entries.filter(c => c && c.ok !== false).length;
  const score = Math.round((ready / total) * 100);

  const ctxStr = 'ctx ' + String(ctxPct) + '%';
  const healthStr = score >= 90 ? '🟢' : score >= 50 ? '🟡' : '🔴';

  let forgeStr = '';
  if (forge.active) {
    forgeStr = ' ' + toBold('FORGE') + ' ' + toFraktur(String(forge.phase || 'active').slice(0, 8));
  }

  const parts = [face, toMono(model.toUpperCase()), ctxStr, healthStr];
  if (forgeStr) parts.push(forgeStr);

  return parts.join('  ');
}

/**
 * Build a detailed info block for error scenes.
 * Shows degraded capabilities and context pressure.
 */
function infoAlert(state) {
  const caps = (state.os && state.os.capabilities) || {};
  const session = state.session || {};
  const lines = [];

  const degraded = Object.entries(caps).filter(([, c]) => c && c.ok === false);
  if (degraded.length > 0) {
    const label = toBold('DEGRADED') + ' ' + inCircle(String(degraded.length));
    const capList = degraded.slice(0, 4).map(([name]) => capEmoji(false, false) + ' ' + toFraktur(name.slice(0, 10)));
    lines.push(label + '  ' + capList.join('  '));
  }

  const ctxPct = typeof session.contextPct === 'number' ? session.contextPct : 0;
  if (ctxPct >= 60) {
    const ctxBar = blockBar(ctxPct, 16);
    lines.push(toBold('CTX') + '  ' + ctxBar + '  ' + toBold(String(ctxPct)) + '%');
  }

  return lines;
}

// --- Scene Definitions ---

const SCENES = {
  idle: {
    name: 'idle',
    mood: 'atmospheric',
    description: 'Workshop at rest. Embers low, air still.',
    background: bgIdle,
    expressions: ['neutral', 'sleepy', 'curious', 'blinking', 'thinking'],
  },

  focused: {
    name: 'focused',
    mood: 'focused',
    description: 'Workshop alive. Hammers ringing, sparks flying.',
    background: bgFocused,
    expressions: ['focused', 'determined', 'thinking', 'excited', 'winking'],
  },

  alert: {
    name: 'alert',
    mood: 'alert',
    description: 'Alarm state. Something needs attention.',
    background: bgAlert,
    expressions: ['angry', 'sad', 'surprised', 'suspicious'],
  },
};

// --- Scene Selection ---

/**
 * Match a session state to a scene name.
 * Priority: error conditions > forge activity > idle.
 */
function selectScene(state) {
  const forge = state.forge || {};
  const caps = (state.os && state.os.capabilities) || {};
  const session = state.session || {};
  const context = state.context || {};

  // Error/alert conditions
  const degradedCount = Object.values(caps).filter(c => c && c.ok === false).length;
  if (degradedCount >= 2) return 'alert';
  if (context.event === 'test-fail') return 'alert';
  if (context.event === 'error') return 'alert';
  if (typeof session.contextPct === 'number' && session.contextPct >= 80) return 'alert';

  // Active/focused conditions
  if (forge.active) return 'focused';
  if (context.event === 'forge-start' || context.event === 'forge-phase') return 'focused';
  if (context.event === 'test-pass') return 'focused';
  if (context.event === 'commit') return 'focused';

  // Default: idle/atmospheric
  return 'idle';
}

/**
 * Get all registered scene names.
 */
function getSceneNames() {
  return Object.keys(SCENES);
}

/**
 * Get a scene definition by name.
 */
function getScene(name) {
  return SCENES[name] || SCENES.idle;
}

module.exports = {
  SCENES,
  selectScene,
  getSceneNames,
  getScene,
  // Layer builders (exported for compositor and testing)
  bgIdle,
  bgFocused,
  bgAlert,
  characterFace,
  infoLine,
  infoAlert,
  // Constants
  SCENE_FACES,
  DENSITY,
  BRAILLE,
  MAX_WIDTH,
  MAX_LINES,
};
