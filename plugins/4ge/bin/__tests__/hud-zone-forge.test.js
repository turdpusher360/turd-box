import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);
const MODULE_PATH = path.resolve(__dirname, '../hud-zone-forge.cjs');

function requireFresh() {
  for (const key of Object.keys(_require.cache)) {
    if (key.includes('hud-zone-forge') || key.includes('hud-palette')) delete _require.cache[key];
  }
  return _require(MODULE_PATH);
}

const palette = {
  ok: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m',
  accent: '\x1b[36m', muted: '\x1b[90m', text: '\x1b[37m',
  bg: '\x1b[40m', reset: '\x1b[0m',
};

describe('renderForgeZone', () => {
  it('inactive forge returns single line', () => {
    const { renderForgeZone } = requireFresh();
    const { stripAnsi } = _require(path.resolve(__dirname, '../hud-palette.cjs'));
    const state = { forge: { active: false, phase: null, teammates: [], scope: null } };
    const lines = renderForgeZone(state, palette);
    expect(lines).toHaveLength(1);
    expect(stripAnsi(lines[0])).toContain('no active session');
  });

  it('active forge shows pipeline markers', () => {
    const { renderForgeZone } = requireFresh();
    const { stripAnsi } = _require(path.resolve(__dirname, '../hud-palette.cjs'));
    const state = { forge: { active: true, phase: 'execute', teammates: [], scope: 'test' } };
    const lines = renderForgeZone(state, palette);
    expect(lines.length).toBeGreaterThan(1);
    const pipelineText = stripAnsi(lines[1]);
    expect(pipelineText).toContain('\u25CF');
    expect(pipelineText).toContain('\u25C6');
    expect(pipelineText).toContain('\u25CB');
  });

  it('active forge with teammates shows teammate rows', () => {
    const { renderForgeZone } = requireFresh();
    const state = {
      forge: { active: true, phase: 'plan', teammates: [{ name: 'worker', phase: 'plan', scope: 'zone', status: '[2/5]' }], scope: 'test' },
    };
    const lines = renderForgeZone(state, palette);
    expect(lines.length).toBeGreaterThanOrEqual(3);
  });
});

describe('phaseIndex', () => {
  it('returns 1-indexed for known phases', () => {
    const { phaseIndex } = requireFresh();
    expect(phaseIndex('scope')).toBe(1);
    expect(phaseIndex('execute')).toBe(5);
    expect(phaseIndex('ship')).toBe(7);
  });

  it('returns 0 for null/unknown', () => {
    const { phaseIndex } = requireFresh();
    expect(phaseIndex(null)).toBe(0);
    expect(phaseIndex('bogus')).toBe(0);
  });
});

describe('ZONE_META', () => {
  it('has correct metadata', () => {
    const { ZONE_META } = requireFresh();
    expect(ZONE_META.idealRows).toBe(6);
  });
});

describe('PHASES', () => {
  it('exports 7 phases', () => {
    const { PHASES } = requireFresh();
    expect(PHASES).toHaveLength(7);
    expect(PHASES[0]).toBe('scope');
    expect(PHASES[6]).toBe('ship');
  });
});
