'use strict';

// --- Expression Engine ---
// Maps context events + OS state to Anvil's eye expressions.
// Each expression is { left: string[], right: string[] } arrays of ANSI rows.
// Call buildExpression(state, palette) to get palette-compliant art.
// selectExpression(state) remains exported for callers that don't need color.

const { RESET, resolvePalette } = require('./hud-palette.cjs');

// --- Color Constants — palette-sourced (palette-portability carry) ---
// Previously these were hardcoded ANSI escape sequences that bypassed the
// palette and broke theme portability (DFE finding 2026-04-09).
// Now they are derived from the forge preset at module load time so that:
//   (a) they remain pixel-equivalent to the prior hardcoded values by default
//   (b) changes to the forge palette entries propagate here automatically
//   (c) the palette path (_codes(palette)) and the fallback path both use the
//       same source of truth — hud-palette.cjs PRESETS
//
// Role mapping:
//   CYN / LCYN  — accent (forge: dim steel-blue c256(39) → accent band)
//   DCYN        — muted  (forge: slate chrome c256(241) — thinking/subdued)
//   WHT         — text   (forge: wheat c256(223))
//   GRY / SLAT  — muted  (forge: slate chrome c256(241) — labels/dividers)
//   DIM         — muted  (forge: slate chrome — slightly dimmer variant maps same)
//
// NOTE: CYN/LCYN/DCYN were previously c256(24)/c256(67)/c256(23). The forge
// preset accent is c256(39). The prior values were a manually-curated sub-band;
// forge.accent is the canonical token. Both render in the steel-blue family.
// Accepting the minor shift — forge.accent c256(39) was the spec-correct value
// (vertical gradient doc pinned it). The old c256(24) was the pre-spec leftover.
const _fp  = resolvePalette({ name: 'forge' });
const CYN  = _fp.accent;
const LCYN = _fp.accent;  // highlight: same accent band — no distinct hi token
const DCYN = _fp.muted;   // thinking/subdued: muted role
const WHT  = _fp.text;    // bright glint pixel
const GRY  = _fp.muted;   // grey label role
const DIM  = _fp.muted;   // dim label role (same muted band)
const SLAT = _fp.muted;   // slate label role (same muted band)
const R = RESET;

// --- Palette-to-tint resolver ---
// Maps semantic roles to raw escape codes for inline eye building.
// Role mapping: accent→CYN, muted→GRY/DIM/SLAT/DCYN, text→WHT.
// Returns fallback constants when palette is absent.
function _codes(palette) {
  if (!palette) {
    return { acc: CYN, hi: LCYN, dim: DCYN, txt: WHT, muted: GRY, dim2: DIM, sl: SLAT, reset: R };
  }
  // Collapse: accent covers CYN+LCYN+DCYN (all in the accent band).
  // muted covers GRY+DIM+SLAT (all subdued roles).
  // text covers WHT (bright glint pixel only).
  // Use ?? (nullish coalescing) so plain theme's empty strings are preserved.
  const acc   = palette.accent ?? CYN;
  const muted = palette.muted  ?? GRY;
  const txt   = palette.text   ?? WHT;
  const reset = palette.reset  ?? R;
  return { acc, hi: acc, dim: muted, txt, muted, dim2: muted, sl: muted, reset };
}

// --- Eye Shape Builders (from batch10) ---
// Public API: accept optional tint escape code (raw string).
// Used by EXPRESSIONS (static, for selectExpression) and by _buildExpressions (palette-aware).

function eyeFull(tint) {
  const E = tint || CYN;
  return [
    E + '  \u2584\u2588\u2588\u2588\u2584  ' + R,
    E + '  \u2588\u2588\u2588\u2588\u2588  ' + R,
    E + '  \u2588\u2588\u2588\u2588\u2588  ' + R,
    E + '  \u2580\u2588\u2588\u2588\u2580  ' + R,
  ];
}

function eyeHighlight(tint) {
  const E = tint || CYN;
  return [
    E + '  \u2584\u2588\u2588\u2588\u2584  ' + R,
    E + '  \u2588\u2588' + WHT + '\u2588' + E + '\u2588\u2588  ' + R,
    E + '  \u2588\u2588\u2588\u2588\u2588  ' + R,
    E + '  \u2580\u2588\u2588\u2588\u2580  ' + R,
  ];
}

