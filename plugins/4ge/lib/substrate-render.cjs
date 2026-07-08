'use strict';

// S527: sanitize caller-supplied base/overlay/word arguments before they are
// composed into combining-mark output — see substrate-sanitize.cjs header
// for the full threat model and strip-boundary rationale. Wired into
// renderPalimpsest, renderStyledPalimpsest, and renderMaxComposition below.
const { sanitizeForOutput } = require('./substrate-sanitize.cjs');

// ---------------------------------------------------------------------------
// Combining Latin Small Letters (U+0363–U+036F)
// Only 13 of the 26 letters are available as combining marks.
// Available: a e i o u c d h m r t v x
// Missing:   b f g j k l n p q s w y z
// ---------------------------------------------------------------------------
const COMBINING_LATIN = {
  a: '\u0363', e: '\u0364', i: '\u0365', o: '\u0366', u: '\u0367',
  c: '\u0368', d: '\u0369', h: '\u036A', m: '\u036B', r: '\u036C',
  t: '\u036D', v: '\u036E', x: '\u036F',
};

// ---------------------------------------------------------------------------
// Enclosing mark codepoints
// ---------------------------------------------------------------------------
const ENCLOSING = {
  circle:      '\u20DD',
  square:      '\u20DE',
  diamond:     '\u20DF',
  prohibition: '\u20E0',
  keycap:      '\u20E3',
  triangle:    '\u20E4',
};

// ---------------------------------------------------------------------------
// Half mark pairs for ligatures spanning two adjacent cells
// ---------------------------------------------------------------------------
const HALF_MARKS = {
  tie:       ['\uFE20', '\uFE21'],
  tilde:     ['\uFE22', '\uFE23'],
  macron:    ['\uFE24', '\uFE25'],
  tieBelow:  ['\uFE28', '\uFE29'],
  solidus:   ['\uFE2A', '\uFE2B'],
};

// ---------------------------------------------------------------------------
// Math Alphanumeric Symbols — contiguous ranges + Letterlike carve-outs
//
// Strategy: build a per-character map for each alphabet.
// For alphabets with carve-outs, explicit exceptions override the naive offset.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Gap table: reserved Math Alphanumeric codepoints → correct Letterlike Symbols
// replacements. Unicode 16.0 assigns these slots as "reserved" and separately
// encodes the intended characters in the Letterlike Symbols block (U+2100–U+214F).
// Any transform that naively computes fromCodePoint(base + offset) will land on
// a reserved codepoint for these letters; _applyGaps() corrects that.
// Source: Unicode 16.0 + probe _runs/substrate-autoresearch/math-alphanumeric-gaps.json
// Affects: Italic (1 gap), Script (11 gaps), Fraktur (5 gaps), Double-Struck (7 gaps).
// Bold, Bold Italic, Bold Script, Bold Fraktur, Sans-Serif*, Monospace: no gaps.
// ---------------------------------------------------------------------------
const MATH_ALPHA_GAPS = {
  // Italic
  0x1D455: '\u210E', // italic h → ℎ (Planck constant)
  // Script uppercase
  0x1D49D: '\u212C', // Script B → ℬ
  0x1D4A0: '\u2130', // Script E → ℰ
  0x1D4A1: '\u2131', // Script F → ℱ
  0x1D4A3: '\u210B', // Script H → ℋ
  0x1D4A4: '\u2110', // Script I → ℐ
  0x1D4A7: '\u2112', // Script L → ℒ
  0x1D4A8: '\u2133', // Script M → ℳ
  0x1D4AB: '\u2118', // Script P → ℘ (Weierstrass p)
  0x1D4AD: '\u211B', // Script R → ℛ
  // Script lowercase
  0x1D4BA: '\u212F', // script e → ℯ
  0x1D4BC: '\u210A', // script g → ℊ
  0x1D4C4: '\u2134', // script o → ℴ
  // Fraktur uppercase
  0x1D506: '\u212D', // Fraktur C → ℭ
  0x1D50B: '\u210C', // Fraktur H → ℌ
  0x1D50C: '\u2111', // Fraktur I → ℑ
  0x1D515: '\u211C', // Fraktur R → ℜ
  0x1D51D: '\u2128', // Fraktur Z → ℨ
  // Double-Struck uppercase
  0x1D53A: '\u2102', // Double-Struck C → ℂ
  0x1D53F: '\u210D', // Double-Struck H → ℍ
  0x1D545: '\u2115', // Double-Struck N → ℕ
  0x1D547: '\u2119', // Double-Struck P → ℙ
  0x1D548: '\u211A', // Double-Struck Q → ℚ
  0x1D549: '\u211D', // Double-Struck R → ℝ
  0x1D551: '\u2124', // Double-Struck Z → ℤ
};

/**
 * Guard a single computed character against the gap table.
 * If the codepoint is reserved, returns the correct Letterlike replacement.
 * @param {string} ch - single character from String.fromCodePoint()
 * @returns {string}
 */
function _applyGaps(ch) {
  return MATH_ALPHA_GAPS[ch.codePointAt(0)] || ch;
}

// Math Bold: fully contiguous — A=U+1D400, a=U+1D41A  (no carve-outs)
function _mathBoldMap() {
  const m = {};
  for (let i = 0; i < 26; i++) {
    m[String.fromCharCode(0x41 + i)] = String.fromCodePoint(0x1D400 + i);
    m[String.fromCharCode(0x61 + i)] = String.fromCodePoint(0x1D41A + i);
  }
  for (let i = 0; i <= 9; i++) {
    m[String.fromCharCode(0x30 + i)] = String.fromCodePoint(0x1D7CE + i);
  }
  return m;
}

// Math Italic: mostly contiguous, but italic h = U+210E (PLANCK CONSTANT)
function _mathItalicMap() {
  const m = {};
  for (let i = 0; i < 26; i++) {
    m[String.fromCharCode(0x41 + i)] = _applyGaps(String.fromCodePoint(0x1D434 + i));
    m[String.fromCharCode(0x61 + i)] = _applyGaps(String.fromCodePoint(0x1D44E + i));
  }
  return m;
}

