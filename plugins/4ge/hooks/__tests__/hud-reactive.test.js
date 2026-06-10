import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

// ── Real temp-dir approach for throttle state ────────────────────────────────
// vi.mock('fs') doesn't reliably intercept CJS require('fs') across module
// boundaries.  We instead point the throttle file at a real temp dir so
// recordRender/shouldThrottle exercise real I/O without touching _runs/.

let tmpDir;
let originalCwd;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-reactive-test-'));
  originalCwd = process.cwd();
  // The module resolves THROTTLE_FILE via process.cwd() at load time, so we
  // must patch cwd() BEFORE requiring the module.
  vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  // Clean up temp dir
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
});

// ── Module loader ─────────────────────────────────────────────────────────────
function requireFresh() {
  const modPath = path.resolve(__dirname, '../hud-reactive.cjs');
  delete require.cache[modPath];
  // hook-utils.cjs must also be cache-busted so its self-destruct timer re-arms
  const hookUtilsPath = path.resolve(__dirname, '../hook-utils.cjs');
  delete require.cache[hookUtilsPath];
  return require(modPath);
}

// ── detectEvent ───────────────────────────────────────────────────────────────
describe('detectEvent', () => {

  // ── commit ──────────────────────────────────────────────────────────────────
  describe('commit event', () => {
    it('returns "commit" for Bash git commit command', () => {
      const { detectEvent } = requireFresh();
      expect(detectEvent({
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "feat: add tests"' },
        tool_response: 'main 1234abc] feat: add tests',
      })).toBe('commit');
    });

    it('does NOT return "commit" when output says nothing to commit', () => {
      const { detectEvent } = requireFresh();
      const result = detectEvent({
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "empty"' },
        tool_response: 'On branch main\nnothing to commit, working tree clean',
      });
      expect(result).not.toBe('commit');
    });

    it('does NOT classify non-git bash commands as commit', () => {
      const { detectEvent } = requireFresh();
      expect(detectEvent({
        tool_name: 'Bash',
        tool_input: { command: 'echo hello' },
        tool_response: 'hello',
      })).toBeNull();
    });
  });

  // ── test-pass ────────────────────────────────────────────────────────────────
  describe('test-pass event', () => {
    it('returns "test-pass" when vitest output shows 0 failed', () => {
      const { detectEvent } = requireFresh();
      expect(detectEvent({
        tool_name: 'Bash',
        tool_input: { command: 'npx vitest run' },
        tool_response: 'Tests  450 passed | 0 failed',
      })).toBe('test-pass');
    });

    it('returns "test-pass" when jest output shows Tests passed', () => {
      const { detectEvent } = requireFresh();
      expect(detectEvent({
        tool_name: 'Bash',
        tool_input: { command: 'npx jest --ci' },
        tool_response: 'Tests  12 passed\nTest Suites: 3 passed',
      })).toBe('test-pass');
    });

    it('returns "test-pass" for vitest output with "Tests  X passed" pattern', () => {
      const { detectEvent } = requireFresh();
      expect(detectEvent({
        tool_name: 'Bash',
        tool_input: { command: 'npx vitest run src/' },
        tool_response: 'Tests  100 passed (100)',
      })).toBe('test-pass');
    });
  });

  // ── test-fail ────────────────────────────────────────────────────────────────
  describe('test-fail event', () => {
    it('returns "test-fail" when vitest output contains failed count > 0', () => {
      const { detectEvent } = requireFresh();
      expect(detectEvent({
        tool_name: 'Bash',
        tool_input: { command: 'npx vitest run' },
        tool_response: 'Tests  3 failed | 97 passed',
      })).toBe('test-fail');
    });

    it('does NOT return "test-fail" when failed count is 0', () => {
      const { detectEvent } = requireFresh();
      // "0 failed" is present — should be test-pass path
      const result = detectEvent({
        tool_name: 'Bash',
        tool_input: { command: 'npx vitest run' },
        tool_response: 'Tests  450 passed | 0 failed',
      });
      expect(result).toBe('test-pass');
    });

    it('does NOT emit test-fail for non-vitest/jest bash commands that mention "failed"', () => {
      const { detectEvent } = requireFresh();
      const result = detectEvent({
        tool_name: 'Bash',
        tool_input: { command: 'npm install' },
        tool_response: '1 package install failed',
      });
      // no vitest/jest in command — falls through
      expect(result).not.toBe('test-fail');
    });
  });

  // ── forge-phase ───────────────────────────────────────────────────────────────
  describe('forge-phase event', () => {
    it('returns "forge-phase" for TaskUpdate with forge in subject', () => {
      const { detectEvent } = requireFresh();
      expect(detectEvent({
        tool_name: 'TaskUpdate',
        tool_input: { subject: 'Forge Phase 5 — execute plan' },
        tool_response: '',
      })).toBe('forge-phase');
    });

    it('returns "forge-phase" for TaskCreate with P5: in subject', () => {
      const { detectEvent } = requireFresh();
      expect(detectEvent({
        tool_name: 'TaskCreate',
        tool_input: { subject: 'P5: ship the feature' },
        tool_response: '',
      })).toBe('forge-phase');
    });

    it('returns "forge-phase" for Agent output matching forge-session', () => {
      const { detectEvent } = requireFresh();
      expect(detectEvent({
        tool_name: 'Agent',
        tool_input: {},
        tool_response: 'forge-session started for implementation',
      })).toBe('forge-phase');
    });

    it('returns "forge-phase" for Task output matching phase keyword', () => {
      const { detectEvent } = requireFresh();
      expect(detectEvent({
        tool_name: 'Task',
        tool_input: {},
        tool_response: 'Completed phase 3 of the plan',
      })).toBe('forge-phase');
    });

    it('does NOT return "forge-phase" for TaskUpdate without forge/P5', () => {
      const { detectEvent } = requireFresh();
      const result = detectEvent({
        tool_name: 'TaskUpdate',
        tool_input: { subject: 'Review code quality' },
        tool_response: '',
      });
      expect(result).not.toBe('forge-phase');
    });
  });

  // ── badge-earned ──────────────────────────────────────────────────────────────
  describe('badge-earned event', () => {
    it('returns "badge-earned" for Write to badges.json', () => {
      const { detectEvent } = requireFresh();
      expect(detectEvent({
        tool_name: 'Write',
        tool_input: { file_path: '/project/_runs/badges.json' },
        tool_response: '',
      })).toBe('badge-earned');
    });

    it('returns "badge-earned" for Edit to badges.json', () => {
      const { detectEvent } = requireFresh();
      expect(detectEvent({
        tool_name: 'Edit',
        tool_input: { file_path: '/project/_runs/badges.json' },
        tool_response: '',
      })).toBe('badge-earned');
    });

    it('does NOT return "badge-earned" for Write to other JSON files', () => {
      const { detectEvent } = requireFresh();
      const result = detectEvent({
        tool_name: 'Write',
        tool_input: { file_path: '/project/package.json' },
        tool_response: '',
      });
      expect(result).not.toBe('badge-earned');
    });
  });

  // ── export ────────────────────────────────────────────────────────────────────
  describe('export event', () => {
    it('returns "export" for Write to a *-brief.md file', () => {
      const { detectEvent } = requireFresh();
      expect(detectEvent({
        tool_name: 'Write',
        tool_input: { file_path: '/docs/session-brief.md' },
        tool_response: '',
      })).toBe('export');
    });

    it('returns "export" for Edit to a *-brief.md file', () => {
      const { detectEvent } = requireFresh();
      expect(detectEvent({
        tool_name: 'Edit',
        tool_input: { file_path: '/docs/handoff-brief.md' },
        tool_response: '',
      })).toBe('export');
    });

    it('returns "export" for Bash with export-pipeline command', () => {
      const { detectEvent } = requireFresh();
      expect(detectEvent({
        tool_name: 'Bash',
        tool_input: { command: 'node export-pipeline.cjs --session S280' },
        tool_response: 'Export complete',
      })).toBe('export');
    });

    it('does NOT return "export" for Write to a regular .md file', () => {
      const { detectEvent } = requireFresh();
      const result = detectEvent({
        tool_name: 'Write',
        tool_input: { file_path: '/docs/README.md' },
        tool_response: '',
      });
      expect(result).not.toBe('export');
    });
  });

  // ── zone-change ───────────────────────────────────────────────────────────────
  describe('zone-change event', () => {
    it('returns "zone-change" for Write to hud-zone-* file', () => {
      const { detectEvent } = requireFresh();
      expect(detectEvent({
        tool_name: 'Write',
        tool_input: { file_path: '/project/bin/hud-zone-forge.cjs' },
        tool_response: '',
      })).toBe('zone-change');
    });

    it('returns "zone-change" for Edit to hud-expressions file', () => {
      const { detectEvent } = requireFresh();
      expect(detectEvent({
        tool_name: 'Edit',
        tool_input: { file_path: '/project/bin/hud-expressions.cjs' },
        tool_response: '',
      })).toBe('zone-change');
    });

    it('returns "zone-change" for Agent output longer than 10 chars', () => {
      const { detectEvent } = requireFresh();
      expect(detectEvent({
        tool_name: 'Agent',
        tool_input: {},
        tool_response: 'Completed reviewing the implementation details',
      })).toBe('zone-change');
    });

    it('returns "zone-change" for Task output longer than 10 chars (no forge match)', () => {
      const { detectEvent } = requireFresh();
      expect(detectEvent({
        tool_name: 'Task',
        tool_input: {},
        tool_response: 'Done with the review task successfully',
      })).toBe('zone-change');
    });

    it('does NOT return "zone-change" for Agent output <=10 chars', () => {
      const { detectEvent } = requireFresh();
      const result = detectEvent({
        tool_name: 'Agent',
        tool_input: {},
        tool_response: 'ok',
      });
      // Short output — falls through to later checks
      expect(result).not.toBe('zone-change');
    });
  });

  // ── session-end ───────────────────────────────────────────────────────────────
  // session-end now takes priority over commit when command contains handoff/session-end.
  describe('session-end event', () => {
    it('returns "session-end" for handoff commit with successful output', () => {
      const { detectEvent } = requireFresh();
      expect(detectEvent({
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "docs: handoff S280"' },
        tool_response: 'main 5678def] docs: handoff S280',
      })).toBe('session-end');
    });

    it('returns "session-end" when commit output says nothing to commit', () => {
      const { detectEvent } = requireFresh();
      expect(detectEvent({
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "docs: handoff S280"' },
        tool_response: 'nothing to commit, working tree clean',
      })).toBe('session-end');
    });

    it('returns "session-end" for session end phrase regardless of output', () => {
      const { detectEvent } = requireFresh();
      expect(detectEvent({
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "session end wrap-up"' },
        tool_response: 'main abc123] session end wrap-up',
      })).toBe('session-end');
    });

    it('returns "commit" for regular commit without handoff/session-end', () => {
      const { detectEvent } = requireFresh();
      expect(detectEvent({
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "feat: add feature"' },
        tool_response: 'main 1234abc] feat: add feature',
      })).toBe('commit');
    });
  });

  // ── rate-limit-warn ───────────────────────────────────────────────────────────
  describe('rate-limit-warn event', () => {
    it('returns "rate-limit-warn" when five_hour used_percentage > 95', () => {
      const { detectEvent } = requireFresh();
      expect(detectEvent({
        tool_name: 'Read',
        tool_input: {},
        tool_response: '',
        rate_limits: {
          five_hour: { used_percentage: 96 },
        },
      })).toBe('rate-limit-warn');
    });

    it('returns "rate-limit-warn" when seven_day used_percentage > 95', () => {
      const { detectEvent } = requireFresh();
      expect(detectEvent({
        tool_name: 'Read',
        tool_input: {},
        tool_response: '',
        rate_limits: {
          seven_day: { used_percentage: 97 },
        },
      })).toBe('rate-limit-warn');
    });

    it('does NOT return "rate-limit-warn" when all tiers are under 95%', () => {
      const { detectEvent } = requireFresh();
      const result = detectEvent({
        tool_name: 'Read',
        tool_input: {},
        tool_response: '',
        rate_limits: {
          five_hour: { used_percentage: 50 },
          seven_day: { used_percentage: 40 },
        },
      });
      expect(result).not.toBe('rate-limit-warn');
    });

    it('does NOT return "rate-limit-warn" when rate_limits is absent', () => {
      const { detectEvent } = requireFresh();
      const result = detectEvent({
        tool_name: 'Read',
        tool_input: {},
        tool_response: '',
      });
      expect(result).not.toBe('rate-limit-warn');
    });
  });

  // ── error-state ───────────────────────────────────────────────────────────────
  describe('error-state event', () => {
    it('returns "error-state" when success === false for non-Bash', () => {
      const { detectEvent } = requireFresh();
      expect(detectEvent({
        tool_name: 'Write',
        tool_input: {},
        tool_response: '',
        success: false,
      })).toBe('error-state');
    });

    it('returns "error-state" when output matches typed error pattern for non-Bash/Read/Grep tool', () => {
      const { detectEvent } = requireFresh();
      expect(detectEvent({
        tool_name: 'Write',
        tool_input: {},
        tool_response: 'Error: ENOENT: no such file or directory',
      })).toBe('error-state');
    });

    it('does NOT return "error-state" for Bash tool output containing "error"', () => {
      const { detectEvent } = requireFresh();
      const result = detectEvent({
        tool_name: 'Bash',
        tool_input: { command: 'npm install' },
        tool_response: 'error in some package',
      });
      expect(result).not.toBe('error-state');
    });

    it('does NOT return "error-state" when success is undefined and no error keyword', () => {
      const { detectEvent } = requireFresh();
      expect(detectEvent({
        tool_name: 'Read',
        tool_input: {},
        tool_response: 'file contents here',
      })).toBeNull();
    });

    it('does NOT false-positive error-state on object tool_response metadata', () => {
      // Write/Edit tool_response is {filePath, success} — metadata, no text field.
      // coerceToolOutput returns '' for it, so the error-pattern regexes never run.
      // Guards the S392 adversarial-verify P3: a path literally containing
      // 'tool_use_error' must not mis-fire error-state. (Regression test.)
      const { detectEvent } = requireFresh();
      expect(detectEvent({
        tool_name: 'Write',
        tool_input: { file_path: '/x/tool_use_error.js' },
        tool_response: { filePath: '/x/tool_use_error.js', success: true },
      })).not.toBe('error-state');
    });
  });

  // ── context-high ──────────────────────────────────────────────────────────────
  describe('context-high event', () => {
    it('returns "context-high" when used_percentage > 75', () => {
      const { detectEvent } = requireFresh();
      expect(detectEvent({
        tool_name: 'Read',
        tool_input: {},
        tool_response: '',
        context_window: { used_percentage: 80 },
      })).toBe('context-high');
    });

    it('does NOT return "context-high" when used_percentage is exactly 75', () => {
      const { detectEvent } = requireFresh();
      expect(detectEvent({
        tool_name: 'Read',
        tool_input: {},
        tool_response: '',
        context_window: { used_percentage: 75 },
      })).not.toBe('context-high');
    });

    it('does NOT return "context-high" when context_window is absent', () => {
      const { detectEvent } = requireFresh();
      expect(detectEvent({
        tool_name: 'Read',
        tool_input: {},
        tool_response: '',
      })).toBeNull();
    });
  });

  // ── null (no match) ───────────────────────────────────────────────────────────
  describe('null event (no match)', () => {
    it('returns null for empty input object', () => {
      const { detectEvent } = requireFresh();
      expect(detectEvent({})).toBeNull();
    });

    it('returns null for unknown tool name with no special output', () => {
      const { detectEvent } = requireFresh();
      expect(detectEvent({
        tool_name: 'Glob',
        tool_input: {},
        tool_response: 'some/path/file.js',
      })).toBeNull();
    });

    it('returns null for Bash command that is not git/vitest/export-pipeline', () => {
      const { detectEvent } = requireFresh();
      expect(detectEvent({
        tool_name: 'Bash',
        tool_input: { command: 'ls -la' },
        tool_response: 'total 42',
      })).toBeNull();
    });

    it('handles missing tool_name gracefully (no throw)', () => {
      const { detectEvent } = requireFresh();
      expect(() => detectEvent({ tool_input: {}, tool_response: '' })).not.toThrow();
    });

    it('handles non-string tool_response (object) gracefully', () => {
      const { detectEvent } = requireFresh();
      expect(() => detectEvent({
        tool_name: 'Read',
        tool_input: {},
        tool_response: { some: 'object' },
      })).not.toThrow();
    });
  });
});

