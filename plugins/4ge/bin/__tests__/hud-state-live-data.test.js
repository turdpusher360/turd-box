import { describe, it, expect } from 'vitest';
const { buildCanonicalState, DEFAULT_SESSION } = require('../hud-state.cjs');

describe('hud-state live-data extensions', () => {
  it('DEFAULT_SESSION includes toolCount and contextLabel', () => {
    expect(DEFAULT_SESSION.toolCount).toBe(0);
    expect(DEFAULT_SESSION.contextLabel).toBe('');
  });

  it('buildCanonicalState passes through toolCount and contextLabel', () => {
    const state = buildCanonicalState({
      session: { toolCount: 42, contextLabel: 'est.', contextPct: 25 },
    });
    expect(state.session.toolCount).toBe(42);
    expect(state.session.contextLabel).toBe('est.');
  });

  it('buildCanonicalState preserves rateLimits string N/A', () => {
    const state = buildCanonicalState({
      session: { rateLimits: 'N/A' },
    });
    expect(state.session.rateLimits).toBe('N/A');
  });

  it('buildCanonicalState clamps rateLimits object', () => {
    const state = buildCanonicalState({
      session: { rateLimits: { fiveHour: 150, sevenDay: -5 } },
    });
    expect(state.session.rateLimits.fiveHour).toBe(100);
    expect(state.session.rateLimits.sevenDay).toBe(0);
  });

  it('buildCanonicalState defaults rateLimits to object when absent', () => {
    const state = buildCanonicalState({ session: {} });
    expect(state.session.rateLimits).toEqual({ fiveHour: 0, sevenDay: 0, fiveHourResetsAt: null, sevenDayResetsAt: null });
  });

  it('toolCount defaults to 0 for negative or non-numeric', () => {
    expect(buildCanonicalState({ session: { toolCount: -1 } }).session.toolCount).toBe(0);
    expect(buildCanonicalState({ session: { toolCount: 'x' } }).session.toolCount).toBe(0);
  });
});
