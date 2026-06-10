import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const cjsRequire = createRequire(import.meta.url);
const { detectRevertAfterWarning, computeHookEffectiveness, formatEffectivenessReport } = cjsRequire('../lib/feedback-harvester.cjs');

describe('feedback-harvester', () => {
  it('detects revert-after-warning pattern within time window', () => {
    const events = [
      { type: 'warning', hook: 'react-patterns', file: 'a.tsx', timestamp: '2026-04-01T10:00:00Z' },
      { type: 'revert', file: 'a.tsx', timestamp: '2026-04-01T10:02:00Z' },
    ];
    const signals = detectRevertAfterWarning(events, 5 * 60 * 1000);
    expect(signals).toHaveLength(1);
    expect(signals[0].hook).toBe('react-patterns');
    expect(signals[0].positive).toBe(true);
  });

  it('ignores reverts outside the time window', () => {
    const events = [
      { type: 'warning', hook: 'react-patterns', file: 'a.tsx', timestamp: '2026-04-01T10:00:00Z' },
      { type: 'revert', file: 'a.tsx', timestamp: '2026-04-01T11:00:00Z' },
    ];
    const signals = detectRevertAfterWarning(events, 5 * 60 * 1000);
    expect(signals).toEqual([]);
  });

  it('ignores reverts on different files', () => {
    const events = [
      { type: 'warning', hook: 'react-patterns', file: 'a.tsx', timestamp: '2026-04-01T10:00:00Z' },
      { type: 'revert', file: 'b.tsx', timestamp: '2026-04-01T10:01:00Z' },
    ];
    const signals = detectRevertAfterWarning(events, 5 * 60 * 1000);
    expect(signals).toEqual([]);
  });

  it('computes hook effectiveness from an array of signals', () => {
    const signals = [
      { hook: 'react-patterns', positive: true },
      { hook: 'react-patterns', positive: true },
      { hook: 'react-patterns', positive: false },
    ];
    const effectiveness = computeHookEffectiveness(signals);
    expect(effectiveness['react-patterns'].positive).toBe(2);
    expect(effectiveness['react-patterns'].total).toBe(3);
  });

  it('formatEffectivenessReport includes hook name and percentage', () => {
    const effectiveness = { 'react-patterns': { positive: 8, total: 10 } };
    const report = formatEffectivenessReport(effectiveness);
    expect(report).toContain('react-patterns');
    expect(report).toContain('80%');
  });

  it('handles empty events list gracefully', () => {
    const signals = detectRevertAfterWarning([], 5 * 60 * 1000);
    expect(signals).toEqual([]);
  });

  it('handles empty effectiveness object in report', () => {
    const report = formatEffectivenessReport({});
    expect(typeof report).toBe('string');
    expect(report.length).toBeGreaterThan(0);
  });
});
