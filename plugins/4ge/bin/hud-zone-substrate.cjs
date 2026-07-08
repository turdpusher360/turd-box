'use strict';

// hud-zone-substrate.cjs
// Substrate render mode: response-text-format scenes built from Unicode substrate
// techniques. No ANSI escape codes. Color via emoji, weight via math alphanumerics,
// density via block elements. Combining marks, half marks, enclosing marks layered on.
//
// Technique inventory (from S245 handoff):
//   Math Bold (U+1D400–U+1D41A)     — uppercase titles
//   Math Fraktur (U+1D504+)         — labels and secondary weight
//   Math Script (U+1D49C+)          — decorative, via substrate-render.cjs (gap-safe)
//   Math Double-Struck (U+1D538+)   — accent, via substrate-render.cjs (gap-safe)
//   Math Monospace (U+1D670+)       — code-weight text
//   Small Caps (BMP: U+1D00+/IPA/A7xx) — styled weight that CAN carry combining marks
//   Combining Latin Small Letters   — U+0363–U+036F (a e i o u c d h m r t v x)
//   Half Marks                      — U+FE20–U+FE2F (ligature spans across 2 cells)
//   Enclosing Marks                 — U+20DD–U+20E4 (circle/square/diamond/keycap around glyph)
//   Block elements                  — U+2588 U+2591 U+2592 U+2593 (█░▒▓)
//   Box drawing                     — U+2500–U+257F
//   Colored emoji                   — 🟢🟡🔴 for capability status

// --- Math Alphanumeric: delegate to substrate-render.cjs ---
// substrate-render.cjs carries the canonical gap table (MATH_ALPHA_GAPS, 24+ entries)
// and applies it in _applyGaps() for every alphabet that has reserved codepoints.
// Using it here means Script and Double-Struck are safe to add — no local gap tracking needed.
const {
  renderMathBold,
  renderMathFraktur,
  renderMathMonospace,
  renderMathScript,
  renderMathDoubleStruck,
  renderSmallCaps,
  renderStyledPalimpsest,
} = require('../lib/substrate-render.cjs');

// S527: every live-state string this zone ingests (session id/model, forge
// phase, capability names) passes through sanitizeForOutput() before it is
// composed into output — see substrate-sanitize.cjs header for the threat
// model. renderPalimpsest/renderStyledPalimpsest already sanitize their own
// arguments at the substrate-render.cjs layer; this zone's local palimpsest()
// helper below is only ever called with hardcoded literal signature words
// (never ingested state), so it does not need its own sanitize call.
const { sanitizeForOutput } = require('../lib/substrate-sanitize.cjs');

// Local wrappers matching the zone's historic naming convention.
// toBold/toFraktur/toMono preserve behavioral identity for callers inside the zone.
// toScript/toDoubleStruck are newly available now that gap protection is in place.
const toBold        = (str) => renderMathBold(str);
const toFraktur     = (str) => renderMathFraktur(str);
const toMono        = (str) => renderMathMonospace(str);
const toScript      = (str) => renderMathScript(str);
const toDoubleStruck = (str) => renderMathDoubleStruck(str);
// toSmallCaps is the one styled alphabet that is BMP — safe under combining marks.
const toSmallCaps   = (str) => renderSmallCaps(str);

// --- Combining Mark Utilities ---
// Combining Latin Small Letters (U+0363–U+036F)
// Available: a e i o u c d h m r t v x
const COMBINING_LATIN = {
  a: '\u0363', e: '\u0364', i: '\u0365', o: '\u0366', u: '\u0367',
  c: '\u0368', d: '\u0369', h: '\u036A', m: '\u036B', r: '\u036C',
  t: '\u036D', v: '\u036E', x: '\u036F',
};

// Layer a combining-letter word on top of a base word (palimpsest technique)
// base: string of base characters. Must be BMP — combining marks on SMP
//   (Math Alphanumerics) render as replacement glyphs on many terminals.
// overlay: string to carry in the combining layer (only a e i o u c d h m r t v x)
// Iterates code points (Array.from) not UTF-16 units, so surrogate pairs
// passed in as base are handled without fragmenting.
function palimpsest(base, overlay) {
  const baseChars = Array.from(base);
  const overlayChars = Array.from(overlay);
  const result = [];
  for (let i = 0; i < baseChars.length; i++) {
    result.push(baseChars[i]);
    const overlayChar = overlayChars[i];
    if (overlayChar && COMBINING_LATIN[overlayChar]) {
      result.push(COMBINING_LATIN[overlayChar]);
    }
  }
  return result.join('');
}

// Apply multiple combining marks to a single base character
function withCombining(base, ...marks) {
  return base + marks.join('');
}

