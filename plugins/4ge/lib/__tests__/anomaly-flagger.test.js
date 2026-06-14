import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  detectAnomalies,
  SEVERITY_CRITICAL,
  SEVERITY_SIGNAL,
  SEVERITY_FLASH,
  RAPID_ERROR_WINDOW_MS,
  STALE_DIRTY_THRESHOLD_MS,
  LONG_IDLE_THRESHOLD_MS,
  RATE_LIMIT_RESET_MIN_MS,
  RATE_LIMIT_USED_THRESHOLD,
  CHECKERS,
} = require('../anomaly-flagger.cjs');

const NOW = Date.now();

// ── Event factories ──

const bash  = (command, extra = {}) => ({ tool: 'Bash', command, ts: NOW, ...extra });
const errEv = (command = 'some error output')  => ({ tool: 'Bash', command, ts: NOW, isError: true });
const tool  = (name, extra = {}) => ({ tool: name, ts: NOW, ...extra });

// ── State factories ──

function gitState({ dirty = 0, lastCommitTs = NOW } = {}) {
  return { git: { uncommittedFiles: dirty, lastCommitTs } };
}

function sessionState({ contextPct = 5, uptime = 30 * 60 * 1000, rateLimits = null } = {}) {
  return { session: { contextPct, uptime, rateLimits } };
}

function fullState(opts = {}) {
  return { ...gitState(opts.git || {}), ...sessionState(opts.session || {}) };
}

// ── Return shape ──

describe('detectAnomalies — return shape', () => {
  it('always returns anomalies array and topSeverity', () => {
    const r = detectAnomalies({ recentTools: [], state: {}, now: NOW });
    expect(r).toHaveProperty('anomalies');
    expect(r).toHaveProperty('topSeverity');
    expect(Array.isArray(r.anomalies)).toBe(true);
  });

  it('each anomaly has type, severity, reason, metrics', () => {
    const events = [errEv(), errEv(), errEv()];
    const r = detectAnomalies({ recentTools: events, state: {}, now: NOW });
    expect(r.anomalies.length).toBeGreaterThan(0);
    const a = r.anomalies[0];
    expect(a).toHaveProperty('type');
    expect(a).toHaveProperty('severity');
    expect(a).toHaveProperty('reason');
    expect(a).toHaveProperty('metrics');
  });
});

// ── No-anomaly baseline ──

describe('detectAnomalies — no anomalies', () => {
  it('returns empty array and null topSeverity when nothing is wrong', () => {
    const state = fullState({
      git:     { dirty: 0, lastCommitTs: NOW },
      session: { contextPct: 5, uptime: 10 * 60 * 1000 },
    });
    const r = detectAnomalies({ recentTools: [tool('Read'), tool('Bash')], state, now: NOW });
    expect(r.anomalies).toHaveLength(0);
    expect(r.topSeverity).toBeNull();
  });

  it('handles null/undefined opts gracefully', () => {
    const r = detectAnomalies({});
    expect(r.anomalies).toHaveLength(0);
    expect(r.topSeverity).toBeNull();
  });
});

// ── Checker registry ──

describe('checker registry', () => {
  it('preserves the shipped checker order', () => {
    expect(CHECKERS.map(checker => checker.type)).toEqual([
      'rapid-error-cascade',
      'stale-dirty-work',
      'ctx-burn-rate-high',
      'rate-limit-approaching',
      'vram-low',
      'process-reaped-kill',
      'process-bloat',
      'error-regression',
      'long-idle',
    ]);
  });

  it('continues after a checker throws', () => {
    const checkers = [
      {
        type: 'throws',
        run: () => { throw new Error('boom'); },
      },
      {
        type: 'still-runs',
        run: () => ({
          type: 'still-runs',
          severity: SEVERITY_FLASH,
          reason: 'later checker ran',
          metrics: {},
        }),
      },
    ];

    const r = detectAnomalies({ recentTools: [], state: {}, now: NOW, checkers });
    expect(r.anomalies.map(a => a.type)).toEqual(['still-runs']);
    expect(r.topSeverity).toBe(SEVERITY_FLASH);
  });
});

// ── zero-producer environment signals ──

