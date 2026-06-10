import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

const ENGINE_PATH = path.resolve(__dirname, '../hud-engine.cjs');

// Import the zone meta priorities for reference
const FORGE_META_PATH = path.resolve(__dirname, '../hud-zone-forge.cjs');
const BADGES_META_PATH = path.resolve(__dirname, '../hud-zone-badges.cjs');
const SESSION_META_PATH = path.resolve(__dirname, '../hud-zone-session.cjs');
const CAPS_META_PATH = path.resolve(__dirname, '../hud-zone-caps.cjs');

function freshEngine() {
  delete _require.cache[_require.resolve(ENGINE_PATH)];
  return _require(ENGINE_PATH);
}

// Build minimal rawState with a given event
function stateWith(event, extras = {}) {
  return {
    terminal: { cols: 120, rows: 40 },
    context: { trigger: 'test', event },
    ...extras,
  };
}

describe('hud-engine zone ordering — event boosts', () => {
  it('renders without error for forge-phase event', () => {
    const { renderFull } = freshEngine();
    const output = renderFull(stateWith('forge-phase', {
      forge: { active: true, phase: 'P2', teammates: [], scope: 'test' },
    }));
    expect(typeof output).toBe('string');
    expect(output.length).toBeGreaterThan(0);
  });

  it('renders without error for badge-earned event', () => {
    const { renderFull } = freshEngine();
    const output = renderFull(stateWith('badge-earned'));
    expect(typeof output).toBe('string');
    expect(output.length).toBeGreaterThan(0);
  });

  it('renders without error for test-pass event', () => {
    const { renderFull } = freshEngine();
    const output = renderFull(stateWith('test-pass'));
    expect(typeof output).toBe('string');
    expect(output.length).toBeGreaterThan(0);
  });

  it('renders without error for test-fail event', () => {
    const { renderFull } = freshEngine();
    const output = renderFull(stateWith('test-fail'));
    expect(typeof output).toBe('string');
    expect(output.length).toBeGreaterThan(0);
  });

  it('renders without error for unknown event (no boost)', () => {
    const { renderFull } = freshEngine();
    const output = renderFull(stateWith('zone-change'));
    expect(typeof output).toBe('string');
    expect(output.length).toBeGreaterThan(0);
  });

  it('renders without error when no event is present', () => {
    const { renderFull } = freshEngine();
    const output = renderFull(stateWith(null));
    expect(typeof output).toBe('string');
    expect(output.length).toBeGreaterThan(0);
  });
});

describe('hud-engine zone ordering — ZONE_META constants unchanged', () => {
  it('forge ZONE_META priority is still 5 after a forge-phase render', () => {
    freshEngine(); // trigger module load
    const { ZONE_META: forgeMeta } = _require(FORGE_META_PATH);
    expect(forgeMeta.priority).toBe(5);
  });

  it('badges ZONE_META priority is still 2 after a badge-earned render', () => {
    freshEngine();
    const { ZONE_META: badgesMeta } = _require(BADGES_META_PATH);
    expect(badgesMeta.priority).toBe(2);
  });

  it('session ZONE_META priority is still 1 after a test-pass render', () => {
    freshEngine();
    const { ZONE_META: sessionMeta } = _require(SESSION_META_PATH);
    expect(sessionMeta.priority).toBe(1);
  });

  it('caps ZONE_META priority is still 6 (not boosted by any event)', () => {
    freshEngine();
    const { ZONE_META: capsMeta } = _require(CAPS_META_PATH);
    expect(capsMeta.priority).toBe(6);
  });
});

describe('hud-engine zone ordering — content presence', () => {
  it('forge-phase render includes forge zone content when forge is active', () => {
    const { renderFull } = freshEngine();
    const output = renderFull(stateWith('forge-phase', {
      forge: { active: true, phase: 'P3', teammates: [], scope: 'my-session' },
    }));
    // FORGE zone renders its name when active
    expect(output).toContain('FORGE');
  });

  it('compact mode handles badge-earned event message', () => {
    const { renderCompact } = freshEngine();
    const output = renderCompact(stateWith('badge-earned'));
    expect(typeof output).toBe('string');
    expect(output).toContain('badge earned');
  });

  it('compact mode handles test-pass event message', () => {
    const { renderCompact } = freshEngine();
    const output = renderCompact(stateWith('test-pass'));
    expect(output).toContain('all tests green');
  });

  it('compact mode handles test-fail event message', () => {
    const { renderCompact } = freshEngine();
    const output = renderCompact(stateWith('test-fail'));
    expect(output).toContain('tests failed');
  });
});
