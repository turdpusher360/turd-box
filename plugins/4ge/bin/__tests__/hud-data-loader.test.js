import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  loadHudData,
  buildCapabilities,
  computeUptime,
  resolveSessionUptime,
  deriveOverall,
  mergeHarnessStdin,
  readFreshJson,
  readFreshReactiveState,
  readFreshAnomalyState,
  readFreshVramState,
  readFreshReaperState,
} = require('../hud-data-loader.cjs');
const { countDegraded } = require('../hud-state.cjs');
const companionInsights = require('../companion-insights.cjs');
const { buildProjectSlug } = require('../hud-transcript-source.cjs');
const actualRefreshMemoryCache = companionInsights.refreshMemoryCache;
const realRefreshMemoryCache = vi.fn((...args) => actualRefreshMemoryCache(...args));
const refreshMemoryCacheStub = vi.fn().mockResolvedValue(undefined);

// loadHudData() requires companion-insights.cjs at call time and destructures
// this export then. Replacing the CommonJS exports-object property therefore
// contains every test in this file without relying on ESM vi.mock interception.
companionInsights.refreshMemoryCache = refreshMemoryCacheStub;

afterAll(() => {
  companionInsights.refreshMemoryCache = actualRefreshMemoryCache;
});

const SHELVED_MALFORMED_CASES = [
  ['boot-ready + ok="true"', 'ready', { ok: 'true' }],
  ['boot-ready + ok=null', 'ready', { ok: null }],
  ['boot-degraded + ok="true"', 'degraded', { ok: 'true' }],
  ['boot-degraded + ok=1', 'degraded', { ok: 1 }],
  ['boot-degraded + ok={}', 'degraded', { ok: {} }],
];

const SHELVED_CONTROL_CASES = [
  ['boot-degraded + ok=false', { probe: { ok: false } }],
  ['boot-degraded + no health entry', {}],
];

