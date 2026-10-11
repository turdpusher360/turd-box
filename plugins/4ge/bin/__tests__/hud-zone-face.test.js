import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);
const MODULE_PATH = path.resolve(__dirname, '../hud-zone-face.cjs');
const { buildCapabilities } = _require(path.resolve(__dirname, '../hud-data-loader.cjs'));
const SHELVED_MALFORMED_CASES = [
  ['boot-ready + ok="true"', 'ready', { ok: 'true' }],
  ['boot-ready + ok=null', 'ready', { ok: null }],
  ['boot-degraded + ok="true"', 'degraded', { ok: 'true' }],
  ['boot-degraded + ok=1', 'degraded', { ok: 1 }],
  ['boot-degraded + ok={}', 'degraded', { ok: {} }],
];
const SHELVED_CONTROL_CASES = [
  ['boot-degraded + ok=false', { probe: { ok: false } }],
  ['boot-degraded + no health entry', {}],
];
let tmpRoot;
let previousProjectDir;
let previousStatePath;

function dropCompanionModules() {
  for (const key of Object.keys(_require.cache)) {
    if (key.includes('companion-state') || key.includes('companion-insights')
      || key.includes('hud-engine')) {
      delete _require.cache[key];
    }
  }
}

function requireFresh() {
  for (const key of Object.keys(_require.cache)) {
    if (key.includes('hud-zone-face') || key.includes('hud-palette') || key.includes('hud-state')
      || key.includes('companion-state') || key.includes('companion-insights')) {
      delete _require.cache[key];
    }
  }
  return _require(MODULE_PATH);
}

// Wide face renders persist companion state, and companion-state.cjs fixes its
// path when first loaded. Contain every test at file scope so an older or future
// wide render cannot fall through to the checkout's live _runs/os path.
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-zone-face-'));
  previousProjectDir = process.env.CLAUDE_PROJECT_DIR;
  previousStatePath = process.env.COMPANION_STATE_PATH;
  process.env.CLAUDE_PROJECT_DIR = tmpRoot;
  process.env.COMPANION_STATE_PATH = path.join(tmpRoot, '_runs', 'os', '.companion-state.json');
  dropCompanionModules();
});

