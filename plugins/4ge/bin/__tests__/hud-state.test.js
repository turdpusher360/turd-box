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
