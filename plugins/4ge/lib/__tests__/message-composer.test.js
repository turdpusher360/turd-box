import { describe, it, expect } from 'vitest';

const {
  composeMessage,
  fmtTokens,
  fmtDuration,
  fmtPct,
  fmtCountdown,
  TEMPLATES,
} = require('../message-composer.cjs');

describe('fmtTokens', () => {
  it('formats millions with one decimal', () => {
    expect(fmtTokens(1_500_000)).toBe('1.5M');
  });
  it('formats thousands without decimals', () => {
    expect(fmtTokens(45_000)).toBe('45k');
  });
  it('returns empty string for zero or invalid', () => {
    expect(fmtTokens(0)).toBe('');
    expect(fmtTokens(null)).toBe('');
    expect(fmtTokens(undefined)).toBe('');
  });
});

describe('fmtDuration', () => {
  it('formats minutes only under 1h', () => {
    expect(fmtDuration(45 * 60 * 1000)).toBe('45m');
  });
  it('formats h+m over 1h', () => {
    expect(fmtDuration(90 * 60 * 1000)).toBe('1h30m');
  });
  it('pads minutes when single-digit', () => {
    expect(fmtDuration(65 * 60 * 1000)).toBe('1h05m');
  });
  it('returns empty for zero or invalid', () => {
    expect(fmtDuration(0)).toBe('');
    expect(fmtDuration(-1)).toBe('');
  });
});

describe('fmtPct', () => {
  it('rounds and appends %', () => {
    expect(fmtPct(13.7)).toBe('14%');
    expect(fmtPct(80)).toBe('80%');
  });
  it('returns empty for invalid', () => {
    expect(fmtPct(null)).toBe('');
  });
});

describe('fmtCountdown', () => {
  it('returns empty for past timestamps', () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    expect(fmtCountdown(past)).toBe('');
  });
  it('formats future ISO strings', () => {
    const future = new Date(Date.now() + 90 * 60 * 1000).toISOString();
    const out = fmtCountdown(future);
    expect(out).toMatch(/\d+h\d+m|\d+m/);
  });
  it('returns empty for null', () => {
    expect(fmtCountdown(null)).toBe('');
  });
});

describe('composeMessage', () => {
  it('returns null for unknown event', () => {
    expect(composeMessage('unknown-event', {}, {})).toBeNull();
  });

  it('falls back through templates when state is thin', () => {
    // commit event with no state at all — should still produce the fallback
    const msg = composeMessage('commit', {}, {});
    expect(msg).toMatch(/shipped/);
  });

  it('prefers richer templates when state is available', () => {
    const state = {
      git: { branch: 'main', uncommittedFiles: 3, recentCommits: ['a', 'b'] },
      session: { uptime: 3600000, toolCount: 50 },
    };
    const msg = composeMessage('commit', state, {});
    // Should NOT be the bare fallback — at least one interpolated template fired
    expect(msg).not.toBe('shipped → main');
    expect(msg).toBeTruthy();
  });

  it('commit messages reference branch and commit count', () => {
    const state = {
      git: { branch: 'feature/x', uncommittedFiles: 0, recentCommits: ['a', 'b', 'c'] },
      session: { uptime: 7200000, toolCount: 100 },
    };
    const msg = composeMessage('commit', state, {});
    // Should mention branch, commit count, or both
    expect(msg).toMatch(/feature\/x|4 shipped|2h/);
  });

  it('test-pass uses context pct when available', () => {
    const state = { session: { contextPct: 35, toolCount: 40, uptime: 1800000 } };
    const msg = composeMessage('test-pass', state, {});
    expect(msg).toBeTruthy();
    expect(msg).toMatch(/green|clean|35%/);
  });

  it('rate-limit-warn includes countdown when future reset exists', () => {
    const future = Math.floor(Date.now() / 1000) + 7200; // 2h ahead
    const state = {
      session: {
        rateLimits: { fiveHour: 85, fiveHourResetsAt: future },
      },
    };
    const msg = composeMessage('rate-limit-warn', state, {});
    expect(msg).toMatch(/85%/);
    expect(msg).toMatch(/1h|2h|reset/);
  });

  it('error-state uses toolName from context', () => {
    const msg = composeMessage('error-state', {}, { toolName: 'Bash' });
    expect(msg).toBe('Bash errored');
  });

  it('forge-phase uses phase and teammate count', () => {
    const state = {
      forge: { phase: 'P5', teammates: [{}, {}, {}] },
    };
    const msg = composeMessage('forge-phase', state, {});
    expect(msg).toMatch(/P5/);
    expect(msg).toMatch(/3/);
  });

  it('session-end summarizes uptime, commits, tools', () => {
    const state = {
      session: { uptime: 3600000, toolCount: 80 },
      git: { recentCommits: ['a', 'b', 'c', 'd'] },
    };
    const msg = composeMessage('session-end', state, {});
    expect(msg).toMatch(/1h/);
    expect(msg).toMatch(/4 commits|80 tools/);
  });

  it('caps output at 60 chars', () => {
    const state = {
      git: { branch: 'x'.repeat(200), recentCommits: ['a'] },
      session: { uptime: 1000, toolCount: 1 },
    };
    const msg = composeMessage('commit', state, {});
    if (msg) expect(msg.length).toBeLessThanOrEqual(60);
  });

  it('is deterministic for same state', () => {
    const state = {
      git: { branch: 'main', recentCommits: [] },
      session: { toolCount: 10, uptime: 60000 },
    };
    const a = composeMessage('commit', state, {});
    const b = composeMessage('commit', state, {});
    expect(a).toBe(b);
  });
});

