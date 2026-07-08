'use strict';

// ---------------------------------------------------------------------------
// substrate-sanitize.cjs
//
// Origin: docs/superpowers/specs/2026-04-12-os-stabilization-phase2.md, Item 2
// ("Substrate Transcript Security"), blocker 5 — "Combining-mark palimpsest
// attack (visible word carrying a hidden directive via U+0363-U+036F)".
// S526 grading (_runs/s526/spec-pointer-grading.md) flagged this as a LIVE
// gap: the exact threat the spec warned about was later shipped as a
// first-class creative technique (S245/S246 substrate-cookbook.md,
// renderPalimpsest / renderStyledPalimpsest / renderMaxComposition in
// substrate-render.cjs) with no sanitizer ever built. This module is that
// sanitizer, scoped to the OUTPUT paths only (S527 operator-approved cut):
// render functions + the HUD substrate zone, not the full 5-blocker /
// 4-forge-action program the original spec described.
//
// THREAT MODEL
// ------------
// Several Unicode codepoint ranges can carry a "hidden" payload riding on,
// or invisible alongside, ordinary visible text:
//
//   1. Combining-mark letter sequences — U+0363-036F (13 combining Latin
//      small letters used by this codebase's own palimpsest technique to
//      spell an overlay word), U+FE20-FE2F (combining half marks / ligature
//      spans), U+20DD-20E4 (combining enclosing marks). All three ride on a
//      preceding base character and are easy to skim past.
//   2. Zero-width family — U+200B ZERO WIDTH SPACE, U+200C ZERO WIDTH
//      NON-JOINER, U+200D ZERO WIDTH JOINER, U+2060 WORD JOINER, U+FEFF
//      ZERO WIDTH NO-BREAK SPACE (BOM). Individually invisible; can carry
//      binary-style payloads or simply pad/split tokens undetectably.
//   3. Unicode Tags block — U+E0000-E007F (Plane 14). Each tag codepoint
//      mirrors an ASCII value (codepoint - 0xE0000 = ascii byte); the block
//      renders as nothing in virtually every font, making it a channel for
//      smuggling arbitrary ASCII text that is completely invisible next to
//      a normal-looking base character (the public "ASCII smuggling" /
//      "invisible flag emoji" technique).
//   4. Anomalous variation-selector runs — standard Variation Selectors
//      (U+FE00-FE0F, 16 codepoints, byte range 0x00-0x0F) and Variation
//      Selectors Supplement (U+E0100-E01EF, 240 codepoints, byte range
//      0x10-0xFF). A single trailing VS16 after an ambiguous emoji base is
//      the ordinary "render as emoji not text" signal (REF-SUBSTRATE-001
//      "Colored Emoji" entry); a RUN of 2+ selectors (or any Supplement-
//      block usage, which has no legitimate standalone use in HUD/substrate
//      text) is the steganographic byte-stuffing pattern — each selector
//      encodes one byte of a hidden payload.
//   5. Invisible format & bidi controls — U+00AD SOFT HYPHEN, U+061C ARABIC
//      LETTER MARK, U+180E MONGOLIAN VOWEL SEPARATOR, U+200E/200F LRM/RLM,
//      U+202A-202E bidi embeddings/overrides and U+2066-2069 bidi isolates
//      (the Trojan-Source family, CVE-2021-42574 — reorders what a reviewer
//      reads vs what the machine sees), U+2061-2064 invisible math
//      operators, U+3164/U+FFA0 Hangul fillers. All render as nothing (or
//      silently reorder text) and carry the same smuggling risk as family
//      (2). Added S527 after adversarial review MAJOR-1
//      (_runs/s527/palimpsest-adversarial-review.md) — the original
//      4-family cut was under-inclusive by its own criterion.
//
// The denylist is CURATED, NOT EXHAUSTIVE — Unicode has more places to hide
// (e.g. ordinary combining diacritics U+0300-0362 abused as carriers,
// interlinear annotation controls U+FFF9-FFFB, exotic space variants). Do
// not describe this module as "unicode smuggling: CLOSED"; it closes the
// families enumerated above at specific internal call sites.
//
// STRIP BOUNDARY — deliberate, not an oversight
// ----------------------------------------------
// strip()/sanitizeForOutput() remove ALL codepoints in the five families
// above, unconditionally, every time — no "just one is fine" leniency. That
// is a correct and intentionally strict choice ONLY because of where this
// module is wired in: the `base`/`overlay`/`word` arguments to
// renderPalimpsest/renderStyledPalimpsest/renderMaxComposition, and the
// live-state strings hud-zone-substrate.cjs reads out of `state`, are all
// INPUT to a controlled internal API — never expected to already carry
// combining marks, zero-width chars, tags, or variation selectors before
// this codebase's own render functions add them as OUTPUT. Three specific
// things this boundary knowingly breaks, and why each is safe in scope:
//
//   (a) U+0363-036F is stripped; the much more common combining diacritics
//       (U+0300 grave, U+0301 acute, U+0303 tilde, U+0308 diaeresis, U+0327
//       cedilla, etc. — all below 0x363) are NOT. "café", "naïve", "piñata",
//       "Zürich" use precomposed Latin-1 Supplement characters (é U+00E9,
//       ï U+00EF, ñ U+00F1, ü U+00FC) or, if NFD-decomposed, combining marks
//       below U+0363 — neither collides with the stripped range. Normal
//       multilingual/accented text survives untouched.
//   (b) The strip is blanket across all 16 standard variation selectors,
//       including a LONE U+FE0F. A single legitimate "render as emoji"
//       VS16 attached to an ambiguous base would also be removed. Safe here
//       because every emoji this codebase's substrate output actually uses
//       (🟢🟡🔴⬛⬜🟥🟧🟨🟩🟦🟪) is an unambiguous single codepoint that
//       already renders as emoji by default — none require or carry VS16.
//   (c) Stripping U+200D breaks ZWJ emoji sequences (e.g. a family/rainbow
//       flag emoji built from several codepoints joined with ZWJ). Safe
//       here for the same reason as (b): no ZWJ sequence is in legitimate
//       use anywhere in this codebase's substrate/HUD output today.
//   (d) Stripping the family-(5) bidi controls breaks legitimate RTL /
//       mixed-direction text, and stripping U+00AD removes legitimate
//       hyphenation hints. Safe here because substrate/HUD output at these
//       call sites is ASCII/box-drawing/emoji English-only — no RTL text or
//       soft-hyphenation is in legitimate use.
//
// If a future legitimate use case needs any of (a)-(d) inside render input,
// that is a scope change for this module (widen an allow-list), not a
// reason to weaken the default here.
//
// detectHidden()/decodePalimpsest() are the separate AUDIT side of this
// module — they run on arbitrary text (including this codebase's own
// already-rendered output, which legitimately contains the declared
// overlay's combining marks) and report everything found, unconditionally,
// so an operator/reviewer can see what a string actually carries. They do
// not gate stripping; strip() always removes every family regardless of
// how "anomalous" a given occurrence looks — the `anomalous` flag on
// variation-selector findings is metadata for a human reader, not a
// stripping decision.
// ---------------------------------------------------------------------------

