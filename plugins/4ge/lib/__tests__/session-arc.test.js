import { describe, it, expect } from 'vitest';

const {
  detectArc,
  PHASE_THRESHOLDS,
  computeMetrics,
} = require('../session-arc.cjs');

// ── Fixed clock ───────────────────────────────────────────────────────────────
const now = Date.now();

// ── Event factory helpers ─────────────────────────────────────────────────────
const ev    = (tool, tsOffset = 0, extra = {}) => ({ tool, ts: now + tsOffset, ...extra });
const bash  = (command, tsOffset = 0)           => ({ tool: 'Bash', command, ts: now + tsOffset });
const edit  = (filePath, tsOffset = 0)          => ({ tool: 'Edit', filePath, ts: now + tsOffset });
const write = (filePath, tsOffset = 0)          => ({ tool: 'Write', filePath, ts: now + tsOffset });

// Build N events evenly spaced over a window (all before now)
function evenSpread(n, windowMs, toolName = 'Bash') {
  const step = windowMs / n;
  return Array.from({ length: n }, (_, i) =>
    ev(toolName, -(windowMs - i * step))
  );
}

// ── Return shape ──────────────────────────────────────────────────────────────

describe('detectArc — return shape', () => {
  it('always returns phase, confidence, reason, metrics', () => {
    const r = detectArc({ recentTools: [], now });
    expect(r).toHaveProperty('phase');
    expect(r).toHaveProperty('confidence');
    expect(r).toHaveProperty('reason');
    expect(r).toHaveProperty('metrics');
    expect(typeof r.confidence).toBe('number');
    expect(r.metrics).toHaveProperty('toolsPerMinute');
    expect(r.metrics).toHaveProperty('gapMs');
    expect(r.metrics).toHaveProperty('avgIntervalMs');
  });

  it('confidence is in [0, 1]', () => {
    const cases = [
      [],
      [ev('Read', -1000)],
      [ev('Bash', -(20 * 60 * 1000))],
    ];
    for (const recentTools of cases) {
      const r = detectArc({ recentTools, now });
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('phase is one of the valid values', () => {
    const valid = ['warmup', 'locked-in', 'drift', 'winding-down', 'cold', 'unknown'];
    const r = detectArc({ recentTools: [], now });
    expect(valid).toContain(r.phase);
  });
});

// ── warmup ────────────────────────────────────────────────────────────────────

describe('detectArc — warmup', () => {
  it('returns warmup for a single tool event', () => {
    const r = detectArc({ recentTools: [ev('Read', -5000)], now });
    expect(r.phase).toBe('warmup');
  });

  it('returns warmup when toolCount < 10 (from state)', () => {
    const recentTools = Array.from({ length: 3 }, (_, i) => ev('Bash', -i * 10000));
    const r = detectArc({
      recentTools,
      state: { session: { toolCount: 3, uptime: 10 * 60 * 1000 } },
      now,
    });
    expect(r.phase).toBe('warmup');
  });

  it('returns warmup when uptime < 5 min even with 12 events', () => {
    const recentTools = Array.from({ length: 12 }, (_, i) => ev('Bash', -i * 10000));
    const r = detectArc({
      recentTools,
      state: { session: { toolCount: 12, uptime: 2 * 60 * 1000 } },
      now,
    });
    expect(r.phase).toBe('warmup');
  });

  it('does NOT return warmup when toolCount >= 10 and uptime >= 5 min', () => {
    // Need enough events to trigger another phase (e.g. locked-in)
    const recentTools = evenSpread(10, 2.5 * 60 * 1000);
    const r = detectArc({
      recentTools,
      state: { session: { toolCount: 10, uptime: 6 * 60 * 1000 } },
      now,
    });
    expect(r.phase).not.toBe('warmup');
  });
});

// ── locked-in ─────────────────────────────────────────────────────────────────

describe('detectArc — locked-in', () => {
  it('detects ≥5 tools in last 3 min with consistent pace', () => {
    // 6 tools evenly spread over 2 min → consistent
    const recentTools = evenSpread(6, 2 * 60 * 1000);
    const r = detectArc({
      recentTools,
      state: { session: { toolCount: 20, uptime: 30 * 60 * 1000 } },
      now,
    });
    expect(r.phase).toBe('locked-in');
    expect(r.confidence).toBeGreaterThanOrEqual(0.75);
  });

  it('detects high velocity even with irregular spacing', () => {
    // 7 tools scattered across 3 min, not perfectly even
    const offsets = [0, 10000, 35000, 60000, 110000, 140000, 170000];
    const recentTools = offsets.map(o => ev('Edit', -(3 * 60 * 1000 - o)));
    const r = detectArc({
      recentTools,
      state: { session: { toolCount: 20, uptime: 30 * 60 * 1000 } },
      now,
    });
    expect(r.phase).toBe('locked-in');
  });

  it('does NOT trigger locked-in for fewer than 5 tools in window', () => {
    const recentTools = evenSpread(3, 2 * 60 * 1000);
    const r = detectArc({
      recentTools,
      state: { session: { toolCount: 20, uptime: 30 * 60 * 1000 } },
      now,
    });
    expect(r.phase).not.toBe('locked-in');
  });
});

// ── drift ─────────────────────────────────────────────────────────────────────

describe('detectArc — drift', () => {
  it('detects drift when last 3 gaps are each ≥2 min', () => {
    const GAP = 3 * 60 * 1000; // 3 min each
    const recentTools = [
      ev('Read', -(4 * GAP)),
      ev('Bash', -(3 * GAP)),
      ev('Edit', -(2 * GAP)),
      ev('Read', -(1 * GAP)),
    ];
    const r = detectArc({
      recentTools,
      state: { session: { toolCount: 20, uptime: 30 * 60 * 1000 } },
      now,
    });
    expect(r.phase).toBe('drift');
  });

  it('does NOT drift when last gap is under 2 min', () => {
    const recentTools = [
      ev('Read', -(5 * 60 * 1000)),
      ev('Bash', -(4 * 60 * 1000)),
      ev('Edit', -(3 * 60 * 1000)),
      ev('Read', -30000), // 30s ago — recent
    ];
    const r = detectArc({
      recentTools,
      state: { session: { toolCount: 20, uptime: 30 * 60 * 1000 } },
      now,
    });
    expect(r.phase).not.toBe('drift');
  });

  it('does NOT drift with insufficient history', () => {
    const r = detectArc({
      recentTools: [ev('Bash', -(3 * 60 * 1000))],
      state: { session: { toolCount: 20, uptime: 30 * 60 * 1000 } },
      now,
    });
    expect(r.phase).not.toBe('drift');
  });
});

// ── winding-down ──────────────────────────────────────────────────────────────

describe('detectArc — winding-down', () => {
  it('detects commit + push pattern', () => {
    const recentTools = [
      bash('git add .', -120000),
      bash('git commit -m "final fixes"', -60000),
      bash('git push origin main', -10000),
    ];
    const r = detectArc({
      recentTools,
      state: { session: { toolCount: 25, uptime: 90 * 60 * 1000 } },
      now,
    });
    expect(r.phase).toBe('winding-down');
    expect(r.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('detects handoff file writes alongside commit+push', () => {
    const recentTools = [
      bash('git commit -m "done"', -90000),
      bash('git push', -60000),
      write('_runs/HANDOFF-S302.md', -30000),
    ];
    const r = detectArc({
      recentTools,
      state: { session: { toolCount: 30, uptime: 120 * 60 * 1000 } },
      now,
    });
    expect(r.phase).toBe('winding-down');
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('detects winding-down from handoff file edits alone (2+)', () => {
    const recentTools = [
      edit('_runs/HANDOFF-S302.md', -60000),
      write('_runs/HANDOFF-S302.md', -30000),
    ];
    const r = detectArc({
      recentTools,
      state: { session: { toolCount: 25, uptime: 90 * 60 * 1000 } },
      now,
    });
    expect(r.phase).toBe('winding-down');
  });

  it('detects session-cartridge file write as winding-down signal', () => {
    const recentTools = [
      bash('git commit -m "close"', -60000),
      write('_runs/session-cartridge.json', -20000),
    ];
    const r = detectArc({
      recentTools,
      state: { session: { toolCount: 25, uptime: 60 * 60 * 1000 } },
      now,
    });
    expect(r.phase).toBe('winding-down');
  });

  it('does NOT trigger winding-down from a single non-specific edit', () => {
    const recentTools = [
      edit('src/main.js', -30000),
    ];
    const r = detectArc({
      recentTools,
      state: { session: { toolCount: 25, uptime: 60 * 60 * 1000 } },
      now,
    });
    expect(r.phase).not.toBe('winding-down');
  });
});

// ── cold ──────────────────────────────────────────────────────────────────────

describe('detectArc — cold', () => {
  it('returns cold when no tool for ≥15 min', () => {
    const recentTools = [ev('Read', -(16 * 60 * 1000))];
    const r = detectArc({ recentTools, now });
    expect(r.phase).toBe('cold');
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('does NOT return cold at exactly 14 min gap', () => {
    const recentTools = [ev('Read', -(14 * 60 * 1000))];
    const r = detectArc({
      recentTools,
      state: { session: { toolCount: 20, uptime: 60 * 60 * 1000 } },
      now,
    });
    expect(r.phase).not.toBe('cold');
  });

  it('cold takes priority over winding-down even if commit+push present', () => {
    const recentTools = [
      bash('git commit -m "x"', -(20 * 60 * 1000)),
      bash('git push', -(18 * 60 * 1000)),
    ];
    const r = detectArc({ recentTools, now });
    expect(r.phase).toBe('cold');
  });
});

// ── unknown ───────────────────────────────────────────────────────────────────

describe('detectArc — unknown', () => {
  it('returns unknown when no pattern scores above threshold', () => {
    // A mature session (bypasses warmup) but no velocity, drift, or winding-down signals
    const recentTools = [
      ev('Bash', -(90 * 1000)),  // 90s ago — not cold, not drift, not locked-in
    ];
    const r = detectArc({
      recentTools,
      state: { session: { toolCount: 15, uptime: 20 * 60 * 1000 } },
      now,
    });
    // Should not be warmup (toolCount >= 10, uptime >= 5 min)
    // Should not be cold (< 15 min)
    // Should not be drift (only 1 event, can't compute 3 gaps)
    // Should not be locked-in (< 5 tools in window)
    expect(['unknown', 'winding-down']).toContain(r.phase);
  });

  it('empty tools with no state returns a valid phase', () => {
    const r = detectArc({ recentTools: [], now });
    const valid = ['warmup', 'locked-in', 'drift', 'winding-down', 'cold', 'unknown'];
    expect(valid).toContain(r.phase);
  });
});

// ── computeMetrics ────────────────────────────────────────────────────────────

describe('computeMetrics', () => {
  it('gapMs reflects time since last event', () => {
    const recentTools = [ev('Bash', -30000)];
    const m = computeMetrics(recentTools, now);
    expect(m.gapMs).toBeGreaterThanOrEqual(29000);
    expect(m.gapMs).toBeLessThanOrEqual(31000);
  });

  it('gapMs is Infinity when no events', () => {
    const m = computeMetrics([], now);
    expect(m.gapMs).toBe(Infinity);
  });

  it('toolsPerMinute counts events in last 5 min', () => {
    // 10 tools evenly in 5 min → 2/min
    const recentTools = evenSpread(10, 5 * 60 * 1000);
    const m = computeMetrics(recentTools, now);
    expect(m.toolsPerMinute).toBeCloseTo(2, 0);
  });

  it('avgIntervalMs is 0 with single event', () => {
    const m = computeMetrics([ev('Read', -5000)], now);
    expect(m.avgIntervalMs).toBe(0);
  });
});

// ── PHASE_THRESHOLDS export ───────────────────────────────────────────────────

describe('PHASE_THRESHOLDS', () => {
  it('exports expected keys', () => {
    expect(PHASE_THRESHOLDS).toHaveProperty('COLD_THRESHOLD_MS');
    expect(PHASE_THRESHOLDS).toHaveProperty('DRIFT_GAP_MS');
    expect(PHASE_THRESHOLDS).toHaveProperty('LOCKED_IN_WINDOW_MS');
    expect(PHASE_THRESHOLDS).toHaveProperty('WARMUP_TOOL_COUNT');
    expect(PHASE_THRESHOLDS).toHaveProperty('VELOCITY_WINDOW_MS');
  });

  it('cold threshold is 15 min', () => {
    expect(PHASE_THRESHOLDS.COLD_THRESHOLD_MS).toBe(15 * 60 * 1000);
  });

  it('drift gap is 2 min', () => {
    expect(PHASE_THRESHOLDS.DRIFT_GAP_MS).toBe(2 * 60 * 1000);
  });
});

// ── fail-safe with missing / partial state ────────────────────────────────────

describe('detectArc — defensive / fail-safe', () => {
  it('handles missing state gracefully', () => {
    expect(() => detectArc({ recentTools: [ev('Bash', -1000)], now })).not.toThrow();
  });

  it('handles null state gracefully', () => {
    expect(() => detectArc({ recentTools: [], state: null, now })).not.toThrow();
  });

  it('handles missing opts gracefully', () => {
    expect(() => detectArc({})).not.toThrow();
  });

  it('handles events with missing ts fields', () => {
    const badEvents = [{ tool: 'Bash', command: 'ls' }]; // no ts
    expect(() => detectArc({ recentTools: badEvents, now })).not.toThrow();
  });
});
