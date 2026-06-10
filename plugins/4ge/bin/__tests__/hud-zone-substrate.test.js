import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

function requireFresh() {
  for (const key of Object.keys(_require.cache)) {
    if (key.includes('hud-zone-substrate')) {
      delete _require.cache[key];
    }
  }
  return _require(path.resolve(__dirname, '../hud-zone-substrate.cjs'));
}

// Minimal state factories
function healthyState() {
  return {
    session: { id: 'session-test', model: 'opus', contextPct: 32, uptime: 3600000 },
    os: {
      overallHealth: 'ready',
      capabilities: {
        memory:    { ok: true, status: 'ready' },
        git:       { ok: true, status: 'ready' },
        infra:     { ok: true, status: 'ready' },
        audit:     { ok: true, status: 'ready' },
        forge:     { ok: true, status: 'ready' },
      },
    },
    forge: { active: false, phase: null, teammates: [], scope: null },
    context: { trigger: 'command', event: null, zone: null },
  };
}

function degradedState() {
  return {
    session: { id: 'session-degraded', model: 'sonnet', contextPct: 78, uptime: 60000 },
    os: {
      overallHealth: 'degraded',
      capabilities: {
        memory:    { ok: true,  status: 'ready' },
        git:       { ok: false, status: 'error' },
        infra:     { ok: false, status: 'error' },
        audit:     { ok: true,  status: 'ready' },
      },
    },
    forge: { active: true, phase: 'execute', teammates: [], scope: null },
    context: { trigger: 'command', event: null, zone: null },
  };
}

describe('renderSubstrateZone — output contract', () => {
  it('returns a string, not an array', () => {
    const { renderSubstrateZone } = requireFresh();
    const result = renderSubstrateZone(healthyState());
    expect(typeof result).toBe('string');
    expect(Array.isArray(result)).toBe(false);
  });

  it('output contains multiple lines (not a single-line response)', () => {
    const { renderSubstrateZone } = requireFresh();
    const result = renderSubstrateZone(healthyState());
    const lines = result.split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(6);
  });

  it('healthy state produces math-bold title characters in the U+1D400 range', () => {
    const { renderSubstrateZone } = requireFresh();
    const result = renderSubstrateZone(healthyState());
    // Math Bold 'F' = U+1D401 (0x1D400 + 5), 'O' = U+1D40E, etc.
    // Check that at least one codepoint in the math-bold range is present
    let foundMathBold = false;
    for (const cp of result) {
      const code = cp.codePointAt(0);
      if (code >= 0x1D400 && code <= 0x1D56F) {
        foundMathBold = true;
        break;
      }
    }
    expect(foundMathBold).toBe(true);
  });

  it('healthy state uses 🟢 indicator for all-ok capabilities', () => {
    const { renderSubstrateZone } = requireFresh();
    const result = renderSubstrateZone(healthyState());
    expect(result).toContain('🟢');
  });

  it('degraded state uses 🟡 or 🔴 indicators (not only green)', () => {
    const { renderSubstrateZone } = requireFresh();
    const result = renderSubstrateZone(degradedState());
    // At least one non-green indicator present
    const hasNonGreen = result.includes('🟡') || result.includes('🔴');
    expect(hasNonGreen).toBe(true);
  });

  it('output contains combining Latin letter codepoints in signature text (U+0363–U+036F)', () => {
    const { renderSubstrateZone } = requireFresh();
    const result = renderSubstrateZone(healthyState());
    let foundCombining = false;
    for (const cp of result) {
      const code = cp.codePointAt(0);
      if (code >= 0x0363 && code <= 0x036F) {
        foundCombining = true;
        break;
      }
    }
    expect(foundCombining).toBe(true);
  });

  it('output contains block elements (█░▒▓) for health bar', () => {
    const { renderSubstrateZone } = requireFresh();
    const result = renderSubstrateZone(healthyState());
    const hasBlocks = result.includes('\u2588') || result.includes('\u2591') ||
                      result.includes('\u2592') || result.includes('\u2593');
    expect(hasBlocks).toBe(true);
  });

  it('output contains no ANSI escape codes (no 0x1b bytes)', () => {
    const { renderSubstrateZone } = requireFresh();
    const result = renderSubstrateZone(healthyState());
    expect(result).not.toContain('\x1b');
  });

  it('output contains half mark codepoints (U+FE20–U+FE2F) for ligature spans', () => {
    const { renderSubstrateZone } = requireFresh();
    const result = renderSubstrateZone(healthyState());
    let foundHalf = false;
    for (const cp of result) {
      const code = cp.codePointAt(0);
      if (code >= 0xFE20 && code <= 0xFE2F) {
        foundHalf = true;
        break;
      }
    }
    expect(foundHalf).toBe(true);
  });

  it('output contains enclosing mark codepoints (U+20DD–U+20E4)', () => {
    const { renderSubstrateZone } = requireFresh();
    const result = renderSubstrateZone(healthyState());
    let foundEnclosing = false;
    for (const cp of result) {
      const code = cp.codePointAt(0);
      if (code >= 0x20DD && code <= 0x20E4) {
        foundEnclosing = true;
        break;
      }
    }
    expect(foundEnclosing).toBe(true);
  });
});