afterEach(() => {
  dropCompanionModules();
  if (previousProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = previousProjectDir;
  if (previousStatePath === undefined) delete process.env.COMPANION_STATE_PATH;
  else process.env.COMPANION_STATE_PATH = previousStatePath;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

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

  // An empty capability map (no health.json or boot-status.json; the loader
  // calls it 'unknown') is no evidence of health. The zone must say "health
  // unknown", not "Agentic OS up", a green "0 ready" or a healthy quip.
  it('renders an empty capability map as health unknown at a wide width', () => {
    const { stripAnsi } = _require(path.resolve(__dirname, '../hud-palette.cjs'));
    const palette = {
      ok: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m',
      accent: '\x1b[36m', muted: '\x1b[90m', text: '\x1b[37m',
      bg: '\x1b[40m', reset: '\x1b[0m',
    };
    const { renderFaceZone } = requireFresh();
    const lines = renderFaceZone({
      projectRoot: tmpRoot,
      terminal: { cols: 120, rows: 40 },
      os: { overallHealth: 'unknown', bootTime: 0, capabilities: {} },
      forge: { active: false },
    }, palette);
    const raw = lines.join('\n');
    // Status line: no count and no quip after the boot time.
    expect(stripAnsi(lines[lines.length - 1]).trim()).toMatch(/^Agentic OS · health unknown · \d+ms$/);
    expect(raw).toContain(`${palette.warn}health unknown`);
    expect(raw).not.toContain('ready');
    expect(stripAnsi(raw)).not.toMatch(/\bup\b/);
  });

  it('renders an empty capability map as health unknown at a narrow width', () => {
    const { renderFaceZone } = requireFresh();
    const { stripAnsi } = _require(path.resolve(__dirname, '../hud-palette.cjs'));
    const palette = {
      ok: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m',
      accent: '\x1b[36m', muted: '\x1b[90m', text: '\x1b[37m',
      bg: '\x1b[40m', reset: '\x1b[0m',
    };
    const lines = renderFaceZone({
      terminal: { cols: 48, rows: 28 },
      os: { overallHealth: 'unknown', bootTime: 0, capabilities: {} },
      forge: { active: false },
    }, palette);
    expect(lines).toHaveLength(1);
    expect(stripAnsi(lines[0])).toContain('health unknown');
    expect(stripAnsi(lines[0])).not.toMatch(/\bup\b/);
    expect(lines[0]).toContain(`${palette.warn}health unknown`);
    // The inline face is muted, not the healthy accent colour.
    expect(lines[0]).not.toContain(palette.accent);
  });

  function expectFailedEmpty(terminal) {
    const { renderFaceZone } = requireFresh();
    const { stripAnsi } = _require(path.resolve(__dirname, '../hud-palette.cjs'));
    const palette = {
      ok: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m',
      accent: '\x1b[36m', muted: '\x1b[90m', text: '\x1b[37m',
      bg: '\x1b[40m', reset: '\x1b[0m',
    };
    const lines = renderFaceZone({
      projectRoot: tmpRoot,
      terminal,
      os: { overallHealth: 'failed', bootTime: 0, capabilities: {} },
      forge: { active: false },
    }, palette);
    const raw = lines.join('\n');
    const text = stripAnsi(raw);
    expect(text).toContain('health failed');
    expect(raw).toContain(`${palette.error}health failed`);
    expect(text).not.toContain('health unknown');
    expect(text).not.toMatch(/\bup\b|\bready\b/);
    expect(text).not.toMatch(/everything is where it should be|all systems green/);
  }

  it('renders an empty failed boot as health failed at a wide width', () => {
    expectFailedEmpty({ cols: 120, rows: 40 });
  });

  it('renders an empty failed boot as health failed at a narrow width', () => {
    expectFailedEmpty({ cols: 48, rows: 8 });
  });

  it('renders a capability without boolean ok as health unknown', () => {
    const { renderFaceZone } = requireFresh();
    const { stripAnsi } = _require(path.resolve(__dirname, '../hud-palette.cjs'));
    const palette = {
      ok: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m',
      accent: '\x1b[36m', muted: '\x1b[90m', text: '\x1b[37m',
      bg: '\x1b[40m', reset: '\x1b[0m',
    };
    const raw = renderFaceZone({
      projectRoot: tmpRoot,
      terminal: { cols: 120, rows: 40 },
      os: { overallHealth: 'degraded', bootTime: 0, capabilities: { memory: { status: 'degraded' } } },
      forge: { active: false },
    }, palette).join('\n');
    const text = stripAnsi(raw);
    expect(text).toContain('health unknown');
    expect(raw).toContain(`${palette.warn}health unknown`);
    expect(text).not.toMatch(/\bup\b|\bready\b/);
    expect(text).not.toMatch(/everything is where it should be|all systems green/);
  });

  it.each([
    ['wide', { cols: 120, rows: 40 }],
    ['narrow', { cols: 48, rows: 8 }],
  ])('renders a null capability as warning-role health unknown at a %s width', (_label, terminal) => {
    const { renderFaceZone } = requireFresh();
    const { stripAnsi } = _require(path.resolve(__dirname, '../hud-palette.cjs'));
    const palette = {
      ok: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m',
      accent: '\x1b[36m', muted: '\x1b[90m', text: '\x1b[37m',
      bg: '\x1b[40m', reset: '\x1b[0m',
    };
    let raw;

    expect(() => {
      raw = renderFaceZone({
        projectRoot: tmpRoot,
        terminal,
        os: { overallHealth: 'unknown', bootTime: 0, capabilities: { probe: null } },
        forge: { active: false },
      }, palette).join('\n');
    }).not.toThrow();

    const text = stripAnsi(raw);
    expect(text).toContain('health unknown');
    expect(raw).toContain(`${palette.warn}health unknown`);
    expect(text).not.toMatch(/\bup\b|\bready\b/);
  });

  it.each([
    ['wide', { cols: 120, rows: 40 }],
    ['narrow', { cols: 48, rows: 8 }],
  ])('never renders a non-boolean live ok value healthy at a %s width', (_label, terminal) => {
    const { renderFaceZone } = requireFresh();
    const { stripAnsi } = _require(path.resolve(__dirname, '../hud-palette.cjs'));
    const palette = {
      ok: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m',
      accent: '\x1b[36m', muted: '\x1b[90m', text: '\x1b[37m',
      bg: '\x1b[40m', reset: '\x1b[0m',
    };
    const capabilities = buildCapabilities({}, { probe: { ok: 'false' } });
    let raw;

    expect(() => {
      raw = renderFaceZone({
        projectRoot: tmpRoot,
        terminal,
        os: { overallHealth: 'degraded', bootTime: 0, capabilities },
        forge: { active: false },
      }, palette).join('\n');
    }).not.toThrow();

    const text = stripAnsi(raw);
    expect(text).toContain('1 degraded');
    expect(raw).toContain(`${palette.warn}1 degraded`);
    expect(text).not.toMatch(/Agentic OS up|\b[1-9]\d* ready\b/);
    expect(text).not.toMatch(/everything is where it should be|all systems green/);
  });

  it.each(SHELVED_MALFORMED_CASES)(
    '[RED-r5 F1 cross-reader] %s is actionable everywhere',
    (_label, bootStatus, healthEntry) => {
      const { renderFaceZone } = requireFresh();
      const { stripAnsi } = _require(path.resolve(__dirname, '../hud-palette.cjs'));
      const { countDegraded } = _require(path.resolve(__dirname, '../hud-state.cjs'));
      const { getExpressionName } = _require(path.resolve(__dirname, '../hud-expressions.cjs'));
      const { renderHealthZone } = _require(path.resolve(__dirname, '../hud-zone-health.cjs'));
      const { renderSubstrateZone } = _require(path.resolve(__dirname, '../hud-zone-substrate.cjs'));
      _require(path.resolve(__dirname, '../companion-insights.cjs')).getInsight = () => null;
      const {
        renderStrip, renderCompact, renderStatusLine, COMPACT_FACES,
      } = _require(path.resolve(__dirname, '../hud-engine.cjs'));
      const palette = {
        ok: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m',
        accent: '\x1b[36m', muted: '\x1b[90m', text: '\x1b[37m',
        bg: '\x1b[40m', reset: '\x1b[0m',
      };
      const capabilities = buildCapabilities(
        { capabilities: { probe: { status: bootStatus, init_ms: 4, shelved: true } } },
        { probe: healthEntry },
      );
      const baseState = {
        projectRoot: tmpRoot,
        session: {
          id: 'r5-f1', model: 'claude-opus-4-6', modelId: 'claude-opus-4-6',
          contextPct: 0, uptime: 0, toolCount: 0, rateLimits: 'N/A',
        },
        os: { overallHealth: 'degraded', bootTime: 4, capabilities },
        forge: { active: false, phase: null, teammates: [], scope: null },
        context: { trigger: 'test', event: null, zone: null },
        badges: {},
        memory: {},
        git: {},
        theme: { name: 'plain' },
      };
      const wideState = { ...baseState, terminal: { cols: 79, rows: 24 } };
      const narrowState = { ...baseState, terminal: { cols: 48, rows: 8 } };
      const faceWide = stripAnsi(renderFaceZone(wideState, palette).join('\n'));
      const faceNarrow = stripAnsi(renderFaceZone(narrowState, palette).join('\n'));
      const healthWide = stripAnsi(renderHealthZone(wideState, palette).join('\n'));
      const healthNarrow = stripAnsi(renderHealthZone(narrowState, palette).join('\n'));
      const strip = stripAnsi(renderStrip(wideState));
      const compact = stripAnsi(renderCompact(wideState));
      const statusline = stripAnsi(renderStatusLine(wideState, 8));
      const substrate = renderSubstrateZone(wideState);

      expect({
        shelved: capabilities.probe.shelved,
        degradedCount: countDegraded(capabilities),
        expression: getExpressionName(wideState),
        faceWideDegraded: faceWide.includes('0 ready · 1 degraded'),
        faceWideHealthyQuip: /everything is where it should be|all systems green/.test(faceWide),
        faceNarrowDegraded: faceNarrow.includes('1 degraded'),
        faceNarrowUp: faceNarrow.includes('Agentic OS up'),
        healthWideFailed: /Health:\s+0\s+F\b/.test(healthWide),
        healthNarrowFailed: /Health:\s+0\s+F\b/.test(healthNarrow),
        substrateFailed: substrate.includes('🔴') && !substrate.includes('🟢'),
        stripCount: /(?:^|\s)0\/1(?:\s|$)/.test(strip),
        compactFace: compact.includes(COMPACT_FACES.curious),
        statuslineCount: /(?:^|\s)0\/1(?:\s|$)/.test(statusline),
      }).toEqual({
        shelved: undefined,
        degradedCount: 1,
        expression: 'curious',
        faceWideDegraded: true,
        faceWideHealthyQuip: false,
        faceNarrowDegraded: true,
        faceNarrowUp: false,
        healthWideFailed: true,
        healthNarrowFailed: true,
        substrateFailed: true,
        stripCount: true,
        compactFace: true,
        statuslineCount: true,
      });
    },
  );

  it.each(SHELVED_CONTROL_CASES)(
    '[guard-r5 F1 cross-reader] %s stays byte-semantically shelved',
    (_label, health) => {
      const { renderFaceZone } = requireFresh();
      const { stripAnsi } = _require(path.resolve(__dirname, '../hud-palette.cjs'));
      const { countDegraded } = _require(path.resolve(__dirname, '../hud-state.cjs'));
      const { getExpressionName } = _require(path.resolve(__dirname, '../hud-expressions.cjs'));
      _require(path.resolve(__dirname, '../companion-insights.cjs')).getInsight = () => null;
      const { renderStrip, renderCompact, renderStatusLine, COMPACT_FACES } = _require(path.resolve(__dirname, '../hud-engine.cjs'));
      const palette = {
        ok: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m',
        accent: '\x1b[36m', muted: '\x1b[90m', text: '\x1b[37m',
        bg: '\x1b[40m', reset: '\x1b[0m',
      };
      const capabilities = buildCapabilities(
        { capabilities: { probe: { status: 'degraded', init_ms: 4, shelved: true } } },
        health,
      );
      const baseState = {
        projectRoot: tmpRoot,
        session: { id: 'r5-guard', model: 'claude-opus-4-6', modelId: 'claude-opus-4-6', contextPct: 0, uptime: 0, toolCount: 0, rateLimits: 'N/A' },
        os: { overallHealth: 'degraded', bootTime: 4, capabilities },
        forge: { active: false, phase: null, teammates: [], scope: null },
        context: { trigger: 'test', event: null, zone: null },
        badges: {}, memory: {}, git: {}, theme: { name: 'plain' },
      };
      const wideState = { ...baseState, terminal: { cols: 79, rows: 24 } };
      const narrowState = { ...baseState, terminal: { cols: 48, rows: 8 } };
      const faceWide = stripAnsi(renderFaceZone(wideState, palette).join('\n'));
      const faceNarrow = stripAnsi(renderFaceZone(narrowState, palette).join('\n'));

      expect(capabilities.probe.shelved).toBe(true);
      expect(countDegraded(capabilities)).toBe(0);
      expect(getExpressionName(wideState)).toBe('neutral alive');
      expect(faceWide).toMatch(/\b1 ready\b/);
      expect(faceNarrow).toContain('Agentic OS up');
      expect(stripAnsi(renderStrip(wideState))).toMatch(/(?:^|\s)1\/1(?:\s|$)/);
      expect(stripAnsi(renderCompact(wideState))).toContain(COMPACT_FACES['neutral alive']);
      expect(stripAnsi(renderStatusLine(wideState, 8))).toMatch(/(?:^|\s)1\/1(?:\s|$)/);
    },
  );

  it('renders mixed ready and unknown observations without healthy copy', () => {
    const { renderFaceZone } = requireFresh();
    const { stripAnsi } = _require(path.resolve(__dirname, '../hud-palette.cjs'));
    const palette = {
      ok: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m',
      accent: '\x1b[36m', muted: '\x1b[90m', text: '\x1b[37m',
      bg: '\x1b[40m', reset: '\x1b[0m',
    };
    const raw = renderFaceZone({
      projectRoot: tmpRoot,
      terminal: { cols: 120, rows: 40 },
      os: {
        overallHealth: 'degraded',
        bootTime: 0,
        capabilities: { git: { ok: true }, memory: { status: 'degraded' } },
      },
      forge: { active: false },
    }, palette).join('\n');
    const text = stripAnsi(raw);
    expect(text).toContain('1 ready · 1 unknown');
    expect(raw).toContain(`${palette.warn}1 ready · 1 unknown`);
    expect(text).not.toMatch(/\bup\b/);
    expect(text).not.toMatch(/everything is where it should be|all systems green/);
  });

  it('passes companion state and idle freeze options to the full-mode orb', () => {
    fs.mkdirSync(path.join(tmpRoot, '_runs', 'os'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, '_runs', 'os', 'hud-active.json'),
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
        projectRoot: tmpRoot,
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

// HUD r5 review P2-2: a capability without a boolean ok is not ready. Every
// surface must agree: ratios leave it out of the numerator, the compact colour
// and the expression leave healthy, and the caps/substrate markers go warn.
// A shelved ok:false keeps its exemption, and an all-ready map does not move.
describe('[B1 P2-2] readiness agrees across surfaces', () => {
  const PALETTE = {
    ok: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m',
    accent: '\x1b[36m', muted: '\x1b[90m', text: '\x1b[37m',
    bg: '\x1b[40m', reset: '\x1b[0m',
  };
  const DOT = '●';

  beforeEach(() => {
    // The compact face role is only observable with real colour codes.
    vi.stubEnv('NO_COLOR', '');
    vi.stubEnv('CLICOLOR', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function renderEverySurface(capabilities) {
    const { renderFaceZone } = requireFresh();
    const { stripAnsi } = _require(path.resolve(__dirname, '../hud-palette.cjs'));
    const { buildCanonicalState } = _require(path.resolve(__dirname, '../hud-state.cjs'));
    const { getExpressionName } = _require(path.resolve(__dirname, '../hud-expressions.cjs'));
    const { renderHealthZone } = _require(path.resolve(__dirname, '../hud-zone-health.cjs'));
    const { renderCapsZone } = _require(path.resolve(__dirname, '../hud-zone-caps.cjs'));
    const { renderSubstrateZone, toFraktur } = _require(path.resolve(__dirname, '../hud-zone-substrate.cjs'));
    _require(path.resolve(__dirname, '../companion-insights.cjs')).getInsight = () => null;
    const {
      renderStrip, renderCompact, renderStatusLine, COMPACT_FACES,
    } = _require(path.resolve(__dirname, '../hud-engine.cjs'));
    const baseState = {
      projectRoot: tmpRoot,
      session: {
        id: 'b1-p2-2', model: 'claude-opus-4-6', modelId: 'claude-opus-4-6',
        contextPct: 0, uptime: 0, toolCount: 0, rateLimits: 'N/A',
      },
      os: { overallHealth: 'ready', bootTime: 4, capabilities },
      forge: { active: false, phase: null, teammates: [], scope: null },
      context: { trigger: 'test', event: null, zone: null },
      badges: {},
      memory: {},
      git: {},
      theme: { name: 'forge' },
    };
    const wide = { ...baseState, terminal: { cols: 79, rows: 24 } };
    const narrow = { ...baseState, terminal: { cols: 48, rows: 8 } };
    const p = buildCanonicalState(wide).palette;
    expect(p.warn).not.toBe(p.accent);
    const compactRaw = renderCompact(wide);
    const faces = Object.values(COMPACT_FACES);
    const ratio = (text) => (text.match(/(?:^|\s)(\d+\/\d+)(?:\s|$)/) || [])[1];
    const substrateLines = renderSubstrateZone(wide).split('\n');
    return {
      statusline: ratio(stripAnsi(renderStatusLine(wide, 8))),
      strip: ratio(stripAnsi(renderStrip(wide))),
      compactRole: faces.some((f) => compactRaw.includes(p.warn + f)) ? 'warn'
        : faces.some((f) => compactRaw.includes(p.accent + f)) ? 'accent' : 'none',
      expression: getExpressionName(wide),
      caps: renderCapsZone(wide, PALETTE).join('\n'),
      substrateMarker: (name) => {
        const frak = toFraktur(name);
        const line = substrateLines.find((l) => l.includes(` ${frak}`)) || '';
        return ['🟢', '🟡', '🔴'].find((m) => line.includes(`${m} ${frak}`)) || null;
      },
      faceNarrow: stripAnsi(renderFaceZone(narrow, PALETTE).join('\n')),
      health: stripAnsi(renderHealthZone(wide, PALETTE).join('\n')),
    };
  }

  it.each([
    ['D: a health-only entry without ok',
      () => buildCapabilities({}, { probe: { reason: 'no sample' } }),
      { ratio: '0/1', label: 'health unknown', gitReady: false }],
    ['E: ready git plus a health-only entry without ok',
      () => buildCapabilities({ capabilities: { git: { status: 'ready', init_ms: 3 } } }, { git: { ok: true }, probe: { state: 'x' } }),
      { ratio: '1/2', label: '1 ready · 1 unknown', gitReady: true }],
    ['F: a null boot entry',
      () => buildCapabilities({ capabilities: { probe: null } }, {}),
      { ratio: '0/1', label: 'health unknown', gitReady: false }],
  ])('%s is not ready on any surface', (_label, build, want) => {
    const out = renderEverySurface(build());

    expect(out.statusline).toBe(want.ratio);
    expect(out.strip).toBe(want.ratio);
    expect(out.compactRole).toBe('warn');
    expect(out.expression).toBe('curious');
    expect(out.caps).not.toMatch(/all \d+ ready/);
    expect(out.caps).toContain(`${PALETTE.warn}${DOT}`);
    expect(out.caps).not.toContain(`${PALETTE.error}${DOT}`);
    expect(out.caps.includes(`${PALETTE.ok}${DOT}`)).toBe(want.gitReady);
    expect(out.substrateMarker('probe')).toBe('🟡');
    if (want.gitReady) expect(out.substrateMarker('git')).toBe('🟢');
    expect(out.faceNarrow).toContain(want.label);
    expect(out.faceNarrow).not.toContain('Agentic OS up');
    expect(out.health).toContain(want.label);
  });

  it('a shelved AISLE ok:false keeps its exemption on every surface (no flip)', () => {
    const out = renderEverySurface(buildCapabilities(
      { capabilities: { git: { status: 'ready', init_ms: 3 }, aisle: { status: 'degraded', init_ms: 2, shelved: true } } },
      { git: { ok: true }, aisle: { ok: false } },
    ));

    // Readiness readers count it ready, exactly as before.
    expect(out.statusline).toBe('2/2');
    expect(out.strip).toBe('2/2');
    expect(out.compactRole).toBe('accent');
    expect(out.expression).toBe('neutral alive');
    expect(out.faceNarrow).toContain('Agentic OS up');
    // The caps, substrate and health zones never exempted a shelved capability
    // (by-design ruling, ADR-SEC-001); their output is unchanged too.
    expect(out.caps).toContain(`${PALETTE.error}${DOT}`);
    expect(out.caps).not.toContain(`${PALETTE.warn}${DOT}`);
    expect(out.substrateMarker('aisle')).toBe('🔴');
    expect(out.substrateMarker('git')).toBe('🟢');
    expect(out.health).toMatch(/Health:\s+50\s+D\b/);
  });

  it('an all-ready map is unchanged on every surface', () => {
    const out = renderEverySurface(buildCapabilities(
      { capabilities: { git: { status: 'ready', init_ms: 3 }, probe: { status: 'ready', init_ms: 2 } } },
      { git: { ok: true }, probe: { ok: true } },
    ));

    expect(out.statusline).toBe('2/2');
    expect(out.strip).toBe('2/2');
    expect(out.compactRole).toBe('accent');
    expect(out.expression).toBe('neutral alive');
    expect(out.caps).toContain(`${PALETTE.ok}${DOT} all 2 ready`);
    expect(out.substrateMarker('git')).toBe('🟢');
    expect(out.substrateMarker('probe')).toBe('🟢');
    expect(out.faceNarrow).toContain('Agentic OS up');
    expect(out.health).toMatch(/Health:\s+100\s+A\b/);
  });
});

// HUD r5 review P2-1, option (a): an explicit failed boot stays failed after the
// next cheap health refresh fills the map (case B). Driven through the loader,
// the canonical state and the zones, so the bootFailed flag must survive all three.
describe('[B2 P2-1] a failed boot survives the cheap health refresh', () => {
  const PALETTE = {
    ok: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m',
    accent: '\x1b[36m', muted: '\x1b[90m', text: '\x1b[37m',
    bg: '\x1b[40m', reset: '\x1b[0m',
  };
  const PROBES = ['forge-session', 'git', 'file-integrity', 'process-health', 'memory',
    'hooks', 'agents', 'skills', 'workflow'];

  function renderFailedBoot(health) {
    const stateDir = path.join(tmpRoot, '_runs', 'os');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'health.json'), JSON.stringify(health));
    fs.writeFileSync(path.join(stateDir, 'boot-status.json'), JSON.stringify({
      session_id: 'failed-boot',
      booted_at: new Date().toISOString(),
      capabilities: {},
      overall: 'failed',
      total_boot_ms: 0,
      reason: 'registry unavailable',
    }));
    const { loadHudData } = _require(path.resolve(__dirname, '../hud-data-loader.cjs'));
    const { buildCanonicalState } = _require(path.resolve(__dirname, '../hud-state.cjs'));
    const { renderFaceZone } = requireFresh();
    const { renderHealthZone } = _require(path.resolve(__dirname, '../hud-zone-health.cjs'));
    const { stripAnsi } = _require(path.resolve(__dirname, '../hud-palette.cjs'));
    const raw = loadHudData({ stateDir, cwd: tmpRoot, runExpensiveProbes: false });
    const wide = buildCanonicalState({ ...raw, terminal: { cols: 79, rows: 24 } });
    const narrow = buildCanonicalState({ ...raw, terminal: { cols: 48, rows: 8 } });
    return {
      raw,
      canonical: wide,
      stripAnsi,
      surfaces: {
        faceWide: renderFaceZone(wide, PALETTE).join('\n'),
        faceNarrow: renderFaceZone(narrow, PALETTE).join('\n'),
        healthWide: renderHealthZone(wide, PALETTE).join('\n'),
        healthNarrow: renderHealthZone(narrow, PALETTE).join('\n'),
      },
    };
  }

  it('case B: nine cheap probes ok after a failed boot render "boot failed", never healthy', () => {
    const out = renderFailedBoot(Object.fromEntries(PROBES.map((name) => [name, { ok: true }])));

    expect(out.raw.os.overallHealth).toBe('ready');
    expect(out.canonical.os.bootFailed).toBe(true);
    for (const [surface, raw] of Object.entries(out.surfaces)) {
      expect(raw, surface).toContain(`${PALETTE.error}boot failed · 9 probes ok`);
      expect(out.stripAnsi(raw), surface)
        .not.toMatch(/Agentic OS up|Health:\s+100|all systems green|everything is where it should be/);
    }
  });

  it('a failed boot with {} health still renders "health failed"', () => {
    const out = renderFailedBoot({});

    expect(out.raw.os.overallHealth).toBe('failed');
    expect(out.canonical.os.bootFailed).toBe(true);
    for (const [surface, raw] of Object.entries(out.surfaces)) {
      expect(raw, surface).toContain(`${PALETTE.error}health failed`);
    }
  });
});
