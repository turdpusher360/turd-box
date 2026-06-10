import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

function requireFresh() {
  for (const key of Object.keys(_require.cache)) {
    if (key.includes('hud-zone-badges') || key.includes('hud-palette')) {
      delete _require.cache[key];
    }
  }
  return _require(path.resolve(__dirname, '../hud-zone-badges.cjs'));
}

const { stripAnsi } = _require(path.resolve(__dirname, '../hud-palette.cjs'));

describe('ZONE_META', () => {
  it('has priority 2', () => {
    const { ZONE_META } = requireFresh();
    expect(ZONE_META.priority).toBe(2);
  });

  it('has minRows 1 and idealRows 2', () => {
    const { ZONE_META } = requireFresh();
    expect(ZONE_META.minRows).toBe(1);
    expect(ZONE_META.idealRows).toBe(2);
  });
});

describe('BADGE_DEFS', () => {
  it('defines 10 badges', () => {
    const { BADGE_DEFS } = requireFresh();
    expect(BADGE_DEFS.length).toBe(10);
  });

  it('each badge has id, name, and desc', () => {
    const { BADGE_DEFS } = requireFresh();
    for (const badge of BADGE_DEFS) {
      expect(typeof badge.id).toBe('string');
      expect(typeof badge.name).toBe('string');
      expect(typeof badge.desc).toBe('string');
      expect(badge.id.length).toBeGreaterThan(0);
    }
  });

  it('badge IDs are unique', () => {
    const { BADGE_DEFS } = requireFresh();
    const ids = BADGE_DEFS.map(b => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('renderBadgesZone', () => {
  const palette = { ok: '', warn: '', error: '', accent: '', muted: '', text: '', bg: '', reset: '' };

  it('returns array of strings', () => {
    const { renderBadgesZone } = requireFresh();
    const state = { badges: { earned: {}, newThisSession: [] } };
    const lines = renderBadgesZone(state, palette);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
  });

  it('renders earned badges with diamond marker', () => {
    const { renderBadgesZone, BADGE_DEFS } = requireFresh();
    const state = {
      badges: {
        earned: { [BADGE_DEFS[0].id]: '2026-04-10T00:00:00Z' },
        newThisSession: [],
      },
    };
    const lines = renderBadgesZone(state, palette);
    const text = lines.map(l => stripAnsi(l)).join('\n');
    expect(text).toContain('\u25C6'); // diamond
    expect(text).toContain(BADGE_DEFS[0].name);
  });

  it('renders new badges with star marker and NEW callout', () => {
    const { renderBadgesZone, BADGE_DEFS } = requireFresh();
    const badgeId = BADGE_DEFS[0].id;
    const state = {
      badges: {
        earned: { [badgeId]: '2026-04-10T00:00:00Z' },
        newThisSession: [badgeId],
      },
    };
    const lines = renderBadgesZone(state, palette);
    const text = lines.map(l => stripAnsi(l)).join('\n');
    expect(text).toContain('\u2605'); // star
    expect(text).toContain('NEW');
  });

  it('renders locked badges with circle marker', () => {
    const { renderBadgesZone } = requireFresh();
    const state = { badges: { earned: {}, newThisSession: [] } };
    const lines = renderBadgesZone(state, palette);
    const text = lines.map(l => stripAnsi(l)).join('\n');
    expect(text).toContain('\u25CB'); // circle (locked)
  });

  it('handles missing badges state gracefully', () => {
    const { renderBadgesZone } = requireFresh();
    const state = {};
    const lines = renderBadgesZone(state, palette);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
  });
});
