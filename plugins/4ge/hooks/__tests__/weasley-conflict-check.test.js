import { describe, it, expect } from 'vitest';

// detectConflict is a PURE function (state + candidate file + selfKey + now -> warning|null).
// No fs/stdin mocks needed — exactly why the logic was factored out of the hook.
import {
  detectConflict,
  clockKey,
  classifyCaller,
  extractEditTarget,
  pruneStale,
  upsertEntry,
  STALE_MS,
  FILE_OWNERSHIP_MS,
} from '../weasley-utils.cjs';

const NOW = 1_000_000_000_000;

function clockWith(entries) {
  return { agents: entries };
}

describe('detectConflict', () => {
  it('returns null when no other agent has touched the file', () => {
    const clock = clockWith({});
    expect(detectConflict(clock, '/proj/a.cjs', 'sessA:main', NOW)).toBeNull();
  });

  it('warns when a live other agent recently touched the same file', () => {
    const clock = clockWith({
      'sessB:agent1': {
        type: 'subagent', name: 'fix-hud', lastActive: NOW - 5000,
        files: { '/proj/a.cjs': NOW - 5000 },
      },
    });
    const w = detectConflict(clock, '/proj/a.cjs', 'sessA:main', NOW);
    expect(w).toBeTruthy();
    expect(w).toContain('a.cjs');
    expect(w).toContain('fix-hud');
    expect(w).toMatch(/CONFLICT/);
  });

  it('excludes the callers own entry (no self-conflict)', () => {
    const clock = clockWith({
      'sessA:main': {
        type: 'main', name: 'lead', lastActive: NOW - 1000,
        files: { '/proj/a.cjs': NOW - 1000 },
      },
    });
    expect(detectConflict(clock, '/proj/a.cjs', 'sessA:main', NOW)).toBeNull();
  });

  it('excludes stale agents (no heartbeat within STALE_MS)', () => {
    const clock = clockWith({
      'sessB:agent1': {
        type: 'subagent', name: 'old', lastActive: NOW - (STALE_MS + 1),
        files: { '/proj/a.cjs': NOW - (STALE_MS + 1) },
      },
    });
    expect(detectConflict(clock, '/proj/a.cjs', 'sessA:main', NOW)).toBeNull();
  });

  it('ignores files the other agent touched too long ago (file ownership expiry)', () => {
    const clock = clockWith({
      'sessB:agent1': {
        type: 'subagent', name: 'busy', lastActive: NOW - 1000, // agent is live...
        files: { '/proj/a.cjs': NOW - (FILE_OWNERSHIP_MS + 5000) }, // ...but moved on from a.cjs
      },
    });
    expect(detectConflict(clock, '/proj/a.cjs', 'sessA:main', NOW)).toBeNull();
  });

  it('does not warn on a different file', () => {
    const clock = clockWith({
      'sessB:agent1': {
        type: 'subagent', name: 'other', lastActive: NOW - 1000,
        files: { '/proj/b.cjs': NOW - 1000 },
      },
    });
    expect(detectConflict(clock, '/proj/a.cjs', 'sessA:main', NOW)).toBeNull();
  });

  it('returns null for a null candidate file', () => {
    expect(detectConflict(clockWith({}), null, 'sessA:main', NOW)).toBeNull();
  });

  it('lists multiple distinct owners', () => {
    const clock = clockWith({
      'sessB:a1': { type: 'subagent', name: 'one', lastActive: NOW - 1000, files: { '/proj/a.cjs': NOW - 1000 } },
      'sessC:a2': { type: 'subagent', name: 'two', lastActive: NOW - 2000, files: { '/proj/a.cjs': NOW - 2000 } },
    });
    const w = detectConflict(clock, '/proj/a.cjs', 'sessA:main', NOW);
    expect(w).toContain('one');
    expect(w).toContain('two');
  });
});

describe('clockKey', () => {
  it('keys on BOTH session and caller id so parallel leads do not collide', () => {
    const leadA = clockKey('sessionAAAA', classifyCaller({}));
    const leadB = clockKey('sessionBBBB', classifyCaller({}));
    expect(leadA).not.toBe(leadB);
    // Both classified as main/lead, but distinct keys.
    expect(leadA).toContain('main');
    expect(leadB).toContain('main');
  });
});

describe('classifyCaller', () => {
  it('classifies lead, teammate, and subagent', () => {
    expect(classifyCaller({}).type).toBe('main');
    expect(classifyCaller({ agent_id: 'x', agent_type: 'in_process_teammate' }).type).toBe('teammate');
    expect(classifyCaller({ agent_id: 'x', agent_type: 'fix-hud' }).name).toBe('fix-hud');
  });
});

describe('extractEditTarget', () => {
  it('extracts file_path for edit tools and null otherwise', () => {
    expect(extractEditTarget('Edit', { file_path: '/p/x.cjs' })).toBe('/p/x.cjs');
    expect(extractEditTarget('Write', { file_path: '/p/y.cjs' })).toBe('/p/y.cjs');
    expect(extractEditTarget('Bash', { command: 'ls' })).toBeNull();
    expect(extractEditTarget('Edit', {})).toBeNull();
  });
});

describe('pruneStale', () => {
  it('drops entries older than STALE_MS, keeps fresh', () => {
    const clock = clockWith({
      fresh: { lastActive: NOW - 1000 },
      stale: { lastActive: NOW - (STALE_MS + 1) },
    });
    const pruned = pruneStale(clock, NOW);
    expect(pruned.agents.fresh).toBeDefined();
    expect(pruned.agents.stale).toBeUndefined();
  });
});

describe('upsertEntry', () => {
  it('records the touched file with a timestamp and caps the file list', () => {
    let clock = { agents: {} };
    const caller = { type: 'main', name: 'lead' };
    clock = upsertEntry(clock, 'sessA:main', caller, 'sessA', '/proj/a.cjs', null, NOW);
    expect(clock.agents['sessA:main'].files['/proj/a.cjs']).toBe(NOW);
    expect(clock.agents['sessA:main'].lastActive).toBe(NOW);

    // Add many files; ensure cap holds.
    for (let i = 0; i < 30; i++) {
      clock = upsertEntry(clock, 'sessA:main', caller, 'sessA', `/proj/f${i}.cjs`, null, NOW + i);
    }
    expect(Object.keys(clock.agents['sessA:main'].files).length).toBeLessThanOrEqual(12);
  });

  it('a fresh upsert then detectConflict from another agent warns end-to-end', () => {
    let clock = { agents: {} };
    clock = upsertEntry(clock, 'sessB:a1', { type: 'subagent', name: 'worker' }, 'sessB', '/proj/shared.cjs', null, NOW);
    const w = detectConflict(clock, '/proj/shared.cjs', 'sessA:main', NOW + 100);
    expect(w).toContain('worker');
  });
});
