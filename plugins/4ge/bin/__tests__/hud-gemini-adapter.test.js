import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const _require = createRequire(import.meta.url);
const ADAPTER_PATH = path.resolve(__dirname, '../hud-gemini-adapter.cjs');
const { stripAnsi } = _require(path.resolve(__dirname, '../hud-palette.cjs'));

function requireFresh() {
  for (const key of Object.keys(_require.cache)) {
    if (key.includes('hud-gemini-adapter') || key.includes('hud-surface-host') || key.includes('hud-engine') || key.includes('hud-data-loader')) {
      delete _require.cache[key];
    }
  }
  return _require(ADAPTER_PATH);
}

describe('hud-gemini-adapter', () => {
  let tmpRoot;
  let stateDir;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-gemini-adapter-'));
    stateDir = path.join(tmpRoot, '_runs', 'os');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'session-meta.json'),
      JSON.stringify({
        session_id: 'gemini-test',
        model: 'claude-opus-4-6',
        est_context_pct: 11,
        tool_count_running: 3,
      }),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('buildRawState uses the shared surface host for workspace-backed HUD state', () => {
    const adapter = requireFresh();
    expect(adapter.usesSurfaceHost).toBe(true);

    const state = adapter.buildRawState({
      workspace: tmpRoot,
      context_usage: 0.42,
      terminal_width: 120,
      git_branch: 'gemini/main',
      model: 'gemini-3-pro',
    });

    expect(state.projectRoot).toBe(tmpRoot);
    expect(state.session.id).toBe('gemini-test');
    expect(state.session.contextPct).toBe(42);
    expect(state.terminal.cols).toBe(120);
    expect(state.git.branch).toBe('gemini/main');
    expect(state.context.trigger).toBe('gemini-statusline');
  });

  it('renders a strip line for Antigravity payloads', () => {
    const adapter = requireFresh();
    const output = stripAnsi(adapter.adaptAndRender({
      workspace: { current_dir: tmpRoot },
      context_usage: 12,
      git_branch: 'gemini/branch',
      terminal_width: 100,
    }));

    expect(output).toContain('ctx 12%');
    expect(output).toContain('gemini/branch');
  });
});