// Reverse of substrate-render.cjs's COMBINING_LATIN table (letter -> mark).
// Kept as a local literal rather than importing substrate-render.cjs, to
// avoid a require cycle (substrate-render.cjs requires this module).
const COMBINING_LATIN_REVERSE = {
  0x0363: 'a', 0x0364: 'e', 0x0365: 'i', 0x0366: 'o', 0x0367: 'u',
  0x0368: 'c', 0x0369: 'd', 0x036A: 'h', 0x036B: 'm', 0x036C: 'r',
  0x036D: 't', 0x036E: 'v', 0x036F: 'x',
};

// Named half marks (Combining Half Marks block, U+FE20-FE2F). Not every
// codepoint in the 16-wide block is exercised by substrate-render.cjs today,
// but detection covers the whole assigned block for completeness.
const HALF_MARK_NAMES = {
  0xFE20: 'ligature-left', 0xFE21: 'ligature-right',
  0xFE22: 'double-tilde-left', 0xFE23: 'double-tilde-right',
  0xFE24: 'macron-left', 0xFE25: 'macron-right',
  0xFE26: 'conjoining-macron',
  0xFE27: 'ligature-left-below', 0xFE28: 'ligature-right-below',
  0xFE29: 'tilde-left-below', 0xFE2A: 'tilde-right-below',
  0xFE2B: 'macron-left-below', 0xFE2C: 'macron-right-below',
  0xFE2D: 'conjoining-macron-below',
  0xFE2E: 'cyrillic-titlo-left', 0xFE2F: 'cyrillic-titlo-right',
};

// Named enclosing marks (U+20DD-20E4) — matches substrate-render.cjs's
// ENCLOSING table naming where it overlaps (circle/square/diamond/
// prohibition/keycap/triangle), plus the two codepoints in the range that
// table doesn't name (U+20E1, U+20E2).
const ENCLOSING_NAMES = {
  0x20DD: 'circle', 0x20DE: 'square', 0x20DF: 'diamond',
  0x20E0: 'prohibition', 0x20E1: 'anticlockwise-arrow-above',
  0x20E2: 'screen', 0x20E3: 'keycap', 0x20E4: 'triangle',
};

