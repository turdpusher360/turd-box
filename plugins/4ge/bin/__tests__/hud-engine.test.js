import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);
const ENGINE_PATH = path.resolve(__dirname, '../hud-engine.cjs');
const MOCK_HEALTHY = path.resolve(__dirname, '../mocks/healthy.json');
const MOCK_DEGRADED = path.resolve(__dirname, '../mocks/degraded.json');
const MOCK_PHONE = path.resolve(__dirname, '../mocks/phone-minimal.json');
const { stripAnsi } = _require(path.resolve(__dirname, '../hud-palette.cjs'));

function runEngine(mockFile, mode = 'full', extraArgs = '') {
  const input = fs.readFileSync(mockFile, 'utf8');
  return execSync(
    `node "${ENGINE_PATH}" --mode=${mode} ${extraArgs}`,
    { input, encoding: 'utf8', timeout: 10000 }
  );
}

describe('hud-engine CLI (integration)', () => {
  it('produces output in full mode with healthy state', { timeout: 15000 }, () => {
    const output = runEngine(MOCK_HEALTHY, 'full');
    expect(output.length).toBeGreaterThan(0);
    expect(output).toContain('Agentic OS');
    expect(output).toContain('Health');
  });

  it('produces output in full mode with degraded state', { timeout: 15000 }, () => {
    const output = runEngine(MOCK_DEGRADED, 'full');
    expect(output.length).toBeGreaterThan(0);
    // Expression engine uses cap-specific quips; just verify meaningful output
    expect(output).toContain('Agentic OS');
  });

  it('produces a single line in strip mode', { timeout: 15000 }, () => {
    const output = runEngine(MOCK_HEALTHY, 'strip');
    const lines = output.split('\n').filter(l => l.trim().length > 0);
    expect(lines.length).toBe(1);
  });

  it('respects phone-sized terminal dimensions', { timeout: 15000 }, () => {
    const output = runEngine(MOCK_PHONE, 'full');
    // Phone output should still contain health info
    expect(output).toContain('Health');
  });

  it('output stays under 50K chars', { timeout: 15000 }, () => {
    const output = runEngine(MOCK_HEALTHY, 'full');
    expect(output.length).toBeLessThan(50000);
  });

  it('produces valid output for zone mode (stub)', { timeout: 15000 }, () => {
    const output = runEngine(MOCK_HEALTHY, 'zone');
    expect(output.length).toBeGreaterThan(0);
  });
});