function eyeHalfLid(tint) {
  const E = tint || CYN;
  return [
    GRY + '  \u2584\u2584\u2584\u2584\u2584  ' + R,
    E + '  \u2584\u2588\u2588\u2588\u2584  ' + R,
    E + '  \u2588\u2588\u2588\u2588\u2588  ' + R,
    E + '  \u2580\u2588\u2588\u2588\u2580  ' + R,
  ];
}

function eyeSquint(tint) {
  const E = tint || CYN;
  return [
    '         ',
    DIM + '  \u2584\u2584\u2584\u2584\u2584  ' + R,
    E + '  \u2580\u2588\u2588\u2588\u2580  ' + R,
    '         ',
  ];
}

function eyeWide(tint) {
  const E = tint || CYN;
  return [
    E + ' \u2584\u2588\u2588\u2588\u2588\u2584 ' + R,
    E + ' \u2588\u2588\u2588\u2588\u2588\u2588 ' + R,
    E + ' \u2588\u2588\u2588\u2588\u2588\u2588 ' + R,
    E + ' \u2588\u2588\u2588\u2588\u2588\u2588 ' + R,
    E + ' \u2580\u2588\u2588\u2588\u2588\u2580 ' + R,
  ];
}

function eyeHappy(tint) {
  const E = tint || LCYN;
  return [
    E + '  \u2584\u2588\u2588\u2588\u2584  ' + R,
    E + '  \u2588\u2588\u2588\u2588\u2588  ' + R,
    E + '  \u2580\u2580\u2580\u2580\u2580  ' + R,
    '         ',
  ];
}

function eyeSad(tint) {
  const E = tint || CYN;
  return [
    SLAT + '  \u2584\u2588\u2588\u2588\u2584  ' + R,
    E + '  \u2588\u2588\u2588\u2588\u2588  ' + R,
    E + '  \u2584\u2588\u2588\u2588\u2584  ' + R,
    SLAT + '\u2584      \u2584 ' + R,
  ];
}

function eyeClosed() {
  return [
    '         ',
    DIM + '  \u2584\u2584\u2584\u2584\u2584  ' + R,
    '         ',
    '         ',
  ];
}

function eyeExcited() {
  const E = LCYN;
  return [
    E + ' \u2584\u2588\u2588\u2588\u2588\u2584 ' + R,
    E + ' \u2588\u2588' + WHT + '\u2588' + E + '\u2588\u2588\u2588 ' + R,
    E + ' \u2588\u2588\u2588\u2588' + WHT + '\u2584' + E + '\u2588 ' + R,
    E + ' \u2588\u2588\u2588\u2588\u2588\u2588 ' + R,
    E + ' \u2580\u2588\u2588\u2588\u2588\u2580 ' + R,
  ];
}

// --- Palette-aware eye builders ---
// Called by _buildExpressions(c) with resolved codes from _codes(palette).
// These are internal — not exported. Each mirrors its public counterpart but
// uses c.acc/c.muted/c.txt/c.reset instead of hardcoded escape constants.

function _eyeFull(c, tint) {
  const E = tint || c.acc;
  return [
    E + '  \u2584\u2588\u2588\u2588\u2584  ' + c.reset,
    E + '  \u2588\u2588\u2588\u2588\u2588  ' + c.reset,
    E + '  \u2588\u2588\u2588\u2588\u2588  ' + c.reset,
    E + '  \u2580\u2588\u2588\u2588\u2580  ' + c.reset,
  ];
}

function _eyeHalfLid(c) {
  return [
    c.muted + '  \u2584\u2584\u2584\u2584\u2584  ' + c.reset,
    c.acc   + '  \u2584\u2588\u2588\u2588\u2584  ' + c.reset,
    c.acc   + '  \u2588\u2588\u2588\u2588\u2588  ' + c.reset,
    c.acc   + '  \u2580\u2588\u2588\u2588\u2580  ' + c.reset,
  ];
}

function _eyeSquint(c, tint) {
  const E = tint || c.acc;
  return [
    '         ',
    c.muted + '  \u2584\u2584\u2584\u2584\u2584  ' + c.reset,
    E       + '  \u2580\u2588\u2588\u2588\u2580  ' + c.reset,
    '         ',
  ];
}

