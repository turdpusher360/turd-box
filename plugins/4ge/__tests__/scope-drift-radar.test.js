// plugins/4ge/__tests__/scope-drift-radar.test.js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

// AUDIT FIX (P0 F2): forge-scope-check.cjs uses require('node:fs').
// In Node 18+, require('node:fs') and require('fs') share the same module cache
// singleton, so spying on either intercepts calls via both specifiers.
// We load 'node:fs' explicitly to match the module's own require call.
const cjsRequire = createRequire(import.meta.url);
const fs = cjsRequire('node:fs');

const {
  checkScopeDrift,
  incrementDriftCounter,
  getDriftCount,
  DRIFT_THRESHOLD,
} = cjsRequire('../hooks/forge-scope-check.cjs');

describe('scope-drift-radar', () => {
  let appendFileSyncSpy;

  beforeEach(() => {
    // Stub appendFileSync so JSONL logging doesn't hit disk during tests
    appendFileSyncSpy = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('allows file within assigned scope', () => {
    const session = { teammates: [{ name: 'impl', scope: ['src/'] }] };
    const result = checkScopeDrift('src/components/Button.tsx', 'impl', session);
    expect(result.inScope).toBe(true);
  });

  it('detects file outside assigned scope', () => {
    const session = { teammates: [{ name: 'impl', scope: ['src/'] }] };
    const result = checkScopeDrift('lib/os/kernel.cjs', 'impl', session);
    expect(result.inScope).toBe(false);
  });

  it('allows any file when no scope assigned', () => {
    const session = { teammates: [{ name: 'impl' }] };
    const result = checkScopeDrift('anywhere/file.ts', 'impl', session);
    expect(result.inScope).toBe(true);
  });

  it('increments drift counter per teammate', () => {
    const counters = {};
    incrementDriftCounter(counters, 'impl');
    incrementDriftCounter(counters, 'impl');
    expect(getDriftCount(counters, 'impl')).toBe(2);
  });

  it('triggers escalation after 3 violations', () => {
    const counters = {};
    for (let i = 0; i < DRIFT_THRESHOLD; i++) {
      incrementDriftCounter(counters, 'impl');
    }
    expect(getDriftCount(counters, 'impl')).toBe(DRIFT_THRESHOLD);
  });

  it('logs drift to JSONL', () => {
    const session = { teammates: [{ name: 'impl', scope: ['src/'] }] };
    checkScopeDrift('lib/file.ts', 'impl', session);
    // appendFileSync called for JSONL logging when file is out of scope
    expect(appendFileSyncSpy).toHaveBeenCalled();
  });
});
