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

// --- Display width (terminal cells) ---
// stripAnsi(x).length counts UTF-16 code units, not terminal cells: a CJK glyph
// or `⚡` is 1 unit but 2 cells, an emoji is 2 units and 2 cells, an SMP math
// letter is 2 units but 1 cell, and a combining mark is 1 unit but 0 cells.
// displayWidth() is the one width measure for statusline row fitting (fitAnsi
// below) and for the tests that check it. The tables are an abridged,
// conservative cut of Unicode EastAsianWidth W/F plus Emoji_Presentation: a
// doubtful glyph counts wide, so a fitted row can fall a cell short but never
// overflows. Ambiguous-width glyphs (box drawing, braille, ◈ · ↻) count 1, as
// in a non-CJK locale.
const ZERO_WIDTH_RANGES = [
  [0x0300, 0x036F], [0x0483, 0x0489], [0x0591, 0x05BD], [0x0610, 0x061A],
  [0x064B, 0x065F], [0x1AB0, 0x1AFF], [0x1DC0, 0x1DFF], [0x200B, 0x200F],
  [0x2028, 0x202E], [0x2060, 0x2064], [0x20D0, 0x20FF], [0xFE00, 0xFE0F],
  [0xFE20, 0xFE2F], [0xFEFF, 0xFEFF], [0xE0000, 0xE007F], [0xE0100, 0xE01EF],
];
const WIDE_RANGES = [
  [0x1100, 0x115F], [0x231A, 0x231B], [0x2329, 0x232A], [0x23E9, 0x23EC],
  [0x23F0, 0x23F0], [0x23F3, 0x23F3], [0x25FD, 0x25FE], [0x2614, 0x2615],
  [0x2648, 0x2653], [0x267F, 0x267F], [0x2693, 0x2693], [0x26A1, 0x26A1],
  [0x26AA, 0x26AB], [0x26BD, 0x26BE], [0x26C4, 0x26C5], [0x26CE, 0x26CE],
  [0x26D4, 0x26D4], [0x26EA, 0x26EA], [0x26F2, 0x26F3], [0x26F5, 0x26F5],
  [0x26FA, 0x26FA], [0x26FD, 0x26FD], [0x2705, 0x2705], [0x270A, 0x270B],
  [0x2728, 0x2728], [0x274C, 0x274C], [0x274E, 0x274E], [0x2753, 0x2755],
  [0x2757, 0x2757], [0x2795, 0x2797], [0x27B0, 0x27B0], [0x27BF, 0x27BF],
  [0x2B1B, 0x2B1C], [0x2B50, 0x2B50], [0x2B55, 0x2B55], [0x2E80, 0x303E],
  [0x3041, 0x33FF], [0x3400, 0x4DBF], [0x4E00, 0x9FFF], [0xA000, 0xA4CF],
  [0xA960, 0xA97F], [0xAC00, 0xD7A3], [0xF900, 0xFAFF], [0xFE10, 0xFE19],
  [0xFE30, 0xFE6F], [0xFF00, 0xFF60], [0xFFE0, 0xFFE6], [0x16FE0, 0x16FE4],
  [0x17000, 0x18CFF], [0x1B000, 0x1B2FF], [0x1F004, 0x1F004], [0x1F0CF, 0x1F0CF],
  [0x1F18E, 0x1F18E], [0x1F191, 0x1F19A], [0x1F1E6, 0x1F1FF], [0x1F200, 0x1F2FF],
  [0x1F300, 0x1F64F], [0x1F680, 0x1F6FF], [0x1F7E0, 0x1F7EB], [0x1F90C, 0x1F9FF],
  [0x1FA70, 0x1FAFF], [0x20000, 0x2FFFD], [0x30000, 0x3FFFD],
];

function inRanges(cp, ranges) {
  for (const [lo, hi] of ranges) {
    if (cp < lo) return false;
    if (cp <= hi) return true;
  }
  return false;
}

function codePointWidth(cp) {
  if (cp < 0x20 || (cp >= 0x7F && cp < 0xA0)) return 0;
  if (inRanges(cp, ZERO_WIDTH_RANGES)) return 0;
  return inRanges(cp, WIDE_RANGES) ? 2 : 1;
}

// Length of the escape sequence at str[i] (str[i] is ESC): CSI (ESC [ … final
// byte), OSC (ESC ] … BEL or ESC \, e.g. the caps zone's OSC-8 links), a
// charset designation (ESC ( x) or a two-byte escape. An unterminated sequence
// runs to the end of the string, so it is never split.
function escapeLength(str, i) {
  const next = str[i + 1];
  if (next === '[') {
    for (let j = i + 2; j < str.length; j++) {
      const c = str.charCodeAt(j);
      if (c >= 0x40 && c <= 0x7E) return j - i + 1;
    }
    return str.length - i;
  }
  if (next === ']') {
    for (let j = i + 2; j < str.length; j++) {
      if (str[j] === '\x07') return j - i + 1;
      if (str[j] === '\x1b' && str[j + 1] === '\\') return j - i + 2;
    }
    return str.length - i;
  }
  if (next === '(' || next === ')') return Math.min(3, str.length - i);
  return Math.min(2, str.length - i);
}

// Terminal cells a (possibly styled) string occupies. Escape sequences count 0.
// VS16 (U+FE0F) after a 1-cell glyph asks for emoji presentation, so it adds 1.
function displayWidth(str) {
  const s = String(str);
  let width = 0;
  let prev = 0;
  for (let i = 0; i < s.length;) {
    if (s.charCodeAt(i) === 0x1B) { i += escapeLength(s, i); continue; }
    const cp = s.codePointAt(i);
    i += cp > 0xFFFF ? 2 : 1;
    if (cp === 0xFE0F && prev === 1) { width += 1; prev = 2; continue; }
    const w = codePointWidth(cp);
    if (w > 0) prev = w;
    width += w;
  }
  return width;
}

// Fit a styled row into `cols` terminal cells. A row that already fits comes
// back unchanged. Otherwise the visible text is cut at the last whole glyph
// that leaves room for '…': a 2-cell glyph that would straddle the edge is
// dropped, a combining mark stays with its base, and a surrogate pair is never
// split. Escape sequences before the cut are copied whole. If the row carried
// any escape, SGR is reset after the ellipsis and an OSC-8 link left open is
// closed, so no colour or link bleeds past the row.
function fitAnsi(str, cols) {
  const s = String(str);
  if (!(cols > 0)) return '';
  if (displayWidth(s) <= cols) return s;
  const budget = cols - 1;
  let out = '';
  let used = 0;
  let prev = 0;
  let sawEscape = false;
  let linkOpen = false;
  for (let i = 0; i < s.length;) {
    if (s.charCodeAt(i) === 0x1B) {
      const seq = s.slice(i, i + escapeLength(s, i));
      if (seq.startsWith('\x1b]8;')) linkOpen = !/^\x1b\]8;[^;]*;(\x07|\x1b\\)$/.test(seq);
      sawEscape = true;
      out += seq;
      i += seq.length;
      continue;
    }
    const cp = s.codePointAt(i);
    const len = cp > 0xFFFF ? 2 : 1;
    const vs16 = cp === 0xFE0F && prev === 1;
    const w = vs16 ? 1 : codePointWidth(cp);
    if (used + w > budget) break;
    out += s.slice(i, i + len);
    used += w;
    if (vs16) prev = 2;
    else if (w > 0) prev = w;
    i += len;
  }
  out += '\u2026';
  if (sawEscape) out += '\x1b[0m';
  if (linkOpen) out += '\x1b]8;;\x1b\\';
  return out;
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
  displayWidth,
  fitAnsi,
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
