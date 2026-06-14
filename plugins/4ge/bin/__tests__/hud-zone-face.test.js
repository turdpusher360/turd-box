import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);
const MODULE_PATH = path.resolve(__dirname, '../hud-zone-face.cjs');

function requireFresh() {
  for (const key of Object.keys(_require.cache)) {
    if (key.includes('hud-zone-face') || key.includes('hud-palette') || key.includes('hud-state')) {
      delete _require.cache[key];
    }
  }
  return _require(MODULE_PATH);
}

describe('renderFaceZone', () => {
  it('returns 3 lines for wide terminal (side-by-side)', () => {
    const { renderFaceZone } = requireFresh();
    const palette = {
      ok: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m',
      accent: '\x1b[36m', muted: '\x1b[90m', text: '\x1b[37m',
      bg: '\x1b[40m', reset: '\x1b[0m',
    };
    const state = {
      terminal: { cols: 120, rows: 40 },
      os: { overallHealth: 'ready', bootTime: 1819, capabilities: { memory: { ok: true }, git: { ok: true } } },
      forge: { active: false },
    };
    const lines = renderFaceZone(state, palette);
    // Expression engine produces 4-row eyes composited into 6-line face art
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(lines.length).toBeLessThanOrEqual(6);
  });

  it('returns 1 line for narrow terminal (inline)', () => {
    const { renderFaceZone } = requireFresh();
    const palette = {
      ok: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m',
      accent: '\x1b[36m', muted: '\x1b[90m', text: '\x1b[37m',
      bg: '\x1b[40m', reset: '\x1b[0m',
    };
    const state = {
      terminal: { cols: 48, rows: 28 },
      os: { overallHealth: 'degraded', bootTime: 1200, capabilities: { memory: { ok: false }, git: { ok: true } } },
      forge: { active: false },
    };
    const lines = renderFaceZone(state, palette);
    expect(lines).toHaveLength(1);
  });

  it('includes face art in output', () => {
    const { renderFaceZone } = requireFresh();
    const { stripAnsi } = _require(path.resolve(__dirname, '../hud-palette.cjs'));
    const palette = {
      ok: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m',
      accent: '\x1b[36m', muted: '\x1b[90m', text: '\x1b[37m',
      bg: '\x1b[40m', reset: '\x1b[0m',
    };
    const state = {
      terminal: { cols: 120, rows: 40 },
      os: { overallHealth: 'ready', bootTime: 1819, capabilities: { memory: { ok: true } } },
      forge: { active: false },
    };
    const lines = renderFaceZone(state, palette);
    const allText = lines.map(l => stripAnsi(l)).join(' ');
    // Should contain face characters or OS status text
    expect(allText).toContain('Agentic OS');
  });

  it('shows degraded info when caps are down', () => {
    const { renderFaceZone } = requireFresh();
    const { stripAnsi } = _require(path.resolve(__dirname, '../hud-palette.cjs'));
    const palette = {
      ok: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m',
      accent: '\x1b[36m', muted: '\x1b[90m', text: '\x1b[37m',
      bg: '\x1b[40m', reset: '\x1b[0m',
    };
    const state = {
      terminal: { cols: 120, rows: 40 },
      os: {
        overallHealth: 'degraded',
        bootTime: 1200,
        capabilities: {
          memory: { ok: false, reason: 'hub unreachable' },
          git: { ok: true },
          aisle: { ok: false, reason: 'not initialized' },
          infra: { ok: false, reason: 'docker down' },
        },
      },
      forge: { active: false },
    };
    const lines = renderFaceZone(state, palette);
    const allText = lines.map(l => stripAnsi(l)).join(' ');
    // Wide mode shows "N degraded" count or a cap-specific quip
    expect(allText).toMatch(/degraded|unreachable|docker|memory|what were/i);
  });

  it('passes companion state and idle freeze options to the full-mode orb', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-zone-face-orb-'));
    const previousProjectDir = process.env.CLAUDE_PROJECT_DIR;
    const previousStatePath = process.env.COMPANION_STATE_PATH;
    process.env.CLAUDE_PROJECT_DIR = tmpDir;
    process.env.COMPANION_STATE_PATH = path.join(tmpDir, '_runs', 'os', '.companion-state.json');
    fs.mkdirSync(path.join(tmpDir, '_runs', 'os'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '_runs', 'os', 'hud-active.json'),
      JSON.stringify({ active: false, at: '2026-06-13T17:00:00.000Z' }),
    );

    const orbPath = path.resolve(__dirname, '../hud-braille-orb.cjs');
    const originalOrb = _require.cache[orbPath];
    let capturedOpts = null;
    _require.cache[orbPath] = {
      exports: {
        renderColoredOrb: (_score, opts) => {
          capturedOpts = opts;
          return ['orb-top', 'orb-bot'];
        },
      },
    };

    try {
      const { renderFaceZone } = requireFresh();
      const palette = {
        ok: '', warn: '', error: '', accent: '', muted: '', text: '', bg: '', reset: '',
      };
      const state = {
        projectRoot: tmpDir,
        terminal: { cols: 120, rows: 40 },
        os: { overallHealth: 'ready', bootTime: 1819, capabilities: { memory: { ok: true } } },
        session: { toolCount: 2, outputTokens: 0 },
        forge: { active: false },
      };
      renderFaceZone(state, palette);
      expect(capturedOpts).toBeTruthy();
      expect(capturedOpts.companionState).toBeTruthy();
      expect(capturedOpts.outerActive).toBe(false);
      expect(capturedOpts.freezeTimeMs).toBe(new Date('2026-06-13T17:00:00.000Z').getTime());
    } finally {
      if (originalOrb) _require.cache[orbPath] = originalOrb;
      else delete _require.cache[orbPath];
      if (previousProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = previousProjectDir;
      if (previousStatePath === undefined) delete process.env.COMPANION_STATE_PATH;
      else process.env.COMPANION_STATE_PATH = previousStatePath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not export or retain the retired Clawd and block-art face builders', () => {
    const mod = requireFresh();
    const source = fs.readFileSync(MODULE_PATH, 'utf8');

    expect(mod.CLAWD_POSES).toBeUndefined();
    expect(mod.pickClawdPose).toBeUndefined();
    expect(mod.buildClawdLines).toBeUndefined();
    expect(mod.FACE_HEALTHY).toBeUndefined();
    expect(mod.FACE_DEGRADED).toBeUndefined();
    expect(source).not.toMatch(/\b(?:CLAWD_POSES|buildClawdLines|pickClawdPose|FACE_HEALTHY(?!_INLINE)|FACE_DEGRADED(?!_INLINE))\b/);
  });
});

describe('ZONE_META', () => {
  it('exports zone metadata for allocator', () => {
    const { ZONE_META } = requireFresh();
    expect(ZONE_META.key).toBe('face');
    expect(ZONE_META.priority).toBe(10);
    expect(ZONE_META.minRows).toBe(1);
    expect(ZONE_META.idealRows).toBe(6);
  });
});
