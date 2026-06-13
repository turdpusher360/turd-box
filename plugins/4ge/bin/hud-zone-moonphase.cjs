'use strict';
// hud-zone-moonphase.cjs — Optional HUD zone: context-consumption as moon phases.
//
// WHY: For 1M-window / DISABLE_AUTO_COMPACT workflows a linear bar conveys little.
// A moon-phase glyph (empty→full circle ramp) mapped to context% decouples the
// "feels full" sense from the hard context limit by letting the operator define
// their own fullThreshold (default 100 = use the real limit).
//
// CONFIG (under companion.moonphase in .4ge/config.json):
//   enabled       boolean  false   — opt-in, zone hidden unless explicitly true
//   fullThreshold number   100     — pct at which the circle reads as "full moon"
//                                   e.g. 50 → full moon when ctx=50% (500K of 1M)
//
// SAFE CONFIG READ: loadCompanionConfig() passes unknown keys straight through
// (companion-config.cjs:73 DEFAULTS spread), so the moonphase sub-object is
// available with zero changes to that module. The 10 s cache + zero-crash fallback
// are inherited. Reads happen at the module boundary (outside the renderer) to
// satisfy the zone contract: zone renderers MUST NOT read files.
//
// GLYPH CHOICE: BMP circles (U+25CB / U+25D4 / U+25D1 / U+25D5 / U+25CF) rather
// than the emoji moon series (SMP, double-width, baked color). BMP is Termius-safe
// and colorizable via colorize(). substrate-canvas.md §"SMP + combining marks trap".

const { colorize } = require('./hud-palette.cjs');

// --- Moon phase glyphs (BMP, width-1, colorizable) ---
// 5-step ramp: new → crescent → half → gibbous → full
const PHASES = ['○', '◔', '◑', '◕', '●'];  // U+25CB 25D4 25D1 25D5 25CF

// --- Zone Metadata ---
const ZONE_META = { key: 'moonphase', priority: 2, minRows: 1, idealRows: 1 };

// --- Config loader (cached, zero-crash) ---
// Reads companion-config.cjs which already performs 10s TTL disk-read and
// validates the companion block. Unknown sub-keys pass through untouched.
function _loadConfig() {
  try {
    const { loadCompanionConfig } = require('./companion-config.cjs');
    const cfg = loadCompanionConfig();
    const mp = (cfg && typeof cfg.moonphase === 'object' && cfg.moonphase) || {};
    const enabled       = mp.enabled === true;
    let   fullThreshold = typeof mp.fullThreshold === 'number' ? mp.fullThreshold : 100;
    // Clamp to [5, 100] — prevents division-by-zero and implausibly tight thresholds
    if (fullThreshold < 5)   fullThreshold = 5;
    if (fullThreshold > 100) fullThreshold = 100;
    return { enabled, fullThreshold };
  } catch {
    return { enabled: false, fullThreshold: 100 };
  }
}

// --- Visibility Predicate ---
// Zone is hidden unless companion.moonphase.enabled === true in config.
function moonphaseVisible(/* state */) {
  return _loadConfig().enabled;
}

// --- Phase index from ratio ---
// ratio ∈ [0, 1]:  0 = new moon (empty circle), 1 = full moon (solid circle).
function phaseIndex(ratio) {
  const clamped = Math.max(0, Math.min(1, ratio));
  return Math.round(clamped * (PHASES.length - 1));
}

// --- Color role from ratio (mirrors hud-zone-context convention) ---
function phaseColor(ratio) {
  if (ratio >= 0.9) return 'error';   // >= 90 % of threshold: danger
  if (ratio >= 0.6) return 'warn';    // 60–89 %: warning
  return 'ok';                        // < 60 %: healthy
}

// --- Renderer ---
// Input:  canonical state (state.session.contextPct is always present, 0-100)
// Output: string[] with exactly 1 row
function renderMoonphaseZone(state, palette) {
  const { fullThreshold } = _loadConfig();
  const contextPct = (state.session && typeof state.session.contextPct === 'number')
    ? state.session.contextPct
    : 0;

  const ratio = contextPct / fullThreshold;
  const idx   = phaseIndex(ratio);
  const glyph = PHASES[idx];
  const role  = phaseColor(ratio);

  const phaseName = ['new', 'crescent', 'half', 'gibbous', 'full'][idx];
  const tLabel    = fullThreshold < 100
    ? colorize(palette, 'muted', ` (full=${fullThreshold}%)`)
    : '';

  const line = [
    '  ',
    colorize(palette, 'muted', 'ctx '),
    colorize(palette, role, glyph),
    ' ',
    colorize(palette, role, `${Math.round(contextPct)}%`),
    colorize(palette, 'muted', ` ${phaseName}`),
    tLabel,
  ].join('');

  return [line];
}

module.exports = {
  renderMoonphaseZone,
  ZONE_META,
  moonphaseVisible,
  // Exported for tests
  phaseIndex,
  phaseColor,
  PHASES,
};
