import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);
const MODULE_PATH = path.resolve(__dirname, '../hud-expressions.cjs');

function requireFresh() {
  for (const key of Object.keys(_require.cache)) {
    if (key.includes('hud-expressions') || key.includes('hud-palette')) {
      delete _require.cache[key];
    }
  }
  return _require(MODULE_PATH);
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

describe('EXPRESSION_RULES', () => {
  it('has a default rule that always matches neutral alive', () => {
    const { EXPRESSION_RULES } = requireFresh();
    const last = EXPRESSION_RULES[EXPRESSION_RULES.length - 1];
    expect(last.match(makeState())).toBe(true);
    expect(last.expr).toBe('neutral alive');
  });

  it('keeps every rule as a name-only mapping', () => {
    const { EXPRESSION_RULES } = requireFresh();
    for (const rule of EXPRESSION_RULES) {
      expect(typeof rule.expr).toBe('string');
      expect(typeof rule.match).toBe('function');
    }
  });
});

describe('getExpressionName', () => {
  it('returns "neutral alive" for default state', () => {
    const { getExpressionName } = requireFresh();
    expect(getExpressionName(makeState())).toBe('neutral alive');
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

describe('retired block-art API', () => {
  it('does not export or retain the old art builders/catalog', () => {
    const mod = requireFresh();
    const source = fs.readFileSync(MODULE_PATH, 'utf8');
    const retiredExports = [
      'EXPRESSIONS',
      'selectExpression',
      'buildExpression',
      'eyeFull',
      'eyeHighlight',
      'eyeHalfLid',
      'eyeSquint',
      'eyeWide',
      'eyeHappy',
      'eyeSad',
      'eyeClosed',
      'eyeExcited',
      '_buildExpressions',
      '_codes',
    ];

    for (const name of retiredExports) {
      expect(mod[name], `${name} should be retired`).toBeUndefined();
    }
    expect(source).not.toMatch(/\b(?:EXPRESSIONS|selectExpression|buildExpression|eyeFull|eyeHighlight|eyeHalfLid|eyeSquint|eyeWide|eyeHappy|eyeSad|eyeClosed|eyeExcited|_buildExpressions|_codes)\b/);
  });
});
