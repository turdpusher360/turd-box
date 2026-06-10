import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const { writeFileAtomic, appendFileAtomic } = require('../atomic-write.cjs');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-write-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
});

// ── writeFileAtomic ───────────────────────────────────────────────────────────

describe('writeFileAtomic — basic write', () => {
  it('writes content to the target path', () => {
    const target = path.join(tmpDir, 'out.txt');
    writeFileAtomic(target, 'hello world');
    expect(fs.readFileSync(target, 'utf8')).toBe('hello world');
  });

  it('overwrites an existing file', () => {
    const target = path.join(tmpDir, 'out.txt');
    fs.writeFileSync(target, 'original', 'utf8');
    writeFileAtomic(target, 'updated');
    expect(fs.readFileSync(target, 'utf8')).toBe('updated');
  });

  it('handles Buffer content', () => {
    const target = path.join(tmpDir, 'buf.bin');
    const buf = Buffer.from([0x68, 0x69]); // "hi"
    writeFileAtomic(target, buf, { encoding: 'binary' });
    expect(fs.existsSync(target)).toBe(true);
  });

  it('JSON round-trip — writes and reads valid JSON', () => {
    const target = path.join(tmpDir, 'state.json');
    const obj = { lastRender: 1234567890, events: { commit: 111 } };
    writeFileAtomic(target, JSON.stringify(obj));
    const read = JSON.parse(fs.readFileSync(target, 'utf8'));
    expect(read.lastRender).toBe(1234567890);
    expect(read.events.commit).toBe(111);
  });

  it('leaves no .tmp file after successful write', () => {
    const target = path.join(tmpDir, 'clean.txt');
    writeFileAtomic(target, 'data');
    const tmpFiles = fs.readdirSync(tmpDir).filter(f => f.includes('.tmp'));
    expect(tmpFiles).toHaveLength(0);
  });

  it('does not throw when target directory does not exist', () => {
    const missing = path.join(tmpDir, 'nonexistent', 'file.json');
    // Should swallow the error (mkdir is caller's responsibility)
    expect(() => writeFileAtomic(missing, '{}')).not.toThrow();
  });
});

// ── writeFileAtomic — EPERM retry simulation ─────────────────────────────────

describe('writeFileAtomic — EPERM retry simulation', () => {
  it('retries once on EPERM and succeeds if second rename works', () => {
    const target = path.join(tmpDir, 'eperm-retry.json');

    let callCount = 0;
    const origRename = fs.renameSync.bind(fs);

    // Spy on renameSync: throw EPERM on first call, succeed on second
    vi.spyOn(fs, 'renameSync').mockImplementation((...args) => {
      callCount++;
      if (callCount === 1) {
        const err = new Error('EPERM: operation not permitted');
        err.code = 'EPERM';
        throw err;
      }
      return origRename(...args);
    });

    writeFileAtomic(target, '{"retried":true}');

    expect(callCount).toBe(2);
    // After second rename succeeds, file should exist with correct content
    expect(fs.readFileSync(target, 'utf8')).toBe('{"retried":true}');
  });

  it('falls back to direct write when both rename attempts fail with EPERM', () => {
    const target = path.join(tmpDir, 'eperm-fallback.json');

    const origWriteFileSync = fs.writeFileSync.bind(fs);
    let renameCallCount = 0;
    let writeCallCount = 0;

    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      renameCallCount++;
      const err = new Error('EPERM');
      err.code = 'EPERM';
      throw err;
    });

    vi.spyOn(fs, 'writeFileSync').mockImplementation((p, data, enc) => {
      // Only intercept the fallback call to target (not the tmp write)
      if (!String(p).includes('.tmp')) {
        writeCallCount++;
        return origWriteFileSync(p, data, enc);
      }
      return origWriteFileSync(p, data, enc);
    });

    writeFileAtomic(target, '{"fallback":true}');

    // renameSync called twice (original + retry), both EPERM
    expect(renameCallCount).toBe(2);
    // File should exist due to fallback direct write
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('{"fallback":true}');
  });

  it('does not throw when all write attempts fail', () => {
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      const err = new Error('ENOSPC: no space left');
      err.code = 'ENOSPC';
      throw err;
    });
    const target = path.join(tmpDir, 'nospace.json');
    // Must never throw — swallows all errors
    expect(() => writeFileAtomic(target, '{}')).not.toThrow();
  });
});

// ── writeFileAtomic — non-EPERM rename failure ────────────────────────────────

describe('writeFileAtomic — non-EPERM rename failure (EXDEV)', () => {
  it('falls back to direct write on EXDEV (cross-device rename)', () => {
    const target = path.join(tmpDir, 'exdev.json');

    const origWriteFileSync = fs.writeFileSync.bind(fs);
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      const err = new Error('EXDEV: cross-device link not permitted');
      err.code = 'EXDEV';
      throw err;
    });

    // writeFileSync: let tmp write through, track fallback call
    let writeCallToTarget = 0;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((p, data, enc) => {
      if (!String(p).includes('.tmp')) writeCallToTarget++;
      return origWriteFileSync(p, data, enc);
    });

    writeFileAtomic(target, '{"exdev":true}');

    expect(writeCallToTarget).toBeGreaterThan(0);
    expect(fs.existsSync(target)).toBe(true);
  });
});

// ── appendFileAtomic ──────────────────────────────────────────────────────────

describe('appendFileAtomic', () => {
  it('appends content to a new file', () => {
    const target = path.join(tmpDir, 'app.txt');
    appendFileAtomic(target, 'line1\n');
    expect(fs.readFileSync(target, 'utf8')).toBe('line1\n');
  });

  it('appends to an existing file without overwriting', () => {
    const target = path.join(tmpDir, 'app.txt');
    appendFileAtomic(target, 'line1\n');
    appendFileAtomic(target, 'line2\n');
    const content = fs.readFileSync(target, 'utf8');
    expect(content).toBe('line1\nline2\n');
  });

  it('does not throw on I/O failure', () => {
    const badPath = path.join(tmpDir, 'missing-dir', 'app.txt');
    expect(() => appendFileAtomic(badPath, 'data')).not.toThrow();
  });
});