// Math Script: many carve-outs from Letterlike Symbols block
// Uppercase base: U+1D49C. Lowercase base: U+1D4B6 (after gap for uppercase).
// Letterlike carve-outs (uppercase): B=U+212C, E=U+2130, F=U+2131, H=U+210B, I=U+2110,
//   L=U+2112, M=U+2133, P=U+2118, R=U+211B
// Letterlike carve-outs (lowercase): e=U+212F, g=U+210A, o=U+2134
function _mathScriptMap() {
  const UC_CARVE = {
    B: '\u212C', E: '\u2130', F: '\u2131', H: '\u210B',
    I: '\u2110', L: '\u2112', M: '\u2133', P: '\u2118', R: '\u211B',
  };
  const LC_CARVE = { e: '\u212F', g: '\u210A', o: '\u2134' };

  // Unicode Math Script uppercase: U+1D49C, with gaps at positions that have carve-outs.
  // The Mathematical Script block has gaps — not all code points exist.
  // Actual assigned script uppercase: A C D G J K N O Q S T U V W X Y Z (contiguous from U+1D49C)
  // plus the carve-outs for B E F H I L M P R.
  // The block is defined such that position i corresponds to the i-th letter where gaps are:
  //   offset 1 (B) gap → carve-out U+212C
  //   offset 4 (E) gap → carve-out U+2130
  //   offset 5 (F) gap → carve-out U+2131
  //   offset 7 (H) gap → carve-out U+210B
  //   offset 8 (I) gap → carve-out U+2110
  //   offset 11 (L) gap → carve-out U+2112
  //   offset 12 (M) gap → carve-out U+2133
  //   offset 15 (P) gap → carve-out U+2118
  //   offset 17 (R) gap → carve-out U+211B
  // The assigned codepoints skip those gaps so we can't use a simple i-offset.

  // Build the uppercase map by walking 0..25 and computing the actual codepoint:
  const ucGapSet = new Set([1, 4, 5, 7, 8, 11, 12, 15, 17]); // letter indices with carve-outs
  const m = {};
  let assignedIdx = 0;
  for (let i = 0; i < 26; i++) {
    const letter = String.fromCharCode(0x41 + i);
    if (UC_CARVE[letter]) {
      m[letter] = UC_CARVE[letter];
    } else {
      m[letter] = _applyGaps(String.fromCodePoint(0x1D49C + assignedIdx));
    }
    if (!ucGapSet.has(i)) assignedIdx++;
  }

  // Lowercase script: base U+1D4B6, gaps at e(4) g(6) o(14)
  const lcGapSet = new Set([4, 6, 14]);
  let lcAssignedIdx = 0;
  for (let i = 0; i < 26; i++) {
    const letter = String.fromCharCode(0x61 + i);
    if (LC_CARVE[letter]) {
      m[letter] = LC_CARVE[letter];
    } else {
      m[letter] = _applyGaps(String.fromCodePoint(0x1D4B6 + lcAssignedIdx));
    }
    if (!lcGapSet.has(i)) lcAssignedIdx++;
  }

  return m;
}

// Math Fraktur: uppercase base U+1D504, carve-outs: C=U+212D, H=U+210C, I=U+2111, R=U+211C, Z=U+2128
// Lowercase base: U+1D51E, no carve-outs
function _mathFrakturMap() {
  const UC_CARVE = {
    C: '\u212D', H: '\u210C', I: '\u2111', R: '\u211C', Z: '\u2128',
  };
  const ucGapSet = new Set([2, 7, 8, 17, 25]); // C=2, H=7, I=8, R=17, Z=25
  const m = {};
  let assignedIdx = 0;
  for (let i = 0; i < 26; i++) {
    const letter = String.fromCharCode(0x41 + i);
    if (UC_CARVE[letter]) {
      m[letter] = UC_CARVE[letter];
    } else {
      m[letter] = _applyGaps(String.fromCodePoint(0x1D504 + assignedIdx));
    }
    if (!ucGapSet.has(i)) assignedIdx++;
  }
  for (let i = 0; i < 26; i++) {
    m[String.fromCharCode(0x61 + i)] = String.fromCodePoint(0x1D51E + i);
  }
  return m;
}

// Math Double-Struck: uppercase base U+1D538, carve-outs: C=U+2102, H=U+210D, N=U+2115, P=U+2119, Q=U+211A, R=U+211D, Z=U+2124
// Lowercase base: U+1D552 (contiguous, no carve-outs)
// Digits: U+1D7D8 (contiguous)
function _mathDoubleStruckMap() {
  const UC_CARVE = {
    C: '\u2102', H: '\u210D', N: '\u2115', P: '\u2119', Q: '\u211A', R: '\u211D', Z: '\u2124',
  };
  const ucGapSet = new Set([2, 7, 13, 15, 16, 17, 25]); // C=2, H=7, N=13, P=15, Q=16, R=17, Z=25
  const m = {};
  let assignedIdx = 0;
  for (let i = 0; i < 26; i++) {
    const letter = String.fromCharCode(0x41 + i);
    if (UC_CARVE[letter]) {
      m[letter] = UC_CARVE[letter];
    } else {
      m[letter] = _applyGaps(String.fromCodePoint(0x1D538 + assignedIdx));
    }
    if (!ucGapSet.has(i)) assignedIdx++;
  }
  for (let i = 0; i < 26; i++) {
    m[String.fromCharCode(0x61 + i)] = String.fromCodePoint(0x1D552 + i);
  }
  for (let i = 0; i <= 9; i++) {
    m[String.fromCharCode(0x30 + i)] = String.fromCodePoint(0x1D7D8 + i);
  }
  return m;
}