describe('zero-producer environment signals', () => {
  it('fires vram-low when cached free VRAM is below 1GiB', () => {
    const state = { os: { vram: { freeMiB: 768, totalMiB: 8192 } } };
    const r = detectAnomalies({ recentTools: [], state, now: NOW });
    const a = r.anomalies.find(x => x.type === 'vram-low');

    expect(a).toBeDefined();
    expect(a.severity).toBe(SEVERITY_SIGNAL);
    expect(a.metrics.freeMiB).toBe(768);
  });

  it('does NOT fire vram-low when cached free VRAM is healthy or missing', () => {
    expect(detectAnomalies({
      recentTools: [],
      state: { os: { vram: { freeMiB: 2048 } } },
      now: NOW,
    }).anomalies.find(x => x.type === 'vram-low')).toBeUndefined();

    expect(detectAnomalies({ recentTools: [], state: { os: {} }, now: NOW })
      .anomalies.find(x => x.type === 'vram-low')).toBeUndefined();
  });

  it('fires process-reaped-kill when the reaper killed processes', () => {
    const state = { os: { processes: { totalProcs: 80, mcpProcs: 0, killed: 2 } } };
    const r = detectAnomalies({ recentTools: [], state, now: NOW });
    const a = r.anomalies.find(x => x.type === 'process-reaped-kill');

    expect(a).toBeDefined();
    expect(a.severity).toBe(SEVERITY_SIGNAL);
    expect(a.metrics.killed).toBe(2);
  });

  it('fires process-bloat when total or MCP process counts cross thresholds', () => {
    const totalState = { os: { processes: { totalProcs: 151, mcpProcs: 1, killed: 0 } } };
    const total = detectAnomalies({ recentTools: [], state: totalState, now: NOW })
      .anomalies.find(x => x.type === 'process-bloat');
    expect(total).toBeDefined();
    expect(total.metrics.totalProcs).toBe(151);

    const mcpState = { os: { processes: { totalProcs: 80, mcpProcs: 8, killed: 0 } } };
    const mcp = detectAnomalies({ recentTools: [], state: mcpState, now: NOW })
      .anomalies.find(x => x.type === 'process-bloat');
    expect(mcp).toBeDefined();
    expect(mcp.metrics.mcpProcs).toBe(8);
  });

  it('does NOT fire process health anomalies for normal process counts', () => {
    const state = { os: { processes: { totalProcs: 95, mcpProcs: 1, killed: 0 } } };
    const r = detectAnomalies({ recentTools: [], state, now: NOW });
    expect(r.anomalies.find(x => x.type === 'process-reaped-kill')).toBeUndefined();
    expect(r.anomalies.find(x => x.type === 'process-bloat')).toBeUndefined();
  });
});

// ── rapid-error-cascade ──

describe('rapid-error-cascade', () => {
  it('fires critical when ≥3 isError events in window', () => {
    const events = [errEv(), errEv(), errEv()];
    const r = detectAnomalies({ recentTools: events, state: {}, now: NOW });
    const a = r.anomalies.find(x => x.type === 'rapid-error-cascade');
    expect(a).toBeDefined();
    expect(a.severity).toBe(SEVERITY_CRITICAL);
    expect(a.metrics.errorCount).toBeGreaterThanOrEqual(3);
  });

  it('fires when bash output contains error keyword', () => {
    const events = [
      bash('npm run build  ← error: cannot resolve'),
      bash('npx tsc  ← error: type mismatch'),
      bash('eslint . ← error: parsing failed'),
    ];
    const r = detectAnomalies({ recentTools: events, state: {}, now: NOW });
    const a = r.anomalies.find(x => x.type === 'rapid-error-cascade');
    expect(a).toBeDefined();
    expect(a.severity).toBe(SEVERITY_CRITICAL);
  });

  it('does NOT fire with only 2 errors', () => {
    const events = [errEv(), errEv()];
    const r = detectAnomalies({ recentTools: events, state: {}, now: NOW });
    const a = r.anomalies.find(x => x.type === 'rapid-error-cascade');
    expect(a).toBeUndefined();
  });

  it('does NOT fire when errors are outside the time window', () => {
    const oldTs = NOW - RAPID_ERROR_WINDOW_MS - 5000;
    const events = [
      { tool: 'Bash', command: 'x', ts: oldTs, isError: true },
      { tool: 'Bash', command: 'y', ts: oldTs, isError: true },
      { tool: 'Bash', command: 'z', ts: oldTs, isError: true },
    ];
    const r = detectAnomalies({ recentTools: events, state: {}, now: NOW });
    const a = r.anomalies.find(x => x.type === 'rapid-error-cascade');
    expect(a).toBeUndefined();
  });
});

