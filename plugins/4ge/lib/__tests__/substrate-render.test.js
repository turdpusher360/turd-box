import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
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
  MATH_ALPHA_GAPS,
  _COMBINING_LATIN,
  _ENCLOSING,
  _HALF_MARKS,
  // New chart helpers
  fg256,
  bg256,
  fg24,
  bg24,
  ANSI_RST,
  ANSI_BOLD,
  ANSI_DIM,
  createBrailleBuffer,
  hbar,
  sparkline,
  progressBar,
  capBrailleDensity,
  // New chart primitives (S533)
  blockRamp,
  brailleChart,
  brailleBand,
  COLD_RAMP_256,
  COLD_RAMP_STOPS,
  rampColor256,
  rampRgb,
  rampColor,
  colorizeRamp,
  // BMP styled alphabets + styled palimpsest
  renderSmallCaps,
  renderFullWidth,
  renderStyledPalimpsest,
  _SMALL_CAPS,
} = require('../substrate-render.cjs');

// Strip ANSI escape sequences for visible-width / glyph assertions.
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// ---------------------------------------------------------------------------
// renderPalimpsest
// ---------------------------------------------------------------------------
describe('renderPalimpsest', () => {
  it('stacks overlay letter as combining mark on base character', () => {
    // 'f' + overlay 'c' → 'f' + U+0368 (combining c)
    const result = renderPalimpsest('f', 'c');
    expect(result.length).toBeGreaterThan(1);
    // first char is 'f', second is the combining mark U+0368
    expect(result.charCodeAt(0)).toBe(0x66); // 'f'
    expect(result.charCodeAt(1)).toBe(0x0368); // combining c
  });

  it('skips overlay letters not in the 13-letter set', () => {
    // 'b' is not in the combining set — should be skipped silently
    const result = renderPalimpsest('forge', 'bbbbb');
    // all 5 overlay chars are 'b' which is unavailable — no combining marks added
    expect([...result].filter(ch => ch === 'f' || ch === 'o' || ch === 'r' || ch === 'g' || ch === 'e').length).toBe(5);
    // length equals base length since no combining marks were added
    expect(result).toBe('forge');
  });

  it('handles overlay shorter than base gracefully', () => {
    const result = renderPalimpsest('forge', 'co');
    // Only first two chars get overlay
    expect(result.charCodeAt(1)).toBe(0x0368); // c over f
    expect(result.charCodeAt(3)).toBe(0x0366); // o over o
  });

  it('handles empty overlay', () => {
    expect(renderPalimpsest('forge', '')).toBe('forge');
  });

  it('handles empty base', () => {
    expect(renderPalimpsest('', 'court')).toBe('');
  });

  it('stacks all 13 available combining letters without error', () => {
    const available = 'aeioucdhmrtvx';
    const base = available; // same length
    const result = renderPalimpsest(base, available);
    // Every base char should have its combining counterpart
    // String length should be 2x (base + combining for each)
    expect(result.length).toBe(available.length * 2);
  });

  it('is case-insensitive for overlay characters', () => {
    const lower = renderPalimpsest('x', 'a');
    const upper = renderPalimpsest('x', 'A');
    // Both should produce the same combining mark
    expect(lower).toBe(upper);
  });
});

// ---------------------------------------------------------------------------
// renderEnclosed
// ---------------------------------------------------------------------------
describe('renderEnclosed', () => {
  it('wraps each character with the circle enclosing mark (U+20DD)', () => {
    const result = renderEnclosed('A', 'circle');
    expect(result.charCodeAt(0)).toBe(0x41); // 'A'
    expect(result.charCodeAt(1)).toBe(0x20DD); // combining enclosing circle
  });

  it('wraps each character with the square enclosing mark (U+20DE)', () => {
    const result = renderEnclosed('B', 'square');
    expect(result.charCodeAt(1)).toBe(0x20DE);
  });

  it('wraps each character with the diamond enclosing mark (U+20DF)', () => {
    const result = renderEnclosed('C', 'diamond');
    expect(result.charCodeAt(1)).toBe(0x20DF);
  });

  it('wraps each character with the prohibition enclosing mark (U+20E0)', () => {
    const result = renderEnclosed('D', 'prohibition');
    expect(result.charCodeAt(1)).toBe(0x20E0);
  });

  it('wraps each character with the keycap enclosing mark (U+20E3)', () => {
    const result = renderEnclosed('5', 'keycap');
    expect(result.charCodeAt(1)).toBe(0x20E3);
  });

  it('wraps each character with the triangle enclosing mark (U+20E4)', () => {
    const result = renderEnclosed('X', 'triangle');
    expect(result.charCodeAt(1)).toBe(0x20E4);
  });

  it('wraps multi-character strings — each char gets its own mark', () => {
    const result = renderEnclosed('AB', 'circle');
    // 'A' + mark + 'B' + mark = 4 chars
    expect(result.length).toBe(4);
    expect(result.charCodeAt(0)).toBe(0x41);
    expect(result.charCodeAt(1)).toBe(0x20DD);
    expect(result.charCodeAt(2)).toBe(0x42);
    expect(result.charCodeAt(3)).toBe(0x20DD);
  });

  it('throws on unknown shape', () => {
    expect(() => renderEnclosed('A', 'hexagon')).toThrow(/Unknown enclosing shape/);
  });
});

