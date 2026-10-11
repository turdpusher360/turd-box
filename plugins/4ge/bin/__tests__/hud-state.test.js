import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);
const MODULE_PATH = path.resolve(__dirname, '../hud-state.cjs');

function requireFresh() {
  delete process.env.NO_COLOR;
  process.env.CLICOLOR_FORCE = '1';
  // Clear caches
  for (const key of Object.keys(_require.cache)) {
    if (key.includes('hud-state') || key.includes('hud-palette')) {
      delete _require.cache[key];
    }
  }
  return _require(MODULE_PATH);
}

describe('buildCanonicalState', () => {
  it('returns full state from complete input', () => {
    const { buildCanonicalState } = requireFresh();
    const input = {
      terminal: { cols: 120, rows: 40 },
      session: { id: 's1', model: 'opus', contextPct: 32, rateLimits: { fiveHour: 18, sevenDay: 9 }, uptime: 3600000 },
      os: {
        overallHealth: 'ready',
        bootTime: 1819,
        capabilities: { memory: { ok: true, status: 'ready', init_ms: 228 } },
      },
      forge: { active: false, phase: null, teammates: [], scope: null },
      context: { trigger: 'command', event: null, zone: null },
      theme: { name: 'dark-ansi' },
      mode: 'full',
    };
    const state = buildCanonicalState(input);
    expect(state.terminal.cols).toBe(79); // capped at MAX_BASH_COLS
    expect(state.session.model).toBe('opus');
    expect(state.os.capabilities.memory.ok).toBe(true);
    expect(state.palette).toBeDefined();
    expect(state.palette.ok).toContain('\x1b[');
    expect(state.mode).toBe('full');
  });

  it('applies safe defaults for empty input', () => {
    const { buildCanonicalState } = requireFresh();
    const state = buildCanonicalState({});
    expect(state.terminal.cols).toBeGreaterThan(0);
    expect(state.terminal.rows).toBeGreaterThan(0);
    expect(state.session.contextPct).toBe(0);
    expect(state.os.capabilities).toEqual({});
    expect(state.forge.active).toBe(false);
    expect(state.mode).toBe('full');
    expect(state.palette).toBeDefined();
  });

  it('applies safe defaults for null input', () => {
    const { buildCanonicalState } = requireFresh();
    const state = buildCanonicalState(null);
    expect(state.terminal.cols).toBeGreaterThan(0);
    expect(state.mode).toBe('full');
  });

  it('clamps contextPct to 0-100', () => {
    const { buildCanonicalState } = requireFresh();
    const state = buildCanonicalState({ session: { contextPct: 150 } });
    expect(state.session.contextPct).toBe(100);
    const state2 = buildCanonicalState({ session: { contextPct: -5 } });
    expect(state2.session.contextPct).toBe(0);
  });

  it('preserves mode from input', () => {
    const { buildCanonicalState } = requireFresh();
    const state = buildCanonicalState({ mode: 'strip' });
    expect(state.mode).toBe('strip');
  });
});

describe('countDegraded', () => {
  it('counts capabilities where ok is false', () => {
    const { countDegraded } = requireFresh();
    const caps = {
      memory: { ok: false },
      git: { ok: true },
      aisle: { ok: false },
    };
    expect(countDegraded(caps)).toBe(2);
  });

  it('returns 0 for empty caps', () => {
    const { countDegraded } = requireFresh();
    expect(countDegraded({})).toBe(0);
  });
});

describe('classifyCapabilityHealth', () => {
  it.each([
    ['a capability without ok as unknown', { probe: { status: 'degraded' } }, { ready: [], failed: [], unknown: ['probe'] }],
    ['a null capability as unknown', { probe: null }, { ready: [], failed: [], unknown: ['probe'] }],
    ['a non-boolean ok as unknown', { probe: { ok: 'false' } }, { ready: [], failed: [], unknown: ['probe'] }],
    ['a mix of ready and unknown', { git: { ok: true }, probe: {} }, { ready: ['git'], failed: [], unknown: ['probe'] }],
    ['all observed ready', { git: { ok: true }, memory: { ok: true } }, { ready: ['git', 'memory'], failed: [], unknown: [] }],
    ['all observed failed', { git: { ok: false }, memory: { ok: false } }, { ready: [], failed: ['git', 'memory'], unknown: [] }],
  ])('classifies %s', (_label, caps, expected) => {
    const { classifyCapabilityHealth } = requireFresh();
    expect(classifyCapabilityHealth(caps)).toEqual({
      total: Object.keys(caps).length,
      ...expected,
    });
  });
});