describe('hud-engine module exports', () => {
  function requireFresh() {
    for (const key of Object.keys(_require.cache)) {
      if (key.includes('hud-engine') || key.includes('hud-palette') || key.includes('hud-state') || key.includes('hud-canvas') || key.includes('hud-zone') ||
          key.includes('companion-state') || key.includes('companion-insights')) {
        delete _require.cache[key];
      }
    }
    return _require(ENGINE_PATH);
  }

  it('exports renderFull', () => {
    const mod = requireFresh();
    expect(typeof mod.renderFull).toBe('function');
  });

  it('exports renderStrip', () => {
    const mod = requireFresh();
    expect(typeof mod.renderStrip).toBe('function');
  });

  it('exports renderStatusLine', () => {
    const mod = requireFresh();
    expect(typeof mod.renderStatusLine).toBe('function');
  });

  it('does not import the SBD control-plane path normalizer into plugin code', () => {
    const source = fs.readFileSync(ENGINE_PATH, 'utf8');
    expect(source).not.toContain("../../../lib/control-plane-paths.cjs");
    expect(source).not.toContain('normalizeCwd');
  });

  it('resolves project roots without SBD canonicalization or global env mutation', () => {
    const mod = requireFresh();
    const original = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = '/tmp/original-env-root';
    try {
      const resolved = mod.resolveProjectRoot({
        envProjectDir: '',
        workspaceProjectDir: '/workspace/example-project/worktree',
        stdinCwd: '/tmp/stdin-cwd',
        fallbackRoot: '/tmp/plugin-cache/turd-box',
      });

      expect(resolved).toBe('/workspace/example-project/worktree');
      expect(process.env.CLAUDE_PROJECT_DIR).toBe('/tmp/original-env-root');
    } finally {
      if (original === undefined) {
        delete process.env.CLAUDE_PROJECT_DIR;
      } else {
        process.env.CLAUDE_PROJECT_DIR = original;
      }
    }
  });

  it('renderFull returns string with newlines', () => {
    const mod = requireFresh();
    const state = JSON.parse(fs.readFileSync(MOCK_HEALTHY, 'utf8'));
    const output = mod.renderFull(state);
    expect(typeof output).toBe('string');
    expect(output).toContain('\n');
  });

  it('renderStrip returns a single line string', () => {
    const mod = requireFresh();
    const state = JSON.parse(fs.readFileSync(MOCK_HEALTHY, 'utf8'));
    const output = mod.renderStrip(state);
    expect(typeof output).toBe('string');
    // No newlines in strip output
    expect(output).not.toContain('\n');
  });

  it('exports resolveCompanionFace', () => {
    const mod = requireFresh();
    expect(typeof mod.resolveCompanionFace).toBe('function');
  });


  it('renderStatusLine returns a string', () => {
    const mod = requireFresh();
    const state = JSON.parse(fs.readFileSync(MOCK_HEALTHY, 'utf8'));
    const output = mod.renderStatusLine(state, 8);
    expect(typeof output).toBe('string');
    expect(output.length).toBeGreaterThan(0);
  });

  it('renderStatusLine respects the maxRows height cap', () => {
    const mod = requireFresh();
    const state = JSON.parse(fs.readFileSync(MOCK_HEALTHY, 'utf8'));
    // With maxRows=4, canvas budget is 4 rows minus 2 margin = 2 rows of content
    const outputSmall = mod.renderStatusLine(state, 4);
    const outputLarge = mod.renderStatusLine(state, 24);
    // Smaller maxRows produces fewer (or equal) lines than larger
    const linesSmall = outputSmall.split('\n').length;
    const linesLarge = outputLarge.split('\n').length;
    expect(linesSmall).toBeLessThanOrEqual(linesLarge);
  });

  it('renderStatusLine does not mutate the input state', () => {
    const mod = requireFresh();
    const state = JSON.parse(fs.readFileSync(MOCK_HEALTHY, 'utf8'));
    const originalRows = state.terminal.rows;
    mod.renderStatusLine(state, 6);
    expect(state.terminal.rows).toBe(originalRows);
  });

  it('renderStatusLine expands fresh reactive events with catalog-backed zone output', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-statusline-reactive-'));
    const previousStatePath = process.env.COMPANION_STATE_PATH;
    process.env.COMPANION_STATE_PATH = path.join(tmpDir, '_runs', 'os', '.companion-state.json');
    try {
      const mod = requireFresh();
      const state = JSON.parse(fs.readFileSync(MOCK_HEALTHY, 'utf8'));
      state.projectRoot = tmpDir;
      state.terminal = { cols: 120, rows: 24 };
      state.reactive = {
        event: 'commit',
        triggeredAt: new Date(1_700_000_000_000).toISOString(),
        ageMs: 1_000,
      };
      state.git = {
        branch: 'main',
        dirty: false,
        ahead: 1,
        behind: 0,
        recentCommits: [{ subject: 'refactor(hud): unify zone catalog dispatch' }],
      };

      const output = stripAnsi(mod.renderStatusLine(state, 7));
      expect(output).toContain('reactive commit');
      expect(output).toContain('git main');
      expect(output).toContain('clean');
    } finally {
      if (previousStatePath === undefined) delete process.env.COMPANION_STATE_PATH;
      else process.env.COMPANION_STATE_PATH = previousStatePath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('exposes optional compact renderers on persistent statusline zones', () => {
    const mod = requireFresh();
    const context = mod.ZONE_CATALOG.find((entry) => entry.key === 'context');
    const rate = mod.ZONE_CATALOG.find((entry) => entry.key === 'rate');
    const health = mod.ZONE_CATALOG.find((entry) => entry.key === 'health');

    expect(typeof context.compact).toBe('function');
    expect(typeof rate.compact).toBe('function');
    expect(health.compact).toBeUndefined();
  });

  it('renders compact zone rows only within spare statusline row budget', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-statusline-compact-'));
    const previousStatePath = process.env.COMPANION_STATE_PATH;
    process.env.COMPANION_STATE_PATH = path.join(tmpDir, '_runs', 'os', '.companion-state.json');
    try {
      const mod = requireFresh();
      const state = JSON.parse(fs.readFileSync(MOCK_HEALTHY, 'utf8'));
      state.projectRoot = tmpDir;
      state.terminal = { cols: 120, rows: 24 };
      state.session.contextPct = 62;
      state.session.contextPctHistory = [8, 16, 25, 37, 50, 62];
      state.session.rateLimits = { fiveHour: 88, sevenDay: 20 };
      state.session.rateLimitHistory = [
        { fiveHour: 40, sevenDay: 10 },
        { fiveHour: 52, sevenDay: 12 },
        { fiveHour: 70, sevenDay: 15 },
        { fiveHour: 88, sevenDay: 20 },
      ];

      const clipped = stripAnsi(mod.renderStatusLine(state, 3));
      const oneSpare = stripAnsi(mod.renderStatusLine(state, 4));
      const expanded = stripAnsi(mod.renderStatusLine(state, 5));

      expect(clipped).not.toContain('ctx trend');
      expect(clipped).not.toContain('rate trend');
      expect(oneSpare).toContain('ctx trend');
      expect(oneSpare).not.toContain('rate trend');
      expect(expanded).toContain('ctx trend');
      expect(expanded).toContain('rate trend');
    } finally {
      if (previousStatePath === undefined) delete process.env.COMPANION_STATE_PATH;
      else process.env.COMPANION_STATE_PATH = previousStatePath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('suppresses compact zone rows during the fresh boot pulse', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-statusline-boot-compact-'));
    const previousStatePath = process.env.COMPANION_STATE_PATH;
    process.env.COMPANION_STATE_PATH = path.join(tmpDir, '_runs', 'os', '.companion-state.json');
    fs.mkdirSync(path.join(tmpDir, '_runs', 'os'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '_runs', 'os', 'boot-status.json'), JSON.stringify({
      booted_at: new Date().toISOString(),
      total_boot_ms: 42,
      capabilities: {
        memory: { status: 'ready', init_ms: 5 },
      },
    }));
    try {
      const mod = requireFresh();
      const state = JSON.parse(fs.readFileSync(MOCK_HEALTHY, 'utf8'));
      state.projectRoot = tmpDir;
      state.terminal = { cols: 120, rows: 24 };
      state.session.contextPct = 62;
      state.session.contextPctHistory = [8, 16, 25, 37, 50, 62];
      state.session.rateLimits = { fiveHour: 88, sevenDay: 20 };
      state.session.rateLimitHistory = [
        { fiveHour: 40, sevenDay: 10 },
        { fiveHour: 52, sevenDay: 12 },
        { fiveHour: 70, sevenDay: 15 },
        { fiveHour: 88, sevenDay: 20 },
      ];

      const output = stripAnsi(mod.renderStatusLine(state, 8));

      expect(output).toContain('OS BOOT');
      expect(output).not.toContain('ctx trend');
      expect(output).not.toContain('rate trend');
    } finally {
      if (previousStatePath === undefined) delete process.env.COMPANION_STATE_PATH;
      else process.env.COMPANION_STATE_PATH = previousStatePath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('renders compact statusline rows fail-soft in catalog order', () => {
    const mod = requireFresh();
    const state = JSON.parse(fs.readFileSync(MOCK_HEALTHY, 'utf8'));
    state.session.rateLimits = { fiveHour: 88, sevenDay: 20 };
    const palette = state.palette || {};
    const entries = [
      mod.ZONE_CATALOG.find((entry) => entry.key === 'context'),
      mod.ZONE_CATALOG.find((entry) => entry.key === 'rate'),
    ];
    const originals = entries.map((entry) => entry.compact);

    try {
      entries[0].compact = () => ['  first', '', '  second'];
      entries[1].compact = () => { throw new Error('boom'); };

      expect(mod.renderCompactStatuslineRows(state, palette, 3)).toEqual(['  first', '  second']);

      entries[0].compact = () => 'not-an-array';
      entries[1].compact = () => ['  third'];

      expect(mod.renderCompactStatuslineRows(state, palette, 3)).toEqual(['  third']);
    } finally {
      for (let i = 0; i < entries.length; i += 1) {
        entries[i].compact = originals[i];
      }
    }
  });

  it('renders anomaly rows ahead of reactive and compact rows under tight statusline budget', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-statusline-anomaly-'));
    const previousStatePath = process.env.COMPANION_STATE_PATH;
    process.env.COMPANION_STATE_PATH = path.join(tmpDir, '_runs', 'os', '.companion-state.json');
    try {
      const mod = requireFresh();
      const state = JSON.parse(fs.readFileSync(MOCK_HEALTHY, 'utf8'));
      state.projectRoot = tmpDir;
      state.terminal = { cols: 120, rows: 24 };
      state.anomaly = {
        type: 'stale-dirty-work',
        severity: 'signal',
        reason: '3 dirty files',
        metrics: { dirty: 3 },
        updatedAt: '2026-06-14T09:20:00.000Z',
      };
      state.reactive = {
        event: 'commit',
        triggeredAt: '2026-06-14T09:20:00.000Z',
        ageMs: 1_000,
      };
      state.session.contextPctHistory = [8, 16, 25, 37, 50, 62];
      state.session.rateLimits = { fiveHour: 88, sevenDay: 20 };
      state.session.rateLimitHistory = [
        { fiveHour: 40, sevenDay: 10 },
        { fiveHour: 52, sevenDay: 12 },
        { fiveHour: 70, sevenDay: 15 },
        { fiveHour: 88, sevenDay: 20 },
      ];

      const output = stripAnsi(mod.renderStatusLine(state, 4));

      expect(output).toContain('anomaly signal stale-dirty-work');
      expect(output).toContain('3 dirty files');
      expect(output).not.toContain('reactive commit');
      expect(output).not.toContain('ctx trend');
      expect(output).not.toContain('rate trend');
    } finally {
      if (previousStatePath === undefined) delete process.env.COMPANION_STATE_PATH;
      else process.env.COMPANION_STATE_PATH = previousStatePath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('renders anomaly rows without live age stamps', () => {
    const mod = requireFresh();
    const state = {
      anomaly: {
        type: 'rate-limit-approaching',
        severity: 'critical',
        reason: '5h 88% used',
        metrics: {},
        updatedAt: '2026-06-14T09:20:00.000Z',
      },
    };

    const output = stripAnsi(mod.renderAnomalyStatuslineRows(state, {}, 1).join('\n'));

    expect(output).toContain('anomaly critical rate-limit-approaching');
    expect(output).toContain('5h 88% used');
    expect(output).not.toContain('ago');
  });

  it('renderByMode routes statusline to renderStatusLine', () => {
    const mod = requireFresh();
    const state = JSON.parse(fs.readFileSync(MOCK_HEALTHY, 'utf8'));
    const viaRouter = mod.renderByMode(state, 'statusline', 8);
    // Shimmer uses Date.now() so exact string differs between calls — check structure.
    expect(viaRouter).toContain('\n');
    expect(viaRouter.split('\n').length).toBeGreaterThanOrEqual(2);
  });

  it('uses companion insight as the statusline voice fallback when no active message exists', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-statusline-insight-'));
    const previousStatePath = process.env.COMPANION_STATE_PATH;
    process.env.COMPANION_STATE_PATH = path.join(tmpDir, '_runs', 'os', '.companion-state.json');
    const mod = requireFresh();
    const insightsPath = path.resolve(__dirname, '../companion-insights.cjs');
    const originalInsights = _require.cache[insightsPath];
    _require.cache[insightsPath] = {
      exports: {
        getInsight: () => 'Check the current handoff before edits.',
      },
    };
    try {
      const state = JSON.parse(fs.readFileSync(MOCK_HEALTHY, 'utf8'));
      state.projectRoot = tmpDir;
      state.terminal = { cols: 120, rows: 24 };
      const output = mod.renderStatusLine(state, 8);
      expect(output).toContain('Check the current handoff before edits.');
    } finally {
      if (originalInsights) _require.cache[insightsPath] = originalInsights;
      else delete _require.cache[insightsPath];
      if (previousStatePath === undefined) delete process.env.COMPANION_STATE_PATH;
      else process.env.COMPANION_STATE_PATH = previousStatePath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('projects companion left gaze onto the statusline bracket face', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-statusline-gaze-'));
    const previousStatePath = process.env.COMPANION_STATE_PATH;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    process.env.COMPANION_STATE_PATH = path.join(tmpDir, '_runs', 'os', '.companion-state.json');
    let cfgSpy;
    try {
      const mod = requireFresh();
      // Hermetic config (S441): repo .4ge/config.json now defaults to animate:false,
      // under which the statusline face is frozen to a static model-identity glyph
      // (no gaze projection). This test asserts ANIMATED gaze, so pin animate:true.
      const ccMod = _require(path.resolve(__dirname, '../companion-config.cjs'));
      cfgSpy = vi.spyOn(ccMod, 'loadCompanionConfig').mockReturnValue({ ...ccMod.loadCompanionConfig(), animate: true, zen: false });
      const state = JSON.parse(fs.readFileSync(MOCK_HEALTHY, 'utf8'));
      state.projectRoot = tmpDir;
      state.terminal = { cols: 120, rows: 24 };
      const output = mod.renderStatusLine(state, 8);
      const firstLine = stripAnsi(output).split('\n')[0];
      expect(firstLine).toContain('[▌ ▆]');
      expect(firstLine).not.toContain('[█ ▆]');
    } finally {
      if (cfgSpy) cfgSpy.mockRestore();
      nowSpy.mockRestore();
      if (previousStatePath === undefined) delete process.env.COMPANION_STATE_PATH;
      else process.env.COMPANION_STATE_PATH = previousStatePath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('freeze invariant: statusline byte-identical across renders under animate:false', () => {
    // The mobile escape hatch (animate:false) must produce byte-identical output
    // across the 2s statusline poll. Pin animate:false regardless of repo config,
    // render twice 5s apart, and assert equality — this locks all three freeze
    // gates at once (orb color wave, orb breath/shimmer, and face expression),
    // which the orb-level unit tests do not cover.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-freeze-'));
    const previousStatePath = process.env.COMPANION_STATE_PATH;
    process.env.COMPANION_STATE_PATH = path.join(tmpDir, '_runs', 'os', '.companion-state.json');
    let cfgSpy, nowSpy;
    try {
      const mod = requireFresh();
      const ccMod = _require(path.resolve(__dirname, '../companion-config.cjs'));
      cfgSpy = vi.spyOn(ccMod, 'loadCompanionConfig').mockReturnValue({ ...ccMod.loadCompanionConfig(), animate: false });
      const state = JSON.parse(fs.readFileSync(MOCK_HEALTHY, 'utf8'));
      state.projectRoot = tmpDir;
      state.terminal = { cols: 120, rows: 24 };
      nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
      const first = mod.renderStatusLine(state, 8);
      nowSpy.mockReturnValue(1_700_000_000_000 + 5_000); // advance 5s: would shift wave/breath if live
      const second = mod.renderStatusLine(state, 8);
      expect(second).toEqual(first);
    } finally {
      if (cfgSpy) cfgSpy.mockRestore();
      if (nowSpy) nowSpy.mockRestore();
      if (previousStatePath === undefined) delete process.env.COMPANION_STATE_PATH;
      else process.env.COMPANION_STATE_PATH = previousStatePath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── Wave 1: faceMotion gate (e4d905d2 revert) ────────────────────────────────
// The per-tool eye SWAP for thinking/exhausted is OFF by default (calm steady
// eyes). It only runs when companion.faceMotion === true AND zen !== true.
describe('hud-engine resolveCompanionFace — faceMotion gate (Wave 1)', () => {
  let cfgRoot;
  let statePath;
  let prevProjectDir;
  let prevStatePath;

  const { stripAnsi } = _require(path.resolve(__dirname, '../hud-palette.cjs'));

  function freshEngine() {
    for (const key of Object.keys(_require.cache)) {
      if (key.includes('hud-engine') || key.includes('hud-palette') || key.includes('hud-zone') ||
          key.includes('companion-state') || key.includes('companion-config') || key.includes('companion-insights')) {
        delete _require.cache[key];
      }
    }
    return _require(ENGINE_PATH);
  }

  function setFaceMotion(val) {
    const dir = path.join(cfgRoot, '.4ge');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ companion: { faceMotion: val } }));
    process.env.CLAUDE_PROJECT_DIR = cfgRoot;
  }

  // stdin that drives detectState → 'tool-running' (outputTokens grew past prev 100).
  const thinkingStdin = {
    session: { id: 'sess-w1', outputTokens: 5000, toolCount: 5 },
    context_window: { total_output_tokens: 5000, used_percentage: 10 },
  };

  function seedPrevState() {
    fs.writeFileSync(statePath, JSON.stringify({
      expression: 'idle', stateKey: 'idle', gaze: 'forward', mode: 'standard',
      changedAt: Date.now() - 99999, lastToolAt: Date.now(), totalOutputTokens: 100,
      toolCount: 5, blinkAt: Date.now(), lastSessionId: 'sess-w1',
    }));
  }

  beforeEach(() => {
    cfgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eng-w1-'));
    statePath = path.join(cfgRoot, '.companion-state.json');
    prevProjectDir = process.env.CLAUDE_PROJECT_DIR;
    prevStatePath = process.env.COMPANION_STATE_PATH;
    process.env.COMPANION_STATE_PATH = statePath;
  });

  afterEach(() => {
    if (prevProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = prevProjectDir;
    if (prevStatePath === undefined) delete process.env.COMPANION_STATE_PATH;
    else process.env.COMPANION_STATE_PATH = prevStatePath;
    fs.rmSync(cfgRoot, { recursive: true, force: true });
  });

  it('faceMotion OFF → steady thinking face (no per-tool swap)', () => {
    setFaceMotion(false);
    seedPrevState();
    const mod = freshEngine();
    const modelFace = { expr: 'thinking', color: 'accent' };
    const a = stripAnsi(mod.resolveCompanionFace(thinkingStdin, {}, modelFace));
    seedPrevState();
    const b = stripAnsi(mod.resolveCompanionFace(thinkingStdin, {}, modelFace));
    // Steady: same face both calls, and it is the model/thinking face, not a swap glyph.
    expect(a).toBe(b);
  });

  it('faceMotion OFF thinking face uses the steady COMPACT_FACES.thinking when no modelFace', () => {
    setFaceMotion(false);
    seedPrevState();
    const mod = freshEngine();
    const face = stripAnsi(mod.resolveCompanionFace(thinkingStdin, {}, null));
    const expected = mod.COMPACT_FACES.thinking; // [◠ ▅]
    // The gradient renderer reassembles the bracketed glyphs; both glyphs must appear.
    const m = expected.match(/^\[(.+) (.+)\]$/);
    expect(face).toContain(m[1]);
    expect(face).toContain(m[2]);
  });

  it('faceMotion ON → swap glyphs differ from the steady face', () => {
    setFaceMotion(false);
    seedPrevState();
    let mod = freshEngine();
    const modelFace = { expr: 'thinking', color: 'accent' };
    const steady = stripAnsi(mod.resolveCompanionFace(thinkingStdin, {}, modelFace));

    setFaceMotion(true);
    seedPrevState();
    mod = freshEngine();
    const swap = stripAnsi(mod.resolveCompanionFace(thinkingStdin, {}, modelFace));
    // The swap path renders [▅ ▃]/[▃ ▅] — different from the steady model face.
    expect(swap).not.toBe(steady);
  });

  it('zen forces calm even when faceMotion is true (swap suppressed)', () => {
    // faceMotion true BUT zen true → gate is `faceMotion===true && zen!==true` → false → steady.
    const dir = path.join(cfgRoot, '.4ge');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ companion: { faceMotion: true, zen: true } }));
    process.env.CLAUDE_PROJECT_DIR = cfgRoot;
    seedPrevState();
    let mod = freshEngine();
    const modelFace = { expr: 'thinking', color: 'accent' };
    const zenFace = stripAnsi(mod.resolveCompanionFace(thinkingStdin, {}, modelFace));

    // Compare against pure faceMotion:false (calm) — should match (zen ⇒ calm).
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ companion: { faceMotion: false } }));
    seedPrevState();
    mod = freshEngine();
    const calmFace = stripAnsi(mod.resolveCompanionFace(thinkingStdin, {}, modelFace));
    expect(zenFace).toBe(calmFace);
  });
});

describe('hud-engine CLI statusline mode (integration)', () => {
  it('produces output in statusline mode', { timeout: 15000 }, () => {
    const harnessInput = JSON.stringify({
      model: { model_id: 'claude-opus-4-6', display_name: 'Opus 4.6' },
      context_window: { used_percentage: 12, total_tokens: 1000000 },
      rate_limits: {
        five_hour: { used_percentage: 30 },
        seven_day: { used_percentage: 10 },
      },
      cost: { total_cost: 2.87 },
      session_id: 'session-test-123',
    });
    const output = execSync(
      `node "${ENGINE_PATH}" --mode=statusline --max-rows=8`,
      { input: harnessInput, encoding: 'utf8', timeout: 10000 }
    );
    expect(output.length).toBeGreaterThan(0);
  });

  it('respects --max-rows flag in statusline mode', { timeout: 15000 }, () => {
    // FIX(D2): statusline is the only mode that honors --max-rows.
    // full mode ignores the flag (row budget is driven by state.terminal.rows, not the CLI flag).
    // Using a static harness input (not MOCK_HEALTHY disk read) prevents disk-state races
    // between the two execSync spawns — the original source of the flake.
    const staticInput = JSON.stringify({
      model: { model_id: 'claude-opus-4-6', display_name: 'Opus 4.6' },
      context_window: { used_percentage: 12, total_tokens: 1000000 },
      rate_limits: { five_hour: { used_percentage: 30 }, seven_day: { used_percentage: 10 } },
      cost: { total_cost: 2.87 },
      session_id: 'session-test-123',
    });
    const outputSmall = execSync(
      `node "${ENGINE_PATH}" --mode=statusline --max-rows=4`,
      { input: staticInput, encoding: 'utf8', timeout: 10000 }
    );
    const outputLarge = execSync(
      `node "${ENGINE_PATH}" --mode=statusline --max-rows=24`,
      { input: staticInput, encoding: 'utf8', timeout: 10000 }
    );
    expect(outputSmall.split('\n').length).toBeLessThanOrEqual(outputLarge.split('\n').length);
  });
});
