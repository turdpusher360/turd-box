import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { forecastBudget, estimateCallsRemaining, getUrgencyLevel } = require('../lib/context-budget.cjs');

describe('context-budget', () => {
  it('estimates calls remaining from threshold and current count', () => {
    const remaining = estimateCallsRemaining(100, 60);
    expect(remaining).toBe(40);
  });

  it('returns 0 when at or over threshold', () => {
    expect(estimateCallsRemaining(100, 100)).toBe(0);
    expect(estimateCallsRemaining(100, 110)).toBe(0);
  });

  it('classifies urgency as high when over 90%', () => {
    expect(getUrgencyLevel(95, 100)).toBe('high');
  });

  it('classifies urgency as medium when over 50%', () => {
    expect(getUrgencyLevel(60, 100)).toBe('medium');
  });

  it('classifies urgency as low when under 50%', () => {
    expect(getUrgencyLevel(30, 100)).toBe('low');
  });

  it('computes rate per minute from session data', () => {
    const result = forecastBudget({
      tool_calls: 30,
      session_started: new Date(Date.now() - 10 * 60000).toISOString(),
      compact_threshold: 100,
    });
    expect(result.rate_per_minute).toBeCloseTo(3, 0);
    expect(result.estimated_minutes_remaining).toBeGreaterThan(0);
  });

  it('handles zero elapsed time gracefully', () => {
    const result = forecastBudget({
      tool_calls: 5,
      session_started: new Date().toISOString(),
      compact_threshold: 100,
    });
    expect(result.rate_per_minute).toBe(0);
    expect(result.estimated_minutes_remaining).toBeNull();
  });
});
