import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

function requireFresh() {
  for (const key of Object.keys(_require.cache)) {
    if (key.includes('hud-zone-session') || key.includes('hud-palette')) {
      delete _require.cache[key];
    }
  }
  return _require(path.resolve(__dirname, '../hud-zone-session.cjs'));
}

const { stripAnsi } = _require(path.resolve(__dirname, '../hud-palette.cjs'));

describe('ZONE_META', () => {
  it('has priority 1 (lowest)', () => {
    const { ZONE_META } = requireFresh();
    expect(ZONE_META.priority).toBe(1);
  });

  it('has minRows 1 and idealRows 4', () => {
    const { ZONE_META } = requireFresh();
    expect(ZONE_META.minRows).toBe(1);
    expect(ZONE_META.idealRows).toBe(4);
  });
});

describe('renderSessionZone', () => {
  const palette = { ok: '', warn: '', error: '', accent: '', muted: '', text: '', glow: '', bg: '', reset: '' };

  it('shows default message when no data available', () => {
    const { renderSessionZone } = requireFresh();
    const state = { session: {}, memory: {} };
    const lines = renderSessionZone(state, palette);
    const text = lines.map(l => stripAnsi(l)).join(' ');
    expect(text).toContain('No session history loaded');
  });

  it('shows last session recall', () => {
    const { renderSessionZone } = requireFresh();
    const state = { session: {}, memory: { lastSession: 'worked on HUD tests' } };
    const lines = renderSessionZone(state, palette);
    const text = lines.map(l => stripAnsi(l)).join(' ');
    expect(text).toContain('Last session');
    expect(text).toContain('worked on HUD tests');
  });

  it('shows parked work', () => {
    const { renderSessionZone } = requireFresh();
    const state = { session: {}, memory: { parked: 'forge phase 3' } };
    const lines = renderSessionZone(state, palette);
    const text = lines.map(l => stripAnsi(l)).join(' ');
    expect(text).toContain('Parked');
    expect(text).toContain('forge phase 3');
  });

  it('shows next action', () => {
    const { renderSessionZone } = requireFresh();
    const state = { session: {}, memory: { next: 'run audit' } };
    const lines = renderSessionZone(state, palette);
    const text = lines.map(l => stripAnsi(l)).join(' ');
    expect(text).toContain('Next');
    expect(text).toContain('run audit');
  });

  it('shows uptime in minutes', () => {
    const { renderSessionZone } = requireFresh();
    const state = { session: { uptime: 300000 }, memory: {} }; // 5 minutes
    const lines = renderSessionZone(state, palette);
    const text = lines.map(l => stripAnsi(l)).join(' ');
    expect(text).toContain('Uptime');
    expect(text).toContain('5m');
  });

  it('shows uptime in hours and minutes when over 1 hour', () => {
    const { renderSessionZone } = requireFresh();
    const state = { session: { uptime: 5400000 }, memory: {} }; // 1.5 hours
    const lines = renderSessionZone(state, palette);
    const text = lines.map(l => stripAnsi(l)).join(' ');
    expect(text).toContain('1h 30m');
  });

  it('does not show uptime when zero', () => {
    const { renderSessionZone } = requireFresh();
    const state = { session: { uptime: 0 }, memory: { lastSession: 'test' } };
    const lines = renderSessionZone(state, palette);
    const text = lines.map(l => stripAnsi(l)).join(' ');
    expect(text).not.toContain('Uptime');
  });

  it('shows all fields together', () => {
    const { renderSessionZone } = requireFresh();
    const state = {
      session: { uptime: 600000 },
      memory: { lastSession: 'HUD work', parked: 'forge phase', next: 'deploy' },
    };
    const lines = renderSessionZone(state, palette);
    expect(lines.length).toBe(4); // last, parked, next, uptime
  });
});