describe('composeMessage - intent awareness', () => {
  it('commit with shipping intent uses "shipped → branch"', () => {
    const state = { git: { branch: 'main', recentCommits: [] }, session: { toolCount: 10 } };
    const ctx = { intent: { intent: 'shipping', confidence: 0.9, reason: 'commit + push' } };
    const msg = composeMessage('commit', state, ctx);
    expect(msg).toMatch(/shipped/);
    expect(msg).toMatch(/main/);
  });

  it('commit with debugging intent uses "fix committed"', () => {
    const state = { git: { branch: 'fix/x', recentCommits: [] }, session: { toolCount: 10 } };
    const ctx = { intent: { intent: 'debugging', confidence: 0.85, reason: '' } };
    const msg = composeMessage('commit', state, ctx);
    expect(msg).toMatch(/fix committed/);
  });

  it('test-fail with debugging intent uses "still red"', () => {
    const state = { git: { branch: 'main' } };
    const ctx = { intent: { intent: 'debugging', confidence: 0.8, reason: '3 reread' } };
    const msg = composeMessage('test-fail', state, ctx);
    expect(msg).toMatch(/still red/);
  });

  it('falls back to state template when intent confidence is low', () => {
    const state = { git: { branch: 'main', recentCommits: [] }, session: { toolCount: 5 } };
    const ctx = { intent: { intent: 'shipping', confidence: 0.3, reason: '' } };
    const msg = composeMessage('commit', state, ctx);
    // Low-confidence shipping template returns null (< 0.7 threshold)
    // Falls through to non-intent templates
    expect(msg).not.toMatch(/^shipped →/);
  });
});

describe('TEMPLATES', () => {
  it('exposes template catalog for inspection', () => {
    expect(TEMPLATES).toBeTypeOf('object');
    expect(TEMPLATES.commit).toBeInstanceOf(Array);
    expect(TEMPLATES['test-pass']).toBeInstanceOf(Array);
  });

  it('has no zone-change entry (too noisy)', () => {
    expect(TEMPLATES['zone-change']).toBeUndefined();
  });

  it('every template returns string or null', () => {
    const emptyState = {};
    for (const [event, list] of Object.entries(TEMPLATES)) {
      for (const t of list) {
        const out = t(emptyState, {});
        expect(out === null || typeof out === 'string').toBe(true);
      }
    }
  });
});
