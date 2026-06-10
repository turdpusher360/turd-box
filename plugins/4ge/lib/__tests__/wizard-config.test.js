import { describe, it, expect } from 'vitest';

const {
  deepMerge,
  mergeConfig,
  enforceSecurityFloors,
  validateSuppress,
  resolveThresholds,
} = require('../../lib/wizard-config.cjs');

describe('wizard-config', () => {
  describe('deepMerge', () => {
    it('merges nested objects', () => {
      const base = { a: { b: 1, c: 2 }, d: 3 };
      const override = { a: { b: 10 } };
      const result = deepMerge(base, override);
      expect(result).toEqual({ a: { b: 10, c: 2 }, d: 3 });
    });

    it('removes keys with null override', () => {
      const base = { a: 1, b: 2 };
      const override = { a: null };
      const result = deepMerge(base, override);
      expect(result).toEqual({ b: 2 });
    });

    it('replaces arrays (no deep merge on arrays)', () => {
      const base = { arr: [1, 2, 3] };
      const override = { arr: [4, 5] };
      const result = deepMerge(base, override);
      expect(result).toEqual({ arr: [4, 5] });
    });

    it('returns base when override is null', () => {
      const base = { a: 1 };
      expect(deepMerge(base, null)).toEqual({ a: 1 });
    });

    it('returns override when base is null', () => {
      const override = { a: 1 };
      expect(deepMerge(null, override)).toEqual({ a: 1 });
    });
  });

  describe('mergeConfig', () => {
    it('applies 3-layer precedence', () => {
      const defaults = { categories: { branches: { weight: 1.0 } }, mode: 'full' };
      const project = { categories: { branches: { weight: 1.5 } } };
      const mode = { mode: 'quick' };
      const result = mergeConfig(defaults, project, mode);
      expect(result.categories.branches.weight).toBe(1.5);
      expect(result.mode).toBe('quick');
    });

    it('handles null project and mode configs', () => {
      const defaults = { categories: { branches: { weight: 1.0 } } };
      const result = mergeConfig(defaults, null, null);
      expect(result.categories.branches.weight).toBe(1.0);
    });

    it('always enforces security floors after merge', () => {
      const defaults = { categories: { security: { enabled: true, pass_threshold: 30 } } };
      const project = { categories: { security: { enabled: false, pass_threshold: 10 } } };
      const result = mergeConfig(defaults, project, null);
      expect(result.categories.security.enabled).toBe(true);
      expect(result.categories.security.pass_threshold).toBe(30);
    });
  });

  describe('enforceSecurityFloors', () => {
    it('re-enables disabled security category', () => {
      const config = { categories: { security: { enabled: false } } };
      const result = enforceSecurityFloors(config);
      expect(result.categories.security.enabled).toBe(true);
    });

    it('floors pass_threshold at 30', () => {
      const config = { categories: { security: { pass_threshold: 10 } } };
      const result = enforceSecurityFloors(config);
      expect(result.categories.security.pass_threshold).toBe(30);
    });

    it('removes wildcard suppress on security', () => {
      const config = {
        suppress: [
          { category: 'security', pattern: '.*' },
          { category: 'branches', pattern: '.*' },
        ],
      };
      const result = enforceSecurityFloors(config);
      expect(result.suppress).toHaveLength(1);
      expect(result.suppress[0].category).toBe('branches');
    });

    it('also blocks (.+) suppress pattern on security (W11 fix)', () => {
      const config = {
        suppress: [
          { category: 'security', pattern: '(.+)' },
        ],
      };
      const result = enforceSecurityFloors(config);
      expect(result.suppress).toHaveLength(0);
    });

    it('rejects weak security threshold overrides', () => {
      const config = {
        categories: {
          security: {
            thresholds: {
              pin_mismatch: { points: 0 },  // too weak (> -1)
              env_tracked: { points: -2 },   // acceptable
            },
          },
        },
      };
      const result = enforceSecurityFloors(config);
      expect(result.categories.security.thresholds.pin_mismatch).toBeUndefined();
      expect(result.categories.security.thresholds.env_tracked.points).toBe(-2);
    });

    it('restores categories when nulled out (W5 DFE fix)', () => {
      const config = { categories: null };
      const result = enforceSecurityFloors(config);
      expect(result.categories).toBeDefined();
      expect(typeof result.categories).toBe('object');
      expect(result.categories.security.enabled).toBe(true);
    });

    it('creates security category if missing', () => {
      const config = { categories: { branches: { weight: 1.0 } } };
      const result = enforceSecurityFloors(config);
      expect(result.categories.security).toBeDefined();
      expect(result.categories.security.enabled).toBe(true);
    });
  });

  describe('validateSuppress', () => {
    it('separates valid, expired, and rejected entries', () => {
      const now = new Date('2026-04-07');
      const entries = [
        { id: 'a', expires: '2026-04-10' },  // valid (future)
        { id: 'b', expires: '2026-04-01' },  // expired (past)
        { id: 'c', severity: 'critical' },   // rejected (critical)
        null,                                  // rejected (invalid)
      ];
      const result = validateSuppress(entries, now);
      expect(result.valid).toHaveLength(1);
      expect(result.valid[0].id).toBe('a');
      expect(result.expired).toHaveLength(1);
      expect(result.expired[0].id).toBe('b');
      expect(result.rejected).toHaveLength(2);
    });

    it('handles empty input', () => {
      const result = validateSuppress(null);
      expect(result.valid).toHaveLength(0);
      expect(result.expired).toHaveLength(0);
      expect(result.rejected).toHaveLength(0);
    });

    it('allows permanent entries (no expires)', () => {
      const result = validateSuppress([{ id: 'a' }]);
      expect(result.valid).toHaveLength(1);
    });
  });

  describe('resolveThresholds', () => {
    it('returns defaults when no overrides', () => {
      const defaults = [
        { id: 'merged_not_deleted', points: -2, max: -6 },
      ];
      const result = resolveThresholds('branches', defaults, null);
      expect(result).toEqual(defaults);
    });

    it('merges overrides onto defaults', () => {
      const defaults = [
        { id: 'merged_not_deleted', points: -2, max: -6 },
      ];
      const overrides = { merged_not_deleted: { points: -3 } };
      const result = resolveThresholds('branches', defaults, overrides);
      expect(result[0].points).toBe(-3);
      expect(result[0].max).toBe(-6); // default preserved
    });

    it('handles empty defaults', () => {
      const result = resolveThresholds('branches', [], {});
      expect(result).toEqual([]);
    });
  });
});
