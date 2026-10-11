import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const _require = createRequire(import.meta.url);
const TMUX_PATH = path.resolve(__dirname, '../hud-tmux-pane.cjs');
const SURFACE_HOST_PATH = path.resolve(__dirname, '../hud-surface-host.cjs');
const { stripAnsi } = _require(path.resolve(__dirname, '../hud-palette.cjs'));

// The state files the pane used to synthesize when they were missing.
const SEEDED_FILES = ['health.json', 'boot-status.json', 'session-meta.json'];

// companion-state.cjs and companion-insights.cjs fix their file paths when first
// loaded, so they are reloaded along with the pane once a test has pointed those
// paths at its temp dir.
function requireFresh(stateOverride, renderOverride) {
  for (const key of Object.keys(_require.cache)) {
    if (key.includes('hud-tmux-pane') || key.includes('hud-surface-host') || key.includes('hud-engine')
      || key.includes('companion-state') || key.includes('companion-insights')) {
      delete _require.cache[key];
    }
  }
  if (stateOverride !== undefined || renderOverride !== undefined) {
    const surfaceHost = _require(SURFACE_HOST_PATH);
    _require.cache[SURFACE_HOST_PATH].exports = {
      ...surfaceHost,
      ...(stateOverride !== undefined ? {
        loadSurfaceState: typeof stateOverride === 'function'
          ? stateOverride
          : () => stateOverride,
      } : {}),
      ...(renderOverride !== undefined ? { renderSurface: renderOverride } : {}),
    };
  }
  return _require(TMUX_PATH);
}

// Resolves true once the child has exited (Node reaps it before 'exit'), or
// false if ms pass first.
function waitForExit(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.off('exit', onExit); resolve(false); }, ms);
    function onExit() { clearTimeout(timer); resolve(true); }
    child.once('exit', onExit);
  });
}

// SIGTERM with a short grace, then SIGKILL. Resolves true once the child is gone.
async function stopChild(child) {
  if (child.pid === undefined) return true; // spawn failed; nothing to reap
  if (child.exitCode !== null || child.signalCode !== null) return true;
  child.kill('SIGTERM');
  if (await waitForExit(child, 2000)) return true;
  child.kill('SIGKILL');
  return waitForExit(child, 2000);
}