// ---------------------------------------------------------------------------
// renderMaxComposition
// ---------------------------------------------------------------------------
describe('renderMaxComposition', () => {
  it('returns a string longer than the input (combining marks added)', () => {
    const result = renderMaxComposition('forge');
    expect(result.length).toBeGreaterThan('forge'.length);
  });

  it('preserves the base characters in their original positions', () => {
    const word = 'forge';
    const result = renderMaxComposition(word);
    // The very first codepoint should still be 'f'
    const first = result.codePointAt(0);
    expect(first).toBe(word.codePointAt(0));
  });

  it('includes an enclosing circle on the middle character', () => {
    // For 'forge' (5 chars), midIdx=2 (r). Circle mark = U+20DD.
    const result = renderMaxComposition('forge');
    expect(result.includes('\u20DD')).toBe(true);
  });

  it('works on single-character input without throwing', () => {
    expect(() => renderMaxComposition('x')).not.toThrow();
  });

  it('works on empty string without throwing', () => {
    expect(() => renderMaxComposition('')).not.toThrow();
    expect(renderMaxComposition('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// renderMathBold
// ---------------------------------------------------------------------------
describe('renderMathBold', () => {
  it('maps A to U+1D400 (Mathematical Bold Capital A)', () => {
    const result = renderMathBold('A');
    expect(result.codePointAt(0)).toBe(0x1D400);
  });

  it('maps a to U+1D41A (Mathematical Bold Small a)', () => {
    const result = renderMathBold('a');
    expect(result.codePointAt(0)).toBe(0x1D41A);
  });

  it('maps Z to U+1D419', () => {
    const result = renderMathBold('Z');
    expect(result.codePointAt(0)).toBe(0x1D419);
  });

  it('maps 0 to U+1D7CE', () => {
    const result = renderMathBold('0');
    expect(result.codePointAt(0)).toBe(0x1D7CE);
  });

  it('passes through non-ASCII characters unchanged', () => {
    expect(renderMathBold('!')).toBe('!');
  });

  it('transforms entire strings', () => {
    const result = renderMathBold('forge');
    const cps = [...result].map(ch => ch.codePointAt(0));
    // f=0x66 → 0x1D41A+5=0x1D41F, o=0x6F → 0x1D428, r=0x72 → 0x1D42B, g=0x67 → 0x1D420, e=0x65 → 0x1D41E
    expect(cps[0]).toBe(0x1D41F); // f
    expect(cps[1]).toBe(0x1D428); // o
  });
});

// ---------------------------------------------------------------------------
// renderMathItalic
// ---------------------------------------------------------------------------
describe('renderMathItalic', () => {
  it('maps A to U+1D434 (Mathematical Italic Capital A)', () => {
    expect(renderMathItalic('A').codePointAt(0)).toBe(0x1D434);
  });

  it('maps h to U+210E (Planck constant carve-out, not naive offset)', () => {
    // Naive offset would be 0x1D44E + 7 = 0x1D455 which is unassigned
    expect(renderMathItalic('h').codePointAt(0)).toBe(0x210E);
  });

  it('maps a to U+1D44E (Mathematical Italic Small a)', () => {
    expect(renderMathItalic('a').codePointAt(0)).toBe(0x1D44E);
  });
});

// ---------------------------------------------------------------------------
// renderMathFraktur
// ---------------------------------------------------------------------------
describe('renderMathFraktur', () => {
  it('maps a to U+1D51E (Mathematical Fraktur Small a)', () => {
    expect(renderMathFraktur('a').codePointAt(0)).toBe(0x1D51E);
  });

  it('maps C to U+212D (carve-out: Black-Letter Capital C)', () => {
    expect(renderMathFraktur('C').codePointAt(0)).toBe(0x212D);
  });

  it('maps H to U+210C (carve-out: Black-Letter Capital H)', () => {
    expect(renderMathFraktur('H').codePointAt(0)).toBe(0x210C);
  });

  it('maps I to U+2111 (carve-out: Black-Letter Capital I)', () => {
    expect(renderMathFraktur('I').codePointAt(0)).toBe(0x2111);
  });

  it('maps R to U+211C (carve-out: Black-Letter Capital R)', () => {
    expect(renderMathFraktur('R').codePointAt(0)).toBe(0x211C);
  });

  it('maps Z to U+2128 (carve-out: Black-Letter Capital Z)', () => {
    expect(renderMathFraktur('Z').codePointAt(0)).toBe(0x2128);
  });

  it('maps A to the correct fraktur codepoint (not shifted by C carve-out gap)', () => {
    // A is index 0, no gaps before it → U+1D504
    expect(renderMathFraktur('A').codePointAt(0)).toBe(0x1D504);
  });
});

// ---------------------------------------------------------------------------
// renderMathScript
// ---------------------------------------------------------------------------
describe('renderMathScript', () => {
  it('maps B to U+212C (carve-out: Script Capital B)', () => {
    expect(renderMathScript('B').codePointAt(0)).toBe(0x212C);
  });

  it('maps E to U+2130 (carve-out: Script Capital E)', () => {
    expect(renderMathScript('E').codePointAt(0)).toBe(0x2130);
  });

  it('maps H to U+210B (carve-out: Script Capital H)', () => {
    expect(renderMathScript('H').codePointAt(0)).toBe(0x210B);
  });

  it('maps e to U+212F (carve-out: Script Small e)', () => {
    expect(renderMathScript('e').codePointAt(0)).toBe(0x212F);
  });

  it('maps g to U+210A (carve-out: Script Small g)', () => {
    expect(renderMathScript('g').codePointAt(0)).toBe(0x210A);
  });

  it('maps o to U+2134 (carve-out: Script Small o)', () => {
    expect(renderMathScript('o').codePointAt(0)).toBe(0x2134);
  });

  it('maps A to U+1D49C (Script Capital A)', () => {
    // A is index 0, first assigned code point
    expect(renderMathScript('A').codePointAt(0)).toBe(0x1D49C);
  });

  it('maps P to U+2118 (carve-out: Weierstrass p — was missing from UC_CARVE)', () => {
    // Naive offset 0x1D49C+15 = 0x1D4AB is reserved; correct is U+2118 ℘
    expect(renderMathScript('P').codePointAt(0)).toBe(0x2118);
  });
});

// ---------------------------------------------------------------------------
// renderMathDoubleStruck
// ---------------------------------------------------------------------------
describe('renderMathDoubleStruck', () => {
  it('maps C to U+2102 (carve-out: Double-Struck Capital C)', () => {
    expect(renderMathDoubleStruck('C').codePointAt(0)).toBe(0x2102);
  });

  it('maps H to U+210D (carve-out: Double-Struck Capital H)', () => {
    expect(renderMathDoubleStruck('H').codePointAt(0)).toBe(0x210D);
  });

  it('maps N to U+2115 (carve-out: Double-Struck Capital N)', () => {
    expect(renderMathDoubleStruck('N').codePointAt(0)).toBe(0x2115);
  });

  it('maps P to U+2119 (carve-out: Double-Struck Capital P)', () => {
    expect(renderMathDoubleStruck('P').codePointAt(0)).toBe(0x2119);
  });

  it('maps Q to U+211A (carve-out: Double-Struck Capital Q)', () => {
    expect(renderMathDoubleStruck('Q').codePointAt(0)).toBe(0x211A);
  });

  it('maps R to U+211D (carve-out: Double-Struck Capital R)', () => {
    expect(renderMathDoubleStruck('R').codePointAt(0)).toBe(0x211D);
  });

  it('maps Z to U+2124 (carve-out: Double-Struck Capital Z)', () => {
    expect(renderMathDoubleStruck('Z').codePointAt(0)).toBe(0x2124);
  });

  it('maps a to U+1D552 (Double-Struck Small a)', () => {
    expect(renderMathDoubleStruck('a').codePointAt(0)).toBe(0x1D552);
  });

  it('maps 0 to U+1D7D8 (Double-Struck Digit Zero)', () => {
    expect(renderMathDoubleStruck('0').codePointAt(0)).toBe(0x1D7D8);
  });
});

// ---------------------------------------------------------------------------
// renderMathMonospace
// ---------------------------------------------------------------------------
describe('renderMathMonospace', () => {
  it('maps A to U+1D670 (Mathematical Monospace Capital A)', () => {
    expect(renderMathMonospace('A').codePointAt(0)).toBe(0x1D670);
  });

  it('maps a to U+1D68A (Mathematical Monospace Small a)', () => {
    expect(renderMathMonospace('a').codePointAt(0)).toBe(0x1D68A);
  });

  it('maps Z to U+1D689 (Mathematical Monospace Capital Z)', () => {
    expect(renderMathMonospace('Z').codePointAt(0)).toBe(0x1D689);
  });

  it('maps 0 to U+1D7F6 (Mathematical Monospace Digit Zero)', () => {
    expect(renderMathMonospace('0').codePointAt(0)).toBe(0x1D7F6);
  });

  it('transforms a full word correctly', () => {
    const result = renderMathMonospace('forge');
    // f=5th letter (index 5 from a), monospace small a=U+1D68A, f=U+1D68F
    expect([...result].length).toBe(5); // 5 surrogate pairs = 5 visible characters (10 UTF-16 code units)
    expect(result.codePointAt(0)).toBe(0x1D68F); // f
  });
});

// ---------------------------------------------------------------------------
// renderAllAlphabets
// ---------------------------------------------------------------------------
describe('renderAllAlphabets', () => {
  it('returns a string containing 6 lines', () => {
    const result = renderAllAlphabets('forge');
    const lines = result.split('\n');
    expect(lines.length).toBe(6);
  });

  it('each line contains the alphabet label', () => {
    const result = renderAllAlphabets('X');
    expect(result).toContain('bold:');
    expect(result).toContain('italic:');
    expect(result).toContain('script:');
    expect(result).toContain('fraktur:');
    expect(result).toContain('double-struck:');
    expect(result).toContain('monospace:');
  });
});

// ---------------------------------------------------------------------------
// renderBlockBar
// ---------------------------------------------------------------------------
describe('renderBlockBar', () => {
  it('returns a string of the specified width', () => {
    expect(renderBlockBar(50, 10).length).toBe(10);
    expect(renderBlockBar(0, 20).length).toBe(20);
    expect(renderBlockBar(100, 8).length).toBe(8);
  });

  it('at 100% all chars are fill (U+2593 ▓)', () => {
    const result = renderBlockBar(100, 5);
    expect([...result].every(ch => ch === '\u2593')).toBe(true);
  });

  it('at 0% all chars are empty (U+2591 ░)', () => {
    const result = renderBlockBar(0, 5);
    expect([...result].every(ch => ch === '\u2591')).toBe(true);
  });

  it('at 50% roughly half fill half empty', () => {
    const result = renderBlockBar(50, 10);
    const fill = [...result].filter(ch => ch === '\u2593').length;
    const empty = [...result].filter(ch => ch === '\u2591').length;
    expect(fill).toBe(5);
    expect(empty).toBe(5);
  });

  it('clamps percent above 100', () => {
    expect(renderBlockBar(150, 4)).toBe('\u2593\u2593\u2593\u2593');
  });

  it('clamps percent below 0', () => {
    expect(renderBlockBar(-10, 4)).toBe('\u2591\u2591\u2591\u2591');
  });
});

// ---------------------------------------------------------------------------
// renderLigature
// ---------------------------------------------------------------------------
describe('renderLigature', () => {
  it('wraps pair with tie half marks (U+FE20/U+FE21)', () => {
    const result = renderLigature('a', 'b', 'tie');
    // a + U+FE20 + b + U+FE21
    expect(result.charCodeAt(0)).toBe(0x61); // a
    expect(result.charCodeAt(1)).toBe(0xFE20); // ligature tie left
    expect(result.charCodeAt(2)).toBe(0x62); // b
    expect(result.charCodeAt(3)).toBe(0xFE21); // ligature tie right
    expect(result.length).toBe(4);
  });

  it('wraps pair with tilde half marks (U+FE22/U+FE23)', () => {
    const result = renderLigature('x', 'y', 'tilde');
    expect(result.charCodeAt(1)).toBe(0xFE22);
    expect(result.charCodeAt(3)).toBe(0xFE23);
  });

  it('wraps pair with macron half marks (U+FE24/U+FE25)', () => {
    const result = renderLigature('m', 'n', 'macron');
    expect(result.charCodeAt(1)).toBe(0xFE24);
    expect(result.charCodeAt(3)).toBe(0xFE25);
  });

  it('wraps pair with tieBelow half marks (U+FE28/U+FE29)', () => {
    const result = renderLigature('p', 'q', 'tieBelow');
    expect(result.charCodeAt(1)).toBe(0xFE28);
    expect(result.charCodeAt(3)).toBe(0xFE29);
  });

  it('wraps pair with solidus half marks (U+FE2A/U+FE2B)', () => {
    const result = renderLigature('s', 't', 'solidus');
    expect(result.charCodeAt(1)).toBe(0xFE2A);
    expect(result.charCodeAt(3)).toBe(0xFE2B);
  });

  it('throws on unknown kind', () => {
    expect(() => renderLigature('a', 'b', 'unknown')).toThrow(/Unknown ligature kind/);
  });
});

// ---------------------------------------------------------------------------
// Internal table sanity checks
// ---------------------------------------------------------------------------
describe('internal combining Latin table', () => {
  it('has exactly 13 entries', () => {
    expect(Object.keys(_COMBINING_LATIN).length).toBe(13);
  });

  it('a maps to U+0363', () => {
    expect(_COMBINING_LATIN.a.charCodeAt(0)).toBe(0x0363);
  });

  it('x maps to U+036F', () => {
    expect(_COMBINING_LATIN.x.charCodeAt(0)).toBe(0x036F);
  });
});

describe('internal enclosing marks table', () => {
  it('has exactly 6 entries', () => {
    expect(Object.keys(_ENCLOSING).length).toBe(6);
  });

  it('circle is U+20DD', () => {
    expect(_ENCLOSING.circle.charCodeAt(0)).toBe(0x20DD);
  });
});

describe('internal half marks table', () => {
  it('has exactly 5 entries', () => {
    expect(Object.keys(_HALF_MARKS).length).toBe(5);
  });

  it('tie pair is [U+FE20, U+FE21]', () => {
    expect(_HALF_MARKS.tie[0].charCodeAt(0)).toBe(0xFE20);
    expect(_HALF_MARKS.tie[1].charCodeAt(0)).toBe(0xFE21);
  });
});

// ---------------------------------------------------------------------------
// MATH_ALPHA_GAPS — exported gap table
// ---------------------------------------------------------------------------
describe('MATH_ALPHA_GAPS', () => {
  it('is exported and is a plain object', () => {
    expect(typeof MATH_ALPHA_GAPS).toBe('object');
    expect(MATH_ALPHA_GAPS).not.toBeNull();
  });

  it('has exactly 25 entries (24 gaps + Script P discovered during patch)', () => {
    expect(Object.keys(MATH_ALPHA_GAPS).length).toBe(25);
  });

  it('maps italic h (0x1D455) to U+210E ℎ', () => {
    expect(MATH_ALPHA_GAPS[0x1D455]).toBe('\u210E');
  });

  it('maps Script P (0x1D4AB) to U+2118 ℘', () => {
    expect(MATH_ALPHA_GAPS[0x1D4AB]).toBe('\u2118');
  });

  it('maps Script F (0x1D4A1) to U+2131 ℱ', () => {
    expect(MATH_ALPHA_GAPS[0x1D4A1]).toBe('\u2131');
  });

  it('maps Fraktur Z (0x1D51D) to U+2128 ℨ', () => {
    expect(MATH_ALPHA_GAPS[0x1D51D]).toBe('\u2128');
  });

  it('maps Double-Struck R (0x1D549) to U+211D ℝ', () => {
    expect(MATH_ALPHA_GAPS[0x1D549]).toBe('\u211D');
  });

  it('all values are single-codepoint strings from the Letterlike Symbols block (U+2100–U+214F)', () => {
    for (const [key, val] of Object.entries(MATH_ALPHA_GAPS)) {
      const cp = val.codePointAt(0);
      expect(cp, `gap key ${key} replacement ${cp?.toString(16)} is outside Letterlike Symbols`)
        .toBeGreaterThanOrEqual(0x2100);
      expect(cp).toBeLessThanOrEqual(0x214F);
    }
  });

  it('no reserved codepoint maps to itself', () => {
    for (const [key, val] of Object.entries(MATH_ALPHA_GAPS)) {
      expect(Number(key)).not.toBe(val.codePointAt(0));
    }
  });
});

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------
describe('ANSI helpers', () => {
  it('fg256 produces correct escape sequence', () => {
    expect(fg256(46)).toBe('\x1b[38;5;46m');
    expect(fg256(196)).toBe('\x1b[38;5;196m');
  });

  it('bg256 produces correct escape sequence', () => {
    expect(bg256(0)).toBe('\x1b[48;5;0m');
    expect(bg256(255)).toBe('\x1b[48;5;255m');
  });

  it('fg24 produces correct truecolor escape sequence', () => {
    expect(fg24(255, 128, 0)).toBe('\x1b[38;2;255;128;0m');
    expect(fg24(0, 0, 0)).toBe('\x1b[38;2;0;0;0m');
  });

  it('bg24 produces correct truecolor escape sequence', () => {
    expect(bg24(20, 120, 220)).toBe('\x1b[48;2;20;120;220m');
  });

  it('ANSI_RST is the full reset sequence', () => {
    expect(ANSI_RST).toBe('\x1b[0m');
  });

  it('ANSI_BOLD is the bold-on sequence', () => {
    expect(ANSI_BOLD).toBe('\x1b[1m');
  });

  it('ANSI_DIM is the dim-on sequence', () => {
    expect(ANSI_DIM).toBe('\x1b[2m');
  });
});

// ---------------------------------------------------------------------------
// createBrailleBuffer
// ---------------------------------------------------------------------------
describe('createBrailleBuffer', () => {
  it('returns an object with set, get, render, cellCols, cellRows', () => {
    const buf = createBrailleBuffer(4, 4);
    expect(typeof buf.set).toBe('function');
    expect(typeof buf.get).toBe('function');
    expect(typeof buf.render).toBe('function');
    expect(buf.cellCols).toBe(2);
    expect(buf.cellRows).toBe(1);
  });

  it('cellCols = ceil(pixelWidth / 2)', () => {
    expect(createBrailleBuffer(10, 4).cellCols).toBe(5);
    expect(createBrailleBuffer(11, 4).cellCols).toBe(6); // odd rounds up
  });

  it('cellRows = ceil(pixelHeight / 4)', () => {
    expect(createBrailleBuffer(4, 8).cellRows).toBe(2);
    expect(createBrailleBuffer(4, 9).cellRows).toBe(3); // odd rounds up
  });

  it('render returns cellRows strings each of length cellCols', () => {
    const buf = createBrailleBuffer(6, 4);
    const lines = buf.render(null);
    expect(lines.length).toBe(1);
    // Each braille codepoint is 1 "character" visually but may be 1 or 2 UTF-16 units
    // codePointAt(0) works; just check line length by codepoints
    expect([...lines[0]].length).toBe(3);
  });

  it('empty buffer renders all blank braille (U+2800)', () => {
    const buf = createBrailleBuffer(4, 4);
    const lines = buf.render(null);
    for (const ch of [...lines[0]]) {
      expect(ch.codePointAt(0)).toBe(0x2800);
    }
  });

  it('set(0,0) sets bit 0 in cell (0,0) → codepoint U+2801', () => {
    const buf = createBrailleBuffer(4, 4);
    buf.set(0, 0);
    const lines = buf.render(null);
    // cell (0,0): dotCol=0, dotRow=0 → bit 0 → 0x2800 + 1 = U+2801
    expect(lines[0].codePointAt(0)).toBe(0x2801);
  });

  it('set(1,0) sets bit 3 in cell (0,0) → codepoint U+2808', () => {
    const buf = createBrailleBuffer(4, 4);
    buf.set(1, 0);
    const lines = buf.render(null);
    // dotCol=1, dotRow=0 → bit 3 → 0x2800 + 8 = U+2808
    expect(lines[0].codePointAt(0)).toBe(0x2808);
  });

  it('out-of-bounds set calls are silently ignored', () => {
    const buf = createBrailleBuffer(2, 4);
    expect(() => buf.set(-1, 0)).not.toThrow();
    expect(() => buf.set(0, -1)).not.toThrow();
    expect(() => buf.set(100, 100)).not.toThrow();
    // Buffer should still be all empty
    const lines = buf.render(null);
    expect(lines[0].codePointAt(0)).toBe(0x2800);
  });

  it('get returns 0 for unset pixel', () => {
    const buf = createBrailleBuffer(4, 4);
    expect(buf.get(0, 0)).toBe(0);
  });

  it('get returns accumulated bits after set', () => {
    const buf = createBrailleBuffer(4, 4);
    buf.set(0, 0); // bit 0
    buf.set(1, 0); // bit 3
    // Both in cell (0,0): bits 0 + 3 = 1 + 8 = 9
    expect(buf.get(0, 0)).toBe(9);
    expect(buf.get(1, 0)).toBe(9); // same cell
  });

  it('colorFn is called for non-empty cells and its return wraps the char', () => {
    const buf = createBrailleBuffer(2, 4);
    buf.set(0, 0);
    const calls = [];
    const lines = buf.render((bits) => {
      calls.push(bits);
      return '\x1b[31m'; // red
    });
    expect(calls.length).toBe(1);
    expect(lines[0]).toContain('\x1b[31m');
    expect(lines[0]).toContain(ANSI_RST);
  });

  it('colorFn returning null skips ANSI wrapping', () => {
    const buf = createBrailleBuffer(2, 4);
    buf.set(0, 0);
    const lines = buf.render(() => null);
    expect(lines[0]).not.toContain('\x1b[');
  });
});

// ---------------------------------------------------------------------------
// hbar
// ---------------------------------------------------------------------------
describe('hbar', () => {
  it('returns a string of the requested width (ignoring ANSI escape sequences)', () => {
    const result = hbar(50, 100, 20, 46);
    // Strip ANSI and count visible chars
    const visible = result.replace(/\x1b\[[0-9;]*m/g, '');
    expect(visible.length).toBe(20);
  });

  it('full bar (value >= max) produces only full-block chars in visible area', () => {
    const result = hbar(100, 100, 10, 46);
    const visible = result.replace(/\x1b\[[0-9;]*m/g, '');
    expect(visible).toBe('\u2588'.repeat(10));
  });

  it('zero value produces spaces in visible area', () => {
    const result = hbar(0, 100, 10, 46);
    const visible = result.replace(/\x1b\[[0-9;]*m/g, '');
    expect(visible).toBe(' '.repeat(10));
  });

  it('contains fg256 color sequence', () => {
    const result = hbar(50, 100, 10, 196);
    expect(result).toContain('\x1b[38;5;196m');
  });

  it('contains ANSI reset sequence', () => {
    const result = hbar(50, 100, 10, 46);
    expect(result).toContain(ANSI_RST);
  });

  it('clamps value above max to full bar', () => {
    const result = hbar(200, 100, 8, 46);
    const visible = result.replace(/\x1b\[[0-9;]*m/g, '');
    expect(visible).toBe('\u2588'.repeat(8));
  });

  it('sub-block fractional edge: half bar on 16-char width contains sub-block char', () => {
    // 50% of 16 = 8 full blocks, no remainder → no sub-block
    // 56.25% of 16 = 9 full blocks, no remainder
    // 53.125% = 8.5 cells = 68 eighths → 8 full + 4 eighths (U+258C = half)
    const result = hbar(53.125, 100, 16, 46);
    const visible = result.replace(/\x1b\[[0-9;]*m/g, '');
    // Should contain exactly 8 full blocks + 1 sub-block + spaces
    expect(visible[8]).toBe('\u258C'); // 4/8 = half-left block
  });
});

// ---------------------------------------------------------------------------
// sparkline
// ---------------------------------------------------------------------------
describe('sparkline', () => {
  it('returns a string of exactly width characters', () => {
    const values = [1, 2, 3, 4, 5];
    const result = sparkline(values, 10);
    expect([...result].length).toBe(10);
  });

  it('all characters are braille codepoints (U+2800–U+28FF)', () => {
    const values = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const result = sparkline(values, 8);
    for (const ch of [...result]) {
      const cp = ch.codePointAt(0);
      expect(cp).toBeGreaterThanOrEqual(0x2800);
      expect(cp).toBeLessThanOrEqual(0x28FF);
    }
  });

  it('empty values array returns blank braille (U+2800) fill', () => {
    const result = sparkline([], 5);
    expect([...result].length).toBe(5);
    for (const ch of [...result]) {
      expect(ch.codePointAt(0)).toBe(0x2800);
    }
  });

  it('constant values produce top-row dots (max = min, all normalized to 1)', () => {
    // All same value → norm = 0/1 = 0 → after (1 - 0) * 3 = 3 → py=3 (bottom row)
    // Actually range=1 when max==min, so norm=(v-v)/1=0 → py = round((1-0)*3) = 3
    const result = sparkline([5, 5, 5, 5], 4);
    // Should be non-blank (dots present at row 3)
    const hasNonBlank = [...result].some(ch => ch.codePointAt(0) !== 0x2800);
    expect(hasNonBlank).toBe(true);
  });

  it('single value is handled without throwing', () => {
    expect(() => sparkline([42], 5)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// progressBar
// ---------------------------------------------------------------------------
describe('progressBar', () => {
  it('contains a percentage label matching the ratio', () => {
    const result = progressBar(0.75, 20, 46);
    expect(result).toContain('75%');
  });

  it('contains fg256 color sequence', () => {
    const result = progressBar(0.5, 10, 226);
    expect(result).toContain('\x1b[38;5;226m');
  });

  it('contains ANSI reset', () => {
    const result = progressBar(0.5, 10, 46);
    expect(result).toContain(ANSI_RST);
  });

  it('at ratio=1.0 bar is all full blocks, label is 100%', () => {
    const result = progressBar(1.0, 10, 46);
    const visible = result.replace(/\x1b\[[0-9;]*m/g, '');
    expect(visible).toBe('\u2588'.repeat(10) + ' 100%');
  });

  it('at ratio=0 bar is all light-shade track chars, label is 0%', () => {
    const result = progressBar(0, 10, 46);
    const visible = result.replace(/\x1b\[[0-9;]*m/g, '');
    // Color prefix is before filled block but filled=0 so: '' + RST + '░'*10 + ' 0%'
    expect(visible).toBe('\u2591'.repeat(10) + ' 0%');
  });

  it('clamps ratio above 1 to 100%', () => {
    const result = progressBar(2.0, 5, 46);
    expect(result).toContain('100%');
  });

  it('clamps ratio below 0 to 0%', () => {
    const result = progressBar(-0.5, 5, 46);
    expect(result).toContain('0%');
  });

  it('at 50% the filled and empty portions split the width', () => {
    const result = progressBar(0.5, 10, 46);
    const visible = result.replace(/\x1b\[[0-9;]*m/g, '');
    // 5 full blocks + 5 light-shade + ' 50%'
    expect(visible.startsWith('\u2588\u2588\u2588\u2588\u2588\u2591\u2591\u2591\u2591\u2591')).toBe(true);
    expect(visible).toContain('50%');
  });
});

// ---------------------------------------------------------------------------
// capBrailleDensity
// ---------------------------------------------------------------------------
describe('capBrailleDensity', () => {
  // Helper: build a string of N braille chars (all U+2800, the blank braille)
  function brailleStr(n) {
    return '\u2800'.repeat(n);
  }

  it('passes through text with fewer than 100 braille codepoints unchanged', () => {
    const input = brailleStr(50);
    const result = capBrailleDensity(input);
    expect(result).toBe(input);
    expect([...result].length).toBe(50);
  });

  it('passes through text with exactly 100 braille codepoints unchanged', () => {
    const input = brailleStr(100);
    const result = capBrailleDensity(input);
    expect(result).toBe(input);
    expect([...result].length).toBe(100);
  });

  it('truncates text at 101 braille codepoints and appends ellipsis', () => {
    const input = brailleStr(101);
    const result = capBrailleDensity(input);
    // Should have exactly 100 braille chars + U+2026
    const codepoints = [...result];
    expect(codepoints.length).toBe(101); // 100 braille + 1 ellipsis
    expect(codepoints[100]).toBe('\u2026');
    // Last char is ellipsis, not another braille codepoint
    expect(codepoints[100].codePointAt(0)).toBe(0x2026);
  });

  it('non-braille characters are preserved and do not count toward the limit', () => {
    // 50 non-braille chars + 50 braille = total 100, should not truncate
    const input = 'x'.repeat(50) + brailleStr(50);
    const result = capBrailleDensity(input);
    expect(result).toBe(input);
  });

  it('non-braille chars interspersed with braille are counted correctly', () => {
    // Alternating: 101 braille + 101 non-braille interspersed
    // Should truncate when braille count hits 100
    const input = Array.from({ length: 101 }, (_, i) => '\u2800' + String.fromCharCode(65 + (i % 26))).join('');
    const result = capBrailleDensity(input);
    const brailleCount = [...result].filter(ch => {
      const cp = ch.codePointAt(0);
      return cp >= 0x2800 && cp <= 0x28FF;
    }).length;
    expect(brailleCount).toBe(100);
    expect(result.endsWith('\u2026')).toBe(true);
  });

  it('respects custom maxCodepoints parameter', () => {
    const input = brailleStr(10);
    const result = capBrailleDensity(input, 5);
    const codepoints = [...result];
    expect(codepoints.length).toBe(6); // 5 braille + ellipsis
    expect(codepoints[5]).toBe('\u2026');
  });

  it('handles empty string without throwing', () => {
    expect(capBrailleDensity('')).toBe('');
  });

  it('handles string with no braille codepoints unchanged', () => {
    const input = 'hello world';
    expect(capBrailleDensity(input)).toBe(input);
  });

  it('sparkline output respects the 100-codepoint cap (integration check)', () => {
    // sparkline with width=60 produces 60 braille chars, which is under the limit
    const values = Array.from({ length: 60 }, (_, i) => i);
    const result = sparkline(values, 60);
    const brailleCount = [...result].filter(ch => {
      const cp = ch.codePointAt(0);
      return cp >= 0x2800 && cp <= 0x28FF;
    }).length;
    // Under 100 — should pass through unchanged (no truncation)
    expect(brailleCount).toBe(60);
    expect(result).not.toContain('\u2026');
  });

  it('sparkline capped at 100 wide produces truncated output for oversized widths', () => {
    // sparkline with width=110 would produce 110 braille chars, but cap kicks in at 100
    const values = Array.from({ length: 110 }, (_, i) => i);
    const result = sparkline(values, 110);
    const codepoints = [...result];
    // After cap: 100 braille + ellipsis = 101 total codepoints
    expect(codepoints.length).toBe(101);
    expect(codepoints[100]).toBe('\u2026');
  });
});

// ---------------------------------------------------------------------------
// renderSmallCaps \u2014 BMP styled alphabet (combining-mark-safe)
// ---------------------------------------------------------------------------
describe('renderSmallCaps', () => {
  it('renders "forge" as the cookbook \u00a74.4 small-caps row \ua730\u1d0f\u0280\u0262\u1d07', () => {
    const result = renderSmallCaps('forge');
    const cps = [...result].map(ch => ch.codePointAt(0));
    expect(cps).toEqual([0xA730, 0x1D0F, 0x0280, 0x0262, 0x1D07]); // \ua730 \u1d0f \u0280 \u0262 \u1d07
  });

  it('is case-insensitive \u2014 A and a both map to U+1D00 \u1d00', () => {
    expect(renderSmallCaps('A').codePointAt(0)).toBe(0x1D00);
    expect(renderSmallCaps('a').codePointAt(0)).toBe(0x1D00);
  });

  it('maps q to U+A7AF \ua7af (Latin Extended-D, Unicode 9.0)', () => {
    expect(renderSmallCaps('q').codePointAt(0)).toBe(0xA7AF);
  });

  it('x falls back to ASCII lowercase x (no small capital X in Unicode)', () => {
    expect(renderSmallCaps('x')).toBe('x');
    expect(renderSmallCaps('X')).toBe('x');
  });

  it('digits and punctuation pass through unchanged', () => {
    expect(renderSmallCaps('42!')).toBe('42!');
  });

  it('INVARIANT: full alphabet output is entirely BMP (every codepoint <= 0xFFFF)', () => {
    // This is the load-bearing property: BMP bases can carry combining marks
    // on Termius; SMP bases cannot. If any map entry drifts into SMP, the
    // styled palimpsest below becomes a replacement-glyph generator.
    const result = renderSmallCaps('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz');
    for (const ch of result) {
      expect(ch.codePointAt(0)).toBeLessThanOrEqual(0xFFFF);
    }
  });

  it('internal map has all 26 letters and no replacement glyphs', () => {
    expect(Object.keys(_SMALL_CAPS).length).toBe(26);
    for (const val of Object.values(_SMALL_CAPS)) {
      expect(val.codePointAt(0)).not.toBe(0xFFFD);
    }
  });
});

// ---------------------------------------------------------------------------
// renderFullWidth \u2014 BMP styled alphabet (combining-mark-safe)
// ---------------------------------------------------------------------------
describe('renderFullWidth', () => {
  it('maps A to U+FF21 (FULLWIDTH LATIN CAPITAL LETTER A)', () => {
    expect(renderFullWidth('A').codePointAt(0)).toBe(0xFF21);
  });

  it('maps a to U+FF41 and 0 to U+FF10', () => {
    expect(renderFullWidth('a').codePointAt(0)).toBe(0xFF41);
    expect(renderFullWidth('0').codePointAt(0)).toBe(0xFF10);
  });

  it('maps printable ASCII punctuation by +0xFEE0 offset (! \u2192 U+FF01)', () => {
    expect(renderFullWidth('!').codePointAt(0)).toBe(0xFF01);
  });

  it('maps space to U+3000 IDEOGRAPHIC SPACE', () => {
    expect(renderFullWidth(' ').codePointAt(0)).toBe(0x3000);
  });

  it('passes non-ASCII characters through unchanged', () => {
    expect(renderFullWidth('\u25c6')).toBe('\u25c6');
  });

  it('INVARIANT: output is entirely BMP for full printable-ASCII input', () => {
    const ascii = Array.from({ length: 0x7E - 0x20 + 1 }, (_, i) => String.fromCharCode(0x20 + i)).join('');
    const result = renderFullWidth(ascii);
    for (const ch of result) {
      expect(ch.codePointAt(0)).toBeLessThanOrEqual(0xFFFF);
    }
  });
});

// ---------------------------------------------------------------------------
// renderStyledPalimpsest \u2014 weight + combining layer in the same cells
// ---------------------------------------------------------------------------
describe('renderStyledPalimpsest', () => {
  it('smallCaps style: base cell is small-caps, overlay rides as combining mark', () => {
    // 'f' \u2192 \ua730 (U+A730), overlay 'c' \u2192 U+0368
    const result = renderStyledPalimpsest('f', 'c', 'smallCaps');
    const cps = [...result].map(ch => ch.codePointAt(0));
    expect(cps).toEqual([0xA730, 0x0368]);
  });

  it('renders CTX/act as \u1d04\u0363\u1d1b\u0368x\u036d (the HUD zone showcase cells)', () => {
    const result = renderStyledPalimpsest('CTX', 'act', 'smallCaps');
    const cps = [...result].map(ch => ch.codePointAt(0));
    // \u1d04+combining-a, \u1d1b+combining-c, x+combining-t
    expect(cps).toEqual([0x1D04, 0x0363, 0x1D1B, 0x0368, 0x78, 0x036D]);
  });

  it('defaults to smallCaps style', () => {
    expect(renderStyledPalimpsest('f', 'c')).toBe(renderStyledPalimpsest('f', 'c', 'smallCaps'));
  });

  it('plain style matches renderPalimpsest behavior', () => {
    expect(renderStyledPalimpsest('forge', 'court', 'plain')).toBe(renderPalimpsest('forge', 'court'));
  });

  it('fullWidth style: combining mark lands on the fullwidth BMP base', () => {
    const result = renderStyledPalimpsest('A', 'a', 'fullWidth');
    const cps = [...result].map(ch => ch.codePointAt(0));
    expect(cps).toEqual([0xFF21, 0x0363]); // \uff21 + combining a
  });

  it('skips overlay letters outside the 13-letter combining set', () => {
    // 'b' has no combining form \u2014 styled base passes through bare
    const result = renderStyledPalimpsest('forge', 'bbbbb', 'smallCaps');
    expect(result).toBe(renderSmallCaps('forge'));
  });

  it('handles overlay shorter than base', () => {
    const result = renderStyledPalimpsest('forge', 'co', 'smallCaps');
    const cps = [...result].map(ch => ch.codePointAt(0));
    // \ua730+c-mark, \u1d0f+o-mark, then bare \u0280 \u0262 \u1d07
    expect(cps).toEqual([0xA730, 0x0368, 0x1D0F, 0x0366, 0x0280, 0x0262, 0x1D07]);
  });

  it('throws on SMP styles, naming the trap', () => {
    for (const bad of ['bold', 'fraktur', 'script', 'doubleStruck', 'monospace', 'italic']) {
      expect(() => renderStyledPalimpsest('x', 'a', bad)).toThrow(/SMP|combining-unsafe/);
    }
  });

  it('throws on unknown styles', () => {
    expect(() => renderStyledPalimpsest('x', 'a', 'neon')).toThrow(/Unknown or combining-unsafe style/);
  });

  it('INVARIANT: every cell receiving a combining mark has a BMP base', () => {
    // Walk the output; whenever a combining Latin letter (U+0363\u2013U+036F)
    // appears, the codepoint immediately before it must be <= 0xFFFF.
    for (const style of ['plain', 'smallCaps', 'fullWidth']) {
      const out = [...renderStyledPalimpsest('forge status', 'court action', style)];
      for (let i = 0; i < out.length; i++) {
        const cp = out[i].codePointAt(0);
        if (cp >= 0x0363 && cp <= 0x036F) {
          expect(i).toBeGreaterThan(0);
          expect(out[i - 1].codePointAt(0)).toBeLessThanOrEqual(0xFFFF);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// S528: renderEnclosed / renderLigature input sanitization (Rider 1 — closes
// the two combining-mark adders left unwired in S527, adversarial review
// INFO-2). A caller must not be able to pre-seat a hidden-channel payload in a
// base/cell argument.
// ---------------------------------------------------------------------------
describe('renderEnclosed — input sanitization (S528)', () => {
  const ZWSP = String.fromCodePoint(0x200B);      // zero-width space
  const CMB_D = String.fromCodePoint(0x0369);     // combining Latin small letter d
  const TAG_X = String.fromCodePoint(0xE0058);    // Plane-14 Tag "X"

  it('strips a smuggled zero-width payload from base before enclosing', () => {
    const out = renderEnclosed('A' + ZWSP + 'B', 'circle');
    expect(out).not.toContain(ZWSP);
    // Two visible bases → two enclosing circles, nothing else hidden.
    expect(out).toBe('A' + _ENCLOSING.circle + 'B' + _ENCLOSING.circle);
  });

  it('strips a pre-seated combining mark and a Plane-14 tag from base', () => {
    const out = renderEnclosed('r' + CMB_D + TAG_X, 'square');
    expect(out).not.toContain(CMB_D);
    expect(out).not.toContain(TAG_X);
    expect(out).toBe('r' + _ENCLOSING.square);
  });

  it('still throws on an unknown shape (behavior unchanged)', () => {
    expect(() => renderEnclosed('A', 'hexagon')).toThrow(/Unknown enclosing shape/);
  });
});

describe('renderLigature — input sanitization (S528)', () => {
  const ZWJ = String.fromCodePoint(0x200D);
  const CMB_A = String.fromCodePoint(0x0363);

  it('strips hidden channels from both cell characters before joining', () => {
    const out = renderLigature('a' + ZWJ, 'b' + CMB_A, 'tie');
    expect(out).not.toContain(ZWJ);
    expect(out).not.toContain(CMB_A);
    expect(out).toBe('a' + _HALF_MARKS.tie[0] + 'b' + _HALF_MARKS.tie[1]);
  });

  it('still throws on an unknown ligature kind (behavior unchanged)', () => {
    expect(() => renderLigature('a', 'b', 'unknown')).toThrow(/Unknown ligature kind/);
  });
});

// ---------------------------------------------------------------------------
// blockRamp — misrender-safe ▁▂▃▄▅▆▇█ sparkline (S533)
// ---------------------------------------------------------------------------
describe('blockRamp', () => {
  it('renders one glyph per sample by default', () => {
    expect([...blockRamp([1, 2, 3, 4, 5])].length).toBe(5);
  });

  it('maps an evenly-spaced ascending series to the full ▁▂▃▄▅▆▇█ ramp', () => {
    // norm = i/7 → round((i/7)*7) = i → glyph index i exactly.
    expect(blockRamp([0, 1, 2, 3, 4, 5, 6, 7])).toBe('▁▂▃▄▅▆▇█');
  });

  it('every glyph is in the lower-block range U+2581–U+2588', () => {
    const out = blockRamp([3, 1, 4, 1, 5, 9, 2, 6]);
    for (const ch of [...out]) {
      const cp = ch.codePointAt(0);
      expect(cp).toBeGreaterThanOrEqual(0x2581);
      expect(cp).toBeLessThanOrEqual(0x2588);
    }
  });

  it('the series minimum renders ▁ and the maximum renders █', () => {
    const out = [...blockRamp([5, 20, 12, 3, 8])];
    // min is 3 (index 3), max is 20 (index 1)
    expect(out[3]).toBe('▁');
    expect(out[1]).toBe('█');
  });

  it('resamples to opts.width when given', () => {
    const long = Array.from({ length: 40 }, (_, i) => i);
    expect([...blockRamp(long, { width: 10 })].length).toBe(10);
  });

  it('a flat series renders as a flat ▁ baseline', () => {
    expect(blockRamp([7, 7, 7, 7])).toBe('▁▁▁▁');
  });

  it('empty series returns an empty string (no width)', () => {
    expect(blockRamp([])).toBe('');
  });

  it('empty series with an explicit width returns that many spaces', () => {
    expect(blockRamp([], { width: 5 })).toBe('     ');
  });

  it('single value renders one baseline glyph', () => {
    expect(blockRamp([42])).toBe('▁');
  });

  it('respects an explicit min/max domain (clamps out-of-range samples)', () => {
    // domain 0..10; value 5 → norm 0.5 → idx round(3.5)=4 → ▅ (index 4)
    const out = [...blockRamp([0, 5, 10], { min: 0, max: 10 })];
    expect(out[0]).toBe('▁');
    expect(out[1]).toBe('▅');
    expect(out[2]).toBe('█');
  });

  it("color 'ramp' wraps each glyph in ANSI but preserves the bare glyphs", () => {
    const colored = blockRamp([0, 1, 2, 3, 4, 5, 6, 7], { color: 'ramp' });
    expect(colored).toContain('\x1b[38;5;'); // 256-color ramp prefix
    expect(colored).toContain(ANSI_RST);
    expect(stripAnsi(colored)).toBe('▁▂▃▄▅▆▇█');
  });

  it('color as a number produces a solid fg256 fill', () => {
    const colored = blockRamp([1, 2, 3], { color: 46 });
    expect(colored).toContain('\x1b[38;5;46m');
    expect(stripAnsi(colored).length).toBe(3);
  });

  it('color as a function receives (norm, value) and its prefix wraps the glyph', () => {
    const seen = [];
    const colored = blockRamp([10, 20], {
      color: (norm, value) => { seen.push([norm, value]); return '\x1b[31m'; },
    });
    expect(seen.length).toBe(2);
    expect(seen[0][1]).toBe(10); // value passed through
    expect(colored).toContain('\x1b[31m');
  });

  it('emits no ANSI when uncolored', () => {
    expect(blockRamp([1, 2, 3])).not.toContain('\x1b[');
  });
});

// ---------------------------------------------------------------------------
// brailleChart — multi-row line / area braille chart (S533)
// ---------------------------------------------------------------------------
describe('brailleChart', () => {
  const wave = [3, 5, 8, 6, 9, 12, 7, 4, 6, 10, 14, 11, 8, 5, 3, 7];

  it('returns a single row by default (height 1)', () => {
    expect(brailleChart(wave)).toHaveLength(1);
  });

  it('returns `height` rows', () => {
    expect(brailleChart(wave, { height: 3, width: 16 })).toHaveLength(3);
  });

  it('each rendered cell is a braille codepoint (U+2800–U+28FF)', () => {
    const lines = brailleChart(wave, { height: 2, width: 12 });
    for (const line of lines) {
      for (const ch of [...line]) {
        const cp = ch.codePointAt(0);
        expect(cp).toBeGreaterThanOrEqual(0x2800);
        expect(cp).toBeLessThanOrEqual(0x28FF);
      }
    }
  });

  it('each row is exactly opts.width cells wide', () => {
    const lines = brailleChart(wave, { height: 2, width: 20 });
    for (const line of lines) {
      expect([...line].length).toBe(20);
    }
  });

  it('default width is ceil(values.length / 2) cells', () => {
    // 16 samples → 8 cells (2 samples per cell)
    expect([...brailleChart(wave)[0]].length).toBe(8);
  });

  it('empty series returns blank braille rows of the given width', () => {
    const lines = brailleChart([], { height: 2, width: 4 });
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect([...line].length).toBe(4);
      for (const ch of [...line]) expect(ch.codePointAt(0)).toBe(0x2800);
    }
  });

  it('area mode fills the baseline row (bottom cell row has no blank cells)', () => {
    const lines = brailleChart(wave, { height: 3, width: 16, mode: 'area' });
    const bottom = [...lines[lines.length - 1]];
    // Every column fills from its curve height down to the bottom pixel row,
    // so the bottom cell row is fully populated.
    expect(bottom.every(ch => ch.codePointAt(0) !== 0x2800)).toBe(true);
  });

  it('line mode does not fill the whole baseline (fewer dots than area)', () => {
    const line = brailleChart(wave, { height: 3, width: 16, mode: 'line' });
    const area = brailleChart(wave, { height: 3, width: 16, mode: 'area' });
    const dots = (rows) => rows.join('').split('').reduce((n, ch) => {
      const cp = ch.codePointAt(0);
      // popcount of the braille bit pattern
      let bits = cp >= 0x2800 && cp <= 0x28FF ? cp - 0x2800 : 0;
      let c = 0; while (bits) { c += bits & 1; bits >>= 1; }
      return n + c;
    }, 0);
    expect(dots(area)).toBeGreaterThan(dots(line));
  });

  it('single value is handled without throwing', () => {
    expect(() => brailleChart([42], { height: 2 })).not.toThrow();
  });

  it("color 'ramp' colors non-blank cells and leaves blank cells bare", () => {
    const lines = brailleChart(wave, { height: 3, width: 16, color: 'ramp' });
    const joined = lines.join('\n');
    expect(joined).toContain('\x1b[38;5;');
    // Stripping ANSI recovers pure braille (+ newlines).
    for (const ch of stripAnsi(joined).replace(/\n/g, '')) {
      const cp = ch.codePointAt(0);
      expect(cp).toBeGreaterThanOrEqual(0x2800);
      expect(cp).toBeLessThanOrEqual(0x28FF);
    }
  });

  it('uncolored output contains no ANSI', () => {
    expect(brailleChart(wave, { height: 2 }).join('')).not.toContain('\x1b[');
  });
});

// ---------------------------------------------------------------------------
// brailleBand — area/density-band convenience (S533)
// ---------------------------------------------------------------------------
describe('brailleBand', () => {
  const series = [2, 4, 3, 6, 8, 5, 7, 9];

  it('equals brailleChart in area mode', () => {
    expect(brailleBand(series, { height: 2, width: 8 }))
      .toEqual(brailleChart(series, { height: 2, width: 8, mode: 'area' }));
  });

  it('forces area mode even if mode:line is passed', () => {
    expect(brailleBand(series, { height: 2, width: 8, mode: 'line' }))
      .toEqual(brailleChart(series, { height: 2, width: 8, mode: 'area' }));
  });

  it('fills the bottom baseline row', () => {
    const lines = brailleBand(series, { height: 2, width: 8 });
    const bottom = [...lines[lines.length - 1]];
    expect(bottom.every(ch => ch.codePointAt(0) !== 0x2800)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Non-finite input hygiene (S533 gate follow-up) — NaN/±Infinity samples must
// not poison the Math.min/Math.max auto-domain and flatten the whole chart.
// ---------------------------------------------------------------------------
describe('non-finite input hygiene', () => {
  it('blockRamp ignores NaN/Infinity samples instead of flattening', () => {
    expect(blockRamp([0, NaN, 10, Infinity, 5], { width: 3 }))
      .toBe(blockRamp([0, 10, 5], { width: 3 }));
  });

  it('blockRamp with a poisoned series still spans the ramp', () => {
    const out = [...blockRamp([0, NaN, 7])];
    expect(out).toContain('▁');
    expect(out).toContain('█');
  });

  it('brailleChart ignores non-finite samples instead of flattening', () => {
    expect(brailleChart([5, NaN, 9, -Infinity, 2], { height: 2, width: 4 }))
      .toEqual(brailleChart([5, 9, 2], { height: 2, width: 4 }));
  });

  it('brailleBand ignores non-finite samples', () => {
    expect(brailleBand([1, Infinity, 4], { height: 1, width: 2 }))
      .toEqual(brailleBand([1, 4], { height: 1, width: 2 }));
  });

  it('an all-non-finite series renders the empty state, not garbage', () => {
    expect(blockRamp([NaN, NaN], { width: 4 })).toBe('    ');
    expect(brailleChart([NaN, Infinity], { height: 2, width: 3 }))
      .toEqual(['⠀⠀⠀', '⠀⠀⠀']);
  });

  it('a clean series is untouched (no behavior change on the happy path)', () => {
    expect(blockRamp([0, 1, 2, 3, 4, 5, 6, 7])).toBe('▁▂▃▄▅▆▇█');
  });
});

// ---------------------------------------------------------------------------
// Cold ramp color helpers (S533) — blue/purple, survival-list safe
// ---------------------------------------------------------------------------
describe('cold ramp color helpers', () => {
  it('COLD_RAMP_256 is the 6-stop violet→cyan ramp anchored on brand 63/39', () => {
    expect(COLD_RAMP_256).toEqual([57, 63, 33, 39, 45, 51]);
    expect(COLD_RAMP_256).toContain(63); // brand purple #5f5fff
    expect(COLD_RAMP_256).toContain(39); // brand blue #00afff
  });

  it('COLD_RAMP_STOPS has one RGB triple per 256 stop', () => {
    expect(COLD_RAMP_STOPS).toHaveLength(COLD_RAMP_256.length);
    for (const stop of COLD_RAMP_STOPS) {
      expect(stop).toHaveLength(3);
      for (const ch of stop) {
        expect(ch).toBeGreaterThanOrEqual(0);
        expect(ch).toBeLessThanOrEqual(255);
      }
    }
  });

  it('rampColor256 maps endpoints and midpoint onto ramp stops', () => {
    expect(rampColor256(0)).toBe(57);   // deep violet
    expect(rampColor256(1)).toBe(51);   // bright cyan
    expect(rampColor256(0.5)).toBe(39);  // round(0.5*5)=3 → brand blue
  });

  it('rampColor256 clamps out-of-range input', () => {
    expect(rampColor256(-3)).toBe(57);
    expect(rampColor256(9)).toBe(51);
    expect(rampColor256(NaN)).toBe(57);
  });

  it('rampRgb returns the anchor endpoints exactly', () => {
    expect(rampRgb(0)).toEqual({ r: 95, g: 0, b: 255 });
    expect(rampRgb(1)).toEqual({ r: 0, g: 255, b: 255 });
  });

  it('rampRgb interpolates between anchor stops', () => {
    // pos = 0.5*5 = 2.5 → lerp stops[2]=[0,135,255] → stops[3]=[0,175,255] @ 0.5
    expect(rampRgb(0.5)).toEqual({ r: 0, g: 155, b: 255 });
  });

  it('rampColor returns a 256 escape by default and truecolor on request', () => {
    expect(rampColor(0.5)).toBe('\x1b[38;5;39m');
    expect(rampColor(0.5, 'truecolor')).toBe('\x1b[38;2;0;155;255m');
  });

  it('colorizeRamp wraps text with the ramp color and a reset', () => {
    expect(colorizeRamp('X', 0)).toBe('\x1b[38;5;57mX' + ANSI_RST);
    expect(colorizeRamp('X', 1, 'truecolor')).toBe('\x1b[38;2;0;255;255mX' + ANSI_RST);
  });

  it('never emits an underline sequence (stripped from response text)', () => {
    // Survival-list discipline: ramp coloring must not depend on underline.
    const samples = [rampColor(0.2), rampColor(0.8, 'truecolor'), colorizeRamp('hi', 0.5)];
    for (const s of samples) expect(s).not.toContain('\x1b[4m');
  });
});