// Math Monospace: fully contiguous — A=U+1D670, a=U+1D68A, 0=U+1D7F6
function _mathMonospaceMap() {
  const m = {};
  for (let i = 0; i < 26; i++) {
    m[String.fromCharCode(0x41 + i)] = String.fromCodePoint(0x1D670 + i);
    m[String.fromCharCode(0x61 + i)] = String.fromCodePoint(0x1D68A + i);
  }
  for (let i = 0; i <= 9; i++) {
    m[String.fromCharCode(0x30 + i)] = String.fromCodePoint(0x1D7F6 + i);
  }
  return m;
}

// Build all maps once at module load
const MAPS = {
  bold:        _mathBoldMap(),
  italic:      _mathItalicMap(),
  script:      _mathScriptMap(),
  fraktur:     _mathFrakturMap(),
  doubleStruck: _mathDoubleStruckMap(),
  monospace:   _mathMonospaceMap(),
};

// Generic transform: map each character through the given alphabet map, pass through unknowns
function _applyMap(text, map) {
  return [...text].map(ch => map[ch] || ch).join('');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Stack overlay text as combining Latin small letters on top of base text.
 * Skips overlay characters not in the 13-letter combining set.
 *
 * S527: both arguments pass through sanitizeForOutput() first, so a caller
 * cannot smuggle a pre-existing hidden-channel payload into `base` (or a
 * second payload into `overlay`) — the only hidden layer that survives in
 * the output is the one this function itself adds from the (now-clean)
 * `overlay` argument.
 * @param {string} base
 * @param {string} overlay
 * @returns {string}
 */
function renderPalimpsest(base, overlay) {
  const cleanBase = sanitizeForOutput(base);
  const cleanOverlay = sanitizeForOutput(overlay);
  const baseChars = [...cleanBase];
  const overlayChars = [...cleanOverlay];
  return baseChars.map((bch, i) => {
    const och = overlayChars[i];
    if (!och) return bch;
    const combining = COMBINING_LATIN[och.toLowerCase()];
    return combining ? bch + combining : bch;
  }).join('');
}

/**
 * Wrap each character of base with the named enclosing mark.
 * Shapes: circle, square, diamond, prohibition, keycap, triangle.
 * @param {string} base
 * @param {string} shape
 * @returns {string}
 */
function renderEnclosed(base, shape) {
  const mark = ENCLOSING[shape];
  if (!mark) throw new Error(`Unknown enclosing shape: "${shape}". Valid: ${Object.keys(ENCLOSING).join(', ')}`);
  // S528: sanitize base before layering the enclosing mark on top — same
  // input-smuggling rationale as renderPalimpsest (a caller must not be able
  // to pre-seat a hidden-channel payload in `base`). Closes one of the two
  // combining-mark adders left unwired in S527 (adversarial review INFO-2).
  const cleanBase = sanitizeForOutput(base);
  return [...cleanBase].map(ch => ch + mark).join('');
}

/**
 * Maximum composition treatment on a single word.
 * Layers: base word + palimpsest overlay + ligature ties on adjacent pairs + enclosing mark on middle char + scattered diacritics.
 * Pattern inspired by the S245 signoff: f︠ͨo︡ͦ̈r⃝ͧg︢ͬe̲︣ͭ
 * @param {string} word
 * @returns {string}
 */
function renderMaxComposition(word) {
  // S527: sanitize before layering our own combining marks on top — see
  // renderPalimpsest's doc comment for the input-smuggling rationale.
  const cleanWord = sanitizeForOutput(word);
  // Overlay words using the available combining letters (a e i o u c d h m r t v x)
  // We cycle through available overlay chars as a dense cover
  const OVERLAY_CYCLE = ['c', 'o', 'u', 'r', 't'];
  const DIACRITICS = [
    '\u0308', // combining diaeresis (̈)
    '\u0347', // combining equals sign below (͇)
    '\u0307', // combining dot above (̇)
    '\u0332', // combining low line (̲)
    '\u030A', // combining ring above (̊)
  ];

  const chars = [...cleanWord];
  const midIdx = Math.floor(chars.length / 2);

  let result = '';
  for (let i = 0; i < chars.length; i++) {
    let cell = chars[i];

    // Palimpsest: overlay from OVERLAY_CYCLE
    const och = OVERLAY_CYCLE[i % OVERLAY_CYCLE.length];
    const combiningOverlay = COMBINING_LATIN[och];
    if (combiningOverlay) cell += combiningOverlay;

    // Scattered diacritic
    cell += DIACRITICS[i % DIACRITICS.length];

    // Half mark ties: on even indices (except last), add left half of tie
    if (i < chars.length - 1 && i % 2 === 0) {
      cell += HALF_MARKS.tie[0]; // ligature tie left on this cell
    }
    // On odd indices, add right half of tie (closes the span from previous)
    if (i > 0 && i % 2 === 1) {
      cell += HALF_MARKS.tie[1]; // ligature tie right on this cell
    }

    // Enclosing mark on middle character
    if (i === midIdx) {
      cell += ENCLOSING.circle;
    }

    result += cell;
  }

  return result;
}

/**
 * @param {string} text
 * @returns {string}
 */
function renderMathBold(text) { return _applyMap(text, MAPS.bold); }

/**
 * @param {string} text
 * @returns {string}
 */
function renderMathItalic(text) { return _applyMap(text, MAPS.italic); }

/**
 * @param {string} text
 * @returns {string}
 */
function renderMathFraktur(text) { return _applyMap(text, MAPS.fraktur); }

/**
 * @param {string} text
 * @returns {string}
 */
function renderMathScript(text) { return _applyMap(text, MAPS.script); }

/**
 * @param {string} text
 * @returns {string}
 */
function renderMathDoubleStruck(text) { return _applyMap(text, MAPS.doubleStruck); }

/**
 * @param {string} text
 * @returns {string}
 */
function renderMathMonospace(text) { return _applyMap(text, MAPS.monospace); }

/**
 * Render all 6 named Math Alphanumeric alphabets for a given text, one per line.
 * (Used by the /substrate alphabets mode — covers bold, italic, script, fraktur, double-struck, monospace)
 * @param {string} text
 * @returns {string}
 */
function renderAllAlphabets(text) {
  return [
    `bold:         ${renderMathBold(text)}`,
    `italic:       ${renderMathItalic(text)}`,
    `script:       ${renderMathScript(text)}`,
    `fraktur:      ${renderMathFraktur(text)}`,
    `double-struck: ${renderMathDoubleStruck(text)}`,
    `monospace:    ${renderMathMonospace(text)}`,
  ].join('\n');
}

/**
 * Horizontal block bar. Fill character ▓ (U+2593), empty ░ (U+2591).
 * @param {number} percent - 0 to 100
 * @param {number} width   - total bar width in characters
 * @returns {string}
 */
function renderBlockBar(percent, width) {
  const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * width);
  return '\u2593'.repeat(filled) + '\u2591'.repeat(width - filled);
}