describe('hud-data-loader', () => {
  let tmpStateDir;
  let tmpCwd;

  beforeEach(() => {
    tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hdl-state-'));
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hdl-cwd-'));
  });

  afterEach(() => {
    fs.rmSync(tmpStateDir, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  describe('readFreshJson', () => {
    it('returns parsed JSON when a timestamp key is within ttl', () => {
      const filePath = path.join(tmpStateDir, 'fresh.json');
      fs.writeFileSync(filePath, JSON.stringify({ updated_at: new Date(Date.now() - 1000).toISOString(), value: 42 }));

      const result = readFreshJson(filePath, {
        ttlMs: 5000,
        timestampKeys: ['updated_at'],
        fallback: null,
      });

      expect(result.value).toBe(42);
    });

    it('returns the configured fallback when timestamp-key data is stale or invalid', () => {
      const filePath = path.join(tmpStateDir, 'stale.json');
      fs.writeFileSync(filePath, JSON.stringify({ updated_at: new Date(Date.now() - 10000).toISOString(), value: 42 }));

      expect(readFreshJson(filePath, {
        ttlMs: 5000,
        timestampKeys: ['updated_at'],
        fallback: {},
      })).toEqual({});

      fs.writeFileSync(filePath, JSON.stringify({ updated_at: 'not-a-date', value: 42 }));
      expect(readFreshJson(filePath, {
        ttlMs: 5000,
        timestampKeys: ['updated_at'],
        fallback: {},
      })).toEqual({});
    });

    it('supports mtime fallback when older data files have no in-json timestamp', () => {
      const filePath = path.join(tmpStateDir, 'mtime.json');
      fs.writeFileSync(filePath, JSON.stringify({ value: 'ok' }));
      const fresh = new Date(Date.now() - 1000);
      fs.utimesSync(filePath, fresh, fresh);

      expect(readFreshJson(filePath, {
        ttlMs: 5000,
        timestampKeys: ['startedAt'],
        mtimeFallback: true,
      })).toEqual({ value: 'ok' });

      const stale = new Date(Date.now() - 10000);
      fs.utimesSync(filePath, stale, stale);
      expect(readFreshJson(filePath, {
        ttlMs: 5000,
        timestampKeys: ['startedAt'],
        mtimeFallback: true,
        fallback: null,
      })).toBeNull();
    });
  });

  it('buildCapabilities merges boot-status + flat health (no .capabilities key)', () => {
    const boot = {
      capabilities: {
        git: { status: 'ready', init_ms: 5 },
        forge: { status: 'degraded', init_ms: 3, reason: 'stale' },
      },
    };
    // Flat health map -- NO wrapper
    const health = {
      git: { ok: true, version: '2.45' },
      forge: { ok: false, reason: 'no session' },
    };
    const caps = buildCapabilities(boot, health);
    expect(caps.git.ok).toBe(true);
    expect(caps.git.init_ms).toBe(5);
    expect(caps.forge.ok).toBe(false);
    expect(caps.forge.reason).toBe('no session');
  });

  it.each([
    ['health-only string "false"', {}, { probe: { ok: 'false' } }],
    ['health-only null', {}, { probe: { ok: null } }],
    ['health-only number', {}, { probe: { ok: 1 } }],
    ['boot-ready plus null', { capabilities: { probe: { status: 'ready', init_ms: 4 } } }, { probe: { ok: null } }],
    ['boot-ready plus string "false"', { capabilities: { probe: { status: 'ready', init_ms: 4 } } }, { probe: { ok: 'false' } }],
    ['boot-degraded plus string "true"', { capabilities: { probe: { status: 'degraded', init_ms: 4 } } }, { probe: { ok: 'true' } }],
  ])('treats %s as a non-ready failed live probe', (_label, boot, health) => {
    const caps = buildCapabilities(boot, health);

    expect(caps.probe.ok).toBe(false);
    expect(caps.probe.status).toBe('degraded');
    expect(countDegraded(caps)).toBe(1);
    expect(deriveOverall(caps)).toBe('degraded');
  });

  it.each(SHELVED_MALFORMED_CASES)(
    '[RED-r5 F1 loader] %s clears the inherited shelved exemption',
    (_label, bootStatus, healthEntry) => {
      const caps = buildCapabilities(
        { capabilities: { probe: { status: bootStatus, init_ms: 4, shelved: true } } },
        { probe: healthEntry },
      );

      expect(caps.probe).toMatchObject({ ok: false, status: 'degraded', init_ms: 4 });
      expect(caps.probe).not.toHaveProperty('shelved');
      expect(countDegraded(caps)).toBe(1);
      expect(deriveOverall(caps)).toBe('degraded');
    },
  );

  it.each(SHELVED_CONTROL_CASES)(
    '[guard-r5 F1 loader] %s keeps the documented shelved exemption',
    (_label, health) => {
      const caps = buildCapabilities(
        { capabilities: { probe: { status: 'degraded', init_ms: 4, shelved: true } } },
        health,
      );

      expect(caps.probe).toEqual({
        status: 'degraded', init_ms: 4, ok: false, shelved: true,
      });
      expect(countDegraded(caps)).toBe(0);
      expect(deriveOverall(caps)).toBe('degraded');
    },
  );

  it('preserves round-3 behavior when a health entry has no ok observation', () => {
    const healthOnly = buildCapabilities({}, { probe: { reason: 'no sample' }, empty: null });
    expect(healthOnly.probe).toEqual({ status: 'degraded', init_ms: 0, reason: 'no sample' });
    expect(healthOnly.empty).toEqual({ status: 'degraded', init_ms: 0 });

    const bootReady = buildCapabilities(
      { capabilities: { probe: { status: 'ready', init_ms: 4 } } },
      { probe: { reason: 'no new sample' } },
    );
    expect(bootReady.probe).toMatchObject({ ok: true, status: 'ready', init_ms: 4, reason: 'no new sample' });
  });

  it('keeps null boot capability data unknown instead of dereferencing it', () => {
    const caps = buildCapabilities({ capabilities: { probe: null } }, {});

    expect(caps.probe).toEqual({ status: 'unknown', init_ms: 0 });
    expect(deriveOverall(caps)).toBe('unknown');
    expect(deriveOverall({ probe: null })).toBe('unknown');
  });

  it('computeUptime returns ms since booted_at', () => {
    const booted = new Date(Date.now() - 10_000).toISOString();
    const uptime = computeUptime({ booted_at: booted });
    expect(uptime).toBeGreaterThanOrEqual(10_000);
    expect(uptime).toBeLessThan(15_000);
  });

  describe('resolveSessionUptime (session-anchored uptime + tool count, S465; per-session map, S550)', () => {
    const anchorFile = () => path.join(tmpStateDir, 'session-uptime.json');
    const readAnchor = () => JSON.parse(fs.readFileSync(anchorFile(), 'utf8'));
    const entryFor = (id) => readAnchor().sessions[id];

    it('returns null and writes NO file when no live sessionId is available', () => {
      expect(resolveSessionUptime({ stateDir: tmpStateDir, sessionId: '' })).toBeNull();
      expect(fs.existsSync(anchorFile())).toBe(false);
      expect(resolveSessionUptime({ stateDir: tmpStateDir })).toBeNull();
      expect(fs.existsSync(anchorFile())).toBe(false);
    });

    it('fresh session: anchor entry created under its own id, uptime 0, tool_count_base captured', () => {
      const now = 1_000_000;
      const r = resolveSessionUptime({ stateDir: tmpStateDir, sessionId: 'S1', now, toolCountRunning: 42 });
      expect(r.uptimeMs).toBe(0);
      expect(r.sessionToolCount).toBe(0);
      expect(readAnchor().version).toBe(2);
      expect(entryFor('S1')).toMatchObject({ started_at_ms: now, tool_count_base: 42 });
    });

    it('same session: uptime grows, toolCount = running - base, anchor entry NOT reset', () => {
      const start = 1_000_000;
      resolveSessionUptime({ stateDir: tmpStateDir, sessionId: 'S1', now: start, toolCountRunning: 42 });
      const r = resolveSessionUptime({ stateDir: tmpStateDir, sessionId: 'S1', now: start + 90 * 60_000, toolCountRunning: 50 });
      expect(r.uptimeMs).toBe(90 * 60_000);
      expect(r.sessionToolCount).toBe(8);
      expect(entryFor('S1').started_at_ms).toBe(start);
      expect(entryFor('S1').tool_count_base).toBe(42);
    });

    it('second session id does NOT clobber the first session anchor (S550 fix — the S465 regression)', () => {
      const t0 = 1_000_000;
      resolveSessionUptime({ stateDir: tmpStateDir, sessionId: 'S1', now: t0, toolCountRunning: 42 });
      resolveSessionUptime({ stateDir: tmpStateDir, sessionId: 'S1', now: t0 + 90 * 60_000, toolCountRunning: 200 });
      const r = resolveSessionUptime({ stateDir: tmpStateDir, sessionId: 'S2', now: t0 + 90 * 60_000, toolCountRunning: 200 });
      // S2 gets its own fresh entry (correct — this is a genuinely new session)...
      expect(r.uptimeMs).toBe(0);
      expect(r.sessionToolCount).toBe(0);
      // ...but S1's anchor is untouched, still readable, still growing correctly.
      const s1Read = resolveSessionUptime({ stateDir: tmpStateDir, sessionId: 'S1', now: t0 + 95 * 60_000, toolCountRunning: 210 });
      expect(s1Read.uptimeMs).toBe(95 * 60_000);
      expect(s1Read.sessionToolCount).toBe(168);
      expect(entryFor('S1')).toMatchObject({ started_at_ms: t0, tool_count_base: 42 });
      expect(entryFor('S2')).toMatchObject({ started_at_ms: t0 + 90 * 60_000, tool_count_base: 200 });
    });

    it('no running count supplied: sessionToolCount is null, uptime still resolves', () => {
      const r = resolveSessionUptime({ stateDir: tmpStateDir, sessionId: 'S3', now: 2_000_000 });
      expect(r.uptimeMs).toBe(0);
      expect(r.sessionToolCount).toBeNull();
    });

    it('backfills tool_count_base on a per-session entry without resetting started_at', () => {
      const now = 3_000_000;
      fs.writeFileSync(anchorFile(), JSON.stringify({
        version: 2,
        sessions: { S4: { started_at_ms: now - 60_000, last_seen_ms: now - 60_000 } },
      }));
      const r = resolveSessionUptime({ stateDir: tmpStateDir, sessionId: 'S4', now, toolCountRunning: 99 });
      expect(r.uptimeMs).toBe(60_000);      // started_at preserved
      expect(r.sessionToolCount).toBe(0);   // base backfilled to current running
      expect(entryFor('S4').tool_count_base).toBe(99);
      expect(entryFor('S4').started_at_ms).toBe(now - 60_000);
    });

    it('migrates a legacy single-slot anchor into the per-session map on first read', () => {
      const legacyStart = 5_000_000;
      fs.writeFileSync(anchorFile(), JSON.stringify({
        session_id: 'LEGACY', started_at_ms: legacyStart, tool_count_base: 7,
      }));
      const r = resolveSessionUptime({ stateDir: tmpStateDir, sessionId: 'LEGACY', now: legacyStart + 30_000, toolCountRunning: 10 });
      expect(r.uptimeMs).toBe(30_000);      // legacy started_at preserved through migration
      expect(r.sessionToolCount).toBe(3);   // legacy tool_count_base preserved through migration
      const anchor = readAnchor();
      expect(anchor.version).toBe(2);
      expect(anchor.sessions.LEGACY).toMatchObject({ started_at_ms: legacyStart, tool_count_base: 7 });
    });

    it('prunes entries older than 48h on write, never the entry just touched', () => {
      const now = 10_000_000_000;
      const stale = now - (49 * 60 * 60 * 1000); // 49h ago — past the 48h cutoff
      const recent = now - (1 * 60 * 60 * 1000); // 1h ago — inside the cutoff
      fs.writeFileSync(anchorFile(), JSON.stringify({
        version: 2,
        sessions: {
          OLD: { started_at_ms: stale, tool_count_base: 1, last_seen_ms: stale },
          FRESHISH: { started_at_ms: recent, tool_count_base: 2, last_seen_ms: recent },
        },
      }));
      // Trigger a write via a genuinely new session — pruning is a write-time side effect.
      resolveSessionUptime({ stateDir: tmpStateDir, sessionId: 'NEW', now, toolCountRunning: 5 });
      const anchor = readAnchor();
      expect(anchor.sessions.OLD).toBeUndefined();
      expect(anchor.sessions.FRESHISH).toBeDefined();
      expect(anchor.sessions.NEW).toBeDefined();
    });

    it('leaves no stray *.tmp siblings after a write', () => {
      resolveSessionUptime({ stateDir: tmpStateDir, sessionId: 'S5', now: 1_000_000, toolCountRunning: 1 });
      const stragglers = fs.readdirSync(tmpStateDir).filter(f => f.startsWith('session-uptime.json.') && f.endsWith('.tmp'));
      expect(stragglers).toEqual([]);
    });
  });

  it('deriveOverall reports failed > degraded > ready', () => {
    expect(deriveOverall({ a: { status: 'ready' } })).toBe('ready');
    expect(deriveOverall({ a: { status: 'degraded' } })).toBe('degraded');
    expect(deriveOverall({ a: { status: 'failed' } })).toBe('failed');
    expect(deriveOverall({})).toBe('unknown');
  });

  it('deriveOverall preserves an explicit failed boot when capabilities are empty', () => {
    expect(deriveOverall({}, { overall: 'failed' })).toBe('failed');
    expect(deriveOverall({}, {})).toBe('unknown');
  });

  it('loadHudData carries an explicit failed empty boot into os.overallHealth', () => {
    fs.writeFileSync(path.join(tmpStateDir, 'health.json'), '{}');
    fs.writeFileSync(path.join(tmpStateDir, 'boot-status.json'), JSON.stringify({
      session_id: 'failed-boot',
      booted_at: new Date().toISOString(),
      capabilities: {},
      overall: 'failed',
      total_boot_ms: 0,
      reason: 'registry unavailable',
    }));

    const raw = loadHudData({ stateDir: tmpStateDir, cwd: tmpCwd, runExpensiveProbes: false });
    expect(raw.os.capabilities).toEqual({});
    expect(raw.os.overallHealth).toBe('failed');
    expect(raw.os.bootFailed).toBe(true);
  });

  // HUD r5 review P2-1 case B: the next cheap health refresh fills the map, and
  // deriveOverall then reads ready. bootFailed keeps the failed boot visible.
  it('keeps bootFailed after a cheap health refresh fills the capability map', () => {
    const probes = ['forge-session', 'git', 'file-integrity', 'process-health', 'memory',
      'hooks', 'agents', 'skills', 'workflow'];
    fs.writeFileSync(path.join(tmpStateDir, 'health.json'),
      JSON.stringify(Object.fromEntries(probes.map((name) => [name, { ok: true }]))));
    fs.writeFileSync(path.join(tmpStateDir, 'boot-status.json'), JSON.stringify({
      session_id: 'failed-boot',
      booted_at: new Date().toISOString(),
      capabilities: {},
      overall: 'failed',
      total_boot_ms: 0,
      reason: 'registry unavailable',
    }));

    const raw = loadHudData({ stateDir: tmpStateDir, cwd: tmpCwd, runExpensiveProbes: false });
    expect(Object.keys(raw.os.capabilities)).toHaveLength(9);
    expect(raw.os.overallHealth).toBe('ready');
    expect(raw.os.bootFailed).toBe(true);
  });

  it('leaves bootFailed false for a boot that registered capabilities or did not fail', () => {
    fs.writeFileSync(path.join(tmpStateDir, 'health.json'), JSON.stringify({ git: { ok: true } }));
    const writeBoot = (status) => fs.writeFileSync(path.join(tmpStateDir, 'boot-status.json'), JSON.stringify(status));

    writeBoot({ capabilities: { git: { status: 'ready', init_ms: 3 } }, overall: 'failed' });
    expect(loadHudData({ stateDir: tmpStateDir, cwd: tmpCwd, runExpensiveProbes: false }).os.bootFailed).toBe(false);

    writeBoot({ capabilities: {}, overall: 'ready' });
    expect(loadHudData({ stateDir: tmpStateDir, cwd: tmpCwd, runExpensiveProbes: false }).os.bootFailed).toBe(false);
  });

  it('[guard-r5 F3] routes the lazy CommonJS refresh through the suite stub', () => {
    refreshMemoryCacheStub.mockClear();
    realRefreshMemoryCache.mockClear();

    expect(companionInsights.refreshMemoryCache).toBe(refreshMemoryCacheStub);

    // Under Vitest the loader skips the refresh outright (its VITEST guard).
    loadHudData({ stateDir: tmpStateDir, cwd: tmpCwd, runExpensiveProbes: false });
    expect(refreshMemoryCacheStub).not.toHaveBeenCalled();

    // With the guard's env blanked, the lazy require still resolves to the
    // suite stub, so neither branch can reach the real hub from this file.
    vi.stubEnv('VITEST', '');
    try {
      loadHudData({ stateDir: tmpStateDir, cwd: tmpCwd, runExpensiveProbes: false });
    } finally {
      vi.unstubAllEnvs();
    }

    expect(refreshMemoryCacheStub).toHaveBeenCalledTimes(1);
    expect(refreshMemoryCacheStub).toHaveBeenCalledWith(tmpCwd);
    expect(realRefreshMemoryCache).not.toHaveBeenCalled();
  });

  describe('transcript freshness enrichment', () => {
    const NOW_MS = 2_000_000_000_000;
    const SESSION_ID = 'transcript-session';
    const TRANSCRIPT_LINES = [
      {
        type: 'assistant',
        timestamp: '2033-05-18T03:33:19.000Z',
        message: {
          content: [{
            type: 'tool_use',
            id: 'tool-1',
            name: 'Bash',
            input: { command: 'printf fresh' },
          }],
        },
      },
      {
        type: 'user',
        timestamp: '2033-05-18T03:33:19.500Z',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'tool-1',
            is_error: false,
            content: 'fresh result',
          }],
        },
      },
    ];

    function makeTranscriptFixture(mtimeMs) {
      const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hdl-home-'));
      const projectDir = path.join(fakeHome, '.claude', 'projects', buildProjectSlug(tmpCwd));
      const transcriptPath = path.join(projectDir, `${SESSION_ID}.jsonl`);
      const transcriptContents = TRANSCRIPT_LINES.map((line) => JSON.stringify(line)).join('\n');
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(transcriptPath, transcriptContents);
      fs.utimesSync(transcriptPath, mtimeMs / 1000, mtimeMs / 1000);
      fs.writeFileSync(
        path.join(tmpStateDir, 'session-meta.json'),
        JSON.stringify({ session_id: SESSION_ID }),
      );
      const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
      return {
        transcriptPath,
        transcriptContents,
        cleanup() {
          homeSpy.mockRestore();
          fs.rmSync(fakeHome, { recursive: true, force: true });
        },
      };
    }

    function loadWithReadSpy(fixture, onTranscriptRead = null) {
      const actualReadFileSync = fs.readFileSync;
      const transcriptReads = [];
      const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation((filePath, ...args) => {
        if (path.resolve(String(filePath)) === path.resolve(fixture.transcriptPath)) {
          transcriptReads.push(filePath);
          if (onTranscriptRead) onTranscriptRead();
        }
        return actualReadFileSync.call(fs, filePath, ...args);
      });
      try {
        return {
          raw: loadHudData({ stateDir: tmpStateDir, cwd: tmpCwd, runExpensiveProbes: false }),
          transcriptReads,
        };
      } finally {
        readSpy.mockRestore();
      }
    }

    it.each([
      ['stale', NOW_MS - 30_001],
      ['exactly at the 30s cutoff', NOW_MS - 30_000],
    ])('skips the transcript read when its mtime is %s', (_label, mtimeMs) => {
      const fixture = makeTranscriptFixture(mtimeMs);
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
      try {
        const { raw, transcriptReads } = loadWithReadSpy(fixture);
        expect(raw.transcript).toBeNull();
        expect(transcriptReads).toHaveLength(0);
      } finally {
        nowSpy.mockRestore();
        fixture.cleanup();
      }
    });

    it('preserves the complete fresh transcript enrichment output', () => {
      const fixture = makeTranscriptFixture(NOW_MS - 1_000);
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
      try {
        const { raw, transcriptReads } = loadWithReadSpy(fixture);
        expect(transcriptReads).toHaveLength(1);
        const expected = {
          source: 'transcript-tail',
          transcriptPath: fixture.transcriptPath,
          fileSize: Buffer.byteLength(fixture.transcriptContents),
          totalLines: 2,
          typeCounts: { assistant: 1, user: 1 },
          toolCounts: { Bash: 1 },
          toolFrequency: [{ name: 'Bash', count: 1 }],
          toolCallsTotal: 1,
          toolResultsTotal: 1,
          toolErrorsTotal: 0,
          textMessagesTotal: 0,
          sessionStartedAt: '2033-05-18T03:33:19.000Z',
          lastActivityAt: '2033-05-18T03:33:19.500Z',
          recentEvents: [
            {
              ts: '2033-05-18T03:33:19.000Z',
              kind: 'tool_use',
              name: 'Bash',
              summary: 'printf fresh',
              id: 'tool-1',
            },
            {
              ts: '2033-05-18T03:33:19.500Z',
              kind: 'tool_result',
              id: 'tool-1',
              error: false,
              summary: 'fresh result',
            },
          ],
        };
        expect(JSON.stringify(raw.transcript)).toBe(JSON.stringify(expected));
      } finally {
        nowSpy.mockRestore();
        fixture.cleanup();
      }
    });

    it('keeps future-mtime transcripts eligible', () => {
      const fixture = makeTranscriptFixture(NOW_MS + 60_000);
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
      try {
        const { raw, transcriptReads } = loadWithReadSpy(fixture);
        expect(transcriptReads).toHaveLength(1);
        expect(raw.transcript).not.toBeNull();
        expect(raw.transcript.transcriptPath).toBe(fixture.transcriptPath);
      } finally {
        nowSpy.mockRestore();
        fixture.cleanup();
      }
    });

    it('retains the final freshness gate when a transcript crosses the cutoff during its read', () => {
      let clock = NOW_MS;
      const fixture = makeTranscriptFixture(NOW_MS - 29_999);
      const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
      try {
        const { raw, transcriptReads } = loadWithReadSpy(fixture, () => { clock += 1; });
        expect(transcriptReads).toHaveLength(1);
        expect(raw.transcript).toBeNull();
      } finally {
        nowSpy.mockRestore();
        fixture.cleanup();
      }
    });

    it('keeps transcript read errors best-effort', () => {
      const fixture = makeTranscriptFixture(NOW_MS - 1_000);
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
      const actualReadFileSync = fs.readFileSync;
      const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation((filePath, ...args) => {
        if (path.resolve(String(filePath)) === path.resolve(fixture.transcriptPath)) {
          throw new Error('fixture read failure');
        }
        return actualReadFileSync.call(fs, filePath, ...args);
      });
      try {
        let raw;
        expect(() => {
          raw = loadHudData({ stateDir: tmpStateDir, cwd: tmpCwd, runExpensiveProbes: false });
        }).not.toThrow();
        expect(raw.transcript).toBeNull();
      } finally {
        readSpy.mockRestore();
        nowSpy.mockRestore();
        fixture.cleanup();
      }
    });
  });

  it('loadHudData reads flat health.json and produces contextLabel/toolCount/rateLimits N/A', () => {
    fs.writeFileSync(
      path.join(tmpStateDir, 'health.json'),
      JSON.stringify({ git: { ok: true } })
    );
    fs.writeFileSync(
      path.join(tmpStateDir, 'boot-status.json'),
      JSON.stringify({
        session_id: 'boot-sess',
        booted_at: new Date(Date.now() - 1000).toISOString(),
        capabilities: { git: { status: 'ready', init_ms: 7 } },
        total_boot_ms: 42,
      })
    );
    fs.writeFileSync(
      path.join(tmpStateDir, 'session-meta.json'),
      JSON.stringify({
        model: 'claude-opus-4-6[1m]',
        session_id: 'meta-sess',
        est_context_pct: 23,
        tool_count_running: 47,
        context_window: 1000000,
      })
    );

    const raw = loadHudData({ stateDir: tmpStateDir, cwd: tmpCwd, runExpensiveProbes: false });
    expect(raw.session.model).toBe('claude-opus-4-6[1m]');
    expect(raw.session.contextLabel).toBe('');  // est_context_pct is truthy (23), so label cleared
    expect(raw.session.contextPct).toBe(23);
    expect(raw.session.toolCount).toBe(47);
    expect(raw.session.rateLimits).toBe('N/A');
    expect(raw.os.capabilities.git.ok).toBe(true);
    expect(raw.os.bootTime).toBe(42);
    expect(raw.os.overallHealth).toBe('ready');
  });

  it('stdinOverride wins over file-assembled state per-key', () => {
    fs.writeFileSync(
      path.join(tmpStateDir, 'session-meta.json'),
      JSON.stringify({ model: 'claude-sonnet-4-6', tool_count_running: 5 })
    );
    const raw = loadHudData({
      stateDir: tmpStateDir,
      cwd: tmpCwd,
      runExpensiveProbes: false,
      stdinOverride: { theme: { name: 'dark' } },
    });
    expect(raw.theme).toEqual({ name: 'dark' });
    expect(raw.session.model).toBe('claude-sonnet-4-6');
  });

  // 2026-04-27 Task 2: hud-context.json TTL guard. The file persists across
  // sessions and is never reset on workflow end — stale labels were leaking
  // into the HUD context zone for days. Reads older than 6 hours should be
  // treated as empty.
  it('loadHudData treats hud-context.json older than 6h as empty', () => {
    const stale = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(
      path.join(tmpStateDir, 'hud-context.json'),
      JSON.stringify({ label: 'forge:phase3', updated_at: stale }),
    );
    const raw = loadHudData({ stateDir: tmpStateDir, cwd: tmpCwd, runExpensiveProbes: false });
    expect(raw.context.event).toBeNull();
  });

  it('loadHudData surfaces hud-context.json when it is fresh (within 6h)', () => {
    const fresh = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    fs.writeFileSync(
      path.join(tmpStateDir, 'hud-context.json'),
      JSON.stringify({ label: 'forge:phase3', updated_at: fresh }),
    );
    const raw = loadHudData({ stateDir: tmpStateDir, cwd: tmpCwd, runExpensiveProbes: false });
    expect(raw.context.event).toBe('forge:phase3');
  });

  it('loadHudData treats hud-context.json without updated_at as empty', () => {
    fs.writeFileSync(
      path.join(tmpStateDir, 'hud-context.json'),
      JSON.stringify({ label: 'no-timestamp' }),
    );
    const raw = loadHudData({ stateDir: tmpStateDir, cwd: tmpCwd, runExpensiveProbes: false });
    expect(raw.context.event).toBeNull();
  });

  it('loadHudData treats hud-context.json with unparseable updated_at as empty', () => {
    fs.writeFileSync(
      path.join(tmpStateDir, 'hud-context.json'),
      JSON.stringify({ label: 'bogus', updated_at: 'not-a-date' }),
    );
    const raw = loadHudData({ stateDir: tmpStateDir, cwd: tmpCwd, runExpensiveProbes: false });
    expect(raw.context.event).toBeNull();
  });

  it('loadHudData defaults gracefully when files are missing', () => {
    const raw = loadHudData({ stateDir: tmpStateDir, cwd: tmpCwd, runExpensiveProbes: false });
    expect(raw.session.model).toBe('unknown');
    expect(raw.session.rateLimits).toBe('N/A');
    expect(raw.os.overallHealth).toBe('unknown');
    expect(raw.forge.active).toBe(false);
  });

  // Under the statusLine slot stdout is a pipe (no .columns); CC exports
  // COLUMNS/LINES to the command instead.
  //
  // Run `fn` with process.stdout reporting the given size (undefined = a pipe),
  // so these tests hold whether or not the runner's stdout is a TTY. The
  // original own-property descriptors are restored afterwards.
  function withStdoutSize(size, fn) {
    const saved = {};
    for (const key of ['columns', 'rows']) {
      saved[key] = Object.getOwnPropertyDescriptor(process.stdout, key);
      Object.defineProperty(process.stdout, key, { value: size[key], configurable: true, writable: true });
    }
    try {
      return fn();
    } finally {
      for (const key of ['columns', 'rows']) {
        if (saved[key]) Object.defineProperty(process.stdout, key, saved[key]);
        else delete process.stdout[key];
      }
    }
  }

  it('loadHudData sizes the terminal from COLUMNS/LINES when stdout has no size', () => {
    vi.stubEnv('COLUMNS', '52');
    vi.stubEnv('LINES', '30');
    try {
      const raw = withStdoutSize({ columns: undefined, rows: undefined },
        () => loadHudData({ stateDir: tmpStateDir, cwd: tmpCwd, runExpensiveProbes: false }));
      expect(raw.terminal.cols).toBe(52);
      expect(raw.terminal.rows).toBe(30);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('loadHudData ignores a non-numeric COLUMNS', () => {
    vi.stubEnv('COLUMNS', 'wide');
    try {
      const raw = withStdoutSize({ columns: undefined, rows: undefined },
        () => loadHudData({ stateDir: tmpStateDir, cwd: tmpCwd, runExpensiveProbes: false }));
      expect(raw.terminal.cols).toBe(80);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('loadHudData prefers a sized stdout over COLUMNS/LINES', () => {
    vi.stubEnv('COLUMNS', '52');
    vi.stubEnv('LINES', '30');
    try {
      const raw = withStdoutSize({ columns: 120, rows: 40 },
        () => loadHudData({ stateDir: tmpStateDir, cwd: tmpCwd, runExpensiveProbes: false }));
      expect(raw.terminal.cols).toBe(120);
      expect(raw.terminal.rows).toBe(40);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('loadHudData hydrates context and rate trend history from hud-history.json', () => {
    fs.writeFileSync(
      path.join(tmpStateDir, 'hud-history.json'),
      JSON.stringify({
        v: 1,
        samples: [
          { ts: new Date(Date.now() - 90_000).toISOString(), contextPct: 12, rateFiveHour: 22, rateSevenDay: 5 },
          { ts: new Date(Date.now() - 60_000).toISOString(), contextPct: 24, rateFiveHour: 45, rateSevenDay: 7 },
          { ts: new Date(Date.now() - 30_000).toISOString(), contextPct: 36, rateFiveHour: 68, rateSevenDay: 9 },
        ],
      }),
    );

    const raw = loadHudData({ stateDir: tmpStateDir, cwd: tmpCwd, runExpensiveProbes: false });

    expect(raw.session.contextPctHistory).toEqual([12, 24, 36]);
    expect(raw.session.rateLimitHistory).toEqual([
      { ts: expect.any(String), fiveHour: 22, sevenDay: 5 },
      { ts: expect.any(String), fiveHour: 45, sevenDay: 7 },
      { ts: expect.any(String), fiveHour: 68, sevenDay: 9 },
    ]);
  });

  it('loadHudData hydrates rig-context summary for HUD consumers', () => {
    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      fs.writeFileSync(
        path.join(tmpStateDir, 'rig-context.json'),
        JSON.stringify({
          version: 1,
          generated_at: new Date(now - 2 * 60_000).toISOString(),
          session_id: 's494-red',
          checks: {
            handoff: { status: 'ok', summary: 'handoff fresh' },
            lockfile: { status: 'warn', summary: 'package-lock.json older than package.json' },
            active_sessions: { status: 'unknown', summary: 'active session count not provided' },
          },
        }),
      );

      const raw = loadHudData({ stateDir: tmpStateDir, cwd: tmpCwd, runExpensiveProbes: false });

      expect(raw.rigContext).toMatchObject({
        path: '_runs/os/rig-context.json',
        status: 'warn',
        issueCount: 2,
        headline: '2 rig checks need attention',
        sessionId: 's494-red',
        ageMinutes: 2,
        isStale: false,
        issues: [
          { name: 'lockfile', status: 'warn', summary: 'package-lock.json older than package.json' },
          { name: 'active_sessions', status: 'unknown', summary: 'active session count not provided' },
        ],
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('loadHudData marks old rig-context snapshots stale even when checks are ok', () => {
    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      fs.writeFileSync(
        path.join(tmpStateDir, 'rig-context.json'),
        JSON.stringify({
          version: 1,
          generated_at: new Date(now - 2 * 60 * 60_000).toISOString(),
          ttl_seconds: 3600,
          checks: {
            handoff: { status: 'ok', summary: 'handoff fresh' },
            generated_state: { status: 'ok', summary: 'state fresh' },
          },
        }),
      );

      const raw = loadHudData({ stateDir: tmpStateDir, cwd: tmpCwd, runExpensiveProbes: false });

      expect(raw.rigContext).toMatchObject({
        status: 'ok',
        issueCount: 0,
        ageMinutes: 120,
        isStale: true,
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('loadHudData hydrates session-zone memory from session-cartridge.json', () => {
    fs.mkdirSync(path.join(tmpCwd, '_runs'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpCwd, '_runs', 'session-cartridge.json'),
      JSON.stringify({
        momentum: {
          summary: 'S427 shipped HUD boot-pulse and found companion eye bugs.',
          next: 'Start the HUD polish pass.',
        },
        tasks: [
          { done: true, text: 'old task' },
          { done: false, text: 'Fix companion eyes and insight fallback.' },
        ],
      }),
    );

    const raw = loadHudData({ stateDir: tmpStateDir, cwd: tmpCwd, runExpensiveProbes: false });
    expect(raw.memory.lastSession).toBe('S427 shipped HUD boot-pulse and found companion eye bugs.');
    expect(raw.memory.next).toBe('Start the HUD polish pass.');
    expect(raw.memory.parked).toBe('Fix companion eyes and insight fallback.');
  });

  it('loadHudData hydrates the freshest unexpired reactive event', () => {
    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      fs.writeFileSync(
        path.join(tmpStateDir, 'hud-last-reactive.json'),
        JSON.stringify({
          lastRender: now - 1_000,
          events: {
            commit: now - 4_000,
            'test-fail': now - 1_000,
          },
        }),
      );

      const raw = loadHudData({ stateDir: tmpStateDir, cwd: tmpCwd, runExpensiveProbes: false });
      expect(raw.reactive).toMatchObject({
        event: 'test-fail',
        triggeredAt: new Date(now - 1_000).toISOString(),
        ageMs: 1_000,
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('loadHudData ignores stale reactive events', () => {
    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      fs.writeFileSync(
        path.join(tmpStateDir, 'hud-last-reactive.json'),
        JSON.stringify({
          lastRender: now - 31_000,
          events: { commit: now - 31_000 },
        }),
      );

      const raw = loadHudData({ stateDir: tmpStateDir, cwd: tmpCwd, runExpensiveProbes: false });
      expect(raw.reactive).toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('readFreshReactiveState ignores anomaly throttle keys', () => {
    const now = 1_700_000_000_000;
    const filePath = path.join(tmpStateDir, 'hud-last-reactive.json');
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        lastRender: now - 1_000,
        events: {
          commit: now - 4_000,
          'anomaly:stale-dirty-work': now - 1_000,
        },
      }),
    );

    expect(readFreshReactiveState(filePath, now)).toMatchObject({
      event: 'commit',
      ageMs: 4_000,
    });
  });

  it('loadHudData hydrates a fresh persistent anomaly row', () => {
    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      fs.writeFileSync(
        path.join(tmpStateDir, 'hud-last-anomaly.json'),
        JSON.stringify({
          updatedAt: new Date(now - 1_000).toISOString(),
          type: 'stale-dirty-work',
          severity: 'signal',
          reason: '3 dirty files',
          metrics: { dirty: 3 },
        }),
      );

      const raw = loadHudData({ stateDir: tmpStateDir, cwd: tmpCwd, runExpensiveProbes: false });
      expect(raw.anomaly).toMatchObject({
        type: 'stale-dirty-work',
        severity: 'signal',
        reason: '3 dirty files',
        metrics: { dirty: 3 },
        updatedAt: new Date(now - 1_000).toISOString(),
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('readFreshAnomalyState returns null for stale or malformed anomaly files', () => {
    const now = 1_700_000_000_000;
    const filePath = path.join(tmpStateDir, 'hud-last-anomaly.json');

    fs.writeFileSync(filePath, JSON.stringify({
      updatedAt: new Date(now - 11 * 60 * 1000).toISOString(),
      type: 'stale-dirty-work',
      severity: 'signal',
      reason: 'old',
    }));
    expect(readFreshAnomalyState(filePath, now)).toBeNull();

    fs.writeFileSync(filePath, JSON.stringify({
      updatedAt: new Date(now - 1_000).toISOString(),
      type: '',
      severity: 'signal',
      reason: 'bad',
    }));
    expect(readFreshAnomalyState(filePath, now)).toBeNull();
  });

  it('loadHudData hydrates fresh zero-producer vram and reaper state', () => {
    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      fs.writeFileSync(
        path.join(tmpStateDir, 'vram-cache.json'),
        JSON.stringify({ free: 768, total: 8192, ts: now - 1_000 }),
      );
      fs.writeFileSync(
        path.join(tmpStateDir, 'reaper-log.jsonl'),
        JSON.stringify({
          ts: new Date(now - 2_000).toISOString(),
          session_id: 'sess-123',
          event: 'reap-linux',
          total_procs: 151,
          mcp_procs: 2,
          killed: 1,
          kills: [{ pid: 123 }],
        }) + '\n',
      );

      const raw = loadHudData({ stateDir: tmpStateDir, cwd: tmpCwd, runExpensiveProbes: false });
      expect(raw.os.vram).toEqual({
        freeMiB: 768,
        totalMiB: 8192,
        updatedAt: new Date(now - 1_000).toISOString(),
      });
      expect(raw.os.processes).toEqual({
        event: 'reap-linux',
        sessionId: 'sess-123',
        totalProcs: 151,
        mcpProcs: 2,
        killed: 1,
        kills: [{ pid: 123 }],
        updatedAt: new Date(now - 2_000).toISOString(),
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('readFreshVramState and readFreshReaperState fail closed for stale or malformed files', () => {
    const now = 1_700_000_000_000;
    const vramPath = path.join(tmpStateDir, 'vram-cache.json');
    const reaperPath = path.join(tmpStateDir, 'reaper-log.jsonl');

    fs.writeFileSync(vramPath, JSON.stringify({ free: 768, ts: now - 11 * 60 * 1000 }));
    expect(readFreshVramState(vramPath, now)).toBeNull();

    fs.writeFileSync(vramPath, JSON.stringify({ free: 'unknown', ts: now - 1_000 }));
    expect(readFreshVramState(vramPath, now)).toBeNull();

    fs.writeFileSync(reaperPath, JSON.stringify({ ts: new Date(now - 3 * 60 * 60 * 1000).toISOString(), total_procs: 200 }) + '\n');
    expect(readFreshReaperState(reaperPath, now)).toBeNull();

    fs.writeFileSync(reaperPath, 'not json\n');
    expect(readFreshReaperState(reaperPath, now)).toBeNull();
  });
});

describe('mergeHarnessStdin', () => {
  function makeBaseState() {
    return {
      session: {
        id: '',
        model: 'unknown',
        contextPct: 0,
        contextLabel: 'est.',
        toolCount: 0,
        uptime: 0,
        rateLimits: 'N/A',
      },
    };
  }

  it('maps model display_name into session.model', () => {
    const state = makeBaseState();
    mergeHarnessStdin(state, { model: { model_id: 'claude-opus-4-6', display_name: 'Opus 4.6' } });
    expect(state.session.model).toBe('Opus 4.6');
  });

  it('falls back to model.id when display_name is absent', () => {
    // A model.id triggers the session-meta write-back, whose root resolves as
    // state.projectRoot || CLAUDE_PROJECT_DIR || cwd. Pin it to a temp root so
    // a hook-spawned run (CLAUDE_PROJECT_DIR = the live checkout) can never
    // rewrite the real _runs/os/session-meta.json.
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hdl-model-root-'));
    try {
      const metaPath = path.join(tmpRoot, '_runs', 'os', 'session-meta.json');
      fs.mkdirSync(path.dirname(metaPath), { recursive: true });
      fs.writeFileSync(metaPath, JSON.stringify({ model: 'seed-model' }));
      const state = Object.assign(makeBaseState(), { projectRoot: tmpRoot });

      mergeHarnessStdin(state, { model: { id: 'claude-opus-4-6' } });

      expect(state.session.model).toBe('claude-opus-4-6');
      // The write-back landed in the temp root, not the live checkout.
      expect(JSON.parse(fs.readFileSync(metaPath, 'utf8')).model).toBe('claude-opus-4-6');
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('maps context_window.used_percentage into session.contextPct', () => {
    const state = makeBaseState();
    mergeHarnessStdin(state, { context_window: { used_percentage: 42 } });
    expect(state.session.contextPct).toBe(42);
  });

  it('sets contextLabel to "of 1M" for 1000000 token window', () => {
    const state = makeBaseState();
    mergeHarnessStdin(state, { context_window: { used_percentage: 10, total_tokens: 1000000 } });
    expect(state.session.contextLabel).toBe('of 1M');
  });

  it('sets contextLabel to "of 200K" for 200000 token window', () => {
    const state = makeBaseState();
    mergeHarnessStdin(state, { context_window: { used_percentage: 10, total_tokens: 200000 } });
    expect(state.session.contextLabel).toBe('of 200K');
  });

  it('maps rate_limits into session.rateLimits object replacing N/A sentinel', () => {
    const state = makeBaseState();
    mergeHarnessStdin(state, {
      rate_limits: {
        five_hour: { used_percentage: 30 },
        seven_day: { used_percentage: 10 },
      },
    });
    expect(state.session.rateLimits).toEqual({ fiveHour: 30, sevenDay: 10, fiveHourResetsAt: null, sevenDayResetsAt: null });
  });

  it('persists live context and rate samples into hud-history.json when projectRoot is available', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hdl-history-root-'));
    try {
      fs.mkdirSync(path.join(tmpRoot, '_runs', 'os'), { recursive: true });
      const state = Object.assign(makeBaseState(), { projectRoot: tmpRoot });

      mergeHarnessStdin(state, {
        context_window: { used_percentage: 42 },
        rate_limits: {
          five_hour: { used_percentage: 30 },
          seven_day: { used_percentage: 10 },
        },
      });

      const persisted = JSON.parse(fs.readFileSync(path.join(tmpRoot, '_runs', 'os', 'hud-history.json'), 'utf8'));
      expect(persisted.samples).toHaveLength(1);
      expect(persisted.samples[0]).toMatchObject({ contextPct: 42, rateFiveHour: 30, rateSevenDay: 10 });
      expect(state.session.contextPctHistory).toEqual([42]);
      expect(state.session.rateLimitHistory).toEqual([
        { ts: expect.any(String), fiveHour: 30, sevenDay: 10 },
      ]);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('maps session_id into state.session.id', () => {
    const state = makeBaseState();
    mergeHarnessStdin(state, { session_id: 'session-abc-123' });
    expect(state.session.id).toBe('session-abc-123');
  });

  it('maps cost.total_cost_usd into state.session.cost', () => {
    const state = makeBaseState();
    mergeHarnessStdin(state, { cost: { total_cost_usd: 2.87 } });
    expect(state.session.cost).toBeCloseTo(2.87);
  });

  it('handles null harness gracefully (no-op)', () => {
    const state = makeBaseState();
    const result = mergeHarnessStdin(state, null);
    expect(result.session.model).toBe('unknown');
    expect(result.session.rateLimits).toBe('N/A');
  });

  it('handles partial harness data gracefully', () => {
    const state = makeBaseState();
    mergeHarnessStdin(state, { model: { display_name: 'Sonnet 4.6' } });
    expect(state.session.model).toBe('Sonnet 4.6');
    expect(state.session.rateLimits).toBe('N/A');
    expect(state.session.contextPct).toBe(0);
  });

  it('handles missing rate_limit sub-fields gracefully (defaults to 0)', () => {
    const state = makeBaseState();
    mergeHarnessStdin(state, { rate_limits: { five_hour: {}, seven_day: {} } });
    expect(state.session.rateLimits).toEqual({ fiveHour: 0, sevenDay: 0, fiveHourResetsAt: null, sevenDayResetsAt: null });
  });

  it('returns the same state reference (mutation in-place)', () => {
    const state = makeBaseState();
    const result = mergeHarnessStdin(state, { session_id: 'x' });
    expect(result).toBe(state);
  });
});