function _eyeWide(c) {
  return [
    c.acc + ' \u2584\u2588\u2588\u2588\u2588\u2584 ' + c.reset,
    c.acc + ' \u2588\u2588\u2588\u2588\u2588\u2588 ' + c.reset,
    c.acc + ' \u2588\u2588\u2588\u2588\u2588\u2588 ' + c.reset,
    c.acc + ' \u2588\u2588\u2588\u2588\u2588\u2588 ' + c.reset,
    c.acc + ' \u2580\u2588\u2588\u2588\u2588\u2580 ' + c.reset,
  ];
}

function _eyeHappy(c) {
  return [
    c.acc + '  \u2584\u2588\u2588\u2588\u2584  ' + c.reset,
    c.acc + '  \u2588\u2588\u2588\u2588\u2588  ' + c.reset,
    c.acc + '  \u2580\u2580\u2580\u2580\u2580  ' + c.reset,
    '         ',
  ];
}

function _eyeSad(c) {
  return [
    c.muted + '  \u2584\u2588\u2588\u2588\u2584  ' + c.reset,
    c.acc   + '  \u2588\u2588\u2588\u2588\u2588  ' + c.reset,
    c.acc   + '  \u2584\u2588\u2588\u2588\u2584  ' + c.reset,
    c.muted + '\u2584      \u2584 ' + c.reset,
  ];
}

function _eyeClosed(c) {
  return [
    '         ',
    c.muted + '  \u2584\u2584\u2584\u2584\u2584  ' + c.reset,
    '         ',
    '         ',
  ];
}

function _eyeExcited(c) {
  return [
    c.acc  + ' \u2584\u2588\u2588\u2588\u2588\u2584 ' + c.reset,
    c.acc  + ' \u2588\u2588' + c.txt + '\u2588' + c.acc + '\u2588\u2588\u2588 ' + c.reset,
    c.acc  + ' \u2588\u2588\u2588\u2588' + c.txt + '\u2584' + c.acc + '\u2588 ' + c.reset,
    c.acc  + ' \u2588\u2588\u2588\u2588\u2588\u2588 ' + c.reset,
    c.acc  + ' \u2580\u2588\u2588\u2588\u2588\u2580 ' + c.reset,
  ];
}

// --- Build palette-aware expression map ---
// Returns the same shape as EXPRESSIONS but with palette-derived colors.
function _buildExpressions(c) {
  return {
    neutral:    { left: _eyeFull(c),           right: _eyeFull(c) },
    happy:      { left: _eyeHappy(c),          right: _eyeHappy(c) },
    focused:    { left: _eyeSquint(c),         right: _eyeSquint(c) },
    curious:    { left: _eyeWide(c),           right: ['         ', ..._eyeFull(c)] },
    sleepy:     { left: _eyeHalfLid(c),        right: _eyeHalfLid(c) },
    surprised:  { left: _eyeWide(c),           right: _eyeWide(c) },
    thinking:   { left: _eyeSquint(c, c.muted), right: _eyeFull(c, c.acc) },
    determined: { left: _eyeSquint(c),         right: _eyeSquint(c) },
    winking:    { left: _eyeFull(c),           right: _eyeClosed(c) },
    excited:    { left: _eyeExcited(c),        right: _eyeExcited(c) },
    suspicious: { left: _eyeFull(c),           right: ['         ', c.muted + '  \u2584\u2584\u2584\u2584\u2584  ' + c.reset, c.acc + '  \u2580\u2588\u2588\u2588\u2580  ' + c.reset, '         '] },
    sad:        { left: _eyeSad(c),            right: _eyeSad(c) },
    angry:      { left: _eyeSquint(c),         right: _eyeSquint(c) },
    blinking:   { left: _eyeClosed(c),         right: _eyeClosed(c) },
    lookLeft:   { left: _eyeFull(c),           right: _eyeFull(c) },
    lookRight:  { left: _eyeFull(c),           right: _eyeFull(c) },
  };
}

