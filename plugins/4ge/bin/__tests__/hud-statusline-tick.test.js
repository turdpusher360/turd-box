// Statusline tick cost and layout (SP1, 2026-10-15): the engine resolves the companion
// once per tick, loads its substrate and scene modules only when those modes run, and
// builds the statusline's load options from the live stdin session. Feed rows keep their
// column once the harness trims leading spaces. Synthetic fixtures only.
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
const COMPANION_PATH = path.join(BIN, 'companion-state.cjs');
const INSIGHTS_PATH = path.join(BIN, 'companion-insights.cjs');
const SUBSTRATE_PATH = path.join(BIN, 'hud-zone-substrate.cjs');
const SCENE_PATH = path.join(BIN, 'scene-compositor.cjs');
const MOCK_HEALTHY = path.join(BIN, 'mocks', 'healthy.json');
const { stripAnsi } = _require(path.join(BIN, 'hud-palette.cjs'));

const BB = '⠀';

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

describe('statusline tick cost', () => {
  it('builds the statusline load options from the live stdin session and parses the transcript only for the activity zone', () => {
    const mod = requireFreshEngine();
    const opts = mod.statuslineLoadOptions({ session_id: 'live-session-1' }, '/tmp/example-root');

    // The loader calls this with the fresh reactive state (or null); true means skip.
    expect(typeof opts.skipTranscript).toBe('function');
    expect(opts.skipTranscript(null)).toBe(true);
    expect(opts.skipTranscript({ event: 'commit' })).toBe(true);
    expect(opts.skipTranscript({ event: 'no-such-event' })).toBe(true);
    expect(opts.skipTranscript({ event: 'test-pass' })).toBe(false);
    expect(opts.skipTranscript({ event: 'skill-load' })).toBe(false);
    expect(opts.sessionId).toBe('live-session-1');
    expect(opts.cwd).toBe('/tmp/example-root');
    expect(opts.stateDir).toBe(path.join('/tmp/example-root', '_runs', 'os'));
    expect(opts.runExpensiveProbes).toBe(false);
    // No stdin session: an empty id means "no session", never the shared meta session.
    expect(mod.statuslineLoadOptions(null, '/tmp/example-root').sessionId).toBe('');
    expect(mod.statuslineLoadOptions({}, '/tmp/example-root').sessionId).toBe('');
  });

  it('resolves the companion expression once per statusline render', () => {
    withIsolatedRoot('hud-tick-resolve', (tmpDir) => {
      const mod = requireFreshEngine();
      const companion = _require(COMPANION_PATH);
      const resolveSpy = vi.spyOn(companion, 'resolveExpression');
      const statePath = process.env.COMPANION_STATE_PATH;
      const realRename = fs.renameSync;
      let stateWrites = 0;
      const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        if (String(to) === statePath) stateWrites += 1;
        return realRename(from, to);
      });
      try {
        const output = mod.renderStatusLine(healthyState(tmpDir), 3);
        expect(output.length).toBeGreaterThan(0);
        expect(resolveSpy).toHaveBeenCalledTimes(1);
        // Each resolve is a read-modify-write of the shared state file.
        expect(stateWrites).toBeLessThanOrEqual(1);
      } finally {
        renameSpy.mockRestore();
        resolveSpy.mockRestore();
      }
    });
  });

  it('loads the substrate and scene modules on first use, not when the engine loads', () => {
    withIsolatedRoot('hud-tick-lazy', (tmpDir) => {
      const mod = requireFreshEngine();
      expect(_require.cache[SUBSTRATE_PATH]).toBeUndefined();
      expect(_require.cache[SCENE_PATH]).toBeUndefined();

      const state = healthyState(tmpDir);
      mod.renderStatusLine(state, 3);
      expect(_require.cache[SUBSTRATE_PATH]).toBeUndefined();
      expect(_require.cache[SCENE_PATH]).toBeUndefined();

      expect(typeof mod.renderByMode(state, 'substrate', 8)).toBe('string');
      expect(_require.cache[SUBSTRATE_PATH]).toBeDefined();
      expect(typeof mod.renderByMode(state, 'scene', 8)).toBe('string');
      expect(_require.cache[SCENE_PATH]).toBeDefined();
    });
  });
});

describe('statusline feed row alignment', () => {
  it('keeps every feed row under the header text after the harness trims leading spaces', () => {
    withIsolatedRoot('hud-feed-gutter', (tmpDir) => {
      const mod = requireFreshEngine();
      // A companion insight would replace row 1 with the speech bubble, so stub the source.
      _require.cache[INSIGHTS_PATH] = { exports: { getInsight: () => null } };
      try {
        const state = healthyState(tmpDir);
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
        state.session.rateLimits = { fiveHour: 88, sevenDay: 20 };
        state.session.rateLimitHistory = [
          { fiveHour: 40, sevenDay: 10 },
          { fiveHour: 52, sevenDay: 12 },
          { fiveHour: 70, sevenDay: 15 },
          { fiveHour: 88, sevenDay: 20 },
        ];

        const lines = stripAnsi(mod.renderStatusLine(state, 8)).split('\n');
        // The harness drops leading normal spaces from every line it paints.
        const trim = (line) => line.replace(/^ +/, '');

        const header = trim(lines[0]);
        const labelCol = header.indexOf(path.basename(tmpDir));
        expect(labelCol).toBeGreaterThan(0);

        const feed = lines.slice(3).filter((line) => line.trim() !== '');
        const joined = feed.join('\n');
        expect(joined).toContain('anomaly signal');
        expect(joined).toContain('reactive commit');
        expect(joined).toContain('rate trend');

        for (const line of feed) {
          const row = trim(line);
          // The label column equals the header's: the gutter survived the trim.
          expect(row.search(new RegExp(`[^${BB} ]`))).toBe(labelCol);
          expect(row.codePointAt(0)).toBe(BB.codePointAt(0));
        }
      } finally {
        delete _require.cache[INSIGHTS_PATH];
      }
    });
  });
});