// --- Half Marks (span 2 adjacent cells) ---
const HALF = {
  ligLeft:  '\uFE20', // ︠ ligature tie left
  ligRight: '\uFE21', // ︡ ligature tie right
  dtLeft:   '\uFE22', // ︢ double tilde left
  dtRight:  '\uFE23', // ︣ double tilde right
  macLeft:  '\uFE24', // ︤ macron above left
  macRight: '\uFE25', // ︥ macron above right
  ligBelowLeft:  '\uFE28', // ︨ ligature below left
  ligBelowRight: '\uFE29', // ︩ ligature below right
};

// Wrap a 2-char pair with ligature tie half marks
function ligTie(left, right) {
  return left + HALF.ligLeft + right + HALF.ligRight;
}

// Double tilde span across 2 chars
function dtSpan(left, right) {
  return left + HALF.dtLeft + right + HALF.dtRight;
}

// --- Enclosing Marks ---
const ENCLOSE = {
  circle:    '\u20DD', // combining enclosing circle
  square:    '\u20DE', // combining enclosing square
  diamond:   '\u20DF', // combining enclosing diamond
  slash:     '\u20E0', // combining enclosing circle backslash (prohibition)
  keycap:    '\u20E3', // combining enclosing keycap
  triangle:  '\u20E4', // combining enclosing upward pointing triangle
};

function inCircle(base)   { return base + ENCLOSE.circle; }
function inSquare(base)   { return base + ENCLOSE.square; }
function inDiamond(base)  { return base + ENCLOSE.diamond; }
function inKeycap(base)   { return base + ENCLOSE.keycap; }
function inTriangle(base) { return base + ENCLOSE.triangle; }

// --- Block Elements ---
const BLOCK = {
  full:  '\u2588', // █
  light: '\u2591', // ░
  med:   '\u2592', // ▒
  dark:  '\u2593', // ▓
};

// Health bar using block elements
// score 0-100, width = number of block characters total
function blockBar(score, width) {
  const filled = Math.round((score / 100) * width);
  const empty = width - filled;
  // Full blocks for the filled portion, light blocks for empty
  return BLOCK.full.repeat(filled) + BLOCK.light.repeat(empty);
}

// Multi-density bar: full → dark → med → light as score decreases
function gradedBlockBar(score, width) {
  const filled = Math.round((score / 100) * width);
  const empty = width - filled;
  let bar = '';
  if (filled > 0) {
    // Top quarter: full █, next: dark ▓, next: med ▒
    const q = Math.ceil(filled / 3);
    const top = Math.min(q, filled);
    const mid = Math.min(q, filled - top);
    const low = filled - top - mid;
    bar += BLOCK.full.repeat(top);
    bar += BLOCK.dark.repeat(mid);
    bar += BLOCK.med.repeat(low);
  }
  bar += BLOCK.light.repeat(empty);
  return bar;
}

// --- Box Drawing ---
const BOX = {
  h:  '\u2500', // ─
  v:  '\u2502', // │
  tl: '\u250C', // ┌
  tr: '\u2510', // ┐
  bl: '\u2514', // └
  br: '\u2518', // ┘
  lt: '\u251C', // ├
  rt: '\u2524', // ┤
  tm: '\u252C', // ┬
  bm: '\u2534', // ┴
  cx: '\u253C', // ┼
  hv: '\u2550', // ═ double horizontal
  vv: '\u2551', // ║ double vertical
  tld: '\u2554', // ╔
  trd: '\u2557', // ╗
  bld: '\u255A', // ╚
  brd: '\u255D', // ╝
};

// --- Capability Status Emoji ---
function capEmoji(ok, degraded) {
  if (degraded) return '🟡';
  if (!ok)      return '🔴';
  return '🟢';
}

// --- Health-Tier Emoji Sequence ---
function healthTierEmoji(score) {
  if (score >= 90) return '🟢🟢🟢';
  if (score >= 75) return '🟢🟢🟡';
  if (score >= 55) return '🟢🟡🟡';
  if (score >= 35) return '🟡🔴🔴';
  return '🔴🔴🔴';
}

// --- Forge Mark ---
// The signature mark: ◆ with combining layers
// ◆ (U+25C6) + circle enclosure + combining c + combining o (not available, skip)
const FORGE_MARK = inCircle(withCombining('\u25C6', COMBINING_LATIN.c, COMBINING_LATIN.a));

// --- Score to Grade ---
function gradeForScore(score) {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 55) return 'C';
  if (score >= 35) return 'D';
  return 'F';
}

// --- Health Score ---
function computeHealthScore(caps) {
  const entries = Object.values(caps || {});
  if (entries.length === 0) return 0;
  const ready = entries.filter(c => c && c.ok).length;
  return Math.round((ready / entries.length) * 100);
}

