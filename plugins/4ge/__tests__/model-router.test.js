import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const cjsRequire = createRequire(import.meta.url);
const { trackAgentResult, computeSuccessRate, recommendModel, MODELS } = cjsRequire('../lib/model-router.cjs');

describe('model-router', () => {
  it('trackAgentResult creates a result entry with all fields', () => {
    const entry = trackAgentResult('impl', 'opus', true);
    expect(entry.agent).toBe('impl');
    expect(entry.model).toBe('opus');
    expect(entry.success).toBe(true);
    expect(entry.timestamp).toBeDefined();
  });

  it('computeSuccessRate computes per agent-model pair', () => {
    const history = [
      { agent: 'impl', model: 'opus', success: true },
      { agent: 'impl', model: 'opus', success: true },
      { agent: 'impl', model: 'opus', success: false },
      { agent: 'impl', model: 'sonnet', success: true },
    ];
    expect(computeSuccessRate(history, 'impl', 'opus')).toBeCloseTo(0.67, 1);
    expect(computeSuccessRate(history, 'impl', 'sonnet')).toBe(1);
  });

  it('recommendModel prefers cheapest model with >= 90% success rate', () => {
    const history = [
      ...Array.from({ length: 10 }, () => ({ agent: 'impl', model: 'opus', success: true })),
      ...Array.from({ length: 10 }, () => ({ agent: 'impl', model: 'sonnet', success: true })),
    ];
    const rec = recommendModel(history, 'impl');
    expect(rec.model).toBe('sonnet');
  });

  it('recommendModel returns opus when sonnet success rate is low', () => {
    const history = [
      ...Array.from({ length: 10 }, () => ({ agent: 'reviewer', model: 'opus', success: true })),
      ...Array.from({ length: 10 }, (_, i) => ({ agent: 'reviewer', model: 'sonnet', success: i < 5 })),
    ];
    const rec = recommendModel(history, 'reviewer');
    expect(rec.model).toBe('opus');
  });

  it('recommendModel returns opus with reason when insufficient data', () => {
    const rec = recommendModel([], 'unknown');
    expect(rec.model).toBe('opus');
    expect(rec.reason).toContain('insufficient');
  });

  it('MODELS array contains sonnet and opus', () => {
    expect(MODELS).toContain('opus');
    expect(MODELS).toContain('sonnet');
  });

  it('requires minimum 5 results before downgrading from opus', () => {
    const history = [
      { agent: 'impl', model: 'sonnet', success: true },
      { agent: 'impl', model: 'sonnet', success: true },
    ];
    const rec = recommendModel(history, 'impl');
    expect(rec.model).toBe('opus');
  });

  it('computeSuccessRate returns 0 for empty history', () => {
    expect(computeSuccessRate([], 'impl', 'opus')).toBe(0);
  });

  it('recommendation result includes data_points and rate fields', () => {
    const history = Array.from({ length: 10 }, () => ({ agent: 'impl', model: 'sonnet', success: true }));
    const rec = recommendModel(history, 'impl');
    expect(rec.data_points).toBeDefined();
    expect(rec.rate).toBeDefined();
  });
});
