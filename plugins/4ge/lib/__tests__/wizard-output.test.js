import { describe, it, expect, beforeEach } from 'vitest';

const {
  renderBar,
  formatScoreBar,
  formatCategoryRow,
  formatFindingRow,
  formatDeltaCard,
  formatProgressLine,
  renderQuickReport,
  setColorEnabled,
} = require('../../lib/wizard-output.cjs');

describe('wizard-output', () => {
  // All format tests run in plain-text mode for deterministic assertions
  beforeEach(() => {
    setColorEnabled(false);
  });

  describe('renderBar', () => {
    it('renders empty bar at 0%', () => {
      expect(renderBar(0, 100, 20)).toBe('--------------------');
    });

    it('renders half-filled bar at 50%', () => {
      expect(renderBar(50, 100, 20)).toBe('==========----------');
    });

    it('renders full bar at 100%', () => {
      expect(renderBar(100, 100, 20)).toBe('====================');
    });

    it('clamps score to range', () => {
      expect(renderBar(150, 100, 20)).toBe('====================');
      expect(renderBar(-10, 100, 20)).toBe('--------------------');
    });

    it('handles zero maxScore gracefully', () => {
      expect(renderBar(50, 0, 20)).toBe('--------------------');
    });

    it('renders category-level bars (20 max)', () => {
      expect(renderBar(15, 20, 20)).toBe('===============-----');
    });
  });

  describe('renderBar (color mode)', () => {
    it('uses block elements when color is enabled', () => {
      setColorEnabled(true);
      const result = renderBar(50, 100, 20);
      expect(result).toContain('▓');
      expect(result).toContain('░');
      expect(result).toContain('\x1b[');
    });

    it('accepts fillColor parameter', () => {
      setColorEnabled(true);
      const result = renderBar(50, 100, 10, 'yellow');
      expect(result).toContain('▓▓▓▓▓');
      expect(result).toContain('░░░░░');
    });
  });

  describe('formatScoreBar', () => {
    it('formats without delta', () => {
      const result = formatScoreBar(85, 'B');
      expect(result).toContain('Health: 85');
      expect(result).toContain('B');
      expect(result).toContain('[');
      expect(result).not.toContain('(');
    });

    it('formats with positive delta', () => {
      const result = formatScoreBar(85, 'B', 5);
      expect(result).toContain('(+5)');
    });

    it('formats with negative delta', () => {
      const result = formatScoreBar(70, 'C', -10);
      expect(result).toContain('(-10)');
    });

    it('formats with zero delta', () => {
      const result = formatScoreBar(85, 'B', 0);
      expect(result).toContain('(+0)');
    });
  });

  describe('formatCategoryRow', () => {
    it('aligns columns correctly', () => {
      const result = formatCategoryRow('Branches', 18, 'A', 'PASS', 0);
      expect(result).toContain('Branches');
      expect(result).toContain('18/20');
      expect(result).toContain('A');
      expect(result).toContain('PASS');
    });

    it('includes finding count when > 0', () => {
      const result = formatCategoryRow('Security', 12, 'C', 'WARN', 3);
      expect(result).toContain('3 findings');
    });

    it('includes bar in output', () => {
      const result = formatCategoryRow('Hooks', 16, 'B', 'PASS', 1);
      expect(result).toContain('[================----]');
    });

    it('omits finding count when 0', () => {
      const result = formatCategoryRow('Config', 20, 'A', 'PASS', 0);
      expect(result).not.toContain('findings');
    });

    it('starts with 2-space indent', () => {
      const result = formatCategoryRow('Tests', 16, 'B', 'PASS', 0);
      expect(result.startsWith('  ')).toBe(true);
    });
  });

  describe('formatFindingRow', () => {
    it('includes all fields', () => {
      const result = formatFindingRow(1, 'recommended', 'Delete merged branch', 'auto', 0.95);
      expect(result).toContain('1.');
      expect(result).toContain('[recommended]');
      expect(result).toContain('Delete merged branch');
      expect(result).toContain('(auto)');
      expect(result).toContain('0.95');
    });

    it('right-justifies finding number', () => {
      const result = formatFindingRow(3, 'suggested', 'Update dep', 'guided', 0.71);
      expect(result).toMatch(/\s+3\./);
    });

    it('starts with 2-space indent', () => {
      const result = formatFindingRow(1, 'detected', 'Stale TODO', 'noted', 0.38);
      expect(result.startsWith('  ')).toBe(true);
    });
  });

  describe('formatDeltaCard', () => {
    it('shows changed categories', () => {
      const delta = {
        overallBefore: 70,
        overallAfter: 85,
        delta: 15,
        gradeBefore: 'C',
        gradeAfter: 'B',
        categories: {
          branches: { before: 12, after: 18, delta: 6 },
        },
      };
      const result = formatDeltaCard(delta);
      expect(result).toContain('branches');
      expect(result).toContain('+6');
      expect(result).toContain('70 -> 85');
      expect(result).toContain('+15');
      expect(result).toContain('C -> B');
    });

    it('shows no-change message when categories empty', () => {
      const delta = {
        overallBefore: 85,
        overallAfter: 85,
        delta: 0,
        gradeBefore: 'B',
        gradeAfter: 'B',
        categories: {},
      };
      const result = formatDeltaCard(delta);
      expect(result).toContain('No category changes');
    });
  });

  describe('formatProgressLine', () => {
    it('formats with detail', () => {
      const result = formatProgressLine('Scanning', 3, 9, 'Hooks', 'checking wiring');
      expect(result).toContain('Scanning');
      expect(result).toContain('[3/9]');
      expect(result).toContain('Hooks');
      expect(result).toContain('checking wiring');
      expect(result).toContain('...');
    });

    it('formats without detail', () => {
      const result = formatProgressLine('Verifying', 1, 2, 'Tests');
      expect(result).toContain('[1/2]');
      expect(result).toContain('Tests');
      expect(result).toContain('...');
      expect(result).not.toContain('(');
    });

    it('starts with 2-space indent', () => {
      const result = formatProgressLine('Scanning', 1, 9, 'Branches');
      expect(result.startsWith('  ')).toBe(true);
    });
  });

  describe('renderQuickReport', () => {
    it('renders a complete report from scan result', () => {
      const scanResult = {
        categories: {
          branches: { raw: 20, deductions: [], weight: 1 },
          security: { raw: 14, deductions: [{ id: 'gitignore_gap', count: 10, deduction: -6 }], weight: 1 },
        },
        overall: { weighted: 94, total: 34, maxTotal: 40, grade: 'A' },
        inbox: { total: 2, categories: { hooks: 2 } },
        stale: ['dep-vulnerability'],
        aisle: { healthy: true, scanners: [{ id: 'A' }] },
      };
      const result = renderQuickReport(scanResult);
      expect(result).toContain('Health: 94');
      expect(result).toContain('A');
      expect(result).toContain('security');
      expect(result).toContain('14/20');
      expect(result).toContain('Inbox: 2 open items');
      expect(result).toContain('Stale data: 1 domains');
      expect(result).toContain('AISLE: 1 scanners, healthy');
    });

    it('sorts categories worst-first', () => {
      const scanResult = {
        categories: {
          good: { raw: 20, deductions: [], weight: 1 },
          bad: { raw: 10, deductions: [{ id: 'x', count: 1, deduction: -10 }], weight: 1 },
        },
        overall: { weighted: 75, total: 30, maxTotal: 40, grade: 'B' },
        inbox: { total: 0, categories: {} },
        stale: [],
        aisle: { healthy: true, scanners: [] },
      };
      const result = renderQuickReport(scanResult);
      const badIdx = result.indexOf('bad');
      const goodIdx = result.indexOf('good');
      expect(badIdx).toBeLessThan(goodIdx);
    });
  });
});
