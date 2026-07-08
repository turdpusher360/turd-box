import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const {
  detectHidden,
  strip,
  decodePalimpsest,
  sanitizeForOutput,
  _COMBINING_LATIN_REVERSE,
  _HALF_MARK_NAMES,
  _ENCLOSING_NAMES,
  _ZERO_WIDTH_NAMES,
  _FORMAT_CONTROL_NAMES,
} = require('../substrate-sanitize.cjs');

const {
  renderPalimpsest,
  renderStyledPalimpsest,
  renderMaxComposition,
} = require('../substrate-render.cjs');

const { renderSubstrateZone } = require('../../bin/hud-zone-substrate.cjs');

// ---------------------------------------------------------------------------
// Test-payload conventions used throughout this file:
//
// - The combining-Latin-letter family (U+0363-036F) is exercised directly in
//   the detectHidden/strip sections below using letters NOT used by any
//   hardcoded signature word this codebase's real render output produces
//   (FORGE_MARK/footerMark use c,a,t,e; the health-bar signature uses d,i,m;
//   the CTX styled palimpsest uses a,c,t; the footer route palimpsest uses
//   r,o,u,t,e — so c,a,d,e,i,m,o,r,t,u are all "live" letters). Tests below
//   that assert *absence* of a specific combining letter in real rendered
//   output use h, v, or x (unused by any hardcoded signature) to avoid a
//   false failure from legitimate overlay content elsewhere in the string.
// - The HUD-ingestion integration tests further down avoid the combining-
//   Latin-letter family entirely and use zero-width space / Unicode Tags
//   instead — codepoints that never appear in ANY legitimate substrate
//   output, so an absence assertion is unambiguous regardless of which
//   hardcoded signature words happen to be nearby.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// detectHidden — one family at a time
// ---------------------------------------------------------------------------
describe('detectHidden — combining-latin-letter family (U+0363-036F)', () => {
  it('reconstructs the spelled overlay word from a real renderPalimpsest output', () => {
    const rendered = renderPalimpsest('forge', 'court');
    const findings = detectHidden(rendered);
    const finding = findings.find((f) => f.kind === 'combining-latin-letter');
    expect(finding).toBeDefined();
    expect(finding.decoded).toBe('court');
  });

  it('reports the code-point index of the first combining-latin-letter mark', () => {
    // 'f' + combining-c is at code-point index 1 (the combining mark, not the base)
    const text = 'f' + 'ͨ' + 'o' + 'ͦ';
    const findings = detectHidden(text);
    const finding = findings.find((f) => f.kind === 'combining-latin-letter');
    expect(finding.index).toBe(1);
    expect(finding.decoded).toBe('co');
  });

  it('returns [] for text with no combining-latin-letter marks', () => {
    expect(detectHidden('plain text').some((f) => f.kind === 'combining-latin-letter')).toBe(false);
  });

  it('reverse table (_COMBINING_LATIN_REVERSE) covers all 13 letters', () => {
    expect(Object.keys(_COMBINING_LATIN_REVERSE).length).toBe(13);
    expect(_COMBINING_LATIN_REVERSE[0x0368]).toBe('c');
    expect(_COMBINING_LATIN_REVERSE[0x036F]).toBe('x');
  });
});

describe('detectHidden — combining-half-mark family (U+FE20-FE2F)', () => {
  it('detects a ligature-tie pair as two findings, named correctly', () => {
    const text = 'a' + '︠' + 'b' + '︡';
    const findings = detectHidden(text).filter((f) => f.kind === 'combining-half-mark');
    expect(findings.length).toBe(2);
    expect(findings[0].decoded).toBe('[half-mark:ligature-left]');
    expect(findings[1].decoded).toBe('[half-mark:ligature-right]');
  });

  it('_HALF_MARK_NAMES covers all 16 assigned codepoints in the block', () => {
    expect(Object.keys(_HALF_MARK_NAMES).length).toBe(16);
  });
});

describe('detectHidden — combining-enclosing-mark family (U+20DD-20E4)', () => {
  it('detects an enclosing circle mark', () => {
    const text = 'r' + '⃝';
    const findings = detectHidden(text).filter((f) => f.kind === 'combining-enclosing-mark');
    expect(findings.length).toBe(1);
    expect(findings[0].decoded).toBe('[enclosing-mark:circle]');
    expect(findings[0].index).toBe(1);
  });

  it('_ENCLOSING_NAMES covers all 8 codepoints in the declared range', () => {
    expect(Object.keys(_ENCLOSING_NAMES).length).toBe(8);
  });
});

