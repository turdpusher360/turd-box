import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const _require = createRequire(import.meta.url);
const TMUX_PATH = path.resolve(__dirname, '../hud-tmux-pane.cjs');
const { stripAnsi } = _require(path.resolve(__dirname, '../hud-palette.cjs'));

function requireFresh() {
  for (const key of Object.keys(_require.cache)) {
    if (key.includes('hud-tmux-pane') || key.includes('hud-surface-host') || key.includes('hud-engine')) {
      delete _require.cache[key];
    }
  }
  return _require(TMUX_PATH);
}

describe('hud-tmux-pane', () => {
  let tmpRoot;
  let stateDir;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-tmux-pane-'));
    stateDir = path.join(tmpRoot, '_runs', 'os');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'session-meta.json'),
      JSON.stringify({
        session_id: 'tmux-test',
        model: 'claude-opus-4-6',
        est_context_pct: 18,
        tool_count_running: 5,
      }),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('exports import-safe tmux helpers backed by the surface host', () => {
    const tmux = requireFresh();
    expect(tmux.usesSurfaceHost).toBe(true);
    expect(typeof tmux.buildState).toBe('function');
    expect(typeof tmux.renderScene).toBe('function');
  });

  it('builds and renders tmux state through the shared host without starting the pane', () => {
    const tmux = requireFresh();
    const state = tmux.buildState({
      projectRoot: tmpRoot,
      stateDir,
      terminal: { cols: 100, rows: 30 },
    });
    const output = stripAnsi(tmux.renderScene({
      projectRoot: tmpRoot,
      stateDir,
      terminal: { cols: 100, rows: 30 },
    }));

    expect(state.session.id).toBe('tmux-test');
    expect(state.context.trigger).toBe('tmux-pane');
    expect(output).toContain('Agentic OS');
    expect(output).toContain('last render:');
  });
});