const ZERO_WIDTH_NAMES = {
  0x200B: 'ZERO WIDTH SPACE',
  0x200C: 'ZERO WIDTH NON-JOINER',
  0x200D: 'ZERO WIDTH JOINER',
  0x2060: 'WORD JOINER',
  0xFEFF: 'ZERO WIDTH NO-BREAK SPACE (BOM)',
};
const ZERO_WIDTH_CODEPOINTS = new Set(Object.keys(ZERO_WIDTH_NAMES).map(Number));

// Family (5): invisible format & bidi controls (S527 adversarial-review
// MAJOR-1 closure). Reported one finding per occurrence, like zero-width —
// each is a standalone control, not part of a spelled word.
const FORMAT_CONTROL_NAMES = {
  0x00AD: 'SOFT HYPHEN',
  0x061C: 'ARABIC LETTER MARK',
  0x180E: 'MONGOLIAN VOWEL SEPARATOR',
  0x200E: 'LEFT-TO-RIGHT MARK',
  0x200F: 'RIGHT-TO-LEFT MARK',
  0x202A: 'LEFT-TO-RIGHT EMBEDDING',
  0x202B: 'RIGHT-TO-LEFT EMBEDDING',
  0x202C: 'POP DIRECTIONAL FORMATTING',
  0x202D: 'LEFT-TO-RIGHT OVERRIDE',
  0x202E: 'RIGHT-TO-LEFT OVERRIDE',
  0x2061: 'FUNCTION APPLICATION',
  0x2062: 'INVISIBLE TIMES',
  0x2063: 'INVISIBLE SEPARATOR',
  0x2064: 'INVISIBLE PLUS',
  0x2066: 'LEFT-TO-RIGHT ISOLATE',
  0x2067: 'RIGHT-TO-LEFT ISOLATE',
  0x2068: 'FIRST STRONG ISOLATE',
  0x2069: 'POP DIRECTIONAL ISOLATE',
  0x3164: 'HANGUL FILLER',
  0xFFA0: 'HALFWIDTH HANGUL FILLER',
};
const FORMAT_CONTROL_CODEPOINTS = new Set(Object.keys(FORMAT_CONTROL_NAMES).map(Number));

// ---------------------------------------------------------------------------
// Single denylist pattern used by strip(). Built from numeric codepoint
// ranges via String.fromCodePoint() + new RegExp(), rather than a /literal/
// containing combining marks, zero-width characters, or \u escapes directly
// in source: this is a security-sensitive detection surface, and encoding
// every range as a plain JS number is unambiguous, diff-safe, and avoids
// embedding invisible/combining bytes in the file (indistinguishable from
// whitespace in a diff, easily corrupted by copy/paste or editor
// normalization). Verified empirically (see S527 build report) to match and
// remove surrogate-pair-backed Plane 14 codepoints as single atomic units,
// not split halves, once compiled with the `u` flag.
// ---------------------------------------------------------------------------
const HIDDEN_CHANNEL_RANGES = [
  [0x0363, 0x036F],   // combining Latin small letters (palimpsest overlay)
  [0xFE20, 0xFE2F],   // combining half marks
  [0x20DD, 0x20E4],   // combining enclosing marks
  [0x200B, 0x200D],   // zero-width space / non-joiner / joiner
  [0x2060, 0x2060],   // word joiner
  [0xFEFF, 0xFEFF],   // zero-width no-break space (BOM)
  [0x00AD, 0x00AD],   // soft hyphen
  [0x061C, 0x061C],   // Arabic letter mark (bidi)
  [0x180E, 0x180E],   // Mongolian vowel separator
  [0x200E, 0x200F],   // LRM / RLM directional marks
  [0x202A, 0x202E],   // bidi embeddings + overrides (Trojan Source, CVE-2021-42574)
  [0x2061, 0x2064],   // invisible math operators
  [0x2066, 0x2069],   // bidi isolates (Trojan Source)
  [0x3164, 0x3164],   // Hangul filler
  [0xFFA0, 0xFFA0],   // halfwidth Hangul filler
  [0xFE00, 0xFE0F],   // variation selectors (standard, VS1-16)
  [0xE0000, 0xE007F], // Unicode Tags block (Plane 14)
  [0xE0100, 0xE01EF], // variation selectors supplement (VS17-256, Plane 14)
];

function _codePointRangeToClassPart([start, end]) {
  return `${String.fromCodePoint(start)}-${String.fromCodePoint(end)}`;
}