// ── stale-dirty-work ──

describe('stale-dirty-work', () => {
  it('fires signal when dirty and no commit in 30 min', () => {
    const lastCommitTs = NOW - STALE_DIRTY_THRESHOLD_MS - 1000;
    const state = { git: { uncommittedFiles: 3, lastCommitTs } };
    const r = detectAnomalies({ recentTools: [], state, now: NOW });
    const a = r.anomalies.find(x => x.type === 'stale-dirty-work');
    expect(a).toBeDefined();
    expect(a.severity).toBe(SEVERITY_SIGNAL);
    expect(a.metrics.uncommittedFiles).toBe(3);
  });

  it('does NOT fire when dirty but committed recently', () => {
    const state = { git: { uncommittedFiles: 5, lastCommitTs: NOW - 5 * 60 * 1000 } };
    const r = detectAnomalies({ recentTools: [], state, now: NOW });
    const a = r.anomalies.find(x => x.type === 'stale-dirty-work');
    expect(a).toBeUndefined();
  });

  it('does NOT fire when clean (0 dirty files)', () => {
    const state = { git: { uncommittedFiles: 0, lastCommitTs: NOW - 2 * 60 * 60 * 1000 } };
    const r = detectAnomalies({ recentTools: [], state, now: NOW });
    const a = r.anomalies.find(x => x.type === 'stale-dirty-work');
    expect(a).toBeUndefined();
  });

  it('accepts ISO 8601 string lastCommitTs (smart-order.cjs format)', () => {
    // smart-order emits ISO strings like "2026-04-16T03:30:00+00:00"
    const lastCommitTs = new Date(NOW - STALE_DIRTY_THRESHOLD_MS - 1000).toISOString();
    const state = { git: { uncommittedFiles: 3, lastCommitTs } };
    const r = detectAnomalies({ recentTools: [], state, now: NOW });
    const a = r.anomalies.find(x => x.type === 'stale-dirty-work');
    expect(a).toBeDefined();
    expect(a.severity).toBe(SEVERITY_SIGNAL);
  });

  it('accepts epoch-seconds lastCommitTs', () => {
    const lastCommitTs = Math.floor((NOW - STALE_DIRTY_THRESHOLD_MS - 1000) / 1000);
    const state = { git: { uncommittedFiles: 2, lastCommitTs } };
    const r = detectAnomalies({ recentTools: [], state, now: NOW });
    const a = r.anomalies.find(x => x.type === 'stale-dirty-work');
    expect(a).toBeDefined();
  });
});

// ── ctx-burn-rate-high ──

