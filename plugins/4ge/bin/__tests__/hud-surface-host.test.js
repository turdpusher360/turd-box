import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const _require = createRequire(import.meta.url);
const HOST_PATH = path.resolve(__dirname, '../hud-surface-host.cjs');
const MOCK_HEALTHY = path.resolve(__dirname, '../mocks/healthy.json');
const { stripAnsi } = _require(path.resolve(__dirname, '../hud-palette.cjs'));

function requireFresh() {
  for (const key of Object.keys(_require.cache)) {
    if (key.includes('hud-surface-host') || key.includes('hud-engine') || key.includes('hud-data-loader')) {
      delete _require.cache[key];
    }
  }
  return _require(HOST_PATH);
}

describe('hud-surface-host', () => {
  let tmpRoot;
  let stateDir;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-surface-host-'));
    stateDir = path.join(tmpRoot, '_runs', 'os');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'session-meta.json'),
      JSON.stringify({
        session_id: 'surface-test',
        model: 'claude-opus-4-6',
        est_context_pct: 22,
        tool_count_running: 7,
      }),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('loads HUD state with shared project root, state dir, terminal, and context overrides', () => {
    const host = requireFresh();
    const state = host.loadSurfaceState({
      projectRoot: tmpRoot,
      stateDir,
      terminal: { cols: 100, rows: 33 },
      context: { trigger: 'surface-test' },
    });

    expect(state.projectRoot).toBe(tmpRoot);
    expect(state.session.id).toBe('surface-test');
    expect(state.terminal).toEqual({ cols: 100, rows: 33 });
    expect(state.context.trigger).toBe('surface-test');
  });

  it('renders a supplied raw state through the shared mode router', () => {
    const host = requireFresh();
    const rawState = JSON.parse(fs.readFileSync(MOCK_HEALTHY, 'utf8'));
    rawState.git = { branch: 'surface/main', dirty: false, uncommittedFiles: 0 };

    const result = host.renderSurface({
      rawState,
      mode: 'strip',
      terminal: { cols: 100, rows: 24 },
      context: { trigger: 'surface-test' },
    });

    expect(result.state.context.trigger).toBe('surface-test');
    expect(stripAnsi(result.output)).toContain('surface/main');
  });
});
