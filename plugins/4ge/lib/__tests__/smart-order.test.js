import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { reorderOptions } = require('../smart-order.cjs');

const OPTIONS = [
  { id: 'forge',   label: 'Start forge session', baseScore: 1 },
  { id: 'fix',     label: 'Fix issues',          baseScore: 1 },
  { id: 'ship',    label: 'Ship changes',         baseScore: 1 },
  { id: 'explore', label: 'Explore codebase',     baseScore: 1 },
  { id: 'test',    label: 'Run tests',            baseScore: 1 },
];

describe('reorderOptions', () => {
  it('returns empty array for empty input', () => {
    expect(reorderOptions([], {})).toEqual([]);
  });

  it('returns empty array for null input', () => {
    expect(reorderOptions(null, {})).toEqual([]);
  });

  it('boosts explore when idle (empty signals)', () => {
    const result = reorderOptions(OPTIONS, {});
    expect(result[0].recommended).toBe(true);
    // Empty signals = idle = explore gets boosted
    const exploreOpt = result.find(o => o.id === 'explore');
    expect(exploreOpt.effectiveScore).toBeGreaterThan(1);
    // Non-explore options stay at base
    const nonExplore = result.filter(o => !(/^(explore|browse|search|audit|review|research)/i.test(o.id)));
    expect(nonExplore.every(o => o.effectiveScore === o.baseScore)).toBe(true);
  });

  it('boosts forge options when forge is active', () => {
    const result = reorderOptions(OPTIONS, {
      forgeState: { forgeActive: true },
    });
    const forgeOpt = result.find(o => o.id === 'forge');
    expect(forgeOpt.effectiveScore).toBeGreaterThan(1);
    expect(result[0].id).toBe('forge');
    expect(result[0].recommended).toBe(true);
  });

  it('boosts fix options when tests failing', () => {
    const result = reorderOptions(OPTIONS, {
      testState: { testsFailing: true },
    });
    const fixOpt = result.find(o => o.id === 'fix');
    const testOpt = result.find(o => o.id === 'test');
    expect(fixOpt.effectiveScore).toBeGreaterThan(1);
    expect(testOpt.effectiveScore).toBeGreaterThan(1);
  });

  it('boosts commit/ship options when uncommitted changes', () => {
    const result = reorderOptions(OPTIONS, {
      gitStatus: { hasUncommitted: true },
    });
    const shipOpt = result.find(o => o.id === 'ship');
    expect(shipOpt.effectiveScore).toBeGreaterThan(1);
  });

  it('boosts explore options when idle', () => {
    const result = reorderOptions(OPTIONS, {
      gitStatus: { hasUncommitted: false },
      forgeState: { forgeActive: false },
      testState: { testsFailing: false },
    });
    const exploreOpt = result.find(o => o.id === 'explore');
    expect(exploreOpt.effectiveScore).toBeGreaterThan(1);
  });

  it('boosts fix options when recent test edits', () => {
    const result = reorderOptions(OPTIONS, {
      recentEdits: { hasTestEdits: true },
    });
    const fixOpt = result.find(o => o.id === 'fix');
    expect(fixOpt.effectiveScore).toBeGreaterThan(1);
  });

  it('boosts fix options when recent hook edits', () => {
    const result = reorderOptions(OPTIONS, {
      recentEdits: { hasHookEdits: true },
    });
    const fixOpt = result.find(o => o.id === 'fix');
    expect(fixOpt.effectiveScore).toBeGreaterThan(1);
  });

  it('double-boosts when multiple signals match same option', () => {
    const result = reorderOptions(OPTIONS, {
      testState: { testsFailing: true },
      recentEdits: { hasTestEdits: true },
    });
    const fixOpt = result.find(o => o.id === 'fix');
    // BOOST * BOOST = 6.25
    expect(fixOpt.effectiveScore).toBeCloseTo(6.25, 1);
  });

  it('sorts descending by effective score', () => {
    const result = reorderOptions(OPTIONS, {
      forgeState: { forgeActive: true },
    });
    for (let i = 1; i < result.length; i++) {
      expect(result[i].effectiveScore).toBeLessThanOrEqual(result[i - 1].effectiveScore);
    }
  });

  it('marks only first item as recommended', () => {
    const result = reorderOptions(OPTIONS, {});
    const recommended = result.filter(o => o.recommended);
    expect(recommended).toHaveLength(1);
    expect(recommended[0]).toBe(result[0]);
  });
});