describe('hud-tmux-pane', () => {
  let tmpRoot;
  let stateDir;
  let previousProjectDir;
  let previousStatePath;

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
    // A render also writes the HUD's own companion state and memory cache,
    // rooted at COMPANION_STATE_PATH and CLAUDE_PROJECT_DIR. Point both at the
    // temp tree before requireFresh() or spawn() (the spawned pane inherits
    // them), so a test run writes nothing outside tmpRoot.
    previousProjectDir = process.env.CLAUDE_PROJECT_DIR;
    previousStatePath = process.env.COMPANION_STATE_PATH;
    process.env.CLAUDE_PROJECT_DIR = tmpRoot;
    process.env.COMPANION_STATE_PATH = path.join(stateDir, '.companion-state.json');
  });

  afterEach(() => {
    if (previousProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = previousProjectDir;
    if (previousStatePath === undefined) delete process.env.COMPANION_STATE_PATH;
    else process.env.COMPANION_STATE_PATH = previousStatePath;
    for (const key of Object.keys(_require.cache)) {
      if (key.includes('companion-state') || key.includes('companion-insights')) delete _require.cache[key];
    }
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

  // The pane used to seed an all-ok health.json, a "ready" boot-status.json and a
  // fake session-meta.json whenever they were missing, into the shared state dir
  // (the live _runs/os by default), so a fresh checkout's HUD, and anything else
  // reading those files, showed green without any real check. Those three files
  // must stay missing. The test waits for the first render ("last render:"),
  // which comes after startup (where the seeding ran) and reads the state dir,
  // then stops the pane: SIGTERM, then SIGKILL if it has not exited.
  it('starting the pane and its first render do not create health.json, boot-status.json or session-meta.json', async () => {
    const emptyDir = path.join(tmpRoot, 'empty-os');
    fs.mkdirSync(emptyDir);
    const child = spawn(process.execPath, [TMUX_PATH, '--state-dir', emptyDir], {
      cwd: tmpRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let spawnError = null;
    let firstRender = false;
    let stopped = false;
    try {
      firstRender = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 10000);
        const finish = (value) => { clearTimeout(timer); resolve(value); };
        child.on('error', (err) => { spawnError = err; finish(false); });
        child.on('exit', () => finish(false));
        child.stdout.on('data', (chunk) => {
          out += chunk.toString('utf8');
          if (out.includes('last render:')) finish(true);
        });
      });
    } finally {
      stopped = await stopChild(child);
    }

    expect(spawnError).toBeNull();
    expect(out).toContain('Watching:');
    expect(firstRender).toBe(true);
    expect(stopped).toBe(true);
    for (const name of SEEDED_FILES) {
      expect(fs.existsSync(path.join(emptyDir, name)), name).toBe(false);
    }
  }, 20000);

  it('renders an empty state dir as health unknown without creating health.json, boot-status.json or session-meta.json', () => {
    const emptyDir = path.join(tmpRoot, 'empty-os-render');
    fs.mkdirSync(emptyDir);
    const tmux = requireFresh();
    const output = stripAnsi(tmux.renderScene({
      projectRoot: tmpRoot,
      stateDir: emptyDir,
      terminal: { cols: 100, rows: 30 },
    }));

    expect(output).not.toContain('hub responding');
    expect(output).not.toContain('repo clean');
    // No capability data: the face and health zones say so, with no "up",
    // "0 ready" or "0 F" grade.
    expect(output).toContain('health unknown');
    expect(output).not.toContain('Agentic OS up');
    expect(output).not.toMatch(/\b0 ready\b/);
    expect(output).not.toMatch(/Health:\s+0\s+F\b/);
    for (const name of SEEDED_FILES) {
      expect(fs.existsSync(path.join(emptyDir, name)), name).toBe(false);
    }
  });

  it('renders an explicit failed boot with no capabilities as health failed', () => {
    const failedDir = path.join(tmpRoot, 'failed-os-render');
    fs.mkdirSync(failedDir);
    fs.writeFileSync(path.join(failedDir, 'health.json'), '{}');
    fs.writeFileSync(path.join(failedDir, 'boot-status.json'), JSON.stringify({
      session_id: 'failed-boot',
      booted_at: new Date().toISOString(),
      capabilities: {},
      overall: 'failed',
      total_boot_ms: 0,
      reason: 'registry unavailable',
    }));
    const tmux = requireFresh();
    const output = stripAnsi(tmux.renderScene({
      projectRoot: tmpRoot,
      stateDir: failedDir,
      terminal: { cols: 100, rows: 30 },
    }));

    expect(output).toContain('health failed');
    expect(output).not.toContain('health unknown');
    expect(output).not.toContain('Agentic OS up');
    expect(output).not.toMatch(/\b\d+ ready\b/);
    expect(output).not.toMatch(/Health:\s+0\s+F\b/);
    expect(output).not.toMatch(/everything is where it should be|all systems green/);
  });

  it.each([
    ['wide', { cols: 100, rows: 30 }],
    ['narrow', { cols: 48, rows: 8 }],
  ])('renders a direct null capability as health unknown in the %s pane', (_label, terminal) => {
    const rawState = {
      projectRoot: tmpRoot,
      terminal,
      session: { id: 'tmux-null', model: 'unknown', contextPct: 0, uptime: 0, toolCount: 0, rateLimits: 'N/A' },
      os: { overallHealth: 'unknown', bootTime: 0, capabilities: { probe: null } },
      forge: { active: false, phase: null, teammates: [], scope: null },
      context: { trigger: 'tmux-pane', event: null, zone: null },
    };
    const tmux = requireFresh(rawState);
    let output;

    expect(() => {
      output = stripAnsi(tmux.renderScene({ projectRoot: tmpRoot, stateDir, terminal }));
    }).not.toThrow();

    expect(output).toContain('health unknown');
    expect(output).not.toContain('Agentic OS up');
    expect(output).not.toMatch(/\b\d+ ready\b/);
    expect(output).not.toMatch(/Health:\s+0\s+F\b/);
  });

  it.each([
    ['wide', { cols: 100, rows: 30 }],
    ['narrow', { cols: 48, rows: 8 }],
  ])('never renders a non-boolean live ok value healthy in the %s pane', (_label, terminal) => {
    const badProbeDir = path.join(tmpRoot, `bad-probe-${terminal.cols}-${terminal.rows}`);
    fs.mkdirSync(badProbeDir);
    fs.writeFileSync(path.join(badProbeDir, 'health.json'), JSON.stringify({ probe: { ok: 'false' } }));
    const tmux = requireFresh();
    let output;

    expect(() => {
      output = stripAnsi(tmux.renderScene({
        projectRoot: tmpRoot,
        stateDir: badProbeDir,
        terminal,
      }));
    }).not.toThrow();

    expect(output).toContain('1 degraded');
    expect(output).not.toContain('Agentic OS up');
    expect(output).not.toMatch(/\b[1-9]\d* ready\b/);
    expect(output).not.toMatch(/Health:\s+100\s+A\b/);
  });

  it.each([
    ['boot-ready + ok="true"', 'ready', { ok: 'true' }, { cols: 100, rows: 30 }],
    ['boot-ready + ok="true" narrow', 'ready', { ok: 'true' }, { cols: 48, rows: 8 }],
    ['boot-ready + ok=null', 'ready', { ok: null }, { cols: 100, rows: 30 }],
    ['boot-ready + ok=null narrow', 'ready', { ok: null }, { cols: 48, rows: 8 }],
    ['boot-degraded + ok="true"', 'degraded', { ok: 'true' }, { cols: 100, rows: 30 }],
    ['boot-degraded + ok="true" narrow', 'degraded', { ok: 'true' }, { cols: 48, rows: 8 }],
    ['boot-degraded + ok=1', 'degraded', { ok: 1 }, { cols: 100, rows: 30 }],
    ['boot-degraded + ok=1 narrow', 'degraded', { ok: 1 }, { cols: 48, rows: 8 }],
    ['boot-degraded + ok={}', 'degraded', { ok: {} }, { cols: 100, rows: 30 }],
    ['boot-degraded + ok={} narrow', 'degraded', { ok: {} }, { cols: 48, rows: 8 }],
  ])('[RED-r5 F1 pane] %s is degraded, never ready', (_label, bootStatus, healthEntry, terminal) => {
    const caseDir = path.join(tmpRoot, `shelved-${terminal.cols}`);
    fs.mkdirSync(caseDir);
    fs.writeFileSync(path.join(caseDir, 'health.json'), JSON.stringify({ probe: healthEntry }));
    fs.writeFileSync(path.join(caseDir, 'boot-status.json'), JSON.stringify({
      capabilities: { probe: { status: bootStatus, init_ms: 4, shelved: true } },
      overall: bootStatus === 'ready' ? 'ready' : 'degraded',
    }));
    const tmux = requireFresh();
    const output = stripAnsi(tmux.renderScene({
      projectRoot: tmpRoot,
      stateDir: caseDir,
      terminal,
    }));

    expect(output).toContain('1 degraded');
    expect(output).not.toContain('Agentic OS up');
    expect(output).not.toMatch(/\b[1-9]\d* ready\b/);
    expect(output).not.toMatch(/everything is where it should be|all systems green/);
    expect(output).toMatch(/Health:\s+0\s+F\b/);
  });

  it('[RED-r5 F2] fallback checks only literal boolean true', () => {
    const fallbackDir = path.join(tmpRoot, 'double-fault');
    fs.mkdirSync(fallbackDir);
    fs.writeFileSync(path.join(fallbackDir, 'health.json'), JSON.stringify({
      a: { ok: 'true' },
      b: { ok: 1 },
      c: { ok: {} },
      d: { ok: true },
      e: { ok: false },
      f: {},
    }));
    const throwLoad = () => { throw new Error('forced loadSurfaceState failure'); };
    const throwRender = () => { throw new Error('forced renderSurface failure'); };
    const tmux = requireFresh(throwLoad, throwRender);
    const output = stripAnsi(tmux.renderScene({
      projectRoot: tmpRoot,
      stateDir: fallbackDir,
      terminal: { cols: 100, rows: 30 },
    }));

    expect(output).toContain('Agentic OS · tmux pane');
    expect(output).toMatch(/^\s*✓ d$/m);
    for (const name of ['a', 'b', 'c', 'e', 'f']) {
      expect(output).toMatch(new RegExp(`^\\s*✗ ${name}$`, 'm'));
    }
    expect(output).not.toMatch(/^\s*✓ [abcef]$/m);
  });
});
