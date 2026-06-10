import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const cjsRequire = createRequire(import.meta.url);
const {
  appendRuleCompliance,
  trackRuleCompliance,
  computeFollowThroughRate,
  suggestDemotions,
} = cjsRequire('../lib/prompt-linter-tuner.cjs');

describe('prompt-linter-tuner', () => {
  it('computes follow-through rate for a rule', () => {
    const history = [
      { rule: 'no-console-log', followed: true },
      { rule: 'no-console-log', followed: false },
      { rule: 'no-console-log', followed: true },
    ];
    const rate = computeFollowThroughRate(history, 'no-console-log');
    expect(rate).toBeCloseTo(0.67, 1);
  });

  it('returns 0 for rules with no history entries', () => {
    const rate = computeFollowThroughRate([], 'unknown-rule');
    expect(rate).toBe(0);
  });

  it('suggests demotion for rules ignored more than 80% of the time', () => {
    const history = Array.from({ length: 10 }, () => ({ rule: 'bad-rule', followed: false }));
    const demotions = suggestDemotions(history);
    expect(demotions.some(d => d.rule === 'bad-rule')).toBe(true);
  });

  it('does not suggest demotion for well-followed rules', () => {
    const history = Array.from({ length: 10 }, () => ({ rule: 'good-rule', followed: true }));
    const demotions = suggestDemotions(history);
    expect(demotions.some(d => d.rule === 'good-rule')).toBe(false);
  });

  it('requires minimum 5 data points before suggesting demotion', () => {
    const history = [
      { rule: 'new-rule', followed: false },
      { rule: 'new-rule', followed: false },
    ];
    const demotions = suggestDemotions(history);
    expect(demotions.some(d => d.rule === 'new-rule')).toBe(false);
  });

  it('includes follow-through rate in demotion suggestion', () => {
    const history = Array.from({ length: 10 }, () => ({ rule: 'low-rule', followed: false }));
    const demotions = suggestDemotions(history);
    const d = demotions.find(d => d.rule === 'low-rule');
    expect(d).toBeDefined();
    expect(d.rate).toBeLessThan(0.2);
  });

  it('trackRuleCompliance creates a timestamped compliance entry', () => {
    const entry = trackRuleCompliance('test-rule', true);
    expect(entry.rule).toBe('test-rule');
    expect(entry.followed).toBe(true);
    expect(entry.timestamp).toBeDefined();
    expect(typeof entry.timestamp).toBe('string');
  });

  it('trackRuleCompliance can persist entries to rule-compliance jsonl', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-linter-tuner-'));
    try {
      const filePath = path.join(tmpDir, '_runs', 'rule-compliance.jsonl');
      const entry = trackRuleCompliance('persisted-rule', true, {
        source: 'test',
        persist: true,
        filePath,
      });

      const rows = fs.readFileSync(filePath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        rule: 'persisted-rule',
        followed: true,
        source: 'test',
      });
      expect(entry.source).toBe('test');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('appendRuleCompliance appends JSONL entries', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-linter-tuner-'));
    try {
      const filePath = path.join(tmpDir, '_runs', 'rule-compliance.jsonl');
      appendRuleCompliance({ rule: 'one', followed: true }, { filePath });
      appendRuleCompliance({ rule: 'two', followed: false }, { filePath });

      const rows = fs.readFileSync(filePath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(rows.map(row => row.rule)).toEqual(['one', 'two']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('demotion suggestions are sorted by rate ascending (worst first)', () => {
    const historyA = Array.from({ length: 10 }, () => ({ rule: 'rule-a', followed: false }));
    const historyB = Array.from({ length: 10 }, (_, i) => ({ rule: 'rule-b', followed: i < 1 }));
    const demotions = suggestDemotions([...historyA, ...historyB]);
    const idxA = demotions.findIndex(d => d.rule === 'rule-a');
    const idxB = demotions.findIndex(d => d.rule === 'rule-b');
    expect(idxA).toBeLessThan(idxB);
  });
});