// HUD r5 review P2-2: the one readiness count for ratios, colours and expressions.
describe('countNotReady', () => {
  it('counts a non-shelved ok:false plus every capability without a boolean ok', () => {
    const { countNotReady } = requireFresh();
    expect(countNotReady({
      ready: { ok: true },
      failed: { ok: false },
      unobserved: { status: 'degraded' },
      nullEntry: null,
      malformed: { ok: 'true' },
    })).toBe(4);
  });

  it('keeps a shelved ok:false ready (the AISLE exemption does not flip)', () => {
    const { countNotReady } = requireFresh();
    expect(countNotReady({ git: { ok: true }, aisle: { ok: false, shelved: true } })).toBe(0);
  });

  it('does not exempt a shelved capability that has no boolean ok', () => {
    const { countNotReady } = requireFresh();
    expect(countNotReady({ aisle: { shelved: true } })).toBe(1);
  });

  it('leaves countDegraded unchanged, so the two never need combining', () => {
    const { countNotReady, countDegraded } = requireFresh();
    const caps = {
      ready: { ok: true },
      failed: { ok: false },
      unobserved: {},
      nullEntry: null,
      shelved: { ok: false, shelved: true },
    };
    expect(countDegraded(caps)).toBe(1);
    expect(countNotReady(caps)).toBe(3);
  });

  it('returns 0 for a missing or non-object map', () => {
    const { countNotReady } = requireFresh();
    expect(countNotReady(undefined)).toBe(0);
    expect(countNotReady(null)).toBe(0);
    expect(countNotReady({})).toBe(0);
  });
});

// C2.2 A2: the statusline render mode gets its own width cap; every other mode
// keeps the 79-column Bash canvas (hud-state-defaults.test.js pins MAX_BASH_COLS).
describe('statusline width cap (C2.2 A2)', () => {
  it('lifts the cap for the statusline render mode only', () => {
    const { buildCanonicalState, MAX_BASH_COLS, MAX_STATUSLINE_COLS } = requireFresh();
    expect(MAX_STATUSLINE_COLS).toBeGreaterThan(MAX_BASH_COLS);
    const wide = { terminal: { cols: 200, rows: 46 } };
    expect(buildCanonicalState(wide, { renderMode: 'statusline' }).terminal.cols).toBe(MAX_STATUSLINE_COLS);
    for (const mode of ['full', 'strip', 'zone', 'compact', 'substrate', 'scene']) {
      expect(buildCanonicalState(wide, { renderMode: mode }).terminal.cols).toBe(MAX_BASH_COLS);
      expect(buildCanonicalState({ ...wide, mode }).terminal.cols).toBe(MAX_BASH_COLS);
    }
    expect(buildCanonicalState(wide).terminal.cols).toBe(MAX_BASH_COLS);
  });

  it('passes a width between the two caps through for the statusline and clamps it elsewhere', () => {
    const { buildCanonicalState, MAX_BASH_COLS } = requireFresh();
    const input = { terminal: { cols: 91, rows: 46 } };
    expect(buildCanonicalState(input, { renderMode: 'statusline' }).terminal.cols).toBe(91);
    expect(buildCanonicalState(input).terminal.cols).toBe(MAX_BASH_COLS);
    expect(buildCanonicalState({ terminal: { cols: 52 } }, { renderMode: 'statusline' }).terminal.cols).toBe(52);
  });

  it('never lets a raw mode field lift the cap', () => {
    // In the non-statusline CLI modes stdin is shallow-merged into the raw
    // state, so a stdin `mode` key must not widen the Bash canvas.
    const { buildCanonicalState, MAX_BASH_COLS, MAX_STATUSLINE_COLS } = requireFresh();
    expect(MAX_STATUSLINE_COLS).toBeGreaterThan(MAX_BASH_COLS);
    const state = buildCanonicalState({ terminal: { cols: 200 }, mode: 'statusline', renderMode: 'statusline' });
    expect(state.terminal.cols).toBe(MAX_BASH_COLS);
  });

  it('defaults the statusline cap to 132', () => {
    // Pinned literal: 132 (operator ruling 2026-09-28). It
    // follows hud-x's wide frame cap. This pin changes only on a new operator
    // ruling on the statusline cap; update it together with MAX_STATUSLINE_COLS.
    const { MAX_STATUSLINE_COLS } = requireFresh();
    expect(MAX_STATUSLINE_COLS).toBe(132);
  });
});
