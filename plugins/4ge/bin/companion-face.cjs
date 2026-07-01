'use strict';
// companion-face.cjs — Canonical 4ge companion eye primitives (CompactFace).
//
// Extracted so every HUD surface — statusline strip, reactive card, and the
// full-HUD face zone — renders the SAME cross-colored eyes from one source instead of
// three divergent face systems. Behavior is byte-identical to the original inline defs
// in hud-engine.cjs; this module is the single home going forward.
//
// Operator-locked: the eye styling + expression behavior here are MAINTAINED as-is
// (they are tuned to the statusline's between-turns refresh cadence). Improvements are
// additive + sign-off-gated, never silent replacements.

const { colorize } = require('./hud-palette.cjs');

// Model-specific resting face (W5 T5.1): healthy idle shows the model's signature look.
const MODEL_FACE = {
  'claude-opus-4-8':     { expr: 'determined', color: 'accent' },
  'claude-opus-4-7':     { expr: 'determined', color: 'accent' },
  'claude-opus-4-6':     { expr: 'determined', color: 'accent' },
  'claude-opus-4-6[1m]': { expr: 'determined', color: 'accent' },
  'claude-sonnet-4-6':   { expr: 'thinking',    color: 'accent' },
  'claude-sonnet-5':     { expr: 'thinking',    color: 'accent' },  // Sonnet 5: adaptive thinking, 1M
  'claude-haiku-4-5':    { expr: 'sleepy',     color: 'muted' },
};

// Prefix-match fallback so model ID version bumps still resolve.
function resolveModelFace(modelId) {
  if (!modelId) return null;
  if (MODEL_FACE[modelId]) return MODEL_FACE[modelId];
  if (modelId.startsWith('claude-opus'))   return MODEL_FACE['claude-opus-4-6'];
  if (modelId.startsWith('claude-sonnet')) return MODEL_FACE['claude-sonnet-4-6'];
  if (modelId.startsWith('claude-haiku'))  return MODEL_FACE['claude-haiku-4-5'];
  return null;
}

const COMPACT_FACES = {
  neutral:        '[▅ ▅]',  // ▅ ▅ — default open eyes
  'neutral alive': '[▅ ▄]', // ▅ ▄ — slight asymmetry = alive
  happy:          '[ˇ ˇ]',  // ˇ ˇ — cheek push (bottom-only)
  sad:            '[̧ ̧]',  // eyes with soft droop
  angry:          '[╱ ╲]',  // ╱ ╲ — inward furrowed
  surprised:      '[O O]',            // wide open
  fear:           '[O O]',            // wide open (same shape, different context)
  worried:        '[╱ ▅]',  // ╱ ▅ — asymmetric
  curious:        '[▅ ◠]',  // ▅ ◠ — one narrowed
  thinking:       '[◠ ▅]',  // ◠ ▅ — other narrowed
  suspicious:     '[╱ ▅]',  // ╱ ▅ — one squinted
  determined:     '[━ ━]',  // ━ ━ — focused
  anxious:        '[▅ ╱]',  // ▅ ╱ — unsettled
  alert:          '[● ●]',  // ● ● — wide and attentive
  excited:        '[★ ★]',  // ★ ★ — lit up
  'proud joy':    '[█ ▆]',  // █ ▆ — full open, sharper asymmetry
  sleepy:         '[─ ─]',  // ─ ─ — drooping
  exhausted:      '[▃ ▂]',  // ▃ ▂ — both eyes fighting to stay open
  blink:          '[─ ─]',  // ─ ─ — closed
  dead:           '[x x]',            // closed slits
  wink:           '[▅ ─]',  // ▅ ─ — one open one closed
  intrigued:      '[▅ ◠]',  // same as curious
  patient:        '[◠ ◠]',  // ◠ ◠ — relaxed half-lids
  guilt:          '[╱ ▄]',  // ╱ ▄ — averted
  'nodding off':  '[┄ ─]',  // ┄ ─ — asymmetric drowsy
};

// Gradient face: left eye blue (39), right eye purple (63); brackets cross-colored.
const FACE_LEFT = '\x1b[38;5;63m';   // muted indigo (left bracket + right eye)
const FACE_RIGHT = '\x1b[38;5;39m';  // sky blue (right bracket + left eye)
const FACE_RESET = '\x1b[0m';

function renderGradientFace(leftGlyph, rightGlyph) {
  // [ = purple (on blue side), ] = blue (on purple side); eyes cross-colored.
  return FACE_LEFT + '[' + FACE_RIGHT + leftGlyph + FACE_RESET + ' ' + FACE_LEFT + rightGlyph + FACE_RIGHT + ']' + FACE_RESET;
}

// Full companion face from raw/stdin state (statusline + strip path). Reads the live
// expression from companion-state and applies tool-parity eye-swap for thinking/exhausted.
function resolveCompanionFace(rawState, palette, _modelFace) {
  try {
    const companion = require('./companion-state.cjs');
    const stdinJson = rawState || {};
    const resolved = companion.resolveExpression(stdinJson);

    // When actively thinking (tool-running), eyes swap on each tool call — not a clock.
    if (resolved.expression === 'thinking') {
      const tc = (resolved.toolCount || resolved.lastToolAt || 0);
      const even = tc % 2 === 0;
      const leftGlyph = even ? '▅' : '▃';   // ▅ or ▃
      const rightGlyph = even ? '▃' : '▅';   // ▃ or ▅
      return renderGradientFace(leftGlyph, rightGlyph);
    }

    // Exhausted: eyes drift on each action. Too tired to hold a face.
    if (resolved.expression === 'exhausted') {
      const tc = (resolved.toolCount || resolved.lastToolAt || 0);
      const even = tc % 2 === 0;
      const leftGlyph = even ? '▃' : '▂';   // ▃ or ▂
      const rightGlyph = even ? '▂' : '▃';   // ▂ or ▃
      return renderGradientFace(leftGlyph, rightGlyph);
    }

    const face = COMPACT_FACES[resolved.expression] || COMPACT_FACES.neutral;
    const glyphs = face.match(/^\[(.+) (.+)\]$/);
    if (glyphs) return renderGradientFace(glyphs[1], glyphs[2]);
    return colorize(palette, 'accent', face);
  } catch {
    // Failure fallback shows the companion's true idle face (asymmetric), not
    // the symmetric reset face.
    return renderGradientFace('▅', '▄');
  }
}

// Render companion eyes from an expression NAME (canonical-state path — for zone
// renderers that already resolved the expression via getExpressionName(state) and do
// not carry rawState). Same cross-colored eyes as resolveCompanionFace.
function renderCompanionEyes(exprName, palette) {
  const face = COMPACT_FACES[exprName] || COMPACT_FACES.neutral;
  const glyphs = face.match(/^\[(.+) (.+)\]$/);
  if (glyphs) return renderGradientFace(glyphs[1], glyphs[2]);
  return colorize(palette, 'accent', face);
}

module.exports = {
  MODEL_FACE,
  resolveModelFace,
  COMPACT_FACES,
  FACE_LEFT,
  FACE_RIGHT,
  FACE_RESET,
  renderGradientFace,
  resolveCompanionFace,
  renderCompanionEyes,
};
