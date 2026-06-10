import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fs = require('fs');

const { TrustScore, THRESHOLDS } = require('../lib/trust-score.cjs');

describe('trust-score', () => {
  beforeEach(() => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    vi.spyOn(fs, 'readFileSync').mockReturnValue('{}');
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('starts at guided level with score 0', () => {
    const ts = new TrustScore();
    expect(ts.getLevel()).toBe('guided');
    expect(ts.getScore()).toBe(0);
  });

  it('increments score by 1 on success', () => {
    const ts = new TrustScore();
    ts.recordSuccess();
    expect(ts.getScore()).toBe(1);
  });

  it('decrements score by 2 on failure', () => {
    const ts = new TrustScore();
    ts.recordSuccess(); ts.recordSuccess(); ts.recordSuccess();
    ts.recordFailure();
    expect(ts.getScore()).toBe(1); // 3 - 2
  });

  it('does not go below 0', () => {
    const ts = new TrustScore();
    ts.recordFailure();
    expect(ts.getScore()).toBe(0);
  });

  it('escalates to assisted at threshold 10', () => {
    const ts = new TrustScore();
    for (let i = 0; i < THRESHOLDS.assisted; i++) ts.recordSuccess();
    expect(ts.getLevel()).toBe('assisted');
  });

  it('escalates to autonomous at threshold 25', () => {
    const ts = new TrustScore();
    for (let i = 0; i < THRESHOLDS.autonomous; i++) ts.recordSuccess();
    expect(ts.getLevel()).toBe('autonomous');
  });

  it('de-escalates on failures', () => {
    const ts = new TrustScore();
    for (let i = 0; i < 12; i++) ts.recordSuccess(); // 12 = assisted
    expect(ts.getLevel()).toBe('assisted');
    ts.recordFailure(); // 12 - 2 = 10, still assisted
    ts.recordFailure(); // 10 - 2 = 8, back to guided
    expect(ts.getLevel()).toBe('guided');
  });

  it('resets score to 0', () => {
    const ts = new TrustScore();
    for (let i = 0; i < 5; i++) ts.recordSuccess();
    ts.reset();
    expect(ts.getScore()).toBe(0);
    expect(ts.getLevel()).toBe('guided');
  });

  it('sets score to arbitrary value', () => {
    const ts = new TrustScore();
    ts.setScore(15);
    expect(ts.getScore()).toBe(15);
    expect(ts.getLevel()).toBe('assisted');
  });

  it('loads from persisted state', () => {
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue(JSON.stringify({ score: 20, history: [] }));
    const ts = TrustScore.load('/fake/trust-score.json');
    expect(ts.getScore()).toBe(20);
    expect(ts.getLevel()).toBe('assisted');
  });
});
