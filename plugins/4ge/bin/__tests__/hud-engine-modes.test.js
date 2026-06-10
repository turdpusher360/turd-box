import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);
const MOCK_HEALTHY = path.resolve(__dirname, '../mocks/healthy.json');
const MOCK_DEGRADED = path.resolve(__dirname, '../mocks/degraded.json');

function requireFresh() {
  for (const key of Object.keys(_require.cache)) {
    if (key.includes('hud-engine') || key.includes('hud-palette') || key.includes('hud-state') ||
        key.includes('hud-canvas') || key.includes('hud-zone') || key.includes('hud-expressions') ||
        key.includes('companion-state') || key.includes('hud-data-loader')) {
      delete _require.cache[key];
    }
  }
  return _require(path.resolve(__dirname, '../hud-engine.cjs'));
}

const { stripAnsi } = _require(path.resolve(__dirname, '../hud-palette.cjs'));

describe('renderByMode routing', () => {
  it('routes "strip" to renderStrip', () => {
    const mod = requireFresh();
    const state = JSON.parse(fs.readFileSync(MOCK_HEALTHY, 'utf8'));
    const output = mod.renderByMode(state, 'strip');
    expect(typeof output).toBe('string');
    expect(output).not.toContain('\n');
  });

  it('routes "full" to renderFull', () => {
    const mod = requireFresh();
    const state = JSON.parse(fs.readFileSync(MOCK_HEALTHY, 'utf8'));
    const output = mod.renderByMode(state, 'full');
    expect(typeof output).toBe('string');
    expect(output).toContain('\n');
  });

  it('routes "compact" to renderCompact', () => {
    const mod = requireFresh();
    const state = JSON.parse(fs.readFileSync(MOCK_HEALTHY, 'utf8'));
    const output = mod.renderByMode(state, 'compact');
    expect(typeof output).toBe('string');
    expect(output.length).toBeGreaterThan(0);
  });

  it('routes "zone" to renderZone', () => {
    const mod = requireFresh();
    const state = JSON.parse(fs.readFileSync(MOCK_HEALTHY, 'utf8'));
    const output = mod.renderByMode(state, 'zone');
    expect(typeof output).toBe('string');
    expect(output.length).toBeGreaterThan(0);
  });

  it('routes unknown mode to renderFull', () => {
    const mod = requireFresh();
    const state = JSON.parse(fs.readFileSync(MOCK_HEALTHY, 'utf8'));
    // renderFull embeds the time-animated "breathing" orb (renderColoredOrb), seeded by
    // Date.now() at millisecond resolution when the session is active. Two back-to-back
    // renders land on different ms → different orb frame, so a naive byte-equality is
    // nondeterministic (green only when the session is idle / clock frozen). Freeze the
    // clock so both renders share one frame; the assertion then genuinely proves that an
    // unknown mode routes to renderFull rather than accidentally passing on a stable frame.
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      const output = mod.renderByMode(state, 'invalid-mode');
      const fullOutput = mod.renderFull(state);
      expect(output).toBe(fullOutput);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('routes "scene" to renderScene', () => {
    const mod = requireFresh();
    const state = JSON.parse(fs.readFileSync(MOCK_HEALTHY, 'utf8'));
    const output = mod.renderByMode(state, 'scene', 10);
    expect(typeof output).toBe('string');
    expect(output).toContain('\n');
    const lineCount = output.split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(10);
    expect(lineCount).toBeGreaterThan(0);
  });
});

describe('renderCompact output structure', () => {
  it('returns 1 line when no event', () => {
    const mod = requireFresh();
    const state = JSON.parse(fs.readFileSync(MOCK_HEALTHY, 'utf8'));
    const output = mod.renderCompact(state);
    const lines = output.split('\n').filter(l => l.trim().length > 0);
    expect(lines.length).toBe(1);
  });

  it('returns 2 lines when event is present', () => {
    const mod = requireFresh();
    const state = JSON.parse(fs.readFileSync(MOCK_HEALTHY, 'utf8'));
    state.context = { trigger: 'command', event: 'commit', zone: null };
    const output = mod.renderCompact(state);
    const lines = output.split('\n').filter(l => l.trim().length > 0);
    expect(lines.length).toBe(2);
  });

  it('includes health score in output', () => {
    const mod = requireFresh();
    const state = JSON.parse(fs.readFileSync(MOCK_HEALTHY, 'utf8'));
    const output = mod.renderCompact(state);
    const plain = stripAnsi(output);
    expect(plain).toContain('Health');
  });
});

describe('renderFull with degraded state', () => {
  it('produces valid output', () => {
    const mod = requireFresh();
    const state = JSON.parse(fs.readFileSync(MOCK_DEGRADED, 'utf8'));
    const output = mod.renderFull(state);
    expect(typeof output).toBe('string');
    expect(output.length).toBeGreaterThan(0);
  });

  it('contains health info', () => {
    const mod = requireFresh();
    const state = JSON.parse(fs.readFileSync(MOCK_DEGRADED, 'utf8'));
    const output = mod.renderFull(state);
    expect(output).toContain('Health');
  });
});

describe('renderZone with specific zones', () => {
  it('renders health zone', () => {
    const mod = requireFresh();
    const state = JSON.parse(fs.readFileSync(MOCK_HEALTHY, 'utf8'));
    state.context = { trigger: 'command', event: null, zone: 'health' };
    const output = mod.renderZone(state);
    expect(typeof output).toBe('string');
    expect(output.length).toBeGreaterThan(0);
  });

  it('renders caps zone', () => {
    const mod = requireFresh();
    const state = JSON.parse(fs.readFileSync(MOCK_HEALTHY, 'utf8'));
    state.context = { trigger: 'command', event: null, zone: 'caps' };
    const output = mod.renderZone(state);
    expect(typeof output).toBe('string');
  });

  it('renders forge zone', () => {
    const mod = requireFresh();
    const state = JSON.parse(fs.readFileSync(MOCK_HEALTHY, 'utf8'));
    state.context = { trigger: 'command', event: null, zone: 'forge' };
    const output = mod.renderZone(state);
    expect(typeof output).toBe('string');
  });

  it('falls back to face for unknown zone', () => {
    const mod = requireFresh();
    const state = JSON.parse(fs.readFileSync(MOCK_HEALTHY, 'utf8'));
    state.context = { trigger: 'command', event: null, zone: 'nonexistent' };
    const output = mod.renderZone(state);
    expect(typeof output).toBe('string');
    expect(output.length).toBeGreaterThan(0);
  });
});