describe('detectHidden — zero-width family', () => {
  it('detects ZERO WIDTH SPACE (U+200B)', () => {
    const text = 'a' + '​' + 'b';
    const findings = detectHidden(text).filter((f) => f.kind === 'zero-width');
    expect(findings.length).toBe(1);
    expect(findings[0].decoded).toBe('[ZERO WIDTH SPACE]');
    expect(findings[0].index).toBe(1);
  });

  it('detects all 5 named zero-width codepoints', () => {
    const text = '​‌‍⁠﻿';
    const findings = detectHidden(text).filter((f) => f.kind === 'zero-width');
    expect(findings.length).toBe(5);
    expect(Object.keys(_ZERO_WIDTH_NAMES).length).toBe(5);
  });
});

describe('detectHidden — unicode-tag family (U+E0000-E007F, Plane 14)', () => {
  it('decodes a TAG-A TAG-B TAG-C run to "ABC"', () => {
    const tagStr = String.fromCodePoint(0xE0041, 0xE0042, 0xE0043);
    const findings = detectHidden('X' + tagStr + 'Y').filter((f) => f.kind === 'unicode-tag');
    expect(findings.length).toBe(1);
    expect(findings[0].decoded).toBe('ABC');
  });

  it('stops decoding at the CANCEL TAG (U+E007F) and flushes as one finding', () => {
    const tagStr = String.fromCodePoint(0xE0041, 0xE0042, 0xE007F);
    const findings = detectHidden(tagStr).filter((f) => f.kind === 'unicode-tag');
    expect(findings.length).toBe(1);
    expect(findings[0].decoded).toBe('AB');
  });

  it('two separate tag runs (interrupted by ordinary text) produce two findings', () => {
    const run1 = String.fromCodePoint(0xE0041);
    const run2 = String.fromCodePoint(0xE0042);
    const findings = detectHidden(run1 + 'mid' + run2).filter((f) => f.kind === 'unicode-tag');
    expect(findings.length).toBe(2);
    expect(findings[0].decoded).toBe('A');
    expect(findings[1].decoded).toBe('B');
  });
});

describe('detectHidden — variation-selector family (standard + supplement)', () => {
  it('a lone standard VS16 is detected but NOT flagged anomalous', () => {
    const text = '\u{1F600}' + '️';
    const finding = detectHidden(text).find((f) => f.kind === 'variation-selector');
    expect(finding).toBeDefined();
    expect(finding.anomalous).toBe(false);
  });

  it('a run of 2+ standard selectors IS flagged anomalous', () => {
    const text = '\u{1F600}' + '︀' + '︁';
    const finding = detectHidden(text).find((f) => f.kind === 'variation-selector');
    expect(finding.anomalous).toBe(true);
  });

  it('any Supplement-block usage (U+E0100+) is flagged anomalous even alone', () => {
    const text = '\u{1F600}' + String.fromCodePoint(0xE0100);
    const finding = detectHidden(text).find((f) => f.kind === 'variation-selector');
    expect(finding.anomalous).toBe(true);
  });

  it('decodes a printable Supplement-block byte run to ASCII text', () => {
    // byte = codepoint - 0xE0100 + 0x10; solving for bytes 0x41/0x42/0x43 ('A'/'B'/'C')
    const vsStr = String.fromCodePoint(0xE0131, 0xE0132, 0xE0133);
    const finding = detectHidden(vsStr).find((f) => f.kind === 'variation-selector');
    expect(finding.decoded).toBe('ABC');
  });

  it('decodes a non-printable byte run to a 0x-prefixed hex string', () => {
    const vsStr = String.fromCodePoint(0xFE00, 0xFE01); // bytes 0x00, 0x01 — non-printable
    const finding = detectHidden(vsStr).find((f) => f.kind === 'variation-selector');
    expect(finding.decoded).toBe('0x0001');
  });
});

describe('detectHidden — defensive input handling', () => {
  it('returns [] for non-string input', () => {
    expect(detectHidden(undefined)).toEqual([]);
    expect(detectHidden(null)).toEqual([]);
    expect(detectHidden(42)).toEqual([]);
  });

  it('returns [] for empty string', () => {
    expect(detectHidden('')).toEqual([]);
  });

  it('findings are sorted by index', () => {
    const text = '​' + 'x' + '⃝' + 'y' + '︠';
    const findings = detectHidden(text);
    for (let i = 1; i < findings.length; i++) {
      expect(findings[i].index).toBeGreaterThanOrEqual(findings[i - 1].index);
    }
  });
});