/**
 * Join a pair of characters with a half-mark ligature spanning two cells.
 * kind: 'tie' | 'tilde' | 'macron' | 'tieBelow' | 'solidus'
 * @param {string} a    - first character
 * @param {string} b    - second character
 * @param {string} kind - half mark pair name
 * @returns {string}
 */
function renderLigature(a, b, kind) {
  const pair = HALF_MARKS[kind];
  if (!pair) throw new Error(`Unknown ligature kind: "${kind}". Valid: ${Object.keys(HALF_MARKS).join(', ')}`);
  // S528: sanitize both cell characters before joining them with the half-mark
  // pair — a caller must not be able to pre-seat a hidden-channel payload in
  // `a` or `b`. Closes the second of the two combining-mark adders left
  // unwired in S527 (adversarial review INFO-2).
  return sanitizeForOutput(a) + pair[0] + sanitizeForOutput(b) + pair[1];
}

// ---------------------------------------------------------------------------
// Small Caps — BMP styled alphabet
// Sources: Phonetic Extensions (U+1D00–U+1D7F), IPA Extensions (U+0250–U+02AF),
// Latin Extended-D (U+A720–U+A7FF). Matches cookbook §4.4: ꜰᴏʀɢᴇ.
//
// Unlike the Math Alphanumeric alphabets above (all SMP, U+1D400+), every
// small-caps codepoint is BMP — so these bases CAN carry combining marks on
// Termius mobile. This makes small caps the load-bearing alphabet for
// renderStyledPalimpsest below: the only way to get display weight AND a
// combining layer in the same cell without tripping the SMP+combining trap.
//
// Coverage notes:
// - No LATIN LETTER SMALL CAPITAL X exists in Unicode; x falls back to ASCII
//   lowercase 'x' (closest visual weight to the small-caps x-height).
// - Q (ꞯ U+A7AF, Unicode 9.0) has thinner font coverage than the rest;
//   acceptable for HUD labels where q is rare.
// ---------------------------------------------------------------------------
const SMALL_CAPS = {
  a: 'ᴀ', b: 'ʙ', c: 'ᴄ', d: 'ᴅ', e: 'ᴇ',
  f: 'ꜰ', g: 'ɢ', h: 'ʜ', i: 'ɪ', j: 'ᴊ',
  k: 'ᴋ', l: 'ʟ', m: 'ᴍ', n: 'ɴ', o: 'ᴏ',
  p: 'ᴘ', q: 'ꞯ', r: 'ʀ', s: 'ꜱ', t: 'ᴛ',
  u: 'ᴜ', v: 'ᴠ', w: 'ᴡ', x: 'x',      y: 'ʏ',
  z: 'ᴢ',
};

/**
 * Transform text to small caps (BMP — combining-mark-safe).
 * Case-insensitive: 'A' and 'a' both map to ᴀ. Digits/punctuation pass through.
 * @param {string} text
 * @returns {string}
 */
function renderSmallCaps(text) {
  return [...text].map(ch => SMALL_CAPS[ch.toLowerCase()] || ch).join('');
}

/**
 * Transform ASCII text to Full-Width forms (BMP — combining-mark-safe).
 * Printable ASCII U+0021–U+007E maps to U+FF01–U+FF5E (offset +0xFEE0);
 * space maps to U+3000 IDEOGRAPHIC SPACE. Other characters pass through.
 * Full-width characters render 2 cells wide — count them double against the
 * 79-char Bash canvas limit.
 * @param {string} text
 * @returns {string}
 */
function renderFullWidth(text) {
  return [...text].map(ch => {
    const cp = ch.codePointAt(0);
    if (cp === 0x20) return '　';
    if (cp >= 0x21 && cp <= 0x7E) return String.fromCodePoint(cp + 0xFEE0);
    return ch;
  }).join('');
}

// Styles whose output is guaranteed BMP, and therefore safe to receive
// combining marks (cookbook §4.1 rendering gotcha; substrate-canvas.md rule).
const BMP_SAFE_STYLES = {
  plain:     (s) => s,
  smallCaps: renderSmallCaps,
  fullWidth: renderFullWidth,
};

/**
 * Styled palimpsest: weight + combining layer in the same cells.
 *
 * renderPalimpsest can only decorate plain text, because every styled alphabet
 * previously in this lib is SMP (Math Bold/Fraktur/Script/Mono/Double-Struck)
 * and SMP bases break combining marks on Termius — the combination fails
 * grapheme cluster formation and renders replacement glyphs. This function
 * closes that gap by restricting the style choice to BMP-safe alphabets,
 * then layering the overlay word per-cell exactly like renderPalimpsest.
 *
 * Example: renderStyledPalimpsest('CTX', 'act', 'smallCaps') → ᴄͣᴛͨxͭ
 *   (small-caps weight on the base, 'act' riding in the combining layer)
 *
 * @param {string} base    - visible text (each char becomes one styled cell)
 * @param {string} overlay - word carried in the combining layer
 *                           (only a e i o u c d h m r t v x land; rest skip)
 * @param {string} [style] - 'smallCaps' (default) | 'fullWidth' | 'plain'
 * @returns {string}
 * @throws {Error} on SMP/unknown styles, naming the trap explicitly
 */
