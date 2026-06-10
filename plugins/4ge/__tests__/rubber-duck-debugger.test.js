// plugins/4ge/__tests__/rubber-duck-debugger.test.js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const cjsRequire = createRequire(import.meta.url);
const fs = cjsRequire('fs');
const {
  normalizeError,
  detectConsecutiveFailures,
  generateSocraticPrompt,
  WINDOW_MS,
} = cjsRequire('../hooks/rubber-duck-debugger.cjs');

describe('rubber-duck-debugger', () => {
  let appendFileSyncSpy;

  beforeEach(() => {
    appendFileSyncSpy = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes error messages by removing line numbers and paths', () => {
    const msg1 = "Error at /home/user/project/src/file.ts:42:10: Cannot find module 'foo'";
    const msg2 = "Error at /home/user/project/src/other.ts:99:3: Cannot find module 'foo'";
    expect(normalizeError(msg1)).toBe(normalizeError(msg2));
  });

  it('normalizes error messages by removing timestamps', () => {
    const msg1 = '2026-04-01T12:00:00Z TypeError: x is not a function';
    const msg2 = '2026-04-02T08:30:00Z TypeError: x is not a function';
    expect(normalizeError(msg1)).toBe(normalizeError(msg2));
  });

  it('detects 3+ consecutive same-error within 5min window', () => {
    const now = Date.now();
    const failures = [
      { timestamp: new Date(now - 4 * 60000).toISOString(), error: 'TypeError: x is not a function', tool: 'Bash' },
      { timestamp: new Date(now - 3 * 60000).toISOString(), error: 'TypeError: x is not a function', tool: 'Bash' },
      { timestamp: new Date(now - 2 * 60000).toISOString(), error: 'TypeError: x is not a function', tool: 'Bash' },
    ];
    const result = detectConsecutiveFailures(failures, now);
    expect(result.triggered).toBe(true);
    expect(result.count).toBe(3);
  });

  it('does not trigger for failures outside 5min window', () => {
    const now = Date.now();
    const failures = [
      { timestamp: new Date(now - 10 * 60000).toISOString(), error: 'TypeError: x is not a function', tool: 'Bash' },
      { timestamp: new Date(now - 9 * 60000).toISOString(), error: 'TypeError: x is not a function', tool: 'Bash' },
      { timestamp: new Date(now - 8 * 60000).toISOString(), error: 'TypeError: x is not a function', tool: 'Bash' },
    ];
    const result = detectConsecutiveFailures(failures, now);
    expect(result.triggered).toBe(false);
  });

  it('does not trigger for different errors', () => {
    const now = Date.now();
    const failures = [
      { timestamp: new Date(now - 2 * 60000).toISOString(), error: 'TypeError: x is not a function', tool: 'Bash' },
      { timestamp: new Date(now - 1 * 60000).toISOString(), error: 'ReferenceError: y is not defined', tool: 'Bash' },
      { timestamp: new Date(now - 30000).toISOString(), error: 'TypeError: z.map is not a function', tool: 'Bash' },
    ];
    const result = detectConsecutiveFailures(failures, now);
    expect(result.triggered).toBe(false);
  });

  it('generates a Socratic prompt with context', () => {
    const prompt = generateSocraticPrompt('TypeError: x is not a function', 3);
    expect(prompt).toContain('same error 3 times');
    expect(prompt).toContain('assumptions');
  });
});