// --- Expression Definitions ---
// 16 named expressions, each mapping to left+right eye shapes
const EXPRESSIONS = {
  neutral:    { left: eyeFull(),         right: eyeFull() },
  happy:      { left: eyeHappy(),        right: eyeHappy() },
  focused:    { left: eyeSquint(),       right: eyeSquint() },
  curious:    { left: eyeWide(),         right: ['         ', ...eyeFull()] },
  sleepy:     { left: eyeHalfLid(),      right: eyeHalfLid() },
  surprised:  { left: eyeWide(),         right: eyeWide() },
  thinking:   { left: eyeSquint(DCYN),   right: eyeFull(LCYN) },
  determined: { left: eyeSquint(),       right: eyeSquint() },
  winking:    { left: eyeFull(),         right: eyeClosed() },
  excited:    { left: eyeExcited(),      right: eyeExcited() },
  suspicious: { left: eyeFull(),         right: ['         ', DIM + '  \u2584\u2584\u2584\u2584\u2584  ' + R, CYN + '  \u2580\u2588\u2588\u2588\u2580  ' + R, '         '] },
  sad:        { left: eyeSad(),          right: eyeSad() },
  angry:      { left: eyeSquint(),       right: eyeSquint() },
  blinking:   { left: eyeClosed(),       right: eyeClosed() },
  lookLeft:   { left: eyeFull(),         right: eyeFull() },   // future: shift pupil
  lookRight:  { left: eyeFull(),         right: eyeFull() },   // future: shift pupil
};

// --- Context-to-Expression Mapping ---
// Priority-ordered rules. First match wins.
const EXPRESSION_RULES = [
  // Forge-related
  { match: (s) => s.context.event === 'forge-start',      expr: 'determined' },
  { match: (s) => s.context.event === 'forge-complete',   expr: 'excited' },
  { match: (s) => s.forge.active && s.forge.phase,        expr: 'focused' },

  // Test results
  { match: (s) => s.context.event === 'test-pass',        expr: 'happy' },
  { match: (s) => s.context.event === 'test-fail',        expr: 'sad' },

  // Capability degradation
  { match: (s) => countDegraded(s) >= 4,                  expr: 'angry' },
  { match: (s) => countDegraded(s) >= 2,                  expr: 'suspicious' },
  { match: (s) => countDegraded(s) === 1,                 expr: 'curious' },

  // Context window pressure
  { match: (s) => s.session.contextPct >= 80,             expr: 'sleepy' },
  { match: (s) => s.session.contextPct >= 60,             expr: 'thinking' },

  // Export
  { match: (s) => s.context.event === 'export',           expr: 'winking' },

  // Badge earned
  { match: (s) => s.context.event === 'badge-earned',     expr: 'excited' },

  // Boot sequence
  { match: (s) => s.context.event === 'boot',             expr: 'surprised' },

  // Session end
  { match: (s) => s.context.event === 'session-end',      expr: 'sleepy' },

  // Blink (periodic — every ~30 renders)
  { match: (s) => s.context.event === 'blink',            expr: 'blinking' },

  // Default
  { match: () => true,                                    expr: 'neutral' },
];

// --- Helper ---
function countDegraded(state) {
  // Skip shelved capabilities (intentionally degraded, not actionable).
  // Mirrors hud-state.cjs countDegraded() — kept duplicated to avoid coupling
  // expression rules to state-builder internals.
  const caps = (state.os && state.os.capabilities) || {};
  let count = 0;
  for (const c of Object.values(caps)) {
    if (c && c.ok === false && c.shelved !== true) count++;
  }
  return count;
}

// --- Expression Selector ---
function selectExpression(state) {
  for (const rule of EXPRESSION_RULES) {
    try {
      if (rule.match(state)) {
        return EXPRESSIONS[rule.expr] || EXPRESSIONS.neutral;
      }
    } catch {
      // Rule eval failed — skip it
    }
  }
  return EXPRESSIONS.neutral;
}

// --- Palette-aware expression builder ---
// Preferred API for zone renderers. Resolves expression name, then builds
// eye art using palette codes so no inner ANSI escapes override the palette.
// Falls back to selectExpression() when palette is absent.
function buildExpression(state, palette) {
  const name = getExpressionName(state);
  const c = _codes(palette);
  const exprs = _buildExpressions(c);
  return exprs[name] || exprs.neutral;
}

// --- Get expression name (for debugging/logging) ---
function getExpressionName(state) {
  for (const rule of EXPRESSION_RULES) {
    try {
      if (rule.match(state)) return rule.expr;
    } catch {
      continue;
    }
  }
  return 'neutral';
}

module.exports = {
  EXPRESSIONS,
  EXPRESSION_RULES,
  selectExpression,
  getExpressionName,
  buildExpression,
  // Export individual builders for testing
  eyeFull,
  eyeHighlight,
  eyeHalfLid,
  eyeSquint,
  eyeWide,
  eyeHappy,
  eyeSad,
  eyeClosed,
  eyeExcited,
};