const HIDDEN_CHANNEL_PATTERN = new RegExp(
  `[${HIDDEN_CHANNEL_RANGES.map(_codePointRangeToClassPart).join('')}]`,
  'gu',
);

/**
 * Format a byte value as a printable ASCII char, or a `\xHH` escape if it
 * falls outside the printable range (0x20-0x7E).
 * @param {number} byte
 * @returns {string}
 */
function _formatByte(byte) {
  return (byte >= 0x20 && byte <= 0x7E)
    ? String.fromCharCode(byte)
    : `\\x${byte.toString(16).padStart(2, '0')}`;
}

/**
 * Scan text for hidden-channel codepoints and describe what each one
 * carries. Read-only — does not modify the input. Iterates by code point
 * (Array.from), so `index` values are code-point indices (position within
 * Array.from(text)), not UTF-16 code-unit offsets — consistent with this
 * codebase's established code-point-safe iteration convention
 * (substrate-render.cjs, hud-zone-substrate.cjs both use the same idiom).
 *
 * Combining Latin letters (U+0363-036F) are coalesced into ONE finding per
 * call: every such mark in the whole input, read in encounter order, is
 * concatenated into a single `decoded` overlay string. This matches how
 * renderPalimpsest/renderStyledPalimpsest actually build an overlay (one
 * letter per base character, across an entire string) — reconstructing the
 * full spelled word is the useful audit signal, not per-mark noise. If a
 * larger text contains several independent palimpsest calls concatenated
 * together, this coalesces all of their overlays into one ordered string;
 * that is an accepted limitation for an audit tool whose job is "reveal
 * that hidden content exists and what it says," not "perfectly reconstruct
 * original call boundaries."
 *
 * Half marks, enclosing marks, zero-width characters, and invisible
 * format/bidi controls are reported one finding per occurrence (each is a
 * standalone symbol, not part of a spelled word). Unicode Tag runs and variation-selector runs are each
 * coalesced into one finding per contiguous run, since a run is the
 * semantically meaningful unit (one hidden payload chunk).
 *
 * @param {string} text
 * @returns {Array<{kind: string, decoded: string, index: number, raw: string, anomalous?: boolean}>}
 */
function detectHidden(text) {
  if (typeof text !== 'string' || text.length === 0) return [];

  const chars = Array.from(text);
  const findings = [];

  let overlayLetters = '';
  let overlayRaw = '';
  let overlayFirstIndex = -1;

  let tagBuffer = null; // { startIndex, decoded: '', raw: '' }
  let vsBuffer = null;  // { startIndex, codepoints: [] }

  function flushTag() {
    if (!tagBuffer) return;
    findings.push({
      kind: 'unicode-tag',
      decoded: tagBuffer.decoded,
      index: tagBuffer.startIndex,
      raw: tagBuffer.raw,
    });
    tagBuffer = null;
  }

  function flushVs() {
    if (!vsBuffer) return;
    const bytes = vsBuffer.codepoints.map((cp) => (cp <= 0xFE0F ? cp - 0xFE00 : cp - 0xE0100 + 0x10));
    const printable = bytes.every((b) => b >= 0x20 && b <= 0x7E);
    const decoded = printable
      ? String.fromCharCode(...bytes)
      : `0x${bytes.map((b) => b.toString(16).padStart(2, '0')).join('')}`;
    findings.push({
      kind: 'variation-selector',
      decoded,
      index: vsBuffer.startIndex,
      raw: vsBuffer.codepoints.map((cp) => String.fromCodePoint(cp)).join(''),
      anomalous: vsBuffer.codepoints.length >= 2 || vsBuffer.codepoints.some((cp) => cp >= 0xE0100),
    });
    vsBuffer = null;
  }

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const cp = ch.codePointAt(0);

    const isTag = cp >= 0xE0000 && cp <= 0xE007F;
    const isVs = (cp >= 0xFE00 && cp <= 0xFE0F) || (cp >= 0xE0100 && cp <= 0xE01EF);

    // A non-tag character ends any open tag run; a non-VS character ends
    // any open variation-selector run. Flush before classifying `ch` itself.
    if (tagBuffer && !isTag) flushTag();
    if (vsBuffer && !isVs) flushVs();

    if (cp >= 0x0363 && cp <= 0x036F) {
      if (overlayFirstIndex === -1) overlayFirstIndex = i;
      overlayLetters += COMBINING_LATIN_REVERSE[cp] || '?';
      overlayRaw += ch;
      continue;
    }

    if (cp >= 0xFE20 && cp <= 0xFE2F) {
      findings.push({
        kind: 'combining-half-mark',
        decoded: `[half-mark:${HALF_MARK_NAMES[cp] || `U+${cp.toString(16).toUpperCase()}`}]`,
        index: i,
        raw: ch,
      });
      continue;
    }

    if (cp >= 0x20DD && cp <= 0x20E4) {
      findings.push({
        kind: 'combining-enclosing-mark',
        decoded: `[enclosing-mark:${ENCLOSING_NAMES[cp] || `U+${cp.toString(16).toUpperCase()}`}]`,
        index: i,
        raw: ch,
      });
      continue;
    }

    if (ZERO_WIDTH_CODEPOINTS.has(cp)) {
      findings.push({
        kind: 'zero-width',
        decoded: `[${ZERO_WIDTH_NAMES[cp]}]`,
        index: i,
        raw: ch,
      });
      continue;
    }

    if (FORMAT_CONTROL_CODEPOINTS.has(cp)) {
      findings.push({
        kind: 'format-control',
        decoded: `[${FORMAT_CONTROL_NAMES[cp]}]`,
        index: i,
        raw: ch,
      });
      continue;
    }

    if (isTag) {
      if (!tagBuffer) tagBuffer = { startIndex: i, decoded: '', raw: '' };
      tagBuffer.raw += ch;
      if (cp === 0xE007F) {
        // CANCEL TAG — explicit terminator; flush immediately rather than
        // waiting for the next non-tag character.
        flushTag();
      } else {
        tagBuffer.decoded += _formatByte(cp - 0xE0000);
      }
      continue;
    }

    if (isVs) {
      if (!vsBuffer) vsBuffer = { startIndex: i, codepoints: [] };
      vsBuffer.codepoints.push(cp);
      continue;
    }
  }

  flushTag();
  flushVs();

  if (overlayLetters.length > 0) {
    findings.push({
      kind: 'combining-latin-letter',
      decoded: overlayLetters,
      index: overlayFirstIndex,
      raw: overlayRaw,
    });
  }

  findings.sort((a, b) => a.index - b.index);
  return findings;
}

