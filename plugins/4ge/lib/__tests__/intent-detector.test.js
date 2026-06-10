import { describe, it, expect } from 'vitest';

const { detectIntent, IDLE_THRESHOLD_MS } = require('../intent-detector.cjs');

const now = Date.now();

// Helpers
const ev = (tool, extra = {}) => ({ tool, ts: now, ...extra });
const bash = (command) => ({ tool: 'Bash', command, ts: now });
const edit = (filePath, replaceAll = false) => ({ tool: 'Edit', filePath, replaceAll, ts: now });
const read = (filePath) => ({ tool: 'Read', filePath, ts: now });
const grep = () => ({ tool: 'Grep', ts: now });
const glob = () => ({ tool: 'Glob', ts: now });
const write = (filePath) => ({ tool: 'Write', filePath, ts: now });

describe('detectIntent - idle', () => {
  it('returns idle when no recent tools', () => {
    const r = detectIntent({ recentTools: [], now });
    expect(r.intent).toBe('idle');
  });

  it('returns idle when last tool was over 5 minutes ago', () => {
    const oldEv = ev('Read', { ts: now - IDLE_THRESHOLD_MS - 1000 });
    const r = detectIntent({ recentTools: [oldEv], now });
    expect(r.intent).toBe('idle');
    expect(r.confidence).toBeGreaterThan(0.8);
  });

  it('does NOT return idle when tools are fresh', () => {
    const fresh = [read('a.js'), read('b.js'), read('c.js'), grep(), grep()];
    const r = detectIntent({ recentTools: fresh, now });
    expect(r.intent).not.toBe('idle');
  });
});

describe('detectIntent - shipping', () => {
  it('detects commit + push', () => {
    const recent = [
      bash('git status'),
      bash('git add .'),
      bash('git commit -m "fix"'),
      bash('git push origin main'),
    ];
    const r = detectIntent({ recentTools: recent, now });
    expect(r.intent).toBe('shipping');
    expect(r.confidence).toBeGreaterThan(0.9);
  });

  it('detects just commit', () => {
    const recent = [
      bash('git status'),
      bash('git diff'),
      bash('git commit -m "msg"'),
    ];
    const r = detectIntent({ recentTools: recent, now });
    expect(r.intent).toBe('shipping');
  });
});

describe('detectIntent - testing', () => {
  it('detects test runs', () => {
    const recent = [
      bash('npx vitest run foo.test.js'),
      bash('npx vitest run bar.test.js'),
      edit('plugins/4ge/lib/foo.test.js'),
    ];
    const r = detectIntent({ recentTools: recent, now });
    expect(r.intent).toBe('testing');
  });
});

describe('detectIntent - debugging', () => {
  it('detects repeated reads of same file + targeted fix', () => {
    const recent = [
      read('src/broken.js'),
      grep(),
      read('src/broken.js'),
      read('src/broken.js'),
      edit('src/broken.js'),
    ];
    const r = detectIntent({ recentTools: recent, now });
    expect(r.intent).toBe('debugging');
  });

  it('detects multiple read→edit pairs', () => {
    const recent = [
      read('a.js'), edit('a.js'),
      read('b.js'), edit('b.js'),
      read('c.js'), edit('c.js'),
    ];
    const r = detectIntent({ recentTools: recent, now });
    expect(r.intent).toBe('debugging');
  });
});

describe('detectIntent - exploring', () => {
  it('detects broad search with no edits', () => {
    const recent = [
      glob(), glob(),
      grep(), grep(),
      read('a.js'), read('b.js'), read('c.js'), read('d.js'), read('e.js'),
    ];
    const r = detectIntent({ recentTools: recent, now });
    expect(r.intent).toBe('exploring');
  });

  it('detects many reads with few edits', () => {
    const recent = [
      read('a.js'), read('b.js'), read('c.js'),
      read('d.js'), read('e.js'), read('f.js'),
      edit('g.js'),
    ];
    const r = detectIntent({ recentTools: recent, now });
    expect(r.intent).toBe('exploring');
  });
});

describe('detectIntent - refactoring', () => {
  it('detects multiple replace_all edits', () => {
    const recent = [
      edit('a.js', true),
      edit('b.js', true),
      edit('c.js', false),
    ];
    const r = detectIntent({ recentTools: recent, now });
    expect(r.intent).toBe('refactoring');
  });

  it('detects many edits in same directory', () => {
    const recent = [
      edit('src/a.js'), edit('src/b.js'), edit('src/c.js'),
      edit('src/d.js'), edit('src/e.js'), edit('src/f.js'),
    ];
    const r = detectIntent({ recentTools: recent, now });
    expect(r.intent).toBe('refactoring');
  });
});

describe('detectIntent - reviewing', () => {
  it('detects read + grep + git log with no edits', () => {
    const recent = [
      bash('git log --oneline'),
      bash('git diff main'),
      read('src/a.js'),
      grep(),
      read('src/b.js'),
      read('src/c.js'),
    ];
    const r = detectIntent({ recentTools: recent, now });
    expect(r.intent).toBe('reviewing');
  });

  it('does NOT classify as reviewing when any edit is present', () => {
    const recent = [
      bash('git log'),
      bash('gh pr view'),
      read('a.js'),
      edit('a.js'),
    ];
    const r = detectIntent({ recentTools: recent, now });
    expect(r.intent).not.toBe('reviewing');
  });
});

describe('detectIntent - unknown', () => {
  it('returns unknown when no pattern is strong enough', () => {
    const recent = [ev('Unknown')];
    const r = detectIntent({ recentTools: recent, now });
    expect(['unknown', 'idle']).toContain(r.intent);
  });
});

describe('detectIntent - return shape', () => {
  it('always returns intent, confidence, reason', () => {
    const r = detectIntent({ recentTools: [], now });
    expect(r).toHaveProperty('intent');
    expect(r).toHaveProperty('confidence');
    expect(r).toHaveProperty('reason');
    expect(typeof r.confidence).toBe('number');
  });
});
