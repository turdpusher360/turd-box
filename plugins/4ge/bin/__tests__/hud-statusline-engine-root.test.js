// Statusline engine root (SP1 follow-up, 2026-10-17): the orb's active flag, its freeze
// time and the companion config are read from the session's project root
// (rawState.projectRoot), never from the folder the engine file sits in. An engine run
// from another install (the ext4 plugin cache) must still see the repo's flag, or the orb
// differs from the checkout-rooted engine on every tick. Synthetic fixtures only.
import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);
const BIN = path.resolve(__dirname, '..');
const ENGINE_PATH = path.join(BIN, 'hud-engine.cjs');
const CONFIG_PATH = path.join(BIN, 'companion-config.cjs');
const ACTIVE_FLAG_PATH = path.resolve(BIN, '..', 'lib', 'hud-active-flag.cjs');
const MOCK_HEALTHY = path.join(BIN, 'mocks', 'healthy.json');
// The root the engine derived from its own location before this fix.
const ENGINE_INSTALL_ROOT = path.resolve(BIN, '..', '..', '..');

function requireFreshEngine() {
  for (const key of Object.keys(_require.cache)) {
    if (key.startsWith(BIN + path.sep) && !key.includes(`${path.sep}__tests__${path.sep}`)) {
      delete _require.cache[key];
    }
  }
  return _require(ENGINE_PATH);
}

// A throwaway project root, a home directory without operator config, and a companion
// state file of its own (the module reads COMPANION_STATE_PATH when it loads).
function withIsolatedRoot(label, fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
  const previous = process.env.COMPANION_STATE_PATH;
  process.env.COMPANION_STATE_PATH = path.join(tmpDir, '_runs', 'os', '.companion-state.json');
  try {
    return fn(tmpDir);
  } finally {
    vi.restoreAllMocks();
    homeSpy.mockRestore();
    if (previous === undefined) delete process.env.COMPANION_STATE_PATH;
    else process.env.COMPANION_STATE_PATH = previous;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function healthyState(tmpDir) {
  const state = JSON.parse(fs.readFileSync(MOCK_HEALTHY, 'utf8'));
  state.projectRoot = tmpDir;
  state.terminal = { cols: 120, rows: 24 };
  return state;
}

function writeActiveFlag(root) {
  const now = Date.now();
  const file = path.join(root, '_runs', 'os', 'hud-active.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    active: true,
    since: new Date(now).toISOString(),
    expires_at: new Date(now + 60_000).toISOString(),
  }));
}

// The engine takes isActive and getFreezeTime from the flag module when it loads, so the
// spies go on before the fresh engine require. companion-config is required at render
// time, so its spy goes on the module the fresh engine will use.
function renderWithSpies(tmpDir) {
  const flag = _require(ACTIVE_FLAG_PATH);
  const activeSpy = vi.spyOn(flag, 'isActive');
  const freezeSpy = vi.spyOn(flag, 'getFreezeTime');
  const mod = requireFreshEngine();
  const config = _require(CONFIG_PATH);
  const configSpy = vi.spyOn(config, 'loadCompanionConfig');
  const output = mod.renderStatusLine(healthyState(tmpDir), 3);
  // Other modules (the companion state and insights) also load the config with no root,
  // which falls back to CLAUDE_PROJECT_DIR; only a call that names a root is the engine's.
  const configRoots = configSpy.mock.calls.map((c) => c[0]).filter((root) => root !== undefined);
  return { output, activeSpy, freezeSpy, configRoots };
}

describe('statusline engine root', () => {
  it('reads the active flag and the companion config from the project root while active', () => {
    withIsolatedRoot('hud-engine-root-active', (tmpDir) => {
      expect(tmpDir).not.toBe(ENGINE_INSTALL_ROOT);
      writeActiveFlag(tmpDir);
      const { output, activeSpy, freezeSpy, configRoots } = renderWithSpies(tmpDir);

      expect(output.length).toBeGreaterThan(0);
      expect(configRoots).toEqual([tmpDir]);
      expect(activeSpy.mock.calls.map((c) => c[0])).toEqual([tmpDir]);
      expect(activeSpy.mock.results[0].value).toBe(true);
      // Active: the orb animates, so no freeze time is read.
      expect(freezeSpy).not.toHaveBeenCalled();
    });
  });

  it('reads the freeze time from the project root while idle, never from the install dir', () => {
    withIsolatedRoot('hud-engine-root-idle', (tmpDir) => {
      const { activeSpy, freezeSpy, configRoots } = renderWithSpies(tmpDir);

      expect(configRoots).toEqual([tmpDir]);
      expect(activeSpy.mock.calls.map((c) => c[0])).toEqual([tmpDir]);
      expect(activeSpy.mock.results[0].value).toBe(false);
      expect(freezeSpy.mock.calls.map((c) => c[0])).toEqual([tmpDir]);
      const roots = [...activeSpy.mock.calls, ...freezeSpy.mock.calls].map((c) => c[0]).concat(configRoots);
      expect(roots).not.toContain(ENGINE_INSTALL_ROOT);
    });
  });
});
