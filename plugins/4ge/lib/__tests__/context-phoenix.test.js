import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';

const { compact } = require('../context-phoenix.cjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-phoenix-test-'));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('context-phoenix compact()', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    // context-phoenix loads dcd-extract.cjs which calls git; we can safely let
    // it fall back to empty strings for git commands (no git repo in tmpDir).
  });

  afterEach(() => {
    cleanup(tmpDir);
    vi.restoreAllMocks();
  });

  it('returns the expected shape: { outputPath, wordCount }', () => {
    const result = compact({ projectRoot: tmpDir });
    expect(result).toBeDefined();
    expect(typeof result.outputPath).toBe('string');
    expect(typeof result.wordCount).toBe('number');
  });

  it('outputPath is a valid file path within _runs/', () => {
    const result = compact({ projectRoot: tmpDir });
    expect(result.outputPath).toContain('decision-chain-latest.md');
    expect(path.isAbsolute(result.outputPath)).toBe(true);
    // writeDCD creates the file
    expect(fs.existsSync(result.outputPath)).toBe(true);
  });

  it('wordCount is a non-negative integer', () => {
    const result = compact({ projectRoot: tmpDir });
    expect(Number.isInteger(result.wordCount)).toBe(true);
    expect(result.wordCount).toBeGreaterThanOrEqual(0);
  });

  it('accepts optional sessionId and trigger without throwing', () => {
    expect(() => compact({ projectRoot: tmpDir, sessionId: 'test-sid', trigger: 'test' })).not.toThrow();
  });

  it('defaults projectRoot to process.cwd() when opts omitted', () => {
    // Should not throw; will use real cwd which is a valid git repo
    expect(() => compact()).not.toThrow();
  });
});
