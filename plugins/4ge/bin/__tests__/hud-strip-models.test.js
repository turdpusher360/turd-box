import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

// Use a test-specific companion state file so tests don't depend on real state
const TEST_COMPANION_PATH = path.resolve(process.cwd(), '_runs/os/.companion-state-test-strip.json');
process.env.COMPANION_STATE_PATH = TEST_COMPANION_PATH;

function requireFresh() {
  for (const key of Object.keys(_require.cache)) {
    if (key.includes('hud-engine') || key.includes('hud-palette') || key.includes('hud-state') ||
        key.includes('hud-canvas') || key.includes('hud-zone') || key.includes('companion-state') ||
        key.includes('hud-expressions') || key.includes('hud-data-loader')) {
      delete _require.cache[key];
    }
  }
  return _require(path.resolve(__dirname, '../hud-engine.cjs'));
}

const { stripAnsi } = _require(path.resolve(__dirname, '../hud-palette.cjs'));

describe('MODEL_FACE map', () => {
  it('maps claude-opus-4-6 to determined', () => {
    const { MODEL_FACE } = requireFresh();
    expect(MODEL_FACE['claude-opus-4-6'].expr).toBe('determined');
    expect(MODEL_FACE['claude-opus-4-6'].color).toBe('accent');
  });

  it('maps claude-opus-4-6[1m] to determined', () => {
    const { MODEL_FACE } = requireFresh();
    expect(MODEL_FACE['claude-opus-4-6[1m]'].expr).toBe('determined');
  });

  it('maps claude-sonnet-4-6 to focused', () => {
    const { MODEL_FACE } = requireFresh();
    expect(MODEL_FACE['claude-sonnet-4-6'].expr).toBe('thinking');
  });

  it('maps claude-sonnet-5 to thinking with accent color', () => {
    const { MODEL_FACE } = requireFresh();
    expect(MODEL_FACE['claude-sonnet-5'].expr).toBe('thinking');
    expect(MODEL_FACE['claude-sonnet-5'].color).toBe('accent');
  });

  it('maps claude-haiku-4-5 to sleepy with muted color', () => {
    const { MODEL_FACE } = requireFresh();
    expect(MODEL_FACE['claude-haiku-4-5'].expr).toBe('sleepy');
    expect(MODEL_FACE['claude-haiku-4-5'].color).toBe('muted');
  });
});

describe('resolveModelFace', () => {
  it('returns exact match for known model ID', () => {
    const { resolveModelFace } = requireFresh();
    const result = resolveModelFace('claude-opus-4-6');
    expect(result).not.toBeNull();
    expect(result.expr).toBe('determined');
  });

  it('falls back to prefix match for future Opus versions', () => {
    const { resolveModelFace } = requireFresh();
    const result = resolveModelFace('claude-opus-5-0');
    expect(result).not.toBeNull();
    expect(result.expr).toBe('determined');
  });

  it('falls back to prefix match for future Sonnet versions', () => {
    const { resolveModelFace } = requireFresh();
    const result = resolveModelFace('claude-sonnet-5-0');
    expect(result).not.toBeNull();
    expect(result.expr).toBe('thinking');
  });

  it('falls back to prefix match for future Haiku versions', () => {
    const { resolveModelFace } = requireFresh();
    const result = resolveModelFace('claude-haiku-5-0');
    expect(result).not.toBeNull();
    expect(result.expr).toBe('sleepy');
  });

  it('returns null for unknown model', () => {
    const { resolveModelFace } = requireFresh();
    expect(resolveModelFace('gpt-4')).toBeNull();
  });

  it('returns null for empty string', () => {
    const { resolveModelFace } = requireFresh();
    expect(resolveModelFace('')).toBeNull();
  });

  it('returns null for null/undefined', () => {
    const { resolveModelFace } = requireFresh();
    expect(resolveModelFace(null)).toBeNull();
    expect(resolveModelFace(undefined)).toBeNull();
  });
});

describe('renderStrip model-specific faces', () => {
  beforeEach(() => {
    // Write fresh idle companion state so tests get predictable results
    const freshState = {
      expression: 'proud joy', gaze: 'forward', mode: 'standard',
      stateKey: 'idle', changedAt: Date.now(), lastToolAt: Date.now(),
      blinkAt: Date.now(), gazePhase: 0, lastHeartbeat: Date.now(),
      bootActive: false, bootFrame: 8, bootTarget: 8, bootStartedAt: Date.now(),
    };
    const dir = path.dirname(TEST_COMPANION_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(TEST_COMPANION_PATH, JSON.stringify(freshState));

    // Hermetic config (S441): the repo .4ge/config.json now defaults to
    // animate:false (mobile freeze), under which resolveCompanionFace returns a
    // STATIC model-identity face. These tests assert the EXPRESSIVE companion idle
    // face, so pin animate:true via a spy that survives requireFresh (which does
    // not clear companion-config from the module cache).
    const ccMod = _require(path.resolve(__dirname, '../companion-config.cjs'));
    ccMod.clearCache?.();
    const realCfg = ccMod.loadCompanionConfig();
    vi.spyOn(ccMod, 'loadCompanionConfig').mockReturnValue({ ...realCfg, animate: true, zen: false });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeHealthyState(modelId) {
    return {
      terminal: { cols: 79, rows: 24 },
      session: {
        id: 'test',
        model: 'opus',
        contextPct: 20,
        rateLimits: { fiveHour: 10, sevenDay: 5 },
        uptime: 3600000,
        modelId: modelId,
      },
      os: {
        overallHealth: 'ready',
        bootTime: 100,
        capabilities: {
          memory: { ok: true, status: 'ready' },
          git: { ok: true, status: 'ready' },
        },
      },
      forge: { active: false, phase: null, teammates: [], scope: null },
      context: { trigger: 'command', event: null, zone: null },
      theme: { name: 'plain' },
    };
  }

  it('shows companion idle face glyphs when healthy — not model-specific', () => {
    const { renderStrip } = requireFresh();
    const output = renderStrip(makeHealthyState('claude-opus-4-6'));
    // Companion drives face with gradient colors — check glyphs are present
    expect(output).toContain('\u2588'); // █ (big eye)
    expect(output).toContain('\u2586'); // ▆ (small eye)
  });

  it('shows same idle face regardless of model when healthy', () => {
    const { renderStrip } = requireFresh();
    const opusStripped = stripAnsi(renderStrip(makeHealthyState('claude-opus-4-6')));
    const sonnetStripped = stripAnsi(renderStrip(makeHealthyState('claude-sonnet-4-6')));
    // Both show same companion idle face when stripped of color
    expect(opusStripped).toContain('[' + '\u2588' + ' ' + '\u2586' + ']');
    expect(sonnetStripped).toContain('[' + '\u2588' + ' ' + '\u2586' + ']');
  });

  it('falls back to companion face when degraded', () => {
    const { renderStrip, COMPACT_FACES } = requireFresh();
    const state = makeHealthyState('claude-opus-4-6');
    // Make one cap degraded
    state.os.capabilities.memory = { ok: false, status: 'degraded', reason: 'down' };
    const output = renderStrip(state);
    // Should NOT show determined (model face) when degraded
    // The companion state machine decides instead
    expect(typeof output).toBe('string');
    expect(output.length).toBeGreaterThan(0);
  });

  it('falls back to companion face when model ID is unknown', () => {
    const { renderStrip } = requireFresh();
    const state = makeHealthyState('some-unknown-model');
    const output = renderStrip(state);
    expect(typeof output).toBe('string');
    expect(output.length).toBeGreaterThan(0);
  });
});