function renderStyledPalimpsest(base, overlay, style = 'smallCaps') {
  const styler = BMP_SAFE_STYLES[style];
  if (!styler) {
    throw new Error(
      `Unknown or combining-unsafe style: "${style}". Valid: ${Object.keys(BMP_SAFE_STYLES).join(', ')}. ` +
      'SMP alphabets (bold, italic, script, fraktur, doubleStruck, monospace) cannot carry ' +
      'combining marks on Termius — SMP base + combining mark fails grapheme cluster ' +
      'formation and renders replacement glyphs. Use a BMP style.'
    );
  }
  // S527: sanitize both arguments before layering our own combining marks
  // on top — see renderPalimpsest's doc comment for the input-smuggling
  // rationale (identical concern here: base/overlay must not already carry
  // a hidden-channel payload before this function adds the declared one).
  const cleanBase = sanitizeForOutput(base);
  const cleanOverlay = sanitizeForOutput(overlay);
  const baseChars = [...cleanBase];
  const overlayChars = [...cleanOverlay];
  return baseChars.map((bch, i) => {
    const styled = styler(bch);
    const och = overlayChars[i];
    if (!och) return styled;
    const mark = COMBINING_LATIN[och.toLowerCase()];
    return mark ? styled + mark : styled;
  }).join('');
}

// ---------------------------------------------------------------------------
// ANSI color helpers — extracted from chart probe scripts for shared use
// ---------------------------------------------------------------------------

/** Set 256-color foreground. */
const fg256 = (n) => `\x1b[38;5;${n}m`;

/** Set 256-color background. */
const bg256 = (n) => `\x1b[48;5;${n}m`;

/** Set 24-bit truecolor foreground. */
const fg24 = (r, g, b) => `\x1b[38;2;${r};${g};${b}m`;

/** Set 24-bit truecolor background. */
const bg24 = (r, g, b) => `\x1b[48;2;${r};${g};${b}m`;

/** Reset all ANSI attributes. */
const ANSI_RST = '\x1b[0m';

/** ANSI bold on. */
const ANSI_BOLD = '\x1b[1m';

/** ANSI dim on. */
const ANSI_DIM = '\x1b[2m';

// ---------------------------------------------------------------------------
// Braille pixel buffer — 2 dots wide x 4 dots tall per character cell
// Dot-to-bit mapping follows the Unicode braille standard (U+2800 base):
//   col 0 rows 0-3 -> bits 0,1,2,6
//   col 1 rows 0-3 -> bits 3,4,5,7
// ---------------------------------------------------------------------------

const _BRAILLE_BIT_MAP = [
  [0, 1, 2, 6],  // dotCol 0
  [3, 4, 5, 7],  // dotCol 1
];

/**
 * Create a braille pixel buffer for 2D dot-resolution drawing.
 * Width and height are in pixels; each character cell covers 2x4 pixels.
 * Returns an object with set(x,y), get(x,y), and render(colorFn) methods.
 * @param {number} pixelWidth  - canvas width in pixels (chars = ceil(w/2))
 * @param {number} pixelHeight - canvas height in pixels (chars = ceil(h/4))
 * @returns {{ set: Function, get: Function, render: Function, cellCols: number, cellRows: number, pixelWidth: number, pixelHeight: number }}
 */
function createBrailleBuffer(pixelWidth, pixelHeight) {
  const cellCols = Math.ceil(pixelWidth / 2);
  const cellRows = Math.ceil(pixelHeight / 4);
  const buf = {};

  /**
   * Set a pixel dot at (px, py). Out-of-bounds coords are silently ignored.
   * @param {number} px
   * @param {number} py
   */
  function set(px, py) {
    if (px < 0 || py < 0 || px >= pixelWidth || py >= pixelHeight) return;
    const cellCol = Math.floor(px / 2);
    const cellRow = Math.floor(py / 4);
    const key = `${cellCol},${cellRow}`;
    if (!buf[key]) buf[key] = 0;
    buf[key] |= (1 << _BRAILLE_BIT_MAP[px % 2][py % 4]);
  }

  /**
   * Get the accumulated bit value for the cell containing pixel (px, py).
   * Returns 0 for empty or out-of-bounds cells.
   * @param {number} px
   * @param {number} py
   * @returns {number}
   */
  function get(px, py) {
    if (px < 0 || py < 0 || px >= pixelWidth || py >= pixelHeight) return 0;
    return buf[`${Math.floor(px / 2)},${Math.floor(py / 4)}`] || 0;
  }

  /**
   * Render the buffer to an array of strings (one per cell row).
   * colorFn receives the accumulated bit value (0-255) for each non-empty cell
   * and returns an ANSI prefix string, or null/undefined to skip coloring.
   * @param {function(number): string|null} [colorFn]
   * @returns {string[]}
   */
  function render(colorFn) {
    const lines = [];
    for (let r = 0; r < cellRows; r++) {
      let line = '';
      for (let c = 0; c < cellCols; c++) {
        const bits = buf[`${c},${r}`] || 0;
        const ch = String.fromCodePoint(0x2800 + bits);
        if (colorFn && bits !== 0) {
          const ansi = colorFn(bits);
          line += ansi ? ansi + ch + ANSI_RST : ch;
        } else {
          line += ch;
        }
      }
      lines.push(line);
    }
    return lines;
  }

  return { set, get, render, cellCols, cellRows, pixelWidth, pixelHeight };
}

// ---------------------------------------------------------------------------
// Chart rendering helpers
// ---------------------------------------------------------------------------

// Sub-block chars at 1/8-cell resolution: index 1-8 -> U+258F..U+2588
const _SUB_BLOCKS = [' ', '\u258F', '\u258E', '\u258D', '\u258C', '\u258B', '\u258A', '\u2589', '\u2588'];

/**
 * Render a colored horizontal bar using sub-block fill characters.
 * Produces a smooth leading edge at 1/8-cell resolution. Pads remainder with spaces.
 * @param {number} value    - current value
 * @param {number} max      - maximum value (bar fills completely when value >= max)
 * @param {number} width    - bar width in terminal characters
 * @param {number} color256 - 256-color palette index for the filled portion
 * @returns {string}
 */
