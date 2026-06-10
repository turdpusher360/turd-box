import { describe, it, expect } from 'vitest';

const {
  scoreCategory,
  computeOverall,
  assignGrade,
  classifyCategory,
  tagConfidence,
  computeDelta,
  needsDeepDive,
  MAX_PER_CATEGORY,
} = require('../../lib/wizard-scoring.cjs');

describe('wizard-scoring', () => {
  // --- scoreCategory ---
  describe('scoreCategory', () => {
    it('returns max score with zero findings', () => {
      const result = scoreCategory('branches', {}, [
        { id: 'merged_not_deleted', points: -2, max: -6 },
      ], { weight: 1.0 });
      expect(result.raw).toBe(20);
      expect(result.deductions).toHaveLength(0);
      expect(result.weight).toBe(1.0);
    });

    it('applies single deduction correctly', () => {
      const result = scoreCategory('branches', { merged_not_deleted: 2 }, [
        { id: 'merged_not_deleted', points: -2, max: -6 },
      ], { weight: 1.0 });
      expect(result.raw).toBe(16);
      expect(result.deductions).toHaveLength(1);
      expect(result.deductions[0].deduction).toBe(-4);
    });

    it('handles per-N counting', () => {
      const result = scoreCategory('dependencies', { major_outdated: 7 }, [
        { id: 'major_outdated', points: -1, per: 3, max: -4 },
      ], { weight: 1.2 });
      // 7/3 = 2 (floor), 2 * -1 = -2, clamped to max -4 -> -2 (since -2 > -4)
      expect(result.raw).toBe(18);
    });

    it('clamps score to 0 minimum', () => {
      const result = scoreCategory('security', { pin_mismatch: 100 }, [
        { id: 'pin_mismatch', points: -5 },
      ], { weight: 1.5 });
      expect(result.raw).toBe(0);
    });

    it('returns skipped result for disabled category', () => {
      const result = scoreCategory('docs', {}, [], { weight: 0.6, enabled: false });
      expect(result.skipped).toBe(true);
      expect(result.raw).toBe(0);
    });

    it('respects max deduction cap per threshold', () => {
      const result = scoreCategory('hooks', { file_missing: 10 }, [
        { id: 'file_missing', points: -4, max: -8 },
      ], { weight: 1.0 });
      // 10 * -4 = -40, capped at -8
      expect(result.raw).toBe(12);
      expect(result.deductions[0].deduction).toBe(-8);
    });
  });

  // --- computeOverall ---
  describe('computeOverall', () => {
    it('computes weighted score for single category', () => {
      const result = computeOverall({
        branches: { raw: 16, weight: 1.0 },
      });
      expect(result.weighted).toBe(80);
      expect(result.grade).toBe('B');
    });

    it('computes weighted score across all 9 categories', () => {
      const cats = {
        branches:     { raw: 20, weight: 1.0 },
        dependencies: { raw: 20, weight: 1.2 },
        agents:       { raw: 20, weight: 0.8 },
        hooks:        { raw: 20, weight: 1.0 },
        tests:        { raw: 20, weight: 1.0 },
        config:       { raw: 20, weight: 1.0 },
        dead_code:    { raw: 20, weight: 0.8 },
        docs:         { raw: 20, weight: 0.6 },
        security:     { raw: 20, weight: 1.5 },
      };
      const result = computeOverall(cats);
      expect(result.weighted).toBe(100);
      expect(result.grade).toBe('A');
    });

    it('excludes skipped categories', () => {
      const cats = {
        branches: { raw: 20, weight: 1.0 },
        docs:     { raw: 0, weight: 0.6, skipped: true },
      };
      const result = computeOverall(cats);
      expect(result.weighted).toBe(100);
    });

    it('returns 0 when all categories are skipped', () => {
      const result = computeOverall({
        a: { raw: 10, weight: 1.0, skipped: true },
      });
      expect(result.weighted).toBe(0);
    });
  });

  // --- assignGrade ---
  describe('assignGrade', () => {
    it('returns correct grades at boundaries', () => {
      expect(assignGrade(100)).toBe('A');
      expect(assignGrade(90)).toBe('A');
      expect(assignGrade(89)).toBe('B');
      expect(assignGrade(75)).toBe('B');
      expect(assignGrade(74)).toBe('C');
      expect(assignGrade(55)).toBe('C');
      expect(assignGrade(54)).toBe('D');
      expect(assignGrade(35)).toBe('D');
      expect(assignGrade(34)).toBe('F');
      expect(assignGrade(0)).toBe('F');
    });

    it('handles NaN and invalid inputs gracefully', () => {
      expect(assignGrade(NaN)).toBe('F');
      expect(assignGrade(undefined)).toBe('F');
    });
  });

  // --- classifyCategory ---
  describe('classifyCategory', () => {
    it('classifies PASS/WARN/FAIL correctly', () => {
      expect(classifyCategory(20)).toBe('PASS');
      expect(classifyCategory(16)).toBe('PASS');
      expect(classifyCategory(15)).toBe('WARN');
      expect(classifyCategory(10)).toBe('WARN');
      expect(classifyCategory(9)).toBe('FAIL');
      expect(classifyCategory(0)).toBe('FAIL');
    });

    it('handles NaN as FAIL', () => {
      expect(classifyCategory(NaN)).toBe('FAIL');
    });
  });

  // --- tagConfidence ---
  describe('tagConfidence', () => {
    it('returns correct tags at thresholds', () => {
      expect(tagConfidence(0.85)).toBe('recommended');
      expect(tagConfidence(0.80)).toBe('recommended');
      expect(tagConfidence(0.60)).toBe('suggested');
      expect(tagConfidence(0.48)).toBe('suggested');
      expect(tagConfidence(0.47)).toBe('detected');
      expect(tagConfidence(0.0)).toBe('detected');
    });

    it('supports custom threshold', () => {
      expect(tagConfidence(0.5, 0.5)).toBe('recommended');
      expect(tagConfidence(0.3, 0.5)).toBe('suggested');
      expect(tagConfidence(0.1, 0.5)).toBe('detected');
    });

    it('handles NaN input', () => {
      expect(tagConfidence(NaN)).toBe('detected');
    });
  });

  // --- computeDelta ---
  describe('computeDelta', () => {
    it('computes deltas for changed categories', () => {
      const before = { branches: { raw: 12, weight: 1.0 } };
      const after = { branches: { raw: 18, weight: 1.0 } };
      const result = computeDelta(before, after);
      expect(result.categories.branches.delta).toBe(6);
      expect(result.delta).toBeGreaterThan(0);
    });

    it('omits unchanged categories', () => {
      const before = { branches: { raw: 20, weight: 1.0 } };
      const after = { branches: { raw: 20, weight: 1.0 } };
      const result = computeDelta(before, after);
      expect(Object.keys(result.categories)).toHaveLength(0);
    });
  });

  // --- needsDeepDive ---
  describe('needsDeepDive', () => {
    it('returns true for FAIL classification', () => {
      expect(needsDeepDive('FAIL', [])).toBe(true);
    });

    it('returns true for critical findings in WARN', () => {
      expect(needsDeepDive('WARN', [{ severity: 'critical' }])).toBe(true);
    });

    it('returns false for PASS with no critical findings', () => {
      expect(needsDeepDive('PASS', [{ severity: 'medium' }])).toBe(false);
    });

    it('returns false for WARN with no critical findings', () => {
      expect(needsDeepDive('WARN', [{ severity: 'high' }])).toBe(false);
    });
  });

  // --- Parameterized boundary tests (replaces property-based) ---
  describe('boundary coverage', () => {
    it.each([0, 1, 5, 10, 15, 19, 20, 50, 100])(
      'scoreCategory with %i findings stays in [0, 20]',
      (count) => {
        const result = scoreCategory('test', { test: count },
          [{ id: 'test', points: -1, max: -20 }],
          { weight: 1.0 });
        expect(result.raw).toBeGreaterThanOrEqual(0);
        expect(result.raw).toBeLessThanOrEqual(20);
      }
    );

    it.each([-10, 0, 34, 35, 54, 55, 74, 75, 89, 90, 100, 110])(
      'assignGrade(%i) returns valid grade',
      (score) => {
        expect(['A', 'B', 'C', 'D', 'F']).toContain(assignGrade(score));
      }
    );

    it('adding findings never increases score (monotonicity)', () => {
      const thresholds = [{ id: 'test', points: -1, max: -20 }];
      const config = { weight: 1.0 };
      for (let i = 0; i < 25; i++) {
        const a = scoreCategory('test', { test: i }, thresholds, config);
        const b = scoreCategory('test', { test: i + 1 }, thresholds, config);
        expect(b.raw).toBeLessThanOrEqual(a.raw);
      }
    });

    it('same inputs produce same outputs (determinism)', () => {
      const thresholds = [{ id: 'test', points: -2, max: -10 }];
      const config = { weight: 1.0 };
      for (const count of [0, 3, 7, 15]) {
        const a = scoreCategory('test', { test: count }, thresholds, config);
        const b = scoreCategory('test', { test: count }, thresholds, config);
        expect(a.raw).toBe(b.raw);
        expect(a.deductions).toEqual(b.deductions);
      }
    });
  });
});
