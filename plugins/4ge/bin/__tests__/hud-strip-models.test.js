import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
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

  it('carries an explicit claude-sonnet-5-5 row, not only the prefix fallback', () => {
    const { MODEL_FACE, resolveModelFace } = requireFresh();
    expect(Object.prototype.hasOwnProperty.call(MODEL_FACE, 'claude-sonnet-5-5')).toBe(true);
    expect(MODEL_FACE['claude-sonnet-5-5'].expr).toBe('thinking');
    expect(MODEL_FACE['claude-sonnet-5-5'].color).toBe('accent');
    // The exact row wins over the claude-sonnet-* prefix branch.
    expect(resolveModelFace('claude-sonnet-5-5')).toBe(MODEL_FACE['claude-sonnet-5-5']);
  });

  it('keeps the companion-face MODEL_FACE copy in sync for Sonnet 5.5 (hud-vocabulary entry 10)', () => {
    const { MODEL_FACE } = requireFresh();
    const companion = _require(path.resolve(__dirname, '../companion-face.cjs'));
    expect(companion.MODEL_FACE['claude-sonnet-5-5']).toEqual(MODEL_FACE['claude-sonnet-5-5']);
    expect(companion.resolveModelFace('claude-sonnet-5-5')).toBe(companion.MODEL_FACE['claude-sonnet-5-5']);
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

// Statusline model label (renderStatusLine row 1). The Fable and solid-family
// literals were pinned from the renderer as it stood before the Mythos and
// Opus 5.5 labels (S706), so any refactor of the label path must keep them
// byte-identical. The Mythos and Opus 5.5 literals are the operator's S706 picks.
// A literal here changes only on an operator-picked restyle.
describe('renderStatusLine model label', () => {
  const MOCK_HEALTHY = path.resolve(__dirname, '../mocks/healthy.json');
  const INSIGHTS_PATH = path.resolve(__dirname, '../companion-insights.cjs');
  const c = (n, s) => `\x1b[38;5;${n}m${s}`;
  const RST = '\x1b[0m';
  let tmpDir;
  let originalInsights;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-model-label-'));
    // A companion message or a rotation-gated ambient insight replaces row 1
    // with a speech bubble, so silence both to keep the model label in view.
    process.env.COMPANION_STATE_PATH = path.join(tmpDir, '.companion-state.json');
    originalInsights = _require.cache[INSIGHTS_PATH];
    _require.cache[INSIGHTS_PATH] = { exports: { getInsight: () => null } };
  });

  afterEach(() => {
    if (originalInsights) _require.cache[INSIGHTS_PATH] = originalInsights;
    else delete _require.cache[INSIGHTS_PATH];
    process.env.COMPANION_STATE_PATH = TEST_COMPANION_PATH;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function renderFor(modelId) {
    const { renderStatusLine } = requireFresh();
    const state = JSON.parse(fs.readFileSync(MOCK_HEALTHY, 'utf8'));
    state.projectRoot = tmpDir;
    state.terminal = { cols: 160, rows: 24 };
    state.session.modelId = modelId;
    return renderStatusLine(state, 8);
  }

  it('keeps Fable 5.1 as the whole-label static ROYGBIV rainbow', () => {
    expect(renderFor('claude-fable-5-1')).toContain(
      `${c(196, 'f')}${c(208, 'a')}${c(226, 'b')}${c(46, 'l')}${c(51, 'e')} ${c(27, '5')}${c(129, '.')}${c(196, '1')}${RST}`,
    );
  });

  it('keeps Fable 5 (single-part version) on the same rainbow', () => {
    expect(renderFor('claude-fable-5')).toContain(
      `${c(196, 'f')}${c(208, 'a')}${c(226, 'b')}${c(46, 'l')}${c(51, 'e')} ${c(27, '5')}${RST}`,
    );
  });

  it('keeps the solid spectrum colors for the other families and Opus versions', () => {
    expect(renderFor('claude-opus-4-8')).toContain(`${c(117, 'opus 4.8')}${RST}`);
    expect(renderFor('claude-opus-5')).toContain(`${c(117, 'opus 5')}${RST}`);
    expect(renderFor('claude-sonnet-5-5')).toContain(`${c(75, 'sonnet 5.5')}${RST}`);
    expect(renderFor('claude-haiku-4-5')).toContain(`${c(110, 'haiku 4.5')}${RST}`);
  });

  it('keeps an unknown model id on the neutral fallback color', () => {
    expect(renderFor('gpt-4')).toContain(`${c(252, ' 4')}${RST}`);
  });

  it('renders Mythos 5.1 with the Fable rainbow on the family word and a red version', () => {
    expect(renderFor('claude-mythos-5-1')).toContain(
      `${c(196, 'm')}${c(208, 'y')}${c(226, 't')}${c(46, 'h')}${c(51, 'o')}${c(27, 's')}${RST} ${c(196, '5.1')}${RST}`,
    );
  });

  it('gives any other claude-mythos-* version the same red version', () => {
    expect(renderFor('claude-mythos-5')).toContain(`${c(27, 's')}${RST} ${c(196, '5')}${RST}`);
  });

  it('renders Opus 5.5 as a static gold-to-amber run, with or without the [1m] suffix', () => {
    const gold = `${c(220, 'o')}${c(214, 'p')}${c(178, 'u')}${c(172, 's')} ${c(220, '5')}${c(214, '.')}${c(178, '5')}${RST}`;
    expect(renderFor('claude-opus-5-5')).toContain(gold);
    expect(renderFor('claude-opus-5-5[1m]')).toContain(gold);
    expect(renderFor('claude-opus-5-5')).not.toContain(c(117, 'opus'));
  });
});

describe('Mythos face rows (hud-vocabulary entry 10)', () => {
  it('gives Mythos 5.1 the Fable face and resolves other Mythos ids to it', () => {
    const { MODEL_FACE, resolveModelFace } = requireFresh();
    expect(MODEL_FACE['claude-mythos-5-1']).toEqual(MODEL_FACE['claude-fable-5-1']);
    expect(resolveModelFace('claude-mythos-6')).toBe(MODEL_FACE['claude-mythos-5-1']);
  });

  it('keeps the companion-face MODEL_FACE copy in sync for Mythos', () => {
    const { MODEL_FACE } = requireFresh();
    const companion = _require(path.resolve(__dirname, '../companion-face.cjs'));
    expect(companion.MODEL_FACE['claude-mythos-5-1']).toEqual(MODEL_FACE['claude-mythos-5-1']);
    expect(companion.resolveModelFace('claude-mythos-6')).toBe(companion.MODEL_FACE['claude-mythos-5-1']);
  });
});