function hbar(value, max, width, color256) {
  const fraction = Math.max(0, Math.min(1, value / (max || 1)));
  const totalEighths = Math.round(fraction * width * 8);
  const fullCells = Math.floor(totalEighths / 8);
  const remainder = totalEighths % 8;
  const color = fg256(color256);
  let bar = color + '\u2588'.repeat(fullCells);
  if (remainder > 0 && fullCells < width) {
    bar += _SUB_BLOCKS[remainder];
  }
  bar += ANSI_RST;
  const filledCells = fullCells + (remainder > 0 ? 1 : 0);
  bar += ' '.repeat(Math.max(0, width - filledCells));
  return bar;
}

/**
 * Render an inline sparkline using braille 2x4 pixel encoding.
 * Each output character covers 2 horizontal samples x 4 vertical levels,
 * giving higher resolution than block-glyph approaches.
 * Values are auto-normalized to the series min/max.
 * @param {number[]} values - data series (at least 1 element)
 * @param {number}   width  - output width in terminal characters
 * @returns {string}
 */
function sparkline(values, width) {
  if (!values || values.length === 0) return '\u2800'.repeat(width);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  // One cell row = 4 pixel rows for an inline sparkline.
  const pixW = width * 2;
  const pixH = 4;
  const braille = createBrailleBuffer(pixW, pixH);

  for (let i = 0; i < pixW; i++) {
    const dataIdx = Math.min(values.length - 1, Math.floor((i / pixW) * values.length));
    const norm = (values[dataIdx] - min) / range;
    // py=0 is top; high norm -> low py
    const py = Math.max(0, Math.min(pixH - 1, Math.round((1 - norm) * (pixH - 1))));
    braille.set(i, py);
  }

  return capBrailleDensity(braille.render(null)[0]);
}

/**
 * Render a progress bar with a percentage label appended.
 * Uses full-block fill (U+2588) and light-shade track (U+2591).
 * @param {number} ratio    - progress as a fraction in [0, 1]
 * @param {number} width    - bar width in terminal characters (label appended after)
 * @param {number} color256 - 256-color palette index for the filled portion
 * @returns {string}
 */
function progressBar(ratio, width, color256) {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  const color = fg256(color256);
  const pctLabel = ` ${Math.round(clamped * 100)}%`;
  return color + '\u2588'.repeat(filled) + ANSI_RST + '\u2591'.repeat(empty) + pctLabel;
}

// ---------------------------------------------------------------------------
// Cold ramp \u2014 value\u2192color mapping for chart primitives
//
// A violet\u2192cyan "cold energy" ramp anchored on the two 4ge brand colors:
// purple #5f5fff (256 index 63, the companion left eye) and blue #00afff
// (256 index 39, the companion right eye). Low values render deep violet,
// high values bright cyan. Honors the ANSI survival list \u2014 every code below is
// a 256-color or 24-bit foreground sequence (both survive Ink's response-text
// stripping; only underline is removed, per substrate-canvas.md "ANSI in Bash
// surface"). Deliberately blue/purple, never yellow-face/emoji
// (feedback_no-yellow-face-art). Ordered low\u2192high.
// ---------------------------------------------------------------------------
const COLD_RAMP_256 = [57, 63, 33, 39, 45, 51];

// Truecolor anchors for the same 6 stops (xterm-256 index \u2192 sRGB), interpolated
// by rampRgb() for smooth 24-bit gradients.
const COLD_RAMP_STOPS = [
  [95, 0, 255],    // 57  #5f00ff  blue-violet
  [95, 95, 255],   // 63  #5f5fff  brand purple (left eye)
  [0, 135, 255],   // 33  #0087ff  blue
  [0, 175, 255],   // 39  #00afff  brand blue (right eye)
  [0, 215, 255],   // 45  #00d7ff  cyan
  [0, 255, 255],   // 51  #00ffff  bright cyan
];

/**
 * Clamp a value into the [0, 1] range (NaN \u2192 0).
 * @param {number} n
 * @returns {number}
 */
function _clamp01(n) {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Map a normalized value to a 256-color index on the cold ramp.
 * @param {number} norm - normalized value in [0, 1]
 * @returns {number} xterm-256 color index
 */
function rampColor256(norm) {
  const t = _clamp01(norm);
  const idx = Math.round(t * (COLD_RAMP_256.length - 1));
  return COLD_RAMP_256[idx];
}

/**
 * Map a normalized value to a 24-bit {r,g,b} color by linear interpolation
 * between the cold-ramp anchor stops.
 * @param {number} norm - normalized value in [0, 1]
 * @returns {{ r: number, g: number, b: number }}
 */
function rampRgb(norm) {
  const t = _clamp01(norm);
  const stops = COLD_RAMP_STOPS;
  const pos = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(pos));
  const frac = pos - i;
  const a = stops[i];
  const b = stops[i + 1];
  return {
    r: Math.round(a[0] + (b[0] - a[0]) * frac),
    g: Math.round(a[1] + (b[1] - a[1]) * frac),
    b: Math.round(a[2] + (b[2] - a[2]) * frac),
  };
}

/**
 * Return an ANSI foreground escape for a normalized value on the cold ramp.
 * @param {number} norm    - normalized value in [0, 1]
 * @param {string} [depth] - '256' (default) | 'truecolor'
 * @returns {string} ANSI escape prefix (pair with ANSI_RST)
 */
function rampColor(norm, depth = '256') {
  if (depth === 'truecolor') {
    const { r, g, b } = rampRgb(norm);
    return fg24(r, g, b);
  }
  return fg256(rampColor256(norm));
}

/**
 * Wrap text with the cold-ramp color for a normalized value, then reset.
 * @param {string} text
 * @param {number} norm    - normalized value in [0, 1]
 * @param {string} [depth] - '256' (default) | 'truecolor'
 * @returns {string}
 */
function colorizeRamp(text, norm, depth = '256') {
  return rampColor(norm, depth) + text + ANSI_RST;
}

