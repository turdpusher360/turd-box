import { describe, it, expect } from 'vitest';

const { formatOptions, parseChoice, createDecisionPoint } = require('../lib/lounge-engine.cjs');

describe('lounge-engine', () => {
  it('formats options as numbered list', () => {
    const text = formatOptions(['Option A', 'Option B', 'Option C']);
    expect(text).toContain('[1] Option A');
    expect(text).toContain('[2] Option B');
    expect(text).toContain('[3] Option C');
  });

  it('limits to max_options (default 4)', () => {
    const text = formatOptions(['A', 'B', 'C', 'D', 'E']);
    expect(text).toContain('[4]');
    expect(text).not.toContain('[5]');
  });

  it('parses numeric input to option', () => {
    const options = ['A', 'B', 'C'];
    expect(parseChoice('1', options)).toBe('A');
    expect(parseChoice('2', options)).toBe('B');
    expect(parseChoice('3', options)).toBe('C');
  });

  it('parses text input matching option', () => {
    const options = ['Accept', 'Reject', 'Skip'];
    expect(parseChoice('accept', options)).toBe('Accept');
    expect(parseChoice('REJECT', options)).toBe('Reject');
  });

  it('returns null for invalid input', () => {
    const options = ['A', 'B'];
    expect(parseChoice('5', options)).toBeNull();
    expect(parseChoice('xyz', options)).toBeNull();
  });

  it('creates a decision point with question and options', () => {
    const dp = createDecisionPoint('What next?', ['Build', 'Test', 'Ship']);
    expect(dp.question).toBe('What next?');
    expect(dp.options).toHaveLength(3);
    expect(dp.formatted).toContain('[1]');
  });

  it('handles single option', () => {
    const dp = createDecisionPoint('Continue?', ['Yes']);
    expect(dp.options).toHaveLength(1);
    expect(dp.formatted).toContain('[1] Yes');
  });

  it('parseChoice handles empty input', () => {
    expect(parseChoice('', ['A', 'B'])).toBeNull();
  });
});
