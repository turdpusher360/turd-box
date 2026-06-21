import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

function requireFresh() {
  const modPath = path.resolve(__dirname, '../hud-events.cjs');
  delete require.cache[modPath];
  return require(modPath);
}

describe('hud-events catalog', () => {
  it('defines the shipped reactive event keys in stable order', () => {
    const { EVENT_KEYS } = requireFresh();
    expect(EVENT_KEYS).toEqual([
      'commit',
      'push',
      'skill-load',
      'test-pass',
      'test-fail',
      'error-state',
      'rate-limit-warn',
      'context-high',
      'forge-phase',
      'badge-earned',
      'export',
      'zone-change',
      'session-end',
    ]);
  });

  it('derives loader ttl, hook throttle, message tier, major, and companion maps', () => {
    const {
      reactiveTtlMap,
      eventThrottleMap,
      eventTierMap,
      majorEventSet,
      companionEventMap,
    } = requireFresh();

    expect(reactiveTtlMap()).toEqual({
      'rate-limit-warn': 120000,
      'error-state': 120000,
      'session-end': 120000,
      'test-fail': 30000,
      'forge-phase': 30000,
      'context-high': 30000,
      commit: 30000,
      push: 30000,
      'skill-load': 8000,
      'test-pass': 8000,
      'badge-earned': 8000,
      export: 8000,
      'zone-change': 8000,
    });

    expect(eventThrottleMap()).toEqual({
      'rate-limit-warn': 120000,
      'error-state': 10000,
      'context-high': 60000,
      commit: 30000,
      push: 30000,
      'skill-load': 30000,
      'test-pass': 30000,
      'test-fail': 30000,
      'forge-phase': 30000,
      'badge-earned': 60000,
      export: 60000,
      'zone-change': 30000,
      'session-end': 0,
    });

    expect(eventTierMap()).toEqual({
      'rate-limit-warn': 'critical',
      'error-state': 'critical',
      'session-end': 'critical',
      'test-fail': 'signal',
      'forge-phase': 'signal',
      'context-high': 'signal',
      commit: 'signal',
      push: 'signal',
      'skill-load': 'flash',
      'test-pass': 'flash',
      'badge-earned': 'flash',
      export: 'flash',
      'zone-change': 'flash',
    });

    expect([...majorEventSet()].sort()).toEqual(
      ['commit', 'push', 'skill-load', 'error-state', 'rate-limit-warn', 'test-fail', 'test-pass'].sort(),
    );

    expect(companionEventMap()).toEqual({
      commit: 'commit',
      push: 'push',
      'skill-load': 'skill-load',
      'test-pass': 'tests-pass',
      'test-fail': 'tests-fail',
      'error-state': 'error',
      'rate-limit-warn': 'rate-limited',
      'context-high': 'context-warn',
    });
  });

  it('derives statusline zones, roles, boosts, compact hints, and compact messages', () => {
    const {
      statuslineZoneMap,
      statuslineRoleMap,
      zoneBoostMap,
      compactCompanionHintMap,
      compactMessageMap,
    } = requireFresh();

    expect(statuslineZoneMap()).toEqual({
      commit: ['gitStatus'],
      push: ['gitStatus'],
      'skill-load': ['activity'],
      'test-pass': ['activity', 'gitStatus'],
      'test-fail': ['health', 'activity'],
      'error-state': ['health', 'activity'],
      'rate-limit-warn': ['rate', 'context'],
      'context-high': ['context'],
      'forge-phase': ['forge', 'forgeProgress'],
      'badge-earned': ['badges'],
      export: ['activity'],
      'zone-change': ['activity'],
      'session-end': ['session'],
    });

    expect(statuslineRoleMap()).toEqual({
      'test-pass': 'ok',
      'test-fail': 'error',
      'error-state': 'error',
      'rate-limit-warn': 'warn',
      'context-high': 'warn',
      'session-end': 'warn',
    });

    expect(zoneBoostMap()).toEqual({
      'forge-phase': { forge: 9, cards: 8 },
      'badge-earned': { badges: 9, cards: 7 },
      'test-pass': { session: 8, cards: 6 },
      'test-fail': { session: 8, cards: 8 },
    });

    expect(compactCompanionHintMap()).toEqual({
      commit: 'commit',
      push: 'push',
      'skill-load': 'skill-load',
      'test-pass': 'tests-pass',
      'test-fail': 'tests-fail',
      'error-state': 'error',
      'rate-limit-warn': 'rate-limited',
      'context-high': 'context-warn',
    });

    expect(compactMessageMap()).toEqual({
      commit: 'committed',
      push: 'pushed',
      'skill-load': 'skill loaded',
      'test-pass': 'all tests green',
      'test-fail': 'tests failed',
      'forge-phase': 'forge phase transition',
      'zone-change': 'zone updated',
      'badge-earned': 'badge earned',
    });
  });

  it('keeps the catalog immutable behind derived maps', () => {
    const { EVENT_CATALOG, zoneBoostMap } = requireFresh();
    const boosts = zoneBoostMap();

    boosts['test-pass'].session = 99;

    expect(Object.isFrozen(EVENT_CATALOG['test-pass'].zoneBoost)).toBe(true);
    expect(zoneBoostMap()['test-pass'].session).toBe(8);
  });

  it('stays dependency-light for hook hot paths', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../hud-events.cjs'), 'utf8');
    expect(src).not.toMatch(/require\(['"].*hud-engine/);
    expect(src).not.toMatch(/require\(['"].*hud-zone-/);
    expect(src).not.toMatch(/createCanvas|renderStatusLine|buildD5Output/);
  });
});