/**
 * Color a single glyph per the shared opts.color contract used by blockRamp and
 * the braille chart cells. Returns the bare glyph when color is falsy.
 *   'ramp'      \u2192 per-value cold gradient (colorizeRamp)
 *   number      \u2192 solid 256-color index
 *   function    \u2192 (norm, value) => ANSI prefix (falsy prefix \u21d2 no color)
 * @param {string} glyph
 * @param {number} norm
 * @param {number|null} value
 * @param {(string|number|function|null)} color
 * @param {string} depth
 * @returns {string}
 */
function _colorGlyph(glyph, norm, value, color, depth) {
  if (color == null || color === false) return glyph;
  if (color === 'ramp') return colorizeRamp(glyph, norm, depth);
  if (typeof color === 'number') return fg256(color) + glyph + ANSI_RST;
  if (typeof color === 'function') {
    const prefix = color(norm, value);
    return prefix ? prefix + glyph + ANSI_RST : glyph;
  }
  return glyph;
}

// ---------------------------------------------------------------------------
// Resampler \u2014 shared by blockRamp and brailleChart
// ---------------------------------------------------------------------------

/**
 * Drop non-finite samples (NaN / ±Infinity) from a series. A single bad
 * sample would otherwise poison the Math.min/Math.max auto-domain and
 * flatten the whole chart to baseline; charts render from the finite
 * samples only. Returns the original array when already clean (no alloc
 * on the hot path).
 * @param {number[]} values
 * @returns {number[]}
 */
function _finiteSeries(values) {
  if (!values) return values;
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) return values.filter(Number.isFinite);
  }
  return values;
}

/**
 * Resample a numeric series to exactly `width` buckets. Downsampling averages
 * the source samples in each bucket; upsampling repeats the nearest sample.
 * Returns a new array of length `width` (empty for width <= 0).
 * @param {number[]} values
 * @param {number}   width
 * @returns {number[]}
 */
