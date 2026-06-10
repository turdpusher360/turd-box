'use strict';

// --- NO_COLOR / CLICOLOR detection ---
function isNoColor() {
  return !!(process.env.NO_COLOR || process.env.CLICOLOR === '0')
    && !process.env.CLICOLOR_FORCE;
}

// --- Color Depth Detection ---
function detectColorDepth() {
  if (process.env.COLORTERM === 'truecolor') return 'truecolor';
  if (process.env.COLORTERM === '256color') return '256';
  if (process.env.TERM && process.env.TERM.includes('256color')) return '256';
  return '8';
}

// --- ANSI Helpers ---
function rgb(r, g, b) { return `\x1b[38;2;${r};${g};${b}m`; }
function rgbBg(r, g, b) { return `\x1b[48;2;${r};${g};${b}m`; }
function c256(n) { return `\x1b[38;5;${n}m`; }
function c256Bg(n) { return `\x1b[48;5;${n}m`; }

const RESET = '\x1b[0m';

// --- Theme Presets ---
// Each preset has variants keyed by color depth.
// All presets define the 7 semantic roles + reset.

const PRESETS = {
  // NOTE: `glow` role is the bottom brightness anchor used by the session zone.
  // Non-forge themes fall `glow` back to the same value as `text` so the
  // session zone renders correctly without drawing a gradient. Only `forge`
  // expresses the full dark-top/bright-bottom ladder. See spec:
  // docs/superpowers/specs/2026-04-08-hud-color-vertical-gradient.md
  'dark-ansi': {
    '8':         { ok: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m', accent: '\x1b[34m', muted: '\x1b[90m', text: '\x1b[37m', glow: '\x1b[97m', bg: '\x1b[40m', reset: RESET },
    '256':       { ok: c256(35), warn: c256(178), error: c256(160), accent: c256(24), muted: c256(240), text: c256(252), glow: c256(252), bg: c256Bg(234), reset: RESET },
    'truecolor': { ok: rgb(76, 175, 80), warn: rgb(255, 193, 7), error: rgb(244, 67, 54), accent: rgb(70, 110, 140), muted: rgb(117, 117, 117), text: rgb(238, 238, 238), glow: rgb(238, 238, 238), bg: rgbBg(30, 30, 30), reset: RESET },
  },
  'tokyonight-dark': {
    '8':         { ok: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m', accent: '\x1b[34m', muted: '\x1b[90m', text: '\x1b[37m', glow: '\x1b[97m', bg: '\x1b[40m', reset: RESET },
    '256':       { ok: c256(114), warn: c256(215), error: c256(203), accent: c256(111), muted: c256(237), text: c256(189), glow: c256(189), bg: c256Bg(234), reset: RESET },
    'truecolor': { ok: rgb(158, 206, 106), warn: rgb(224, 175, 104), error: rgb(247, 118, 142), accent: rgb(122, 162, 247), muted: rgb(59, 66, 97), text: rgb(169, 177, 214), glow: rgb(169, 177, 214), bg: rgbBg(26, 27, 38), reset: RESET },
  },
  'plain': {
    '8':         { ok: '', warn: '', error: '', accent: '', muted: '', text: '', glow: '', bg: '', reset: '' },
    '256':       { ok: '', warn: '', error: '', accent: '', muted: '', text: '', glow: '', bg: '', reset: '' },
    'truecolor': { ok: '', warn: '', error: '', accent: '', muted: '', text: '', glow: '', bg: '', reset: '' },
  },

  // Catppuccin Mocha: warm dark pastels
  'catppuccin-mocha': {
    '8':         { ok: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m', accent: '\x1b[35m', muted: '\x1b[90m', text: '\x1b[37m', glow: '\x1b[97m', bg: '\x1b[40m', reset: RESET },
    '256':       { ok: c256(114), warn: c256(215), error: c256(210), accent: c256(183), muted: c256(59), text: c256(189), glow: c256(189), bg: c256Bg(235), reset: RESET },
    'truecolor': { ok: rgb(166, 227, 161), warn: rgb(250, 179, 135), error: rgb(243, 139, 168), accent: rgb(203, 166, 247), muted: rgb(69, 71, 90), text: rgb(205, 214, 244), glow: rgb(205, 214, 244), bg: rgbBg(30, 30, 46), reset: RESET },
  },

  // Dracula: vivid purple-accented dark
  'dracula': {
    '8':         { ok: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m', accent: '\x1b[35m', muted: '\x1b[90m', text: '\x1b[37m', glow: '\x1b[97m', bg: '\x1b[40m', reset: RESET },
    '256':       { ok: c256(84), warn: c256(215), error: c256(203), accent: c256(141), muted: c256(61), text: c256(253), glow: c256(253), bg: c256Bg(236), reset: RESET },
    'truecolor': { ok: rgb(80, 250, 123), warn: rgb(255, 184, 108), error: rgb(255, 85, 85), accent: rgb(189, 147, 249), muted: rgb(98, 114, 164), text: rgb(248, 248, 242), glow: rgb(248, 248, 242), bg: rgbBg(40, 42, 54), reset: RESET },
  },

  // Nord: cool blue-grey arctic palette
  'nord': {
    '8':         { ok: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m', accent: '\x1b[36m', muted: '\x1b[90m', text: '\x1b[37m', glow: '\x1b[97m', bg: '\x1b[40m', reset: RESET },
    '256':       { ok: c256(108), warn: c256(179), error: c256(131), accent: c256(110), muted: c256(60), text: c256(253), glow: c256(253), bg: c256Bg(236), reset: RESET },
    'truecolor': { ok: rgb(163, 190, 140), warn: rgb(235, 203, 139), error: rgb(191, 97, 106), accent: rgb(136, 192, 208), muted: rgb(76, 86, 106), text: rgb(216, 222, 233), glow: rgb(216, 222, 233), bg: rgbBg(46, 52, 64), reset: RESET },
  },

  // Forge: warm workshop with a vertical gradient — dark iron at the top
  // (where the face sits), glowing molten-metal cream at the bottom (where
  // the session zone lives). The ladder is locked by spec:
  // docs/superpowers/specs/2026-04-08-hud-color-vertical-gradient.md
  //
  // 256-index ladder (darkest top → lightest bottom):
  //   bg     234  dark iron panel background
  //   accent 24   dim steel-blue — face eyes, forge title (TOP anchor)
  //   muted  241  slate chrome — labels, dividers
  //   ok     65   cool sage — health-ok signal
  //   warn   172  warm ember — attention signal
  //   error  167  coral rust — error signal
  //   text   223  wheat — body text
  //   glow   230  hot cream — session zone (BOTTOM anchor)
  //
  // Any change to these indices must update the spec in the same commit.
  'forge': {
    '8':         { ok: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m', accent: '\x1b[36m', muted: '\x1b[90m', text: '\x1b[37m', glow: '\x1b[97m', bg: '\x1b[40m', reset: RESET },
    '256':       { ok: c256(65),  warn: c256(172), error: c256(167), accent: c256(39),  muted: c256(241), text: c256(223), glow: c256(230), bg: c256Bg(234), reset: RESET },
    'truecolor': { ok: rgb(120, 160, 110), warn: rgb(210, 140, 70), error: rgb(210, 100, 90), accent: rgb(70, 110, 140), muted: rgb(120, 115, 105), text: rgb(220, 205, 175), glow: rgb(250, 240, 215), bg: rgbBg(22, 20, 18), reset: RESET },
  },
};

// --- Palette Resolution ---
function resolvePalette(themeConfig) {
  // NO_COLOR override
  if (isNoColor()) {
    return PRESETS.plain['8'];
  }

  const name = (themeConfig && themeConfig.name) || 'forge';
  const preset = PRESETS[name] || PRESETS['forge'];
  const depth = detectColorDepth();
  return preset[depth] || preset['8'];
}

// --- Colorize Helper ---
// Wraps text with a semantic role's ANSI code + reset.
// If the role code is empty (plain theme), returns bare text.
function colorize(palette, role, text) {
  const code = palette[role];
  if (!code) return text;
  return `${code}${text}${palette.reset}`;
}

// --- Strip ANSI ---
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

// --- Theme Selector (runtime + disk persistence) ---
const path = require('path');
const fs = require('fs');

const PRESET_NAMES = Object.keys(PRESETS);

// Disk persistence: reads/writes plugins/4ge/.data/theme.json
const THEME_FILE = path.join(__dirname, '..', '.data', 'theme.json');

// Module-level in-memory theme — initialized from disk on load
let _currentTheme = (() => {
  try {
    const data = JSON.parse(fs.readFileSync(THEME_FILE, 'utf8'));
    if (data && data.theme && PRESETS[data.theme]) return data.theme;
  } catch {
    // file missing or invalid — use default
  }
  return 'forge';
})();

/**
 * Set the active theme by name. Persists to disk. Returns true if valid, false if rejected.
 * @param {string} name
 * @returns {boolean}
 */
function setTheme(name) {
  if (!PRESETS[name]) return false;
  _currentTheme = name;
  try {
    const dir = path.dirname(THEME_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(THEME_FILE, JSON.stringify({ theme: name, setAt: new Date().toISOString() }, null, 2));
  } catch {
    // disk write failure is non-fatal — in-memory selection still applies
  }
  return true;
}

/**
 * Returns the current theme name string.
 * @returns {string}
 */
function getTheme() {
  return _currentTheme;
}

/**
 * Returns all preset names with the current selection marked.
 * @returns {Array<{ name: string, current: boolean }>}
 */
function listThemes() {
  return PRESET_NAMES.map(name => ({ name, current: name === _currentTheme }));
}

module.exports = {
  isNoColor,
  detectColorDepth,
  resolvePalette,
  colorize,
  stripAnsi,
  PRESETS,
  PRESET_NAMES,
  THEME_FILE,
  RESET,
  rgb,
  rgbBg,
  c256,
  c256Bg,
  setTheme,
  getTheme,
  listThemes,
};
