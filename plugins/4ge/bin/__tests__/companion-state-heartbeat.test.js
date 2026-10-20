// Quiet statusline ticks do not rewrite the shared companion state (SP1 D4, 2026-10-15).
// resolveExpression stamped `lastHeartbeat` on every tick (every ~2 s per session), so the
// state file was rewritten, tmp file and all, even when nothing else had moved. The write is
// now skipped when only the heartbeat changed; a real change (session, blink, expression)
// still persists, and the heartbeat itself is refreshed once per HEARTBEAT_WRITE_INTERVAL_MS.
// Synthetic fixtures only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);
const MODULE_PATH = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../companion-state.cjs');
const { loadCompanionConfig, clearCache: clearCompanionConfig } = _require('../companion-config.cjs');

// 12:00:00 UTC, second 0 of the minute: the gaze-drift phase is 0.
const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);

let tmpDir;
let statePath;
let previousStatePath;
let previousProjectDir;
let homeSpy;
let renameCalls;

function loadModule() {
  delete _require.cache[MODULE_PATH];
  return _require(MODULE_PATH);
}

function quietState(overrides = {}) {
  return {
    expression: 'proud joy',
    gaze: 'forward',
    mode: 'standard',
    stateKey: 'idle',
    changedAt: NOW - 600_000,
    lastToolAt: NOW - 1000,
    blinkAt: NOW - 600_000,
    gazePhase: 0,
    lastSessionId: 'sess-quiet',
    totalOutputTokens: 0,
    lastHeartbeat: NOW - 2000,
    ...overrides,
  };
}

function writeState(state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state));
}

const readState = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-heartbeat-'));
  statePath = path.join(tmpDir, '_runs', 'os', '.companion-state.json');
  previousStatePath = process.env.COMPANION_STATE_PATH;
  process.env.COMPANION_STATE_PATH = statePath;
  homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
  // companion-state reads its config with no root, so the root comes from CLAUDE_PROJECT_DIR
  // or the cwd: point it at the tmp dir, and drop a config cached by an earlier test.
  previousProjectDir = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = tmpDir;
  clearCompanionConfig();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  renameCalls = 0;
  const realRename = fs.renameSync;
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(to) === statePath) renameCalls += 1;
    return realRename.call(fs, from, to);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  homeSpy.mockRestore();
  if (previousStatePath === undefined) delete process.env.COMPANION_STATE_PATH;
  else process.env.COMPANION_STATE_PATH = previousStatePath;
  if (previousProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = previousProjectDir;
  clearCompanionConfig();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const QUIET_STDIN = { session: { id: 'sess-quiet', toolCount: 0, outputTokens: 0 } };

describe('resolveExpression heartbeat writes', () => {
  it('skips the write when only the heartbeat would change', () => {
    writeState(quietState());
    const { resolveExpression } = loadModule();

    const result = resolveExpression(QUIET_STDIN);

    expect(result.stateKey).toBe('idle');
    expect(renameCalls).toBe(0);
    expect(readState().lastHeartbeat).toBe(NOW - 2000);
  });

  it('refreshes the persisted heartbeat once the write interval has passed', () => {
    const { resolveExpression, HEARTBEAT_WRITE_INTERVAL_MS } = loadModule();
    writeState(quietState({ lastHeartbeat: NOW - HEARTBEAT_WRITE_INTERVAL_MS - 1 }));

    resolveExpression(QUIET_STDIN);

    expect(renameCalls).toBe(1);
    expect(readState().lastHeartbeat).toBe(NOW);
  });

  it('still persists a session change', () => {
    writeState(quietState());
    const { resolveExpression } = loadModule();

    resolveExpression({ session: { id: 'sess-other', toolCount: 0, outputTokens: 0 } });

    expect(renameCalls).toBe(1);
    expect(readState().lastSessionId).toBe('sess-other');
  });

  it('still persists the blink timestamp of a long-idle blink', () => {
    const { resolveExpression } = loadModule();
    const cfgBlinkMs = loadCompanionConfig(tmpDir).blinkInterval;
    writeState(quietState({
      stateKey: 'long-idle',
      lastToolAt: NOW - 400_000,
      changedAt: NOW - 400_000,
      blinkAt: NOW - cfgBlinkMs - 5000,
    }));

    const result = resolveExpression(QUIET_STDIN);

    expect(result.expression).toBe('blink');
    expect(renameCalls).toBe(1);
    expect(readState().blinkAt).toBe(NOW);
  });

  it('still persists an expression change and its changedAt', () => {
    writeState(quietState());
    const { resolveExpression } = loadModule();

    // 85% context is an immediate, higher-priority state: the key and changedAt move.
    const result = resolveExpression({
      session: { id: 'sess-quiet', toolCount: 0, outputTokens: 0 },
      context_window: { used_percentage: 85 },
    });

    expect(result.expression).toBe('exhausted');
    expect(renameCalls).toBe(1);
    const saved = readState();
    expect(saved.stateKey).toBe('context-warn');
    expect(saved.changedAt).toBe(NOW);
  });

  it('writes on the first tick, when no state file exists yet', () => {
    const { resolveExpression } = loadModule();

    resolveExpression(QUIET_STDIN);

    expect(renameCalls).toBe(1);
    expect(readState().lastSessionId).toBe('sess-quiet');
  });
});
