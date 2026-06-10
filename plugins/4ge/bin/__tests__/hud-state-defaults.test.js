import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

function requireFresh() {
  for (const key of Object.keys(_require.cache)) {
    if (key.includes('hud-state') || key.includes('hud-palette')) {
      delete _require.cache[key];
    }
  }
  return _require(path.resolve(__dirname, '../hud-state.cjs'));
}

describe('buildCanonicalState defaults', () => {
  it('produces valid state from empty input', () => {
    const { buildCanonicalState } = requireFresh();
    const state = buildCanonicalState({});
    expect(state.terminal.cols).toBeGreaterThan(0);
    expect(state.terminal.rows).toBeGreaterThan(0);
    expect(state.session.model).toBe('unknown');
    expect(state.session.contextPct).toBe(0);
    expect(state.os.overallHealth).toBe('unknown');
    expect(state.forge.active).toBe(false);
    expect(state.context.trigger).toBe('unknown');
    expect(state.mode).toBe('full');
  });

  it('produces valid state from null input', () => {
    const { buildCanonicalState } = requireFresh();
    const state = buildCanonicalState(null);
    expect(state.session.model).toBe('unknown');
  });

  it('produces valid state from undefined input', () => {
    const { buildCanonicalState } = requireFresh();
    const state = buildCanonicalState(undefined);
    expect(state.session.model).toBe('unknown');
  });

  it('clamps contextPct to 0-100', () => {
    const { buildCanonicalState } = requireFresh();
    const high = buildCanonicalState({ session: { contextPct: 200 } });
    expect(high.session.contextPct).toBe(100);
    const low = buildCanonicalState({ session: { contextPct: -50 } });
    expect(low.session.contextPct).toBe(0);
  });

  it('clamps rate limits to 0-100', () => {
    const { buildCanonicalState } = requireFresh();
    const state = buildCanonicalState({
      session: { rateLimits: { fiveHour: 150, sevenDay: -10 } },
    });
    expect(state.session.rateLimits.fiveHour).toBe(100);
    expect(state.session.rateLimits.sevenDay).toBe(0);
  });

  it('handles N/A rate limits', () => {
    const { buildCanonicalState } = requireFresh();
    const state = buildCanonicalState({ session: { rateLimits: 'N/A' } });
    expect(state.session.rateLimits).toBe('N/A');
  });

  it('preserves modelId string', () => {
    const { buildCanonicalState } = requireFresh();
    const state = buildCanonicalState({ session: { modelId: 'claude-opus-4-6' } });
    expect(state.session.modelId).toBe('claude-opus-4-6');
  });

  it('preserves agent context fields', () => {
    const { buildCanonicalState } = requireFresh();
    const state = buildCanonicalState({
      context: { agentType: 'audit', agentName: 'master-auditor', agentId: 'a-123' },
    });
    expect(state.context.agentType).toBe('audit');
    expect(state.context.agentName).toBe('master-auditor');
    expect(state.context.agentId).toBe('a-123');
  });

  it('preserves badges state', () => {
    const { buildCanonicalState } = requireFresh();
    const state = buildCanonicalState({
      badges: {
        earned: { 'forge-master': '2026-04-10T00:00:00Z' },
        newThisSession: ['forge-master'],
      },
    });
    expect(state.badges.earned['forge-master']).toBe('2026-04-10T00:00:00Z');
    expect(state.badges.newThisSession).toContain('forge-master');
  });

  it('preserves transcript data', () => {
    const { buildCanonicalState } = requireFresh();
    const state = buildCanonicalState({
      transcript: { toolCallsTotal: 5, recentEvents: [{ kind: 'tool_use' }] },
    });
    expect(state.transcript.toolCallsTotal).toBe(5);
  });
});

describe('countDegraded', () => {
  it('returns 0 for all healthy caps', () => {
    const { countDegraded } = requireFresh();
    expect(countDegraded({ a: { ok: true }, b: { ok: true } })).toBe(0);
  });

  it('counts caps with ok:false', () => {
    const { countDegraded } = requireFresh();
    expect(countDegraded({ a: { ok: false }, b: { ok: true }, c: { ok: false } })).toBe(2);
  });

  it('returns 0 for empty object', () => {
    const { countDegraded } = requireFresh();
    expect(countDegraded({})).toBe(0);
  });

  it('returns 0 for null', () => {
    const { countDegraded } = requireFresh();
    expect(countDegraded(null)).toBe(0);
  });
});

describe('clamp', () => {
  it('clamps values within range', () => {
    const { clamp } = requireFresh();
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it('returns min for NaN', () => {
    const { clamp } = requireFresh();
    expect(clamp(NaN, 0, 100)).toBe(0);
  });

  it('returns min for non-number', () => {
    const { clamp } = requireFresh();
    expect(clamp('abc', 0, 100)).toBe(0);
  });
});

describe('exported constants', () => {
  it('MAX_BASH_COLS is 79', () => {
    const { MAX_BASH_COLS } = requireFresh();
    expect(MAX_BASH_COLS).toBe(79);
  });

  it('DEFAULT_SESSION has expected shape', () => {
    const { DEFAULT_SESSION } = requireFresh();
    expect(DEFAULT_SESSION.model).toBe('unknown');
    expect(DEFAULT_SESSION.contextPct).toBe(0);
    expect(typeof DEFAULT_SESSION.modelId).toBe('string');
  });

  it('DEFAULT_CONTEXT has agentType field', () => {
    const { DEFAULT_CONTEXT } = requireFresh();
    expect(typeof DEFAULT_CONTEXT.agentType).toBe('string');
    expect(typeof DEFAULT_CONTEXT.agentName).toBe('string');
  });
});