// ---------------------------------------------------------------------------
// strip — removal + boundary (accented text preserved) + idempotence
// ---------------------------------------------------------------------------
describe('strip', () => {
  it('removes combining-latin-letter marks, leaving base characters intact', () => {
    const smuggled = 'f' + 'ͨ' + 'o'; // 'f' carrying a hidden combining-c, then 'o'
    expect(strip(smuggled)).toBe('fo');
  });

  it('removes half marks', () => {
    expect(strip('a' + '︠' + 'b' + '︡')).toBe('ab');
  });

  it('removes enclosing marks', () => {
    expect(strip('r' + '⃝')).toBe('r');
  });

  it('removes the full zero-width family', () => {
    expect(strip('a' + '​‌‍⁠﻿' + 'b')).toBe('ab');
  });

  it('removes a Unicode Tags run (surrogate-pair-backed, Plane 14)', () => {
    const tagStr = String.fromCodePoint(0xE0041, 0xE0042, 0xE0043);
    expect(strip('X' + tagStr + 'Y')).toBe('XY');
  });

  it('removes variation selectors (both standard and supplement blocks)', () => {
    const emoji = '\u{1F600}';
    const withVs = emoji + '️' + String.fromCodePoint(0xE0100);
    expect(strip(withVs)).toBe(emoji);
  });

  it('is idempotent: strip(strip(x)) === strip(x)', () => {
    const mixed = 'f' + 'ͨ' + '​' + String.fromCodePoint(0xE0041) + '️' + 'end';
    const once = strip(mixed);
    const twice = strip(once);
    expect(once).toBe(twice);
  });

  it('preserves normal precomposed accented text (café, naïve, piñata, Zürich)', () => {
    const text = 'café naïve piñata Zürich';
    expect(strip(text)).toBe(text);
  });

  it('preserves the same text NFD-decomposed (base + combining diacritic below U+0363)', () => {
    const nfd = 'café naïve piñata Zürich'.normalize('NFD');
    expect(strip(nfd)).toBe(nfd);
    // Sanity: NFD decomposition actually introduced combining marks below the
    // stripped range (e.g. U+0301 combining acute), proving this is a real
    // boundary test and not a no-op because normalize() did nothing.
    expect(nfd).not.toBe('café naïve piñata Zürich');
  });

  it('non-string input passes through unchanged', () => {
    expect(strip(undefined)).toBe(undefined);
    expect(strip(42)).toBe(42);
  });

  it('empty string passes through unchanged', () => {
    expect(strip('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// decodePalimpsest — audit affordance
// ---------------------------------------------------------------------------
describe('decodePalimpsest', () => {
  it('round-trips real renderPalimpsest output back to the declared overlay word', () => {
    const rendered = renderPalimpsest('forge', 'court');
    expect(decodePalimpsest(rendered)).toContain('court');
  });

  it('round-trips real renderStyledPalimpsest output', () => {
    const rendered = renderStyledPalimpsest('CTX', 'act', 'smallCaps');
    expect(decodePalimpsest(rendered)).toContain('act');
  });

  it('returns "" when nothing hidden is present', () => {
    expect(decodePalimpsest('plain text, no hidden channel')).toBe('');
  });

  it('returns "" for empty input', () => {
    expect(decodePalimpsest('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// sanitizeForOutput — wiring entrypoint
// ---------------------------------------------------------------------------
describe('sanitizeForOutput', () => {
  it('strips hidden-channel codepoints, matching strip()', () => {
    const smuggled = 'f' + 'ͨ' + 'o';
    expect(sanitizeForOutput(smuggled)).toBe(strip(smuggled));
  });

  it('is a no-op on clean text', () => {
    expect(sanitizeForOutput('clean forge text')).toBe('clean forge text');
  });

  it('accepts an opts argument without changing behavior (reserved for future use)', () => {
    const smuggled = 'a' + '​' + 'b';
    expect(sanitizeForOutput(smuggled, {})).toBe(sanitizeForOutput(smuggled));
  });
});

// ---------------------------------------------------------------------------
// Wiring: substrate-render.cjs — smuggling attempts stripped, declared
// overlay survives. Smuggled and declared payloads use deliberately
// different, non-colliding combining letters so the assertions cannot pass
// by accidental overlap.
// ---------------------------------------------------------------------------
describe('renderPalimpsest — sanitizes both arguments before composing', () => {
  it('smuggled combining-mark in `base` is stripped; declared `overlay` still lands', () => {
    // base carries a pre-loaded combining-d (U+0369) — NOT the declared overlay
    // letter — riding on 'f', then 'o'. overlay is the single letter 'a'
    // (U+0363) — a different codepoint entirely from the smuggled one.
    const smuggledBase = 'f' + 'ͩ' + 'o';
    const result = renderPalimpsest(smuggledBase, 'a');
    expect(result).not.toContain('ͩ'); // smuggled combining-d is gone
    expect(result).toContain('ͣ');     // declared overlay combining-a survives
  });

  it('sanitizing a clean base/overlay pair leaves the classic example byte-identical', () => {
    // Backward-compatibility check: clean inputs produce the exact same
    // output as before sanitization was wired in (matches the vocabulary
    // doc's own worked example and the pre-existing substrate-render.test.js
    // coverage for this function).
    const expected = 'f' + 'ͨ' + 'o' + 'ͦ' + 'r' + 'ͧ' + 'g' + 'ͬ' + 'e' + 'ͭ';
    expect(renderPalimpsest('forge', 'court')).toBe(expected);
  });
});

describe('renderStyledPalimpsest — sanitizes both arguments before composing', () => {
  it('smuggled combining-mark in `base` is stripped; declared `overlay` still lands', () => {
    const smuggledBase = 'f' + 'ͩ'; // smuggled combining-d riding on 'f'
    const result = renderStyledPalimpsest(smuggledBase, 'a', 'plain');
    expect(result).not.toContain('ͩ');
    expect(result).toContain('ͣ');
  });

  it('sanitizing a clean base/overlay pair leaves the classic example byte-identical', () => {
    const result = renderStyledPalimpsest('CTX', 'act', 'smallCaps');
    // ᴄ+combining-a, ᴛ+combining-c, x+combining-t (matches the pre-existing
    // hud-zone-substrate.test.js assertion for this exact call).
    const cps = [...result].map((ch) => ch.codePointAt(0));
    expect(cps).toEqual([0x1D04, 0x0363, 0x1D1B, 0x0368, 0x78, 0x036D]);
  });
});

describe('renderMaxComposition — sanitizes its argument before composing', () => {
  it('a smuggled zero-width-space in `word` does not survive into the output', () => {
    const smuggledWord = 'x' + '​' + 'y';
    const result = renderMaxComposition(smuggledWord);
    expect(result).not.toContain('​');
  });

  it('sanitizing a clean word leaves existing invariants intact (no regression)', () => {
    const result = renderMaxComposition('forge');
    expect(result.length).toBeGreaterThan('forge'.length);
    expect(result.codePointAt(0)).toBe('forge'.codePointAt(0));
    expect(result.includes('⃝')).toBe(true); // enclosing circle on middle char
  });
});

// ---------------------------------------------------------------------------
// Wiring: hud-zone-substrate.cjs — every ingested live-state string is
// sanitized before it is composed into output. Uses zero-width space and
// Unicode Tags — codepoints that never appear in any legitimate substrate
// output — so absence assertions are unambiguous regardless of which
// hardcoded signature words (FORGE_MARK, "dim", "act", "route", footer
// "cate") happen to land nearby in the rendered string.
// ---------------------------------------------------------------------------
describe('hud-zone-substrate.cjs — sanitizes ingested live-state strings', () => {
  const ZWSP = '​';

  function baseState({ session, forge, capabilities } = {}) {
    return {
      session: { id: 'session-test', model: 'opus', contextPct: 32, uptime: 3600000, ...session },
      os: { capabilities: capabilities || { memory: { ok: true }, git: { ok: true } } },
      forge: { active: true, phase: 'execute', teammates: [], scope: null, ...forge },
      context: { trigger: 'command', event: null, zone: null },
    };
  }

  it('session.id payload does not survive into rendered output', () => {
    const result = renderSubstrateZone(baseState({ session: { id: 'sess' + ZWSP + 'ion' } }));
    expect(result).not.toContain(ZWSP);
  });

  it('session.model payload does not survive into rendered output', () => {
    const result = renderSubstrateZone(baseState({ session: { model: 'opus' + ZWSP } }));
    expect(result).not.toContain(ZWSP);
  });

  it('forge.phase payload does not survive into rendered output', () => {
    const result = renderSubstrateZone(baseState({ forge: { phase: 'execute' + ZWSP } }));
    expect(result).not.toContain(ZWSP);
  });

  it('capability-name payload (healthy grid) does not survive into rendered output', () => {
    const result = renderSubstrateZone(baseState({ capabilities: { ['git' + ZWSP]: { ok: true } } }));
    expect(result).not.toContain(ZWSP);
  });

  it('capability-name payload (degraded summary) does not survive into rendered output', () => {
    const result = renderSubstrateZone(baseState({ capabilities: { ['git' + ZWSP]: { ok: false } } }));
    expect(result).not.toContain(ZWSP);
  });

  it('a Unicode-Tags-block payload across session.model and forge.phase does not survive', () => {
    const tagStr = String.fromCodePoint(0xE0041, 0xE0042, 0xE0043); // "ABC"
    const result = renderSubstrateZone(baseState({
      session: { model: 'opus' + tagStr },
      forge: { phase: 'execute' + tagStr },
    }));
    expect(result).not.toContain(String.fromCodePoint(0xE0041));
    expect(result).not.toContain(String.fromCodePoint(0xE0042));
    expect(result).not.toContain(String.fromCodePoint(0xE0043));
  });

  it('clean state (no planted payload) still renders normally — no regression', () => {
    const result = renderSubstrateZone(baseState());
    expect(typeof result).toBe('string');
    expect(result.split('\n').length).toBeGreaterThanOrEqual(6);
    expect(result).toContain('🟢');
  });
});

// ---------------------------------------------------------------------------
// Family (5): invisible format & bidi controls — S527 adversarial-review
// MAJOR-1 closure. Every codepoint the review empirically confirmed passing
// through the original 4-family strip() must now be detected AND stripped.
// ---------------------------------------------------------------------------
describe('detectHidden / strip — format-control family (S527 MAJOR-1)', () => {
  // The exact set the adversarial review confirmed as bypasses, ascending.
  const CONFIRMED_BYPASS_SET = [
    0x00AD, 0x061C, 0x180E, 0x200E, 0x200F,
    0x202A, 0x202B, 0x202C, 0x202D, 0x202E,
    0x2061, 0x2062, 0x2063, 0x2064,
    0x2066, 0x2067, 0x2068, 0x2069,
    0x3164, 0xFFA0,
  ];

  it('strips every codepoint the adversarial review confirmed as a bypass', () => {
    for (const cp of CONFIRMED_BYPASS_SET) {
      const smuggled = 'a' + String.fromCodePoint(cp) + 'b';
      expect(strip(smuggled), `U+${cp.toString(16).toUpperCase()} must be stripped`).toBe('ab');
    }
  });

  it('detectHidden reports each occurrence as a named format-control finding', () => {
    const rlo = 'a' + String.fromCodePoint(0x202E) + 'b';
    const findings = detectHidden(rlo).filter((f) => f.kind === 'format-control');
    expect(findings.length).toBe(1);
    expect(findings[0].decoded).toBe('[RIGHT-TO-LEFT OVERRIDE]');
    expect(findings[0].index).toBe(1);
  });

  it('a Trojan-Source-style bidi sandwich is fully stripped (CVE-2021-42574 shape)', () => {
    const trojan = 'if (ok' + String.fromCodePoint(0x202E) + ' )esle{' + String.fromCodePoint(0x2066) + ')';
    const cleaned = strip(trojan);
    expect(cleaned).not.toContain(String.fromCodePoint(0x202E));
    expect(cleaned).not.toContain(String.fromCodePoint(0x2066));
    expect(detectHidden(cleaned)).toEqual([]);
  });

  it('strip() remains idempotent with the new family included', () => {
    const mixed = 'x' + String.fromCodePoint(0x00AD) + 'y' + String.fromCodePoint(0x2063) + 'z' + String.fromCodePoint(0x3164);
    expect(strip(strip(mixed))).toBe(strip(mixed));
    expect(strip(mixed)).toBe('xyz');
  });

  it('_FORMAT_CONTROL_NAMES covers exactly the confirmed bypass set', () => {
    const covered = Object.keys(_FORMAT_CONTROL_NAMES).map(Number).sort((a, b) => a - b);
    expect(covered).toEqual(CONFIRMED_BYPASS_SET);
  });

  it('wired call site: an RLO smuggled into renderPalimpsest base does not survive', () => {
    const result = renderPalimpsest('fo' + String.fromCodePoint(0x202E) + 'rge', 'a');
    expect(result).not.toContain(String.fromCodePoint(0x202E));
  });

  it('normal visible text (hyphenated ASCII, precomposed accents) is untouched', () => {
    expect(strip('well-known co-op naïve café')).toBe('well-known co-op naïve café');
  });
});