describe('ctx-burn-rate-high', () => {
  it('fires signal when burn rate exceeds 10%/min', () => {
    // 50% used in 4 minutes = 12.5%/min
    const state = { session: { contextPct: 50, uptime: 4 * 60 * 1000 } };
    const r = detectAnomalies({ recentTools: [], state, now: NOW });
    const a = r.anomalies.find(x => x.type === 'ctx-burn-rate-high');
    expect(a).toBeDefined();
    expect(a.severity).toBe(SEVERITY_SIGNAL);
    expect(a.metrics.ratePctPerMin).toBeGreaterThan(10);
  });

  it('uses recent context history slope when at least three samples are present', () => {
    const state = {
      session: {
        contextPct: 50,
        uptime: 60 * 60 * 1000,
        contextPctHistory: [10, 20, 35, 50],
      },
    };
    const r = detectAnomalies({ recentTools: [], state, now: NOW });
    const a = r.anomalies.find(x => x.type === 'ctx-burn-rate-high');
    expect(a).toBeDefined();
    expect(a.metrics.source).toBe('history');
    expect(a.metrics.sampleCount).toBe(4);
    expect(a.metrics.ratePctPerMin).toBeCloseTo(13.3, 1);
  });

  it('does NOT fall back to noisy uptime burn rate when history slope is acceptable', () => {
    const state = {
      session: {
        contextPct: 50,
        uptime: 4 * 60 * 1000,
        contextPctHistory: [35, 39, 43, 47, 50],
      },
    };
    const r = detectAnomalies({ recentTools: [], state, now: NOW });
    const a = r.anomalies.find(x => x.type === 'ctx-burn-rate-high');
    expect(a).toBeUndefined();
  });

  it('does NOT fire when burn rate is acceptable', () => {
    // 20% in 60 minutes = 0.33%/min
    const state = { session: { contextPct: 20, uptime: 60 * 60 * 1000 } };
    const r = detectAnomalies({ recentTools: [], state, now: NOW });
    const a = r.anomalies.find(x => x.type === 'ctx-burn-rate-high');
    expect(a).toBeUndefined();
  });

  it('does NOT fire when session state is missing', () => {
    const r = detectAnomalies({ recentTools: [], state: {}, now: NOW });
    const a = r.anomalies.find(x => x.type === 'ctx-burn-rate-high');
    expect(a).toBeUndefined();
  });
});

// ── rate-limit-approaching ──

describe('rate-limit-approaching', () => {
  beforeEach(() => { process.env.ANOMALY_RATE_LIMIT = '1'; });
  afterEach(() => { delete process.env.ANOMALY_RATE_LIMIT; });

  it('fires critical when five-hour >70% used and reset 3h away', () => {
    const fiveHourResetsAt = NOW + 3 * 60 * 60 * 1000; // 3 hours from now (epoch ms)
    const state = { session: { rateLimits: { fiveHour: 75, fiveHourResetsAt } } };
    const r = detectAnomalies({ recentTools: [], state, now: NOW });
    const a = r.anomalies.find(x => x.type === 'rate-limit-approaching');
    expect(a).toBeDefined();
    expect(a.severity).toBe(SEVERITY_CRITICAL);
    expect(a.metrics.usedPct).toBe(75);
    expect(a.metrics.window).toBe('5h');
  });

  it('fires critical on seven-day window too', () => {
    const sevenDayResetsAt = NOW + 5 * 60 * 60 * 1000;
    const state = { session: { rateLimits: { sevenDay: 85, sevenDayResetsAt } } };
    const r = detectAnomalies({ recentTools: [], state, now: NOW });
    const a = r.anomalies.find(x => x.type === 'rate-limit-approaching');
    expect(a).toBeDefined();
    expect(a.metrics.window).toBe('7d');
  });

  it('picks worst offender when both windows qualify', () => {
    const resetsAt = NOW + 3 * 60 * 60 * 1000;
    const state = {
      session: {
        rateLimits: {
          fiveHour: 72, fiveHourResetsAt: resetsAt,
          sevenDay:  88, sevenDayResetsAt: resetsAt,
        },
      },
    };
    const r = detectAnomalies({ recentTools: [], state, now: NOW });
    const a = r.anomalies.find(x => x.type === 'rate-limit-approaching');
    expect(a.metrics.window).toBe('7d');
    expect(a.metrics.usedPct).toBe(88);
  });

  it('accepts epoch-seconds resetsAt', () => {
    const fiveHourResetsAt = Math.floor((NOW + 3 * 60 * 60 * 1000) / 1000);
    const state = { session: { rateLimits: { fiveHour: 80, fiveHourResetsAt } } };
    const r = detectAnomalies({ recentTools: [], state, now: NOW });
    const a = r.anomalies.find(x => x.type === 'rate-limit-approaching');
    expect(a).toBeDefined();
    expect(a.severity).toBe(SEVERITY_CRITICAL);
  });

  it('does NOT fire when below 70% used', () => {
    const fiveHourResetsAt = NOW + 3 * 60 * 60 * 1000;
    const state = { session: { rateLimits: { fiveHour: 60, fiveHourResetsAt } } };
    const r = detectAnomalies({ recentTools: [], state, now: NOW });
    const a = r.anomalies.find(x => x.type === 'rate-limit-approaching');
    expect(a).toBeUndefined();
  });

  it('does NOT fire when reset is imminent (<2h)', () => {
    const fiveHourResetsAt = NOW + 1 * 60 * 60 * 1000; // only 1 hour away
    const state = { session: { rateLimits: { fiveHour: 90, fiveHourResetsAt } } };
    const r = detectAnomalies({ recentTools: [], state, now: NOW });
    const a = r.anomalies.find(x => x.type === 'rate-limit-approaching');
    expect(a).toBeUndefined();
  });
});

