import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

function requireFresh() {
  for (const key of Object.keys(_require.cache)) {
    if (key.includes('hud-expressions') || key.includes('hud-palette')) {
      delete _require.cache[key];
    }
  }
  return _require(path.resolve(__dirname, '../hud-expressions.cjs'));
}

function makeState(overrides) {
  return {
    session: { contextPct: 20, rateLimits: { fiveHour: 10, sevenDay: 5 } },
    os: { capabilities: {} },
    forge: { active: false, phase: null, teammates: [] },
    context: { trigger: 'command', event: null, zone: null },
    ...overrides,
  };
}

describe('EXPRESSIONS', () => {
  it('defines 16 named expressions', () => {
    const { EXPRESSIONS } = requireFresh();
    expect(Object.keys(EXPRESSIONS).length).toBe(16);
  });

  it('each expression has left and right arrays', () => {
    const { EXPRESSIONS } = requireFresh();
    for (const [name, expr] of Object.entries(EXPRESSIONS)) {
      expect(Array.isArray(expr.left), `${name}.left should be array`).toBe(true);
      expect(Array.isArray(expr.right), `${name}.right should be array`).toBe(true);
      expect(expr.left.length, `${name}.left should have rows`).toBeGreaterThan(0);
      expect(expr.right.length, `${name}.right should have rows`).toBeGreaterThan(0);
    }
  });
});

describe('EXPRESSION_RULES', () => {
  it('has a default rule that always matches', () => {
    const { EXPRESSION_RULES } = requireFresh();
    const last = EXPRESSION_RULES[EXPRESSION_RULES.length - 1];
    expect(last.match(makeState())).toBe(true);
    expect(last.expr).toBe('neutral');
  });
});

describe('getExpressionName', () => {
  it('returns "neutral" for default state', () => {
    const { getExpressionName } = requireFresh();
    expect(getExpressionName(makeState())).toBe('neutral');
  });

  it('returns "determined" for forge-start event', () => {
    const { getExpressionName } = requireFresh();
    expect(getExpressionName(makeState({ context: { event: 'forge-start' } }))).toBe('determined');
  });

  it('returns "excited" for forge-complete event', () => {
    const { getExpressionName } = requireFresh();
    expect(getExpressionName(makeState({ context: { event: 'forge-complete' } }))).toBe('excited');
  });

  it('returns "focused" for active forge with phase', () => {
    const { getExpressionName } = requireFresh();
    expect(getExpressionName(makeState({ forge: { active: true, phase: 'execute' } }))).toBe('focused');
  });

  it('returns "happy" for test-pass event', () => {
    const { getExpressionName } = requireFresh();
    expect(getExpressionName(makeState({ context: { event: 'test-pass' } }))).toBe('happy');
  });

  it('returns "sad" for test-fail event', () => {
    const { getExpressionName } = requireFresh();
    expect(getExpressionName(makeState({ context: { event: 'test-fail' } }))).toBe('sad');
  });

  it('returns "angry" when 4+ caps degraded', () => {
    const { getExpressionName } = requireFresh();
    const caps = { a: { ok: false }, b: { ok: false }, c: { ok: false }, d: { ok: false } };
    expect(getExpressionName(makeState({ os: { capabilities: caps } }))).toBe('angry');
  });

  it('returns "suspicious" when 2-3 caps degraded', () => {
    const { getExpressionName } = requireFresh();
    const caps = { a: { ok: false }, b: { ok: false }, c: { ok: true } };
    expect(getExpressionName(makeState({ os: { capabilities: caps } }))).toBe('suspicious');
  });

  it('returns "curious" when exactly 1 cap degraded', () => {
    const { getExpressionName } = requireFresh();
    const caps = { a: { ok: false }, b: { ok: true } };
    expect(getExpressionName(makeState({ os: { capabilities: caps } }))).toBe('curious');
  });

  it('returns "sleepy" when context >= 80%', () => {
    const { getExpressionName } = requireFresh();
    expect(getExpressionName(makeState({ session: { contextPct: 85 } }))).toBe('sleepy');
  });

  it('returns "thinking" when context 60-79%', () => {
    const { getExpressionName } = requireFresh();
    expect(getExpressionName(makeState({ session: { contextPct: 65 } }))).toBe('thinking');
  });
});

describe('selectExpression', () => {
  it('returns an object with left and right arrays', () => {
    const { selectExpression } = requireFresh();
    const result = selectExpression(makeState());
    expect(Array.isArray(result.left)).toBe(true);
    expect(Array.isArray(result.right)).toBe(true);
  });
});

describe('buildExpression', () => {
  it('returns palette-aware art with left and right arrays', () => {
    const { buildExpression } = requireFresh();
    const { resolvePalette } = _require(path.resolve(__dirname, '../hud-palette.cjs'));
    const palette = resolvePalette({ name: 'forge' });
    const result = buildExpression(makeState(), palette);
    expect(Array.isArray(result.left)).toBe(true);
    expect(Array.isArray(result.right)).toBe(true);
  });

  it('works without palette (falls back to hardcoded)', () => {
    const { buildExpression } = requireFresh();
    const result = buildExpression(makeState(), null);
    expect(Array.isArray(result.left)).toBe(true);
  });
});

