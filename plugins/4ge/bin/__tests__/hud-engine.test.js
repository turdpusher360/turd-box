import { describe, it, expect, vi } from 'vitest';
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
    try {
      const mod = requireFresh();
      const state = JSON.parse(fs.readFileSync(MOCK_HEALTHY, 'utf8'));
      state.projectRoot = tmpDir;
      state.terminal = { cols: 120, rows: 24 };
      const output = mod.renderStatusLine(state, 8);
      const firstLine = stripAnsi(output).split('\n')[0];
      expect(firstLine).toContain('[▌ ▆]');
      expect(firstLine).not.toContain('[█ ▆]');
    } finally {
      nowSpy.mockRestore();
      if (previousStatePath === undefined) delete process.env.COMPANION_STATE_PATH;
      else process.env.COMPANION_STATE_PATH = previousStatePath;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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