// ── shouldThrottle ────────────────────────────────────────────────────────────
describe('shouldThrottle', () => {
  it('returns false when throttle file does not exist', () => {
    const { shouldThrottle } = requireFresh();
    expect(shouldThrottle('commit', 30000)).toBe(false);
  });

  it('returns true when event fired within threshold', () => {
    const { shouldThrottle, recordRender } = requireFresh();
    recordRender('commit');
    // Immediately after recording, should throttle
    expect(shouldThrottle('commit', 30000)).toBe(true);
  });

  it('returns false when event fired outside threshold (threshold=0)', () => {
    const { shouldThrottle, recordRender } = requireFresh();
    recordRender('session-end');
    // threshold=0 means never throttle
    expect(shouldThrottle('session-end', 0)).toBe(false);
  });

  it('throttles per-event independently (different events do not share state)', () => {
    const { shouldThrottle, recordRender } = requireFresh();
    recordRender('commit');
    // A different event that has not been recorded should not be throttled
    expect(shouldThrottle('test-pass', 30000)).toBe(false);
  });

  it('returns false on corrupt throttle file (parse error)', () => {
    const { shouldThrottle } = requireFresh();
    // Write invalid JSON to the throttle file path
    const runsDir = path.join(tmpDir, '_runs', 'os');
    fs.mkdirSync(runsDir, { recursive: true });
    fs.writeFileSync(path.join(runsDir, 'hud-last-reactive.json'), 'CORRUPTED{{{');
    expect(shouldThrottle('commit', 30000)).toBe(false);
  });

  it('EVENT_THROTTLE defines per-event overrides for all known events', () => {
    const { EVENT_THROTTLE } = requireFresh();
    // Key events must have entries
    expect(typeof EVENT_THROTTLE['commit']).toBe('number');
    expect(typeof EVENT_THROTTLE['rate-limit-warn']).toBe('number');
    expect(typeof EVENT_THROTTLE['session-end']).toBe('number');
    // session-end has 0 throttle (always fires)
    expect(EVENT_THROTTLE['session-end']).toBe(0);
    // compact-start removed (unreachable via PostToolUse)
    expect(EVENT_THROTTLE['compact-start']).toBeUndefined();
    // rate-limit-warn has a long throttle (120s)
    expect(EVENT_THROTTLE['rate-limit-warn']).toBe(120000);
  });
});

