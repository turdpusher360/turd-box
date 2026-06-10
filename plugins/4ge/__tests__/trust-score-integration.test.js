import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('trust score integration', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('TrustScore starts at 0 / guided', () => {
    const { TrustScore } = require('../lib/trust-score.cjs');
    const ts = new TrustScore();
    expect(ts.getScore()).toBe(0);
    expect(ts.getLevel()).toBe('guided');
  });

  it('recordSuccess increments score', () => {
    const { TrustScore } = require('../lib/trust-score.cjs');
    const ts = new TrustScore();
    ts.recordSuccess();
    expect(ts.getScore()).toBe(1);
  });

  it('recordFailure decrements by 2, clamped to 0', () => {
    const { TrustScore } = require('../lib/trust-score.cjs');
    const ts = new TrustScore(1);
    ts.recordFailure();
    expect(ts.getScore()).toBe(0);
  });

  it('reaches assisted at score 10', () => {
    const { TrustScore, THRESHOLDS } = require('../lib/trust-score.cjs');
    const ts = new TrustScore();
    for (let i = 0; i < THRESHOLDS.assisted; i++) ts.recordSuccess();
    expect(ts.getLevel()).toBe('assisted');
    expect(ts.getScore()).toBe(10);
  });

  it('reaches autonomous at score 25', () => {
    const { TrustScore, THRESHOLDS } = require('../lib/trust-score.cjs');
    const ts = new TrustScore();
    for (let i = 0; i < THRESHOLDS.autonomous; i++) ts.recordSuccess();
    expect(ts.getLevel()).toBe('autonomous');
  });

  it('save and load roundtrip preserves score', () => {
    const { TrustScore } = require('../lib/trust-score.cjs');
    const filePath = path.join(tmpDir, 'trust.json');
    const ts = new TrustScore();
    for (let i = 0; i < 5; i++) ts.recordSuccess();
    ts.save(filePath);

    const loaded = TrustScore.load(filePath);
    expect(loaded.getScore()).toBe(5);
    expect(loaded.getLevel()).toBe('guided');
  });

  it('load from missing file returns score 0', () => {
    const { TrustScore } = require('../lib/trust-score.cjs');
    const ts = TrustScore.load(path.join(tmpDir, 'nonexistent.json'));
    expect(ts.getScore()).toBe(0);
  });

  it('save creates directories recursively', () => {
    const { TrustScore } = require('../lib/trust-score.cjs');
    const deep = path.join(tmpDir, 'a', 'b', 'c', 'trust.json');
    const ts = new TrustScore(7);
    ts.save(deep);
    expect(fs.existsSync(deep)).toBe(true);
    const loaded = TrustScore.load(deep);
    expect(loaded.getScore()).toBe(7);
  });

  it('getProgression shows remaining to next level', () => {
    const { TrustScore } = require('../lib/trust-score.cjs');
    const ts = new TrustScore(8);
    const prog = ts.getProgression();
    expect(prog.level).toBe('guided');
    expect(prog.nextLevel).toBe('assisted');
    expect(prog.remaining).toBe(2);
  });

  it('getProgression at autonomous shows no next level', () => {
    const { TrustScore } = require('../lib/trust-score.cjs');
    const ts = new TrustScore(30);
    const prog = ts.getProgression();
    expect(prog.level).toBe('autonomous');
    expect(prog.nextLevel).toBeNull();
    expect(prog.remaining).toBe(0);
  });

  it('load clamps out-of-range scores', () => {
    const { TrustScore } = require('../lib/trust-score.cjs');
    const filePath = path.join(tmpDir, 'clamp.json');
    // Poison with out-of-range score
    fs.writeFileSync(filePath, JSON.stringify({ score: 99999 }));
    const ts = TrustScore.load(filePath);
    expect(ts.getScore()).toBe(0);
  });

  it('load rejects non-numeric scores', () => {
    const { TrustScore } = require('../lib/trust-score.cjs');
    const filePath = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(filePath, JSON.stringify({ score: "evil" }));
    const ts = TrustScore.load(filePath);
    expect(ts.getScore()).toBe(0);
  });

  it('load rejects negative scores', () => {
    const { TrustScore } = require('../lib/trust-score.cjs');
    const filePath = path.join(tmpDir, 'neg.json');
    fs.writeFileSync(filePath, JSON.stringify({ score: -5 }));
    const ts = TrustScore.load(filePath);
    expect(ts.getScore()).toBe(0);
  });
});
