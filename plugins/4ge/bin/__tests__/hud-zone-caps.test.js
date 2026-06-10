import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

function requireFresh() {
  for (const key of Object.keys(_require.cache)) {
    if (key.includes('hud-zone-caps') || key.includes('hud-palette')) {
      delete _require.cache[key];
    }
  }
  return _require(path.resolve(__dirname, '../hud-zone-caps.cjs'));
}

const { stripAnsi } = _require(path.resolve(__dirname, '../hud-palette.cjs'));

describe('ZONE_META', () => {
  it('has priority 6', () => {
    const { ZONE_META } = requireFresh();
    expect(ZONE_META.priority).toBe(6);
  });

  it('has minRows 1 and idealRows 2', () => {
    const { ZONE_META } = requireFresh();
    expect(ZONE_META.minRows).toBe(1);
    expect(ZONE_META.idealRows).toBe(2);
  });
});

describe('CAP_ORDER', () => {
  it('defines expected capabilities in order', () => {
    const { CAP_ORDER } = requireFresh();
    expect(Array.isArray(CAP_ORDER)).toBe(true);
    expect(CAP_ORDER.length).toBeGreaterThan(0);
    expect(CAP_ORDER).toContain('git');
    expect(CAP_ORDER).toContain('infra');
    expect(CAP_ORDER).toContain('audit');
  });
});

describe('renderCapsZone', () => {
  const palette = { ok: '', warn: '', error: '', accent: '', muted: '', text: '', bg: '', reset: '' };

  it('returns fallback when no capabilities', () => {
    const { renderCapsZone } = requireFresh();
    const state = { os: { capabilities: {} } };
    const lines = renderCapsZone(state, palette);
    const text = lines.map(l => stripAnsi(l)).join(' ');
    expect(text).toContain('no capability data');
  });

  it('shows all-ready when every cap is ok', () => {
    const { renderCapsZone } = requireFresh();
    const state = {
      os: {
        capabilities: {
          git: { ok: true },
          memory: { ok: true },
          audit: { ok: true },
        },
      },
    };
    const lines = renderCapsZone(state, palette);
    const text = lines.map(l => stripAnsi(l)).join(' ');
    expect(text).toContain('all 3 ready');
  });

  it('shows grid when some caps degraded', () => {
    const { renderCapsZone } = requireFresh();
    const state = {
      os: {
        capabilities: {
          git: { ok: true },
          memory: { ok: false },
          audit: { ok: true },
        },
      },
    };
    const lines = renderCapsZone(state, palette);
    expect(lines.length).toBeGreaterThan(0);
    const text = lines.map(l => stripAnsi(l)).join(' ');
    expect(text).toContain('\u25CF'); // dot marker
  });

  it('respects CAP_ORDER for rendering order', () => {
    const { renderCapsZone } = requireFresh();
    const state = {
      os: {
        capabilities: {
          audit: { ok: true },
          git: { ok: false },
          infra: { ok: true },
        },
      },
    };
    const lines = renderCapsZone(state, palette);
    const text = lines.map(l => stripAnsi(l)).join(' ');
    // git comes before infra in CAP_ORDER, infra before audit
    const gitIdx = text.indexOf('git');
    const infraIdx = text.indexOf('infra');
    const auditIdx = text.indexOf('audit');
    expect(gitIdx).toBeLessThan(infraIdx);
    expect(infraIdx).toBeLessThan(auditIdx);
  });

  it('handles caps not in CAP_ORDER', () => {
    const { renderCapsZone } = requireFresh();
    const state = {
      os: {
        capabilities: {
          'custom-cap': { ok: true },
          git: { ok: false },
        },
      },
    };
    const lines = renderCapsZone(state, palette);
    const text = lines.map(l => stripAnsi(l)).join(' ');
    expect(text).toContain('custom-cap');
    expect(text).toContain('git');
  });

  it('handles missing os gracefully', () => {
    const { renderCapsZone } = requireFresh();
    const state = {};
    const lines = renderCapsZone(state, palette);
    expect(Array.isArray(lines)).toBe(true);
  });
});