describe('renderSubstrateZone — content accuracy', () => {
  it('includes health score as math-bold digits', () => {
    const { renderSubstrateZone, toBold } = requireFresh();
    const result = renderSubstrateZone(healthyState());
    // Score should be 100 for all-ok state, rendered as math-bold '100'
    // Just verify the plain score number appears somewhere (math-bold digits are in a different range)
    expect(result).toContain(toBold('100'));
  });

  it('degraded state mentions DEGRADED in math-bold', () => {
    const { renderSubstrateZone, toBold } = requireFresh();
    const result = renderSubstrateZone(degradedState());
    expect(result).toContain(toBold('DEGRADED'));
  });

  it('forge active state mentions the forge phase', () => {
    const { renderSubstrateZone, toBold } = requireFresh();
    const result = renderSubstrateZone(degradedState()); // degradedState has forge active
    // Phase is 'execute' — should appear bold
    expect(result).toContain(toBold('execute'));
  });

  it('empty caps produces valid output (no crash)', () => {
    const { renderSubstrateZone } = requireFresh();
    const state = {
      session: { id: '', model: 'unknown', contextPct: 0, uptime: 0 },
      os: { overallHealth: 'unknown', capabilities: {} },
      forge: { active: false, phase: null, teammates: [], scope: null },
      context: { trigger: 'command', event: null, zone: null },
    };
    expect(() => renderSubstrateZone(state)).not.toThrow();
    const result = renderSubstrateZone(state);
    expect(typeof result).toBe('string');
  });
});

describe('substrate utility functions', () => {
  it('toBold converts ASCII letters to math-bold codepoints', () => {
    const { toBold } = requireFresh();
    const bold = toBold('FORGE');
    // F = U+1D401 (5th letter offset from U+1D400... actually 'A'=U+1D400, so F=U+1D405)
    const fCode = bold.codePointAt(0);
    expect(fCode).toBe(0x1D405); // 'F' = 0x1D400 + 5
  });

  it('palimpsest layers combining marks on base characters', () => {
    const { palimpsest, COMBINING_LATIN } = requireFresh();
    const result = palimpsest('forge', 'court');
    // 'f' has no combining 'c' (c is available: U+0368)
    // result[0] = 'f', result[1] = combining c (U+0368)
    expect(result).toContain('f');
    expect(result).toContain(COMBINING_LATIN.c);
    expect(result).toContain(COMBINING_LATIN.o);
  });

  it('blockBar fills correct proportion', () => {
    const { blockBar, BLOCK } = requireFresh();
    const bar = blockBar(50, 10);
    expect(bar).toHaveLength(10);
    expect(bar).toContain(BLOCK.full);
    expect(bar).toContain(BLOCK.light);
  });

  it('gradedBlockBar uses full blocks at the high end', () => {
    const { gradedBlockBar, BLOCK } = requireFresh();
    const bar = gradedBlockBar(100, 9);
    // Full fill — all should be full, dark, or med blocks, no light
    expect(bar).not.toContain(BLOCK.light);
    expect(bar).toContain(BLOCK.full);
  });

  it('ligTie wraps two chars with half marks', () => {
    const { ligTie, HALF } = requireFresh();
    const result = ligTie('A', 'B');
    expect(result).toBe('A' + HALF.ligLeft + 'B' + HALF.ligRight);
  });

  it('inCircle adds enclosing circle mark', () => {
    const { inCircle, ENCLOSE } = requireFresh();
    const result = inCircle('X');
    expect(result).toBe('X' + ENCLOSE.circle);
  });
});