// ── signalCompanion ───────────────────────────────────────────────────────────
describe('signalCompanion and COMPANION_EVENT_MAP', () => {
  it('COMPANION_EVENT_MAP maps commit -> commit', () => {
    const { COMPANION_EVENT_MAP } = requireFresh();
    expect(COMPANION_EVENT_MAP['commit']).toBe('commit');
  });

  it('COMPANION_EVENT_MAP maps test-pass -> tests-pass', () => {
    const { COMPANION_EVENT_MAP } = requireFresh();
    expect(COMPANION_EVENT_MAP['test-pass']).toBe('tests-pass');
  });

  it('COMPANION_EVENT_MAP maps test-fail -> tests-fail', () => {
    const { COMPANION_EVENT_MAP } = requireFresh();
    expect(COMPANION_EVENT_MAP['test-fail']).toBe('tests-fail');
  });

  it('COMPANION_EVENT_MAP maps error-state -> error', () => {
    const { COMPANION_EVENT_MAP } = requireFresh();
    expect(COMPANION_EVENT_MAP['error-state']).toBe('error');
  });

  it('COMPANION_EVENT_MAP maps rate-limit-warn -> rate-limited', () => {
    const { COMPANION_EVENT_MAP } = requireFresh();
    expect(COMPANION_EVENT_MAP['rate-limit-warn']).toBe('rate-limited');
  });

  it('COMPANION_EVENT_MAP maps context-high -> context-warn', () => {
    const { COMPANION_EVENT_MAP } = requireFresh();
    expect(COMPANION_EVENT_MAP['context-high']).toBe('context-warn');
  });

  it('signalCompanion does not throw when companion-state module is unavailable', () => {
    const { signalCompanion } = requireFresh();
    // companion-state.cjs require path may or may not resolve in test env;
    // signalCompanion swallows errors — must never throw
    expect(() => signalCompanion('commit', { tool_name: 'Bash' })).not.toThrow();
  });

  it('signalCompanion does not throw for null event with activity tool', () => {
    const { signalCompanion } = requireFresh();
    expect(() => signalCompanion(null, { tool_name: 'Read' })).not.toThrow();
  });
});
