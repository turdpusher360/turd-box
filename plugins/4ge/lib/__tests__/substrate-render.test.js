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
  // BMP styled alphabets + styled palimpsest
  renderSmallCaps,
  renderFullWidth,
  renderStyledPalimpsest,
  _SMALL_CAPS,
} = require('../substrate-render.cjs');

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