// --- Count degraded ---
function countDegraded(caps) {
  if (!caps || typeof caps !== 'object') return 0;
  let count = 0;
  for (const c of Object.values(caps)) {
    if (c && c.ok === false) count++;
  }
  return count;
}

// --- Main Zone Renderer ---
// Returns a UTF-8 string (multiple lines joined with \n).
// No ANSI codes. Substrate channels only.
function renderSubstrateZone(state) {
  const caps = (state.os && state.os.capabilities) || {};
  const score = computeHealthScore(caps);
  const grade = gradeForScore(score);
  const degradedCount = countDegraded(caps);
  const session = state.session || {};
  const forge = state.forge || {};
  const capNames = Object.keys(caps);
  const totalCaps = capNames.length;

  const lines = [];

  // --- HEADER ---
  // Title in math-bold: "FORGE OS" with ligature ties between F-O and O-S
  // Layer a combining signature on the forge mark
  const signatureMark = FORGE_MARK;
  // Half-mark ligature tie across the OS pair
  const osLig = toBold('O') + HALF.ligLeft + toBold('S') + HALF.ligRight;
  const title = toBold('FORGE') + ' ' + osLig + '  ' + signatureMark;

  // Enclosing keycap around grade
  const gradeDisplay = inKeycap(grade);

  // Tier emoji + grade + score
  const tierEmoji = healthTierEmoji(score);
  const scoreDisplay = String(score);

  lines.push(title + '  ' + tierEmoji + '  ' + toBold(scoreDisplay) + ' ' + gradeDisplay);

  // --- HEALTH BAR ---
  // Full-width graded block bar
  const barWidth = 32;
  const hBar = gradedBlockBar(score, barWidth);
  // Label in fraktur, bar in blocks
  const healthLabel = toFraktur('Health');
  // Palimpsest: layer "dimmed" in combining marks over the bar chars
  // combining layer: d i m (d, i, m available: d=yes, i=yes, m=yes)
  // Apply to first 3 bar chars
  const barChars = hBar.split('');
  let barWithSig = '';
  const sigWord = 'dim';
  for (let i = 0; i < barChars.length; i++) {
    barWithSig += barChars[i];
    if (i < sigWord.length && COMBINING_LATIN[sigWord[i]]) {
      barWithSig += COMBINING_LATIN[sigWord[i]];
    }
  }
  lines.push(healthLabel + '  ' + barWithSig);

  // --- CAPABILITY GRID ---
  // Each cap: emoji + fraktur name + double-tilde span on ok caps
  const capLineLabel = toFraktur('Capabilities') + '  ' + toBold(String(totalCaps));
  lines.push(capLineLabel);

  // Render caps in rows, emoji first then math-fraktur name.
  // No half marks on Fraktur bases — that combo renders as replacement glyphs
  // on Termius. Plain Fraktur is clean.
  const capEntries = [];
  for (const [name, cap] of Object.entries(caps)) {
    const ok = cap && cap.ok !== false;
    // S527: capability name is ingested from state.os.capabilities — sanitize
    // before it flows into toFraktur() output.
    const shortName = sanitizeForOutput(name).slice(0, 8);
    const frakName = toFraktur(shortName);
    const emoji = capEmoji(ok, false);
    capEntries.push(emoji + ' ' + frakName);
  }

  // 3 caps per line
  const perRow = 3;
  for (let i = 0; i < capEntries.length; i += perRow) {
    const row = capEntries.slice(i, i + perRow);
    lines.push('  ' + row.join('   '));
  }

  // --- SEPARATOR ---
  // Box drawing separator with enclosing marks at ends
  const sepWidth = 36;
  const sep = inDiamond('\u25C6') + BOX.hv.repeat(sepWidth) + inDiamond('\u25C6');
  lines.push(sep);

  // --- SESSION PANEL ---
  // Context usage with block density representation
  const ctxPct = typeof session.contextPct === 'number' ? session.contextPct : 0;
  const ctxBar = blockBar(ctxPct, 16);
  // Styled palimpsest: small caps are BMP, so the label carries display weight
  // AND the 'act' combining layer in the same cells — the one styled alphabet
  // where that combination is legal. SMP math alphabets (Bold/Fraktur/Mono/...)
  // break combining marks on Termius; see renderStyledPalimpsest in
  // substrate-render.cjs. Renders ᴄͣᴛͨxͭ (x has no small-caps codepoint).
  const ctxLabelPalimpsest = renderStyledPalimpsest('CTX', 'act', 'smallCaps');
  lines.push(ctxLabelPalimpsest + '  ' + ctxBar + '  ' + toBold(String(ctxPct)) + '%');

  // Model + uptime
  // S527: session.model is ingested live state — sanitize before use.
  const model = sanitizeForOutput(String(session.model || 'opus'));
  const uptime = typeof session.uptime === 'number'
    ? (session.uptime >= 3600000
        ? Math.floor(session.uptime / 3600000) + 'h'
        : session.uptime >= 60000
          ? Math.floor(session.uptime / 60000) + 'm'
          : Math.floor(session.uptime / 1000) + 's')
    : '—';
  // Enclosing square goes on the ASCII initial (BMP), rest of name in Fraktur.
  // Putting the enclosing mark on a Fraktur SMP base breaks on Termius.
  const initial = model.slice(0, 1).toUpperCase();
  const modelDisplay = inSquare(initial) + toFraktur(model.slice(1));
  lines.push(toFraktur('Model') + '  ' + modelDisplay + '  ' + toFraktur('Up') + ' ' + toBold(uptime));

  // --- FORGE PANEL ---
  // Phase shown in Math Bold without ligature ties (half marks on Math Bold
  // SMP base render as replacement on Termius). Active state uses an
  // ASCII-base palimpsest line for the combining signature instead.
  const forgeActive = forge.active;
  const forgePhase = forge.phase;
  const forgeLabel = toFraktur('Forge');
  let forgeStatus;
  if (forgeActive) {
    // S527: forge.phase is ingested live state — sanitize before use.
    const phaseStr = sanitizeForOutput(forgePhase ? String(forgePhase) : 'active');
    forgeStatus = inTriangle('⊕') + ' ' + toBold(phaseStr.slice(0, 8));
  } else {
    // Idle shown in plain Fraktur (no half marks on SMP)
    forgeStatus = toFraktur('idle');
  }
  lines.push(forgeLabel + '  ' + forgeStatus);

  // --- DEGRADED SUMMARY ---
  if (degradedCount > 0) {
    // Show degraded caps with 🔴 + ASCII initial in enclosing square + Fraktur rest.
    // inSquare on ASCII base renders cleanly; inSquare on SMP does not.
    const degradedLabel = toBold('DEGRADED') + '  ' + inCircle(String(degradedCount));
    lines.push(degradedLabel);
    for (const [name, cap] of Object.entries(caps)) {
      if (cap && cap.ok === false) {
        // S527: capability name is ingested from state.os.capabilities —
        // sanitize before it flows into inSquare()/toFraktur() output.
        const shortName = sanitizeForOutput(name).slice(0, 8);
        const initial = shortName[0].toUpperCase();
        const display = '🔴 ' + inSquare(initial) + toFraktur(shortName.slice(1));
        lines.push('  ' + display);
      }
    }
  }

  // --- SIGNATURE FOOTER ---
  // The forge mark with maximum combining depth as a footer line
  // ◆ encircled, carrying 'ca' in combining layer (c and a both available),
  // then a double-diamond box drawing footer
  const footerMark = withCombining(
    inCircle('\u25C6'),
    COMBINING_LATIN.c,
    COMBINING_LATIN.a,
    COMBINING_LATIN.t,
    COMBINING_LATIN.e,
  );
  // Footer line: mark + separator + session signature
  const footerSep = BOX.h.repeat(12);
  // Palimpsest the word "route" over the separator (r o u t e — all available except o→U+0366)
  // route: r(r) o(o) u(u) t(t) e(e) — all 5 available
  const footerSepPalimpsest = palimpsest(footerSep.slice(0, 5), 'route') + footerSep.slice(5);
  // S527: session.id is ingested live state — sanitize (before truncating)
  // so a hidden-channel payload can't ride in ahead of the 12-char slice.
  const sessionId = sanitizeForOutput(String(session.id || '')).slice(0, 12) || 'substrate';
  const sessionSig = toFraktur(sessionId.slice(0, 8));
  lines.push(footerMark + '  ' + footerSepPalimpsest + '  ' + sessionSig);

  return lines.join('\n');
}

// --- Zone Metadata (for engine compatibility) ---
const ZONE_META = {
  key: 'substrate',
  priority: 7,
  minRows: 6,
  idealRows: 14,
};

module.exports = {
  renderSubstrateZone,
  ZONE_META,
  // Export substrate utilities for testing + reuse
  toBold,
  toFraktur,
  toMono,
  toScript,
  toDoubleStruck,
  toSmallCaps,
  renderStyledPalimpsest,
  palimpsest,
  blockBar,
  gradedBlockBar,
  ligTie,
  dtSpan,
  inCircle,
  inSquare,
  inDiamond,
  inKeycap,
  inTriangle,
  capEmoji,
  COMBINING_LATIN,
  HALF,
  ENCLOSE,
  BLOCK,
  BOX,
};