// ── error-regression ──

describe('error-regression', () => {
  it('fires signal when test suite passes then fails', () => {
    const events = [
      bash('npx vitest run  ✓ all 22 tests passed'),
      bash('npx vitest run  FAIL src/foo.test.js', { isError: true }),
    ];
    const r = detectAnomalies({ recentTools: events, state: {}, now: NOW });
    const a = r.anomalies.find(x => x.type === 'error-regression');
    expect(a).toBeDefined();
    expect(a.severity).toBe(SEVERITY_SIGNAL);
  });

  it('does NOT fire when tests were always failing', () => {
    const events = [
      bash('npx vitest run  FAIL foo.test.js', { isError: true }),
      bash('npx vitest run  FAIL foo.test.js', { isError: true }),
    ];
    const r = detectAnomalies({ recentTools: events, state: {}, now: NOW });
    const a = r.anomalies.find(x => x.type === 'error-regression');
    expect(a).toBeUndefined();
  });

  it('does NOT fire for non-test bash commands', () => {
    const events = [
      bash('git status'),
      bash('git diff', { isError: true }),
    ];
    const r = detectAnomalies({ recentTools: events, state: {}, now: NOW });
    const a = r.anomalies.find(x => x.type === 'error-regression');
    expect(a).toBeUndefined();
  });
});

// ── long-idle ──

describe('long-idle', () => {
  it('fires flash when last tool was 6+ minutes ago', () => {
    const oldEv = { tool: 'Read', ts: NOW - LONG_IDLE_THRESHOLD_MS - 60 * 1000 };
    const r = detectAnomalies({ recentTools: [oldEv], state: {}, now: NOW });
    const a = r.anomalies.find(x => x.type === 'long-idle');
    expect(a).toBeDefined();
    expect(a.severity).toBe(SEVERITY_FLASH);
    expect(a.metrics.idleMs).toBeGreaterThanOrEqual(LONG_IDLE_THRESHOLD_MS);
  });

  it('does NOT fire when tools are recent', () => {
    const r = detectAnomalies({ recentTools: [tool('Read')], state: {}, now: NOW });
    const a = r.anomalies.find(x => x.type === 'long-idle');
    expect(a).toBeUndefined();
  });

  it('does NOT fire on empty ring (session just started)', () => {
    const r = detectAnomalies({ recentTools: [], state: {}, now: NOW });
    const a = r.anomalies.find(x => x.type === 'long-idle');
    expect(a).toBeUndefined();
  });
});

// ── Multiple anomalies + topSeverity ──

