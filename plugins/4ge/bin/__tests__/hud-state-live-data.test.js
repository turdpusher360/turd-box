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

  it('buildCanonicalState preserves HUD context and rate history arrays', () => {
    const state = buildCanonicalState({
      session: {
        contextPctHistory: [10, '20', 150, -4, 'bad'],
        rateLimitHistory: [
          { ts: '2026-06-14T00:00:00.000Z', fiveHour: 15, sevenDay: 4 },
          { ts: '2026-06-14T00:01:00.000Z', fiveHour: 110, sevenDay: -5 },
          null,
        ],
      },
    });

    expect(state.session.contextPctHistory).toEqual([10, 20, 100, 0]);
    expect(state.session.rateLimitHistory).toEqual([
      { ts: '2026-06-14T00:00:00.000Z', fiveHour: 15, sevenDay: 4 },
      { ts: '2026-06-14T00:01:00.000Z', fiveHour: 100, sevenDay: 0 },
    ]);
  });

  it('toolCount defaults to 0 for negative or non-numeric', () => {
    expect(buildCanonicalState({ session: { toolCount: -1 } }).session.toolCount).toBe(0);
    expect(buildCanonicalState({ session: { toolCount: 'x' } }).session.toolCount).toBe(0);
  });

  it('normalizes a persistent anomaly row', () => {
    const state = buildCanonicalState({
      anomaly: {
        type: 'stale-dirty-work',
        severity: 'loud',
        reason: '  3 dirty files  ',
        metrics: { dirty: 3 },
        updatedAt: '2026-06-14T09:20:00.000Z',
      },
    });

    expect(state.anomaly).toEqual({
      type: 'stale-dirty-work',
      severity: 'signal',
      reason: '3 dirty files',
      metrics: { dirty: 3 },
      updatedAt: '2026-06-14T09:20:00.000Z',
    });
  });

  it('defaults anomaly to null when required fields are missing', () => {
    expect(buildCanonicalState({ anomaly: { type: 'x' } }).anomaly).toBeNull();
    expect(buildCanonicalState({}).anomaly).toBeNull();
  });

  it('normalizes zero-producer OS vram and process state', () => {
    const state = buildCanonicalState({
      os: {
        vram: { freeMiB: '768', totalMiB: 8192, updatedAt: '2026-06-14T09:40:00.000Z' },
        processes: {
          event: 'reap-linux',
          sessionId: 'sess-123',
          totalProcs: '151',
          mcpProcs: 2,
          killed: 1,
          kills: [{ pid: 123 }],
          updatedAt: '2026-06-14T09:39:58.000Z',
        },
      },
    });

    expect(state.os.vram).toEqual({
      freeMiB: 768,
      totalMiB: 8192,
      updatedAt: '2026-06-14T09:40:00.000Z',
    });
    expect(state.os.processes).toEqual({
      event: 'reap-linux',
      sessionId: 'sess-123',
      totalProcs: 151,
      mcpProcs: 2,
      killed: 1,
      kills: [{ pid: 123 }],
      updatedAt: '2026-06-14T09:39:58.000Z',
    });
  });

  it('defaults malformed zero-producer OS state to null', () => {
    const state = buildCanonicalState({
      os: {
        vram: { freeMiB: 'bad', updatedAt: '2026-06-14T09:40:00.000Z' },
        processes: { event: 'reap-linux', totalProcs: 'bad' },
      },
    });

    expect(state.os.vram).toBeNull();
    expect(state.os.processes).toBeNull();
  });
});
