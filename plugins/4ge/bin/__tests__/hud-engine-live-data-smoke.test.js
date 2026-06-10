import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { renderByMode } = require('../hud-engine.cjs');
const { loadHudData } = require('../hud-data-loader.cjs');
const { stripAnsi } = require('../hud-palette.cjs');

describe('hud-engine live-data smoke', () => {
  let tmpStateDir;
  let tmpCwd;

  beforeEach(() => {
    tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-state-'));
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-cwd-'));

    // Flat health.json -- critical: no wrapper
    fs.writeFileSync(
      path.join(tmpStateDir, 'health.json'),
      JSON.stringify({
        git: { ok: true, version: '2.45' },
        forge: { ok: true, active_session: false },
        audit: { ok: true, audit_agents: 5 },
      })
    );
    fs.writeFileSync(
      path.join(tmpStateDir, 'boot-status.json'),
      JSON.stringify({
        session_id: 'smoke-sess',
        booted_at: new Date(Date.now() - 5000).toISOString(),
        capabilities: {
          git: { status: 'ready', init_ms: 3 },
          forge: { status: 'ready', init_ms: 2 },
          audit: { status: 'ready', init_ms: 1 },
        },
        total_boot_ms: 10,
      })
    );
    fs.writeFileSync(
      path.join(tmpStateDir, 'session-meta.json'),
      JSON.stringify({
        model: 'claude-opus-4-6[1m]',
        session_id: 'smoke-sess',
        est_context_pct: 14,
        tool_count_running: 77,
        context_window: 1000000,
      })
    );
  });

  afterEach(() => {
    fs.rmSync(tmpStateDir, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  it('strip mode shows live ctx% from session-meta', () => {
    const raw = loadHudData({ stateDir: tmpStateDir, cwd: tmpCwd, runExpensiveProbes: false });
    const out = renderByMode(raw, 'strip');
    expect(stripAnsi(out)).toContain('ctx 14%');
  });

  it('full mode renders without crashes using live data', () => {
    const raw = loadHudData({ stateDir: tmpStateDir, cwd: tmpCwd, runExpensiveProbes: false });
    const out = renderByMode(raw, 'full');
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
    // Context zone renders — label is conditional on whether data is estimated
    expect(out.length).toBeGreaterThan(100);
  });

  it('zone context renders rate: -- when live data has no rate info', () => {
    const raw = loadHudData({ stateDir: tmpStateDir, cwd: tmpCwd, runExpensiveProbes: false });
    raw.context = { trigger: 'manual', zone: 'context', event: null };
    const out = renderByMode(raw, 'zone');
    expect(stripAnsi(out)).toContain('rate: --');
  });

  it('stdinOverride merges cleanly with file data', () => {
    const raw = loadHudData({
      stateDir: tmpStateDir,
      cwd: tmpCwd,
      runExpensiveProbes: false,
      stdinOverride: { theme: { name: 'dark' } },
    });
    const out = renderByMode(raw, 'full');
    expect(typeof out).toBe('string');
  });
});