describe('engine substrate mode integration', () => {
  it('renderByMode with substrate mode returns a string', () => {
    const engine = _require(path.resolve(__dirname, '../hud-engine.cjs'));
    const result = engine.renderByMode(healthyState(), 'substrate');
    expect(typeof result).toBe('string');
  });

  it('renderSubstrate export exists on engine module', () => {
    const engine = _require(path.resolve(__dirname, '../hud-engine.cjs'));
    expect(typeof engine.renderSubstrate).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Gap-table protection tests
// Verifies that all six Math Alphanumeric alphabets, rendered through the
// zone's wrapper functions, produce zero replacement-glyph codepoints (U+FFFD).
// This is the S246 footgun: naively-computed SMP codepoints for reserved
// Unicode slots (Script B/E/F/H/I/L/M/P/R, Fraktur C/H/I/R/Z, etc.) return
// U+FFFD on Termius mobile. gap-safe lookup via substrate-render.cjs MATH_ALPHA_GAPS
// corrects those slots to their Letterlike Symbols replacements.
// ---------------------------------------------------------------------------

/** Scan a string for the Unicode replacement character U+FFFD. */
function hasReplacementGlyph(str) {
  for (const ch of str) {
    if (ch.codePointAt(0) === 0xFFFD) return true;
  }
  return false;
}

/** All 26 uppercase + 26 lowercase ASCII letters, concatenated. */
const ALL_ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

describe('Math Alphanumeric gap-table protection (via substrate-render.cjs)', () => {
  it('toBold — full alphabet produces no replacement glyphs', () => {
    const { toBold } = requireFresh();
    const result = toBold(ALL_ALPHA);
    expect(hasReplacementGlyph(result)).toBe(false);
    expect(result.length).toBeGreaterThan(0);
  });

  it('toFraktur — full alphabet produces no replacement glyphs', () => {
    const { toFraktur } = requireFresh();
    const result = toFraktur(ALL_ALPHA);
    expect(hasReplacementGlyph(result)).toBe(false);
  });

  it('toFraktur — gap letters C H I R Z render as Letterlike Symbols (BMP), not reserved SMP slots', () => {
    // Fraktur gap letters: C=U+212D, H=U+210C, I=U+2111, R=U+211C, Z=U+2128
    // Reserved (wrong) codepoints: 1D506, 1D50B, 1D50C, 1D515, 1D51D
    const { toFraktur } = requireFresh();
    const frakC = toFraktur('C'); // should be ℭ (U+212D)
    const frakH = toFraktur('H'); // should be ℌ (U+210C)
    const frakI = toFraktur('I'); // should be ℑ (U+2111)
    const frakR = toFraktur('R'); // should be ℜ (U+211C)
    const frakZ = toFraktur('Z'); // should be ℨ (U+2128)
    expect(frakC.codePointAt(0)).toBe(0x212D);
    expect(frakH.codePointAt(0)).toBe(0x210C);
    expect(frakI.codePointAt(0)).toBe(0x2111);
    expect(frakR.codePointAt(0)).toBe(0x211C);
    expect(frakZ.codePointAt(0)).toBe(0x2128);
  });

  it('toMono — full alphabet produces no replacement glyphs', () => {
    const { toMono } = requireFresh();
    const result = toMono(ALL_ALPHA);
    expect(hasReplacementGlyph(result)).toBe(false);
  });

  it('toScript — full alphabet produces no replacement glyphs', () => {
    const { toScript } = requireFresh();
    const result = toScript(ALL_ALPHA);
    expect(hasReplacementGlyph(result)).toBe(false);
  });

  it('toScript — gap letter P renders as Weierstrass p (U+2118), not reserved U+1D4AB', () => {
    // Script P (U+1D4AB) is reserved; correct form is ℘ (Weierstrass p, U+2118).
    // This was the S248 Script P bug: missing from UC_CARVE in the original map.
    const { toScript } = requireFresh();
    const scriptP = toScript('P');
    expect(scriptP.codePointAt(0)).toBe(0x2118);
    expect(scriptP.codePointAt(0)).not.toBe(0x1D4AB);
  });

  it('toDoubleStruck — full alphabet produces no replacement glyphs', () => {
    const { toDoubleStruck } = requireFresh();
    const result = toDoubleStruck(ALL_ALPHA);
    expect(hasReplacementGlyph(result)).toBe(false);
  });

  it('toDoubleStruck — gap letters C H N P Q R Z render as Letterlike Symbols', () => {
    // Double-Struck gaps: C=U+2102, H=U+210D, N=U+2115, P=U+2119, Q=U+211A, R=U+211D, Z=U+2124
    const { toDoubleStruck } = requireFresh();
    const expected = { C: 0x2102, H: 0x210D, N: 0x2115, P: 0x2119, Q: 0x211A, R: 0x211D, Z: 0x2124 };
    for (const [letter, expectedCp] of Object.entries(expected)) {
      const rendered = toDoubleStruck(letter);
      expect(rendered.codePointAt(0)).toBe(expectedCp);
    }
  });

  it('all six zone alphabet functions are exported', () => {
    const zone = requireFresh();
    expect(typeof zone.toBold).toBe('function');
    expect(typeof zone.toFraktur).toBe('function');
    expect(typeof zone.toMono).toBe('function');
    expect(typeof zone.toScript).toBe('function');
    expect(typeof zone.toDoubleStruck).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Styled palimpsest (S399) — small caps are the one styled alphabet that is
// BMP and therefore legal under combining marks (SMP+combining trap).
// The CTX session label showcases it: ᴄͣᴛͨxͭ — small-caps weight carrying 'act'.
// ---------------------------------------------------------------------------
describe('styled palimpsest — BMP small caps carrying combining marks', () => {
  it('toSmallCaps is exported and produces only BMP codepoints', () => {
    const { toSmallCaps } = requireFresh();
    expect(typeof toSmallCaps).toBe('function');
    const result = toSmallCaps('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    for (const ch of result) {
      expect(ch.codePointAt(0)).toBeLessThanOrEqual(0xFFFF);
    }
  });

  it('renderStyledPalimpsest is re-exported from the zone', () => {
    const { renderStyledPalimpsest } = requireFresh();
    expect(typeof renderStyledPalimpsest).toBe('function');
  });

  it('rendered zone contains the small-caps CTX label cells (ᴄ+combining-a, ᴛ+combining-c)', () => {
    const { renderSubstrateZone } = requireFresh();
    const result = renderSubstrateZone(healthyState());
    // ᴄ U+1D04 followed by combining a U+0363; ᴛ U+1D1B followed by combining c U+0368
    expect(result).toContain('ᴄͣᴛͨ');
  });

  it('no combining Latin mark in the zone output sits on an SMP base', () => {
    const { renderSubstrateZone } = requireFresh();
    for (const state of [healthyState(), degradedState()]) {
      const out = [...renderSubstrateZone(state)];
      for (let i = 0; i < out.length; i++) {
        const cp = out[i].codePointAt(0);
        if (cp >= 0x0363 && cp <= 0x036F) {
          const baseCp = out[i - 1].codePointAt(0);
          expect(baseCp, `combining mark at index ${i} rides SMP base U+${baseCp.toString(16)}`)
            .toBeLessThanOrEqual(0xFFFF);
        }
      }
    }
  });
});