function _resample(values, width) {
  if (width <= 0) return [];
  if (values.length === width) return values.slice();
  const out = new Array(width);
  for (let i = 0; i < width; i++) {
    const start = Math.floor((i / width) * values.length);
    const end = Math.max(start + 1, Math.ceil(((i + 1) / width) * values.length));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end && j < values.length; j++) {
      sum += values[j];
      count++;
    }
    out[i] = count > 0 ? sum / count : values[Math.min(values.length - 1, start)];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Block-ramp sparkline \u2014 lower-block glyphs \u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588 (U+2581\u2013U+2588)
//
// The misrender-safe fallback for the braille sparkline: one glyph per sample
// (or resampled to a fixed width), 8 vertical levels. Braille packs 2\u00d74 dots
// per cell for higher density but breaks on terminals/fonts without braille
// coverage; these BMP block glyphs render everywhere. Auto-scales to the series
// min/max unless an explicit domain is supplied.
// ---------------------------------------------------------------------------

// Index 0..7 \u2192 \u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588. The series min (and a flat series) render \u2581 so the
// baseline stays visible; only genuinely empty output uses a space.
const _RAMP_BLOCKS = ['\u2581', '\u2582', '\u2583', '\u2584', '\u2585', '\u2586', '\u2587', '\u2588'];

/**
 * Render a block-ramp sparkline from a numeric series.
 * One glyph per sample by default; pass opts.width to resample to a fixed
 * width. Values auto-scale to the series min/max (override with opts.min /
 * opts.max). A flat series renders as a flat baseline row.
 *
 * @param {number[]} values      - data series
 * @param {object}   [opts]
 * @param {number}   [opts.width] - output width in glyphs (default = values.length)
 * @param {number}   [opts.min]   - domain minimum (default = series min)
 * @param {number}   [opts.max]   - domain maximum (default = series max)
 * @param {(string|number|function)} [opts.color] - 'ramp' for a per-glyph cold
 *   gradient, a 256-color index for a solid color, or a
 *   (norm, value) => ANSI prefix function. Omit for uncolored output.
 * @param {string}   [opts.depth] - '256' (default) | 'truecolor' (ramp coloring)
 * @returns {string}
 */
function blockRamp(values, opts = {}) {
  const finite = _finiteSeries(values);
  const width = opts.width != null
    ? Math.max(0, Math.floor(opts.width))
    : (finite ? finite.length : 0);
  if (!finite || finite.length === 0 || width === 0) return ' '.repeat(width);

  const series = _resample(finite, width);
  const min = opts.min != null ? opts.min : Math.min(...series);
  const max = opts.max != null ? opts.max : Math.max(...series);
  const range = max - min || 1;
  const depth = opts.depth || '256';

  let out = '';
  for (let i = 0; i < series.length; i++) {
    const norm = _clamp01((series[i] - min) / range);
    const idx = Math.round(norm * (_RAMP_BLOCKS.length - 1));
    out += _colorGlyph(_RAMP_BLOCKS[idx], norm, series[i], opts.color, depth);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Braille line / area chart \u2014 multi-row 2\u00d74-dot canvas
//
// The high-density sibling of blockRamp: each cell packs 2 horizontal samples \u00d7
// 4 vertical levels (createBrailleBuffer), and the chart can be several cells
// tall for real vertical resolution. 'line' plots the curve; 'area' (the
// density band) fills every dot from the curve down to the baseline. Per-column
// coloring follows the same opts.color contract as blockRamp.
// ---------------------------------------------------------------------------

/**
 * Render a multi-row braille chart from a numeric series.
 * Returns an array of `height` strings, top row first. Auto-scales to the
 * series min/max unless a domain is supplied.
 *
 * @param {number[]} values       - data series
 * @param {object}   [opts]
 * @param {number}   [opts.width]  - width in cells (default = ceil(values.length / 2))
 * @param {number}   [opts.height] - height in cells (default 1)
 * @param {string}   [opts.mode]   - 'line' (default) | 'area'
 * @param {number}   [opts.min]    - domain minimum (default = series min)
 * @param {number}   [opts.max]    - domain maximum (default = series max)
 * @param {(string|number|function)} [opts.color] - 'ramp' | 256 index | (norm,value)=>ANSI
 * @param {string}   [opts.depth]  - '256' (default) | 'truecolor'
 * @returns {string[]}
 */
function brailleChart(values, opts = {}) {
  const height = Math.max(1, Math.floor(opts.height || 1));
  const finite = _finiteSeries(values);
  const cellCols = opts.width != null
    ? Math.max(0, Math.floor(opts.width))
    : Math.ceil((finite ? finite.length : 0) / 2);

  if (!finite || finite.length === 0 || cellCols === 0) {
    return new Array(height).fill('\u2800'.repeat(cellCols));
  }

  const pixW = cellCols * 2;
  const pixH = height * 4;
  const series = _resample(finite, pixW);
  const min = opts.min != null ? opts.min : Math.min(...series);
  const max = opts.max != null ? opts.max : Math.max(...series);
  const range = max - min || 1;
  const mode = opts.mode || 'line';
  const depth = opts.depth || '256';

  const buf = createBrailleBuffer(pixW, pixH);
  // Per-cell-column normalized value (mean of the 2 dot-columns in the cell) \u2014
  // drives ramp/solid coloring so a cell's color tracks the data it draws.
  const colNorm = new Array(cellCols).fill(0);
  const colCount = new Array(cellCols).fill(0);

  let prevPy = null;
  for (let x = 0; x < pixW; x++) {
    const norm = _clamp01((series[x] - min) / range);
    // py=0 is the top pixel row; a high value sits near the top.
    const pyTop = Math.max(0, Math.min(pixH - 1, Math.round((1 - norm) * (pixH - 1))));
    if (mode === 'area') {
      for (let py = pyTop; py < pixH; py++) buf.set(x, py);
    } else if (prevPy === null) {
      buf.set(x, pyTop);
    } else {
      // Connected line: bridge the vertical gap to the previous sample so the
      // curve reads continuous instead of as scattered dots at height > 1.
      const lo = Math.min(prevPy, pyTop);
      const hi = Math.max(prevPy, pyTop);
      for (let py = lo; py <= hi; py++) buf.set(x, py);
    }
    prevPy = pyTop;
    const c = Math.floor(x / 2);
    colNorm[c] += norm;
    colCount[c] += 1;
  }
  for (let c = 0; c < cellCols; c++) {
    if (colCount[c] > 0) colNorm[c] /= colCount[c];
  }

  const rawLines = buf.render(null);
  if (opts.color == null || opts.color === false) return rawLines;
  return rawLines.map(line => _colorizeBrailleCells(line, colNorm, opts.color, depth));
}

/**
 * Area / density-band convenience: brailleChart in 'area' mode.
 * @param {number[]} values
 * @param {object}   [opts] - same as brailleChart (mode is forced to 'area')
 * @returns {string[]}
 */
function brailleBand(values, opts = {}) {
  return brailleChart(values, { ...opts, mode: 'area' });
}

/**
 * Color each non-blank braille cell of a rendered row by its column's
 * normalized value. Blank cells (U+2800) pass through uncolored to keep the
 * escape count low.
 * @param {string}   line    - one rendered braille row (cellCols codepoints)
 * @param {number[]} colNorm - per-column normalized value
 * @param {(string|number|function)} color
 * @param {string}   depth
 * @returns {string}
 */
function _colorizeBrailleCells(line, colNorm, color, depth) {
  const cells = [...line];
  let out = '';
  for (let c = 0; c < cells.length; c++) {
    const ch = cells[c];
    if (ch.codePointAt(0) === 0x2800) { out += ch; continue; }
    out += _colorGlyph(ch, colNorm[c] != null ? colNorm[c] : 0, null, color, depth);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Braille density guard
// ---------------------------------------------------------------------------

/**
 * Cap the number of braille codepoints (U+2800–U+28FF) in a string.
 * If the count exceeds maxCodepoints, the string is truncated and '…' appended.
 * Non-braille characters are preserved and do not count toward the limit.
 * @param {string} text
 * @param {number} maxCodepoints - default 100
 * @returns {string}
 */
function capBrailleDensity(text, maxCodepoints = 100) {
  const chars = [...text]; // iterate by codepoint (handles surrogates correctly)
  let brailleCount = 0;
  const result = [];
  for (const ch of chars) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x2800 && cp <= 0x28FF) {
      if (brailleCount >= maxCodepoints) {
        result.push('\u2026'); // horizontal ellipsis
        return result.join('');
      }
      brailleCount++;
    }
    result.push(ch);
  }
  return result.join('');
}

module.exports = {
  renderPalimpsest,
  renderEnclosed,
  renderMaxComposition,
  renderMathBold,
  renderMathItalic,
  renderMathFraktur,
  renderMathScript,
  renderMathDoubleStruck,
  renderMathMonospace,
  renderAllAlphabets,
  renderBlockBar,
  renderLigature,
  // BMP styled alphabets + styled palimpsest (combining-mark-safe)
  renderSmallCaps,
  renderFullWidth,
  renderStyledPalimpsest,
  // ANSI helpers
  fg256,
  bg256,
  fg24,
  bg24,
  ANSI_RST,
  ANSI_BOLD,
  ANSI_DIM,
  // Chart rendering
  createBrailleBuffer,
  hbar,
  sparkline,
  progressBar,
  blockRamp,
  brailleChart,
  brailleBand,
  // Cold ramp color helpers (value → blue/purple gradient, survival-list safe)
  COLD_RAMP_256,
  COLD_RAMP_STOPS,
  rampColor256,
  rampRgb,
  rampColor,
  colorizeRamp,
  // Braille density guard
  capBrailleDensity,
  // Expose gap table for tests (reserved codepoint -> correct Letterlike replacement)
  MATH_ALPHA_GAPS,
  // Expose internal maps for tests
  _COMBINING_LATIN: COMBINING_LATIN,
  _ENCLOSING: ENCLOSING,
  _HALF_MARKS: HALF_MARKS,
  _SMALL_CAPS: SMALL_CAPS,
};
