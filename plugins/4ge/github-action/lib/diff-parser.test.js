import { describe, it, expect } from 'vitest';
import { parsePatch, buildLineIndex, isAnchorable } from './diff-parser.js';

describe('parsePatch', () => {
  it('returns an empty set for missing or empty patches', () => {
    expect(parsePatch(undefined).size).toBe(0);
    expect(parsePatch(null).size).toBe(0);
    expect(parsePatch('').size).toBe(0);
  });

  it('marks added lines as commentable on the new-file side', () => {
    // New file starts at line 10; one context line, two additions.
    const patch = ['@@ -10,1 +10,3 @@', ' const a = 1;', '+const b = 2;', '+const c = 3;'].join('\n');
    const lines = parsePatch(patch);
    expect([...lines].sort((x, y) => x - y)).toEqual([10, 11, 12]);
  });

  it('does not advance the new-file counter on removed lines', () => {
    // -20,2 +20,1: two old lines, one new. The removal sits between context.
    const patch = ['@@ -20,3 +20,2 @@', ' keep1', '-removed', '+added', ' keep2'].join('\n');
    const lines = parsePatch(patch);
    // RIGHT side: 20 (keep1), 21 (added), 22 (keep2). The removed line never counts.
    expect([...lines].sort((x, y) => x - y)).toEqual([20, 21, 22]);
  });

  it('handles multiple hunks in a single patch', () => {
    const patch = [
      '@@ -1,2 +1,2 @@',
      ' line1',
      '+line2new',
      '@@ -50,1 +60,2 @@',
      ' line60',
      '+line61',
    ].join('\n');
    const lines = parsePatch(patch);
    expect([...lines].sort((x, y) => x - y)).toEqual([1, 2, 60, 61]);
  });

  it('ignores the no-newline-at-end-of-file marker', () => {
    const patch = ['@@ -1,1 +1,1 @@', '-old', '+new', '\\ No newline at end of file'].join('\n');
    const lines = parsePatch(patch);
    expect([...lines]).toEqual([1]);
  });

  it('parses single-line hunk headers without counts', () => {
    const patch = ['@@ -1 +1 @@', '+only'].join('\n');
    expect([...parsePatch(patch)]).toEqual([1]);
  });

  it('skips file-metadata lines before the first hunk header', () => {
    const patch = ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1,1 +1,2 @@', ' a', '+b'].join('\n');
    expect([...parsePatch(patch)].sort((x, y) => x - y)).toEqual([1, 2]);
  });
});

describe('buildLineIndex', () => {
  it('returns an empty map for non-array input', () => {
    expect(buildLineIndex(undefined).size).toBe(0);
    expect(buildLineIndex(null).size).toBe(0);
  });

  it('indexes commentable lines per file path', () => {
    const files = [
      { filename: 'src/a.js', patch: ['@@ -1,1 +1,2 @@', ' x', '+y'].join('\n') },
      { filename: 'src/b.js', patch: ['@@ -5,1 +5,1 @@', '+z'].join('\n') },
    ];
    const index = buildLineIndex(files);
    expect([...index.get('src/a.js')].sort((x, y) => x - y)).toEqual([1, 2]);
    expect([...index.get('src/b.js')]).toEqual([5]);
  });

  it('yields an empty set for binary files with no patch', () => {
    const index = buildLineIndex([{ filename: 'logo.png', status: 'added' }]);
    expect(index.get('logo.png').size).toBe(0);
  });

  it('skips malformed file entries', () => {
    const index = buildLineIndex([null, {}, { filename: 42 }]);
    expect(index.size).toBe(0);
  });
});

describe('isAnchorable', () => {
  const index = buildLineIndex([
    { filename: 'src/a.js', patch: ['@@ -1,1 +1,2 @@', ' x', '+y'].join('\n') },
  ]);

  it('is true for a line present in the diff', () => {
    expect(isAnchorable(index, 'src/a.js', 1)).toBe(true);
    expect(isAnchorable(index, 'src/a.js', 2)).toBe(true);
  });

  it('is false for a line outside the diff', () => {
    expect(isAnchorable(index, 'src/a.js', 99)).toBe(false);
  });

  it('is false for files not in the diff', () => {
    expect(isAnchorable(index, 'src/missing.js', 1)).toBe(false);
  });

  it('rejects invalid line numbers and paths', () => {
    expect(isAnchorable(index, 'src/a.js', 0)).toBe(false);
    expect(isAnchorable(index, 'src/a.js', -1)).toBe(false);
    expect(isAnchorable(index, 'src/a.js', 1.5)).toBe(false);
    expect(isAnchorable(index, '', 1)).toBe(false);
  });
});