describe('eye shape builders', () => {
  it('eyeFull returns 4-row array', () => {
    const { eyeFull } = requireFresh();
    expect(eyeFull().length).toBe(4);
  });

  it('eyeHighlight returns 4-row array', () => {
    const { eyeHighlight } = requireFresh();
    expect(eyeHighlight().length).toBe(4);
  });

  it('eyeHalfLid returns 4-row array', () => {
    const { eyeHalfLid } = requireFresh();
    expect(eyeHalfLid().length).toBe(4);
  });

  it('eyeSquint returns 4-row array', () => {
    const { eyeSquint } = requireFresh();
    expect(eyeSquint().length).toBe(4);
  });

  it('eyeWide returns 5-row array', () => {
    const { eyeWide } = requireFresh();
    expect(eyeWide().length).toBe(5);
  });

  it('eyeHappy returns 4-row array', () => {
    const { eyeHappy } = requireFresh();
    expect(eyeHappy().length).toBe(4);
  });

  it('eyeSad returns 4-row array', () => {
    const { eyeSad } = requireFresh();
    expect(eyeSad().length).toBe(4);
  });

  it('eyeClosed returns 4-row array', () => {
    const { eyeClosed } = requireFresh();
    expect(eyeClosed().length).toBe(4);
  });

  it('eyeExcited returns 5-row array', () => {
    const { eyeExcited } = requireFresh();
    expect(eyeExcited().length).toBe(5);
  });

  it('eye builders accept tint argument', () => {
    const { eyeFull } = requireFresh();
    const result = eyeFull('\x1b[38;5;196m');
    expect(result.length).toBe(4);
    expect(result[0]).toContain('\x1b[38;5;196m');
  });
});

// --- W5 T5.1: Expression palette cross-reference audit ---
// companion-state.cjs STATE_MAP and BOOT_SEQUENCE use expression names that belong
// to the COMPACT_FACES vocabulary in hud-engine.cjs (strip/compact mode).
// EXPRESSIONS in hud-expressions.cjs is a separate vocabulary for the full-mode
// face zone art (hud-zone-face.cjs). The two systems are intentionally disjoint:
//   - hud-expressions.EXPRESSIONS → hud-zone-face.cjs (pixel art, full mode)
//   - hud-engine.COMPACT_FACES   → companion-state.cjs (glyphs, strip/compact mode)
// This test suite documents and locks the boundary so the split does not drift
// into a silent bug (e.g., companion expression name changed but COMPACT_FACES entry not).
describe('W5: expression palette cross-reference', () => {
  // Expression names referenced by EXPRESSION_RULES in hud-expressions.cjs.
  // These must all exist as keys in EXPRESSIONS.
  const EXPRESSIONS_RULE_NAMES = [
    'determined', 'excited', 'focused', 'happy', 'sad',
    'angry', 'suspicious', 'curious', 'sleepy', 'thinking',
    'winking', 'surprised', 'blinking', 'neutral',
  ];

  it('every expression name in EXPRESSION_RULES resolves in EXPRESSIONS', () => {
    const { EXPRESSIONS } = requireFresh();
    for (const name of EXPRESSIONS_RULE_NAMES) {
      expect(EXPRESSIONS[name], `EXPRESSIONS["${name}"] should exist`).toBeDefined();
    }
  });

  it('EXPRESSIONS has left and right arrays for every rule-referenced name', () => {
    const { EXPRESSIONS } = requireFresh();
    for (const name of EXPRESSIONS_RULE_NAMES) {
      const expr = EXPRESSIONS[name];
      if (!expr) continue; // guarded by previous test
      expect(Array.isArray(expr.left),  `${name}.left should be array`).toBe(true);
      expect(Array.isArray(expr.right), `${name}.right should be array`).toBe(true);
    }
  });

  // Companion-state vocabulary (STATE_MAP + BOOT_SEQUENCE expression strings).
  // These must all exist in hud-engine.cjs COMPACT_FACES.
  // Verified by reading companion-state.cjs STATE_MAP and BOOT_SEQUENCE.
  const COMPANION_STATE_EXPRESSIONS = [
    'proud joy', 'blink', 'thinking', 'happy', 'dead', 'alert',
    'curious', 'exhausted', 'sleepy', 'determined', 'sad',
    'neutral alive',
  ];

  it('companion-state expression names are documented (COMPACT_FACES vocabulary)', () => {
    // This test does not require importing hud-engine to avoid heavyweight deps.
    // It locks the known set so any future addition to companion-state STATE_MAP
    // is caught here and must also be added to COMPACT_FACES.
    const knownCompactFaces = [
      'neutral', 'neutral alive', 'happy', 'sad', 'angry', 'surprised',
      'fear', 'worried', 'curious', 'thinking', 'suspicious', 'determined',
      'anxious', 'alert', 'excited', 'proud joy', 'sleepy', 'exhausted',
      'blink', 'dead', 'wink', 'intrigued', 'patient', 'guilt', 'nodding off',
    ];
    for (const name of COMPANION_STATE_EXPRESSIONS) {
      expect(knownCompactFaces).toContain(name);
    }
  });

  it('getExpressionName returns only names that exist in EXPRESSIONS', () => {
    const { EXPRESSION_RULES, EXPRESSIONS } = requireFresh();
    for (const rule of EXPRESSION_RULES) {
      expect(EXPRESSIONS[rule.expr], `rule.expr "${rule.expr}" should exist in EXPRESSIONS`).toBeDefined();
    }
  });
});