/**
 * Remove every hidden-channel codepoint (see module header threat model)
 * from text. The visible layer — every character NOT in one of the five
 * flagged families — passes through unchanged. Unconditional: does not
 * consult `anomalous` or any other heuristic; every occurrence of every
 * family is removed every time (see "STRIP BOUNDARY" in the module header
 * for why that is the correct default at this module's actual call sites).
 * Idempotent: strip(strip(x)) === strip(x).
 * @param {string} text
 * @returns {string}
 */
function strip(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  return text.replace(HIDDEN_CHANNEL_PATTERN, '');
}

/**
 * Audit affordance: make any hidden overlay in `text` readable on demand.
 * Thin wrapper over detectHidden() — renders each finding as
 * `[kind] decoded`, one per line, in index order. Returns '' when nothing
 * hidden is found (never null/undefined, so callers can safely concatenate
 * or check `.length`).
 * @param {string} text
 * @returns {string}
 */
function decodePalimpsest(text) {
  const findings = detectHidden(text);
  if (findings.length === 0) return '';
  return findings.map((f) => `[${f.kind}] ${f.decoded}`).join('\n');
}

/**
 * Wiring entrypoint for render paths. Strips hidden-channel codepoints from
 * `text` before it is used to compose substrate output. `opts` is accepted
 * per the module's API contract and reserved for future use (e.g. a
 * per-family allow-list); it does not currently change behavior — every
 * call strips every family, matching strip()'s unconditional default.
 * @param {string} text
 * @param {object} [opts]
 * @returns {string}
 */
function sanitizeForOutput(text, opts) { // eslint-disable-line no-unused-vars -- opts reserved, see doc comment
  if (typeof text !== 'string' || text.length === 0) return text;
  return strip(text);
}

module.exports = {
  detectHidden,
  strip,
  decodePalimpsest,
  sanitizeForOutput,
  // Internal tables, exposed for tests (matches this codebase's convention
  // of underscore-prefixed test-only exports, e.g. substrate-render.cjs's
  // _COMBINING_LATIN / _ENCLOSING / _HALF_MARKS).
  _COMBINING_LATIN_REVERSE: COMBINING_LATIN_REVERSE,
  _HALF_MARK_NAMES: HALF_MARK_NAMES,
  _ENCLOSING_NAMES: ENCLOSING_NAMES,
  _ZERO_WIDTH_NAMES: ZERO_WIDTH_NAMES,
  _FORMAT_CONTROL_NAMES: FORMAT_CONTROL_NAMES,
  _HIDDEN_CHANNEL_PATTERN: HIDDEN_CHANNEL_PATTERN,
};
