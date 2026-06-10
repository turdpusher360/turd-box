// plugins/4ge/__tests__/hook-auditor.test.js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

// Use createRequire so fs and the CJS module share the same singleton.
// vi.mock('fs') does NOT intercept CJS require('fs') — spyOn is required.
const cjsRequire = createRequire(import.meta.url);
const fs = cjsRequire('fs');
const { findUnwiredHooks, findOrphanedWirings, auditHooks } = cjsRequire('../lib/hook-auditor.cjs');

describe('hook-auditor', () => {
  let existsSyncSpy;
  let readFileSyncSpy;
  let readdirSyncSpy;

  beforeEach(() => {
    existsSyncSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    readFileSyncSpy = vi.spyOn(fs, 'readFileSync').mockReturnValue('{}');
    readdirSyncSpy = vi.spyOn(fs, 'readdirSync').mockReturnValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('finds hooks in .claude/hooks/ not wired in settings.json', () => {
    readdirSyncSpy.mockReturnValue(['hook-a.cjs', 'hook-b.cjs', 'hook-utils.cjs']);
    readFileSyncSpy.mockReturnValue(JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ command: 'node .claude/hooks/hook-a.cjs' }] }] },
    }));

    const unwired = findUnwiredHooks('/fake');
    expect(unwired).toContain('hook-b.cjs');
    expect(unwired).not.toContain('hook-a.cjs');
    expect(unwired).not.toContain('hook-utils.cjs'); // shared util excluded
  });

  it('excludes known shared utility files from unwired list', () => {
    readdirSyncSpy.mockReturnValue([
      'hook-utils.cjs',
      'memory-capture-utils.cjs',
      'ollama-utils.cjs',
    ]);
    readFileSyncSpy.mockReturnValue(JSON.stringify({ hooks: {} }));

    const unwired = findUnwiredHooks('/fake');
    expect(unwired).toEqual([]);
  });

  // The existsSync mock must distinguish between the settings.json / hooks dir
  // (which exist) and the individual missing hook file (which does not).
  it('finds wired entries pointing to missing files', () => {
    existsSyncSpy.mockImplementation((p) => {
      const s = String(p);
      if (s.endsWith('settings.json')) return true;
      if (s.endsWith('.cjs')) return false;       // individual hook files missing
      return s.includes('.claude/hooks');          // hooks directory exists
    });
    readFileSyncSpy.mockReturnValue(JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ command: 'node .claude/hooks/missing-hook.cjs' }] }] },
    }));

    const orphaned = findOrphanedWirings('/fake');
    expect(orphaned).toContain('missing-hook.cjs');
  });

  it('returns empty arrays when no issues found', () => {
    readdirSyncSpy.mockReturnValue(['hook-a.cjs']);
    readFileSyncSpy.mockReturnValue(JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ command: 'node .claude/hooks/hook-a.cjs' }] }] },
    }));
    existsSyncSpy.mockReturnValue(true);

    const result = auditHooks('/fake');
    expect(result.unwired).toEqual([]);
    expect(result.orphaned).toEqual([]);
  });

  it('auditHooks returns combined results with both properties', () => {
    readdirSyncSpy.mockReturnValue(['hook-a.cjs', 'hook-b.cjs']);
    readFileSyncSpy.mockReturnValue(JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ command: 'node .claude/hooks/hook-a.cjs' }] }] },
    }));

    const result = auditHooks('/fake');
    expect(result).toHaveProperty('unwired');
    expect(result).toHaveProperty('orphaned');
  });

  it('handles missing settings.json gracefully', () => {
    // Hooks directory exists, but settings.json does not.
    // All non-utility hooks should appear as unwired.
    existsSyncSpy.mockImplementation((p) => {
      const s = String(p);
      if (s.endsWith('settings.json')) return false;
      return true; // hooks dir exists
    });
    readdirSyncSpy.mockReturnValue(['hook-a.cjs']);

    const result = auditHooks('/fake');
    expect(result.unwired).toContain('hook-a.cjs');
  });
});
