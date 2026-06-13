import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

// CJS require for the hook module (CommonJS)
const require = createRequire(import.meta.url);
const {
  extractCommandToken,
  normalizeError,
  categorize,
  buildPatternKey,
} = require('../feedback-queue-capture.cjs');

// ─── Unit tests ────────────────────────────────────────────────────────────

describe('extractCommandToken', () => {
  it('returns basename of absolute path command', () => {
    expect(extractCommandToken('/usr/bin/node foo.js')).toBe('node');
  });

  it('strips leading VAR=value assignments', () => {
    expect(extractCommandToken('FOO=bar BAZ=qux git status')).toBe('git');
  });

  it('handles plain command token', () => {
    expect(extractCommandToken('npx vitest run')).toBe('npx');
  });

  it('returns "unknown" for empty string', () => {
    expect(extractCommandToken('')).toBe('unknown');
  });

  it('caps at 40 chars', () => {
    const long = 'a'.repeat(50) + ' arg';
    expect(extractCommandToken(long).length).toBeLessThanOrEqual(40);
  });
});

describe('normalizeError', () => {
  it('strips Unix absolute paths to basename', () => {
    const result = normalizeError('Error at /home/user/project/src/index.cjs');
    expect(result).not.toContain('/home/user/project/src/');
    expect(result).toContain('index.cjs');
  });

  it('strips epoch numbers', () => {
    const result = normalizeError('pid 1234567890 exited');
    expect(result).toContain('<epoch>');
    expect(result).not.toContain('1234567890');
  });

  it('strips hex hashes', () => {
    const result = normalizeError('commit abc1234 failed');
    expect(result).toContain('<hash>');
  });

  it('collapses digits to N', () => {
    const result = normalizeError('exit code 127 on line 42');
    expect(result).not.toMatch(/\b(?:127|42)\b/);
  });

  it('handles empty/null', () => {
    expect(normalizeError('')).toBe('');
    expect(normalizeError(null)).toBe('');
    expect(normalizeError(undefined)).toBe('');
  });

  it('produces stable output for same logical error across different runs', () => {
    const err1 = 'Cannot find module /home/alice/project/lib/utils.cjs at pid 1234567890';
    const err2 = 'Cannot find module /home/bob/other/lib/utils.cjs at pid 9876543210';
    expect(normalizeError(err1)).toBe(normalizeError(err2));
  });
});

describe('categorize', () => {
  it('returns "shell-escape" for permission denied', () => {
    expect(categorize('rm', normalizeError('EACCES: permission denied'))).toBe('shell-escape');
  });

  it('returns "hook-crash" for hook-related errors', () => {
    expect(categorize('node .claude/hooks/myhook.cjs', 'MODULE_NOT_FOUND')).toBe('hook-crash');
  });

  it('returns "tool-misuse" for bad option', () => {
    expect(categorize('git', normalizeError('unknown flag --bad-option'))).toBe('tool-misuse');
  });

  it('returns "unknown" for unrecognized errors', () => {
    expect(categorize('some-cmd', 'something went sideways')).toBe('unknown');
  });
});

describe('buildPatternKey', () => {
  it('combines token and first line of normalized error', () => {
    const key = buildPatternKey('node', 'MODULE_NOT_FOUND cannot find lib');
    expect(key).toBe('node:MODULE_NOT_FOUND cannot find lib');
  });

  it('truncates first line to 80 chars', () => {
    const longLine = 'x'.repeat(100);
    const key = buildPatternKey('cmd', longLine);
    const errorPart = key.split(':').slice(1).join(':');
    expect(errorPart.length).toBeLessThanOrEqual(80);
  });

  it('uses only first line of multiline error', () => {
    // buildPatternKey receives already-normalized input from the hook;
    // pass a pre-normalized string to test the line-splitting behavior directly.
    const key = buildPatternKey('npm', 'error line N\nerror line N\nerror line N');
    expect(key).toBe('npm:error line N');
  });
});

// ─── Integration smoke test ────────────────────────────────────────────────

describe('feedback-queue-capture hook smoke test', () => {
  let tempDir;
  let tempQueue;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r09-test-'));
    tempQueue = path.join(tempDir, 'feedback-queue.jsonl');
  });

  afterEach(() => {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('appends a queue entry when tool_name is Bash', () => {
    const payload = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'git push origin main' },
      error: 'EACCES: permission denied on /home/user/.ssh/known_hosts',
      exit_code: 1,
      is_interrupt: false,
    });

    const hookPath = path.join(process.cwd(), 'plugins', '4ge', 'hooks', 'feedback-queue-capture.cjs');
    const result = spawnSync(process.execPath, [hookPath], {
      input: payload,
      encoding: 'utf8',
      timeout: 5000,
      env: {
        ...process.env,
        FEEDBACK_QUEUE_FILE: tempQueue,
      },
    });

    expect(result.status, `hook exited non-zero: stderr=${result.stderr}`).toBe(0);
    expect(fs.existsSync(tempQueue), 'queue file should have been created').toBe(true);

    const lines = fs.readFileSync(tempQueue, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(1);

    const entry = JSON.parse(lines[0]);
    expect(entry.tool).toBe('Bash');
    expect(entry.pattern_key).toBeTruthy();
    expect(entry.pattern_key).toContain('git:');
    expect(entry.category).toBe('shell-escape');
    expect(typeof entry.ts).toBe('string');
    expect(entry.command).toContain('git push');
  });

  it('does NOT append when tool_name is not Bash', () => {
    const payload = JSON.stringify({
      tool_name: 'Read',
      error: 'File not found',
      exit_code: null,
      is_interrupt: false,
    });

    const hookPath = path.join(process.cwd(), 'plugins', '4ge', 'hooks', 'feedback-queue-capture.cjs');
    const result = spawnSync(process.execPath, [hookPath], {
      input: payload,
      encoding: 'utf8',
      timeout: 5000,
      env: {
        ...process.env,
        FEEDBACK_QUEUE_FILE: tempQueue,
      },
    });

    expect(result.status).toBe(0);
    expect(fs.existsSync(tempQueue)).toBe(false);
  });

  it('accumulates multiple entries — dedup via pattern_key at read time', () => {
    const hookPath = path.join(process.cwd(), 'plugins', '4ge', 'hooks', 'feedback-queue-capture.cjs');
    const payload = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'npm install' },
      error: 'ENOENT: no such file or directory package.json',
      exit_code: 1,
    });

    // Fire 3 times to simulate repeated failures
    for (let i = 0; i < 3; i++) {
      const result = spawnSync(process.execPath, [hookPath], {
        input: payload,
        encoding: 'utf8',
        timeout: 5000,
        env: {
          ...process.env,
          FEEDBACK_QUEUE_FILE: tempQueue,
        },
      });
      expect(result.status).toBe(0);
    }

    const lines = fs.readFileSync(tempQueue, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(3);

    const entries = lines.map(l => JSON.parse(l));
    const keys = entries.map(e => e.pattern_key);
    // All 3 entries should have the same pattern_key (stable normalization)
    expect(new Set(keys).size).toBe(1);
  });
});