describe('multiple anomalies', () => {
  beforeEach(() => { process.env.ANOMALY_RATE_LIMIT = '1'; });
  afterEach(() => { delete process.env.ANOMALY_RATE_LIMIT; });

  it('returns all active anomalies and topSeverity is highest', () => {
    // Trigger both a critical and a signal
    const lastCommitTs = NOW - STALE_DIRTY_THRESHOLD_MS - 1000;
    const fiveHourResetsAt = NOW + 3 * 60 * 60 * 1000;
    const state = {
      git: { uncommittedFiles: 2, lastCommitTs },
      session: { rateLimits: { fiveHour: 80, fiveHourResetsAt } },
    };
    const r = detectAnomalies({ recentTools: [], state, now: NOW });
    expect(r.anomalies.length).toBeGreaterThanOrEqual(2);
    expect(r.topSeverity).toBe(SEVERITY_CRITICAL);
  });

  it('topSeverity is signal when only signal anomalies fire', () => {
    const lastCommitTs = NOW - STALE_DIRTY_THRESHOLD_MS - 1000;
    const state = {
      git: { uncommittedFiles: 1, lastCommitTs },
      session: { contextPct: 50, uptime: 4 * 60 * 1000 },
    };
    const r = detectAnomalies({ recentTools: [], state, now: NOW });
    const types = r.anomalies.map(a => a.type);
    expect(types).toContain('stale-dirty-work');
    expect(r.topSeverity).toBe(SEVERITY_SIGNAL);
  });

  it('anomalies are ordered critical first', () => {
    const lastCommitTs = NOW - STALE_DIRTY_THRESHOLD_MS - 1000;
    const resetsAt = NOW + 3 * 60 * 60 * 1000;
    const state = {
      git: { uncommittedFiles: 2, lastCommitTs },
      session: { rateLimits: { usedPct: 80, resetsAt } },
    };
    const r = detectAnomalies({ recentTools: [], state, now: NOW });
    if (r.anomalies.length >= 2) {
      const firstSeverity = r.anomalies[0].severity;
      expect(['critical']).toContain(firstSeverity);
    }
  });
});

// ── S303 B.5 regression — 70-80% rate-limit band ──
//
// Verifies that a rate-limit-approaching anomaly fires as CRITICAL when usage
// is in the 70-80% band — even though the rate-limit-warn EVENT only fires at
// >80%. Pre-fix this anomaly was silently swallowed because anomaly escalation
// was gated on event detection. (S303 Track B.5 decouple fix)

describe('rate-limit-approaching — 70-80% band regression (S303 B.5)', () => {
  beforeEach(() => { process.env.ANOMALY_RATE_LIMIT = '1'; });
  afterEach(() => { delete process.env.ANOMALY_RATE_LIMIT; });

  const THRESHOLD_PCT = RATE_LIMIT_USED_THRESHOLD * 100; // 70

  it('fires critical anomaly at exactly the threshold boundary (70%)', () => {
    const fiveHourResetsAt = NOW + 3 * 60 * 60 * 1000;
    const state = { session: { rateLimits: { fiveHour: THRESHOLD_PCT, fiveHourResetsAt } } };
    const r = detectAnomalies({ recentTools: [], state, now: NOW });
    const a = r.anomalies.find(x => x.type === 'rate-limit-approaching');
    expect(a).toBeDefined();
    expect(a.severity).toBe(SEVERITY_CRITICAL);
    expect(a.metrics.usedPct).toBe(THRESHOLD_PCT);
  });

  it('fires critical anomaly in the 70-80% band (75%)', () => {
    // 75% is above anomaly threshold (70) but below event threshold (80).
    // This was the silent-swallow case: detectAnomalies fires, but
    // hud-reactive signalCompanion only ran escalation inside COMPANION_EVENT_MAP
    // guard, which required rate-limit-warn event (>80%). Fix: escalation now
    // runs on bare tool activity too.
    const fiveHourResetsAt = NOW + 3 * 60 * 60 * 1000;
    const state = { session: { rateLimits: { fiveHour: 75, fiveHourResetsAt } } };
    const r = detectAnomalies({ recentTools: [], state, now: NOW });
    const a = r.anomalies.find(x => x.type === 'rate-limit-approaching');
    expect(a).toBeDefined();
    expect(a.severity).toBe(SEVERITY_CRITICAL);
  });

  it('does NOT fire below threshold (69%)', () => {
    const fiveHourResetsAt = NOW + 3 * 60 * 60 * 1000;
    const state = { session: { rateLimits: { fiveHour: 69, fiveHourResetsAt } } };
    const r = detectAnomalies({ recentTools: [], state, now: NOW });
    const a = r.anomalies.find(x => x.type === 'rate-limit-approaching');
    expect(a).toBeUndefined();
  });

  it('topSeverity is critical in 70-80% band', () => {
    const fiveHourResetsAt = NOW + 3 * 60 * 60 * 1000;
    const state = { session: { rateLimits: { fiveHour: 75, fiveHourResetsAt } } };
    const r = detectAnomalies({ recentTools: [], state, now: NOW });
    expect(r.topSeverity).toBe(SEVERITY_CRITICAL);
  });
});
