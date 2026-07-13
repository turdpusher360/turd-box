import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const _require = createRequire(import.meta.url);
const meter = _require('../usage-meter.cjs');

const HOUR = 3600 * 1000;

// Injected pricing fixture — synthetic rates, deliberately NOT the shipped
// model-pricing.json numbers (repo rule: no pinned-moving-values — the shipped
// file is config that advances; pinning it detonates on healthy rate updates).
const PRICING = {
  models: {
    'test-alpha': { input: 2, output: 4, cache_write_5m: 2.5, cache_write_1h: 4, cache_read: 0.2 },
    'test-alpha-pro': { input: 20, output: 40, cache_write_5m: 25, cache_write_1h: 40, cache_read: 2 },
    'test-b': { input: 1, output: 1, cache_write_5m: 1, cache_write_1h: 1, cache_read: 1 },
  },
};

/** Build one transcript JSONL line in the shape observed on real rigs. */
function line(over = {}) {
  const {
    ts = '2026-01-01T10:00:00.000Z',
    type = 'assistant',
    model = 'test-b',
    msgId = 'msg_1',
    reqId = 'req_1',
    sessionId = 'sess-1',
    sidechain = false,
    input = 0,
    output = 0,
    cacheCreate = 0,
    cacheRead = 0,
    cache5m = null,
    cache1h = null,
    content = [{ type: 'text', text: 'CONTENT_MARKER_NEVER_RETAINED' }],
  } = over;
  const usage = {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: cacheCreate,
    cache_read_input_tokens: cacheRead,
  };
  if (cache5m != null || cache1h != null) {
    usage.cache_creation = {
      ephemeral_5m_input_tokens: cache5m || 0,
      ephemeral_1h_input_tokens: cache1h || 0,
    };
  }
  return JSON.stringify({
    type,
    timestamp: ts,
    requestId: reqId,
    sessionId,
    isSidechain: sidechain,
    uuid: 'u-x',
    message: { id: msgId, model, role: 'assistant', content, usage },
  });
}

let tmpRoot;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-meter-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function writeTranscript(rel, lines) {
  const p = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

// ---------------------------------------------------------------------------
// Default-root discovery diagnostics
// ---------------------------------------------------------------------------

describe('defaultProjectDirs', () => {
  it('counts an unreadable configured root while retaining a readable HOME fallback', () => {
    const configDir = path.join(tmpRoot, 'config');
    const configuredProjects = path.join(configDir, 'projects');
    const home = path.join(tmpRoot, 'home');
    const fallbackProjects = path.join(home, '.claude', 'projects');
    fs.mkdirSync(fallbackProjects, { recursive: true });

    const realpathSync = fs.realpathSync.bind(fs);
    const spy = vi.spyOn(fs, 'realpathSync').mockImplementation((candidate, ...args) => {
      if (path.resolve(String(candidate)) === path.resolve(configuredProjects)) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      return realpathSync(candidate, ...args);
    });
    const diagnostics = {};

    try {
      const dirs = meter.defaultProjectDirs({ HOME: home, CLAUDE_CONFIG_DIR: configDir }, diagnostics);
      expect(dirs).toEqual([realpathSync(fallbackProjects)]);
      expect(diagnostics.rootFailures).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('does not count a genuinely missing configured root as a failure', () => {
    const home = path.join(tmpRoot, 'home-missing');
    const fallbackProjects = path.join(home, '.claude', 'projects');
    fs.mkdirSync(fallbackProjects, { recursive: true });
    const diagnostics = {};

    const dirs = meter.defaultProjectDirs({
      HOME: home,
      CLAUDE_CONFIG_DIR: path.join(tmpRoot, 'missing-config'),
    }, diagnostics);

    expect(dirs).toEqual([fs.realpathSync(fallbackProjects)]);
    expect(diagnostics.rootFailures).toBe(0);
  });

  it('counts an existing configured projects path that is not a directory', () => {
    const configDir = path.join(tmpRoot, 'config-file');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'projects'), 'not a directory');
    const home = path.join(tmpRoot, 'home-file');
    const fallbackProjects = path.join(home, '.claude', 'projects');
    fs.mkdirSync(fallbackProjects, { recursive: true });
    const diagnostics = {};

    const dirs = meter.defaultProjectDirs({ HOME: home, CLAUDE_CONFIG_DIR: configDir }, diagnostics);

    expect(dirs).toEqual([fs.realpathSync(fallbackProjects)]);
    expect(diagnostics.rootFailures).toBe(1);
  });

  it('uses USERPROFILE when HOME is absent and prefers HOME when both are supplied', () => {
    const profile = path.join(tmpRoot, 'profile-home');
    const profileProjects = path.join(profile, '.claude', 'projects');
    fs.mkdirSync(profileProjects, { recursive: true });
    const home = path.join(tmpRoot, 'posix-home');
    const homeProjects = path.join(home, '.claude', 'projects');
    fs.mkdirSync(homeProjects, { recursive: true });

    expect(meter.defaultProjectDirs({ USERPROFILE: profile }, {}))
      .toEqual([fs.realpathSync(profileProjects)]);
    expect(meter.defaultProjectDirs({ HOME: home, USERPROFILE: profile }, {}))
      .toEqual([fs.realpathSync(homeProjects)]);
  });

  it('counts a stat failure after a candidate root resolves', () => {
    const configDir = path.join(tmpRoot, 'config-stat');
    const configuredProjects = path.join(configDir, 'projects');
    fs.mkdirSync(configuredProjects, { recursive: true });
    const configuredReal = fs.realpathSync(configuredProjects);
    const home = path.join(tmpRoot, 'home-stat');
    const fallbackProjects = path.join(home, '.claude', 'projects');
    fs.mkdirSync(fallbackProjects, { recursive: true });

    const statSync = fs.statSync.bind(fs);
    const spy = vi.spyOn(fs, 'statSync').mockImplementation((candidate, ...args) => {
      if (path.resolve(String(candidate)) === path.resolve(configuredReal)) {
        throw Object.assign(new Error('I/O failure'), { code: 'EIO' });
      }
      return statSync(candidate, ...args);
    });
    const diagnostics = {};

    try {
      const dirs = meter.defaultProjectDirs({ HOME: home, CLAUDE_CONFIG_DIR: configDir }, diagnostics);
      expect(dirs).toEqual([fs.realpathSync(fallbackProjects)]);
      expect(diagnostics.rootFailures).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// extractEntry
// ---------------------------------------------------------------------------

describe('extractEntry', () => {
  it('extracts the billing fields from a valid assistant entry', () => {
    const raw = JSON.parse(line({
      ts: '2026-01-01T10:00:00.000Z', model: 'test-alpha', msgId: 'm1', reqId: 'r1',
      sessionId: 's1', input: 5, output: 7, cacheCreate: 11, cacheRead: 13,
      cache5m: 4, cache1h: 7,
    }));
    const e = meter.extractEntry(raw);
    expect(e).not.toBeNull();
    expect(e.ts).toBe(Date.parse('2026-01-01T10:00:00.000Z'));
    expect(e.model).toBe('test-alpha');
    expect(e.messageId).toBe('m1');
    expect(e.requestId).toBe('r1');
    expect(e.sessionId).toBe('s1');
    expect(e.input).toBe(5);
    expect(e.output).toBe(7);
    expect(e.cacheCreate).toBe(11);
    expect(e.cacheRead).toBe(13);
    expect(e.cache5m).toBe(4);
    expect(e.cache1h).toBe(7);
  });

  it('returns null for non-assistant, synthetic, usage-less, and timestamp-less entries', () => {
    expect(meter.extractEntry(JSON.parse(line({ type: 'user' })))).toBeNull();
    expect(meter.extractEntry(JSON.parse(line({ model: '<synthetic>' })))).toBeNull();
    const noUsage = JSON.parse(line({}));
    delete noUsage.message.usage;
    expect(meter.extractEntry(noUsage)).toBeNull();
    const noTs = JSON.parse(line({}));
    delete noTs.timestamp;
    expect(meter.extractEntry(noTs)).toBeNull();
    expect(meter.extractEntry(null)).toBeNull();
    expect(meter.extractEntry('str')).toBeNull();
  });

  it('privacy: message content is structurally dropped, never retained', () => {
    const raw = JSON.parse(line({ content: [{ type: 'text', text: 'SECRET_PAYLOAD_XYZ' }] }));
    const e = meter.extractEntry(raw);
    expect(JSON.stringify(e)).not.toContain('SECRET_PAYLOAD_XYZ');
    expect(e.content).toBeUndefined();
    expect(e.message).toBeUndefined();
  });

  it('coerces negative / non-numeric token counts to 0', () => {
    const raw = JSON.parse(line({}));
    raw.message.usage.input_tokens = -5;
    raw.message.usage.output_tokens = 'lots';
    raw.message.usage.cache_creation_input_tokens = null;
    raw.message.usage.cache_read_input_tokens = Infinity;
    const e = meter.extractEntry(raw);
    expect(e.input).toBe(0);
    expect(e.output).toBe(0);
    expect(e.cacheCreate).toBe(0);
    expect(e.cacheRead).toBe(0);
  });

  it('cache split is null when cache_creation is absent (older schema)', () => {
    const raw = JSON.parse(line({ cacheCreate: 100 }));
    const e = meter.extractEntry(raw);
    expect(e.cache5m).toBeNull();
    expect(e.cache1h).toBeNull();
    expect(e.cacheCreate).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// parseTranscriptFile / loadEntries
// ---------------------------------------------------------------------------

describe('parseTranscriptFile', () => {
  it('skips malformed, blank, truncated and non-JSON lines without throwing', async () => {
    const p = path.join(tmpRoot, 'slug', 'a.jsonl');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, [
      line({ msgId: 'm1', reqId: 'r1', input: 10 }),
      '{ this is not json',
      '',
      'plain garbage line',
      line({ msgId: 'm2', reqId: 'r2', input: 20 }),
      '{"type":"assistant","message":{"id":"m3","model":"test-b","usage":{"input_tokens":', // truncated at EOF
    ].join('\n'));
    const res = await meter.parseTranscriptFile(p);
    expect(res.entries.length).toBe(2);
    expect(res.parseErrors).toBe(3); // malformed + garbage + truncated (blank line not counted)
  });

  it('handles multibyte content and CRLF line endings', async () => {
    const p = path.join(tmpRoot, 'slug', 'crlf.jsonl');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const l1 = line({ msgId: 'm1', reqId: 'r1', input: 3, content: [{ type: 'text', text: '🔥🔥 多字节 ταινία 🎬' }] });
    const l2 = line({ msgId: 'm2', reqId: 'r2', output: 4, content: [{ type: 'text', text: '𝔘𝔫𝔦𝔠𝔬𝔡𝔢' }] });
    fs.writeFileSync(p, l1 + '\r\n' + l2 + '\r\n');
    const res = await meter.parseTranscriptFile(p);
    expect(res.parseErrors).toBe(0);
    expect(res.entries.map((e) => e.input + e.output)).toEqual([3, 4]);
  });
});

describe('loadEntries', () => {
  it('discovers nested subagent transcripts and merges them', async () => {
    writeTranscript('slug/root.jsonl', [line({ msgId: 'm1', reqId: 'r1', input: 1 })]);
    writeTranscript('slug/sess-uuid/subagents/agent-abc.jsonl', [
      line({ msgId: 'm2', reqId: 'r2', input: 2, sidechain: true }),
    ]);
    const res = await meter.loadEntries({ dirs: [tmpRoot] });
    expect(res.filesScanned).toBe(2);
    expect(res.entries.length).toBe(2);
    expect(res.entries.some((e) => e.isSidechain)).toBe(true);
  });

  it('dedups identical (messageId, requestId) pairs across files — last timestamp wins', async () => {
    writeTranscript('slug/a.jsonl', [
      line({ ts: '2026-01-01T10:00:00.000Z', msgId: 'm1', reqId: 'r1', output: 100 }),
    ]);
    writeTranscript('slug/b.jsonl', [
      line({ ts: '2026-01-01T10:00:02.000Z', msgId: 'm1', reqId: 'r1', output: 501 }),
      line({ ts: '2026-01-01T10:00:03.000Z', msgId: 'm1', reqId: 'r9', output: 7 }),
    ]);
    const res = await meter.loadEntries({ dirs: [tmpRoot] });
    expect(res.entries.length).toBe(2); // (m1,r1) deduped; (m1,r9) distinct
    const dedup = res.entries.find((e) => e.requestId === 'r1');
    expect(dedup.output).toBe(501); // later snapshot won
  });

  it('keeps entries without a messageId (nothing to dedup on)', async () => {
    const l = JSON.parse(line({ input: 5 }));
    delete l.message.id;
    writeTranscript('slug/a.jsonl', [JSON.stringify(l), JSON.stringify(l)]);
    const res = await meter.loadEntries({ dirs: [tmpRoot] });
    expect(res.entries.length).toBe(2);
  });

  it('mtime prefilter skips old files but does not error on empty results', async () => {
    const p = writeTranscript('slug/old.jsonl', [line({ msgId: 'm1', reqId: 'r1', input: 5 })]);
    const oldTime = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(p, oldTime, oldTime);
    const res = await meter.loadEntries({ dirs: [tmpRoot], sinceMs: Date.parse('2025-01-01T00:00:00Z') });
    expect(res.entries.length).toBe(0);
    expect(res.skippedByMtime).toBe(1);
    expect(res.candidatesTotal).toBe(1);
  });

  it('throws ENOTRANSCRIPTS when no .jsonl exists at all', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'empty-dir'), { recursive: true });
    await expect(meter.loadEntries({ dirs: [path.join(tmpRoot, 'empty-dir')] }))
      .rejects.toMatchObject({ code: 'ENOTRANSCRIPTS' });
    await expect(meter.loadEntries({ dirs: [path.join(tmpRoot, 'no-such-dir')] }))
      .rejects.toMatchObject({ code: 'ENOTRANSCRIPTS' });
  });

  it('retains a failed default-root diagnostic when the readable fallback is empty', async () => {
    const configDir = path.join(tmpRoot, 'config-empty');
    const configuredProjects = path.join(configDir, 'projects');
    const home = path.join(tmpRoot, 'home-empty');
    fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
    const realpathSync = fs.realpathSync.bind(fs);
    const spy = vi.spyOn(fs, 'realpathSync').mockImplementation((candidate, ...args) => {
      if (path.resolve(String(candidate)) === path.resolve(configuredProjects)) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      return realpathSync(candidate, ...args);
    });

    try {
      let error;
      try {
        await meter.loadEntries({ env: { HOME: home, CLAUDE_CONFIG_DIR: configDir } });
      } catch (e) {
        error = e;
      }
      expect(error).toMatchObject({ code: 'ENOTRANSCRIPTS' });
      expect(error.message).toContain('1 root failure');
    } finally {
      spy.mockRestore();
    }
  });

  it('does not claim a root failure when default roots are merely missing or empty', async () => {
    const home = path.join(tmpRoot, 'home-missing-empty');
    fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
    let error;
    try {
      await meter.loadEntries({
        env: { HOME: home, CLAUDE_CONFIG_DIR: path.join(tmpRoot, 'missing-config-empty') },
      });
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({ code: 'ENOTRANSCRIPTS' });
    expect(error.message).not.toContain('root failure');
  });
});

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

describe('resolveModelPricing', () => {
  it('longest prefix wins; exact beats shorter prefix; unknown is null', () => {
    expect(meter.resolveModelPricing(PRICING, 'test-alpha-pro-max')).toBe(PRICING.models['test-alpha-pro']);
    expect(meter.resolveModelPricing(PRICING, 'test-alpha-pro')).toBe(PRICING.models['test-alpha-pro']);
    expect(meter.resolveModelPricing(PRICING, 'test-alpha-lite')).toBe(PRICING.models['test-alpha']);
    expect(meter.resolveModelPricing(PRICING, 'test-b')).toBe(PRICING.models['test-b']);
    expect(meter.resolveModelPricing(PRICING, 'other-model')).toBeNull();
    expect(meter.resolveModelPricing(null, 'test-b')).toBeNull();
  });
});

describe('loadPricing', () => {
  it('loads from an explicit path; opts.path beats env override', () => {
    const pA = path.join(tmpRoot, 'a.json');
    const pB = path.join(tmpRoot, 'b.json');
    fs.writeFileSync(pA, JSON.stringify({ as_of: '2026-01-01', models: { a: { input: 1 } } }));
    fs.writeFileSync(pB, JSON.stringify({ as_of: '2026-02-02', models: { b: { input: 2 } } }));
    const viaPath = meter.loadPricing({ path: pA, env: { FORGE_USAGE_PRICING: pB } });
    expect(viaPath.as_of).toBe('2026-01-01');
    const viaEnv = meter.loadPricing({ env: { FORGE_USAGE_PRICING: pB } });
    expect(viaEnv.as_of).toBe('2026-02-02');
  });

  it('degrades to empty models + error on unreadable or shapeless config', () => {
    const bad = path.join(tmpRoot, 'bad.json');
    fs.writeFileSync(bad, '{ nope');
    const r1 = meter.loadPricing({ path: bad });
    expect(r1.models).toEqual({});
    expect(r1.error).toBeTruthy();
    const shapeless = path.join(tmpRoot, 'shapeless.json');
    fs.writeFileSync(shapeless, JSON.stringify({ hello: 1 }));
    const r2 = meter.loadPricing({ path: shapeless });
    expect(r2.models).toEqual({});
    expect(r2.error).toBeTruthy();
    const r3 = meter.loadPricing({ path: path.join(tmpRoot, 'missing.json') });
    expect(r3.error).toBeTruthy();
  });

  it('shipped config is structurally valid (no numeric pins — rates are config)', () => {
    const shipped = meter.loadPricing({ env: {} });
    expect(shipped.error).toBeNull();
    expect(typeof shipped.as_of).toBe('string');
    const names = Object.keys(shipped.models);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const m = shipped.models[name];
      for (const k of ['input', 'output', 'cache_write_5m', 'cache_write_1h', 'cache_read']) {
        expect(Number.isFinite(m[k]), `${name}.${k} finite`).toBe(true);
        expect(m[k], `${name}.${k} >= 0`).toBeGreaterThanOrEqual(0);
      }
      expect(typeof m.verified, `${name}.verified`).toBe('boolean');
      expect(typeof m.basis, `${name}.basis`).toBe('string');
    }
  });
});

describe('entryCostUSD', () => {
  const M = 1e6;
  it('prices input/output/cacheRead and the 5m/1h cache split separately', () => {
    const e = {
      model: 'test-alpha', input: 1 * M, output: 2 * M,
      cacheCreate: 3 * M, cacheRead: 5 * M, cache5m: 1 * M, cache1h: 2 * M,
    };
    // 1M*2 + 2M*4 + (1M*2.5 + 2M*4) + 5M*0.2  = 2 + 8 + 10.5 + 1 = 21.5
    const { costUSD, unpriced } = meter.entryCostUSD(e, PRICING);
    expect(unpriced).toBe(false);
    expect(costUSD).toBeCloseTo(21.5, 10);
  });

  it('falls back to the 5m rate for blended cache creation (no split)', () => {
    const e = { model: 'test-alpha', input: 0, output: 0, cacheCreate: 2 * M, cacheRead: 0, cache5m: null, cache1h: null };
    const { costUSD } = meter.entryCostUSD(e, PRICING);
    expect(costUSD).toBeCloseTo(5.0, 10); // 2M * 2.5/M
  });

  it('unknown model → $0 and unpriced flag', () => {
    const e = { model: 'mystery-9', input: 1e6, output: 1e6, cacheCreate: 0, cacheRead: 0, cache5m: null, cache1h: null };
    const { costUSD, unpriced } = meter.entryCostUSD(e, PRICING);
    expect(costUSD).toBe(0);
    expect(unpriced).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

function mkEntry(tsIso, over = {}) {
  return {
    ts: Date.parse(tsIso),
    model: over.model || 'test-b',
    messageId: over.msgId || `m-${tsIso}`,
    requestId: over.reqId || `r-${tsIso}`,
    sessionId: over.sessionId || 'sess-1',
    isSidechain: over.sidechain === true,
    input: over.input || 0,
    output: over.output || 0,
    cacheCreate: over.cacheCreate || 0,
    cacheRead: over.cacheRead || 0,
    cache5m: over.cache5m != null ? over.cache5m : null,
    cache1h: over.cache1h != null ? over.cache1h : null,
  };
}

describe('identifyBlocks', () => {
  it('floors block start to the UTC hour of the first entry', () => {
    const now = Date.parse('2026-01-01T12:00:00Z');
    const blocks = meter.identifyBlocks([mkEntry('2026-01-01T10:47:13Z')], { now });
    expect(blocks.length).toBe(1);
    expect(blocks[0].startMs).toBe(Date.parse('2026-01-01T10:00:00Z'));
    expect(blocks[0].endMs).toBe(Date.parse('2026-01-01T15:00:00Z'));
  });

  it('keeps entries inside the 5h window in one block; boundary entry starts a new one', () => {
    const now = Date.parse('2026-01-02T00:00:00Z');
    const entries = [
      mkEntry('2026-01-01T10:30:00Z'),
      mkEntry('2026-01-01T14:59:59Z'), // inside (start 10:00, end 15:00)
      mkEntry('2026-01-01T15:00:00Z'), // exactly at end → new block
    ];
    const blocks = meter.identifyBlocks(entries, { now });
    expect(blocks.length).toBe(2);
    expect(blocks[0].entries.length).toBe(2);
    expect(blocks[1].startMs).toBe(Date.parse('2026-01-01T15:00:00Z'));
  });

  it('entries past the window start a new hour-floored block (a >=5h gap is one way to get there)', () => {
    // Honesty note: no fixture can isolate the explicit gap predicate — with
    // startMs = floor(firstTs), any >=5h gap from an in-window entry lands
    // past the window boundary too (proof in identifyBlocks). This test pins
    // the OBSERVABLE contract: a long-gap successor gets a fresh floored block.
    const now = Date.parse('2026-01-02T00:00:00Z');
    const entries = [
      mkEntry('2026-01-01T01:10:00Z'),
      mkEntry('2026-01-01T07:45:00Z'), // 6h35m gap
    ];
    const blocks = meter.identifyBlocks(entries, { now });
    expect(blocks.length).toBe(2);
    expect(blocks[1].startMs).toBe(Date.parse('2026-01-01T07:00:00Z'));
  });

  it('active = window contains now AND recent activity; past-window block is inactive', () => {
    const entries = [mkEntry('2026-01-01T10:30:00Z'), mkEntry('2026-01-01T12:00:00Z')];
    let blocks = meter.identifyBlocks(entries, { now: Date.parse('2026-01-01T13:00:00Z') });
    expect(blocks[0].isActive).toBe(true);
    blocks = meter.identifyBlocks(entries, { now: Date.parse('2026-01-01T15:00:00Z') });
    expect(blocks[0].isActive).toBe(false); // window [10:00,15:00) excludes 15:00
    blocks = meter.identifyBlocks(entries, { now: Date.parse('2026-01-01T14:59:59Z') });
    expect(blocks[0].isActive).toBe(true);
  });
});

describe('blockStats', () => {
  it('burn rate, cost/hr and projection with an injected clock', () => {
    const entries = [
      mkEntry('2026-01-01T10:00:00Z', { input: 300000 }),
      mkEntry('2026-01-01T10:30:00Z', { input: 300000 }),
    ];
    const now = Date.parse('2026-01-01T10:50:00Z');
    const [block] = meter.identifyBlocks(entries, { now });
    expect(block.isActive).toBe(true);
    const s = meter.blockStats(block, { now, pricing: PRICING });
    // 600k tokens over 50min (firstTs → now)
    expect(s.tokensPerMinute).toBeCloseTo(12000, 6);
    // test-b input rate $1/M → cost $0.60 over 50min → $0.72/hr
    expect(s.costUSD).toBeCloseTo(0.6, 10);
    expect(s.costPerHour).toBeCloseTo(0.72, 10);
    // remaining 10:50 → 15:00 = 4h10m
    expect(s.remainingMs).toBe((4 * 60 + 10) * 60 * 1000);
    expect(s.projectedCostUSD).toBeCloseTo(0.6 + 0.72 * (250 / 60), 8);
    expect(s.projectedTokens).toBe(600000 + 12000 * 250);
  });

  it('closed blocks use the activity span and have no projection', () => {
    const entries = [
      mkEntry('2026-01-01T10:00:00Z', { input: 100000 }),
      mkEntry('2026-01-01T11:00:00Z', { input: 100000 }),
    ];
    const now = Date.parse('2026-01-01T20:00:00Z');
    const [block] = meter.identifyBlocks(entries, { now });
    expect(block.isActive).toBe(false);
    const s = meter.blockStats(block, { now, pricing: PRICING });
    expect(s.tokensPerMinute).toBeCloseTo(200000 / 60, 6);
    expect(s.projectedCostUSD).toBeNull();
    expect(s.projectedTokens).toBeNull();
    expect(s.remainingMs).toBe(0);
  });

  it('floors the burn window at one minute (no divide-by-zero bursts)', () => {
    const entries = [mkEntry('2026-01-01T10:00:00Z', { input: 60000 })];
    const now = Date.parse('2026-01-01T10:00:00Z');
    const [block] = meter.identifyBlocks(entries, { now });
    const s = meter.blockStats(block, { now, pricing: PRICING });
    expect(s.tokensPerMinute).toBeCloseTo(60000, 6); // 60k over the 1-min floor
  });
});

// ---------------------------------------------------------------------------
// Aggregations
// ---------------------------------------------------------------------------

describe('dayKey / monthKey', () => {
  it('applies an explicit tz offset (minutes east of UTC)', () => {
    const ts = Date.parse('2026-07-10T03:00:00Z');
    expect(meter.dayKey(ts, 0)).toBe('2026-07-10');
    expect(meter.dayKey(ts, -420)).toBe('2026-07-09'); // UTC-7 evening
    expect(meter.dayKey(ts, 330)).toBe('2026-07-10'); // UTC+5:30
    expect(meter.monthKey(Date.parse('2026-08-01T02:00:00Z'), -180)).toBe('2026-07');
  });
});

describe('aggregateDaily / aggregateMonthly', () => {
  it('buckets by day with per-model breakdown and sorts ascending', () => {
    const entries = [
      mkEntry('2026-01-02T10:00:00Z', { input: 10, model: 'test-b' }),
      mkEntry('2026-01-01T10:00:00Z', { input: 5, model: 'test-b' }),
      mkEntry('2026-01-02T11:00:00Z', { output: 3, model: 'test-alpha' }),
    ];
    const daily = meter.aggregateDaily(entries, { tzOffsetMinutes: 0, pricing: PRICING });
    expect(daily.map((d) => d.key)).toEqual(['2026-01-01', '2026-01-02']);
    const d2 = daily[1];
    expect(d2.entryCount).toBe(2);
    expect(d2.tokens.total).toBe(13);
    expect(Object.keys(d2.models).sort()).toEqual(['test-alpha', 'test-b']);
    expect(d2.models['test-alpha'].tokens.output).toBe(3);
  });

  it('monthly buckets roll across days', () => {
    const entries = [
      mkEntry('2026-01-31T10:00:00Z', { input: 1 }),
      mkEntry('2026-02-01T10:00:00Z', { input: 2 }),
    ];
    const monthly = meter.aggregateMonthly(entries, { tzOffsetMinutes: 0, pricing: PRICING });
    expect(monthly.map((m) => m.key)).toEqual(['2026-01', '2026-02']);
  });

  it('lists unpriced models in the bucket', () => {
    const entries = [mkEntry('2026-01-01T10:00:00Z', { input: 5, model: 'mystery-9' })];
    const daily = meter.aggregateDaily(entries, { tzOffsetMinutes: 0, pricing: PRICING });
    expect(daily[0].unpricedModels).toEqual(['mystery-9']);
    expect(daily[0].costUSD).toBe(0);
  });
});

describe('aggregateSessions', () => {
  it('groups by sessionId (subagent entries roll into the parent), newest first, honors limit', () => {
    const entries = [
      mkEntry('2026-01-01T10:00:00Z', { sessionId: 'sess-old', input: 1 }),
      mkEntry('2026-01-01T12:00:00Z', { sessionId: 'sess-new', input: 2 }),
      mkEntry('2026-01-01T12:30:00Z', { sessionId: 'sess-new', input: 4, sidechain: true }),
      mkEntry('2026-01-01T11:00:00Z', { sessionId: 'sess-mid', input: 8 }),
    ];
    const sessions = meter.aggregateSessions(entries, { pricing: PRICING });
    expect(sessions.map((s) => s.sessionId)).toEqual(['sess-new', 'sess-mid', 'sess-old']);
    expect(sessions[0].tokens.input).toBe(6); // parent + sidechain rolled together
    expect(sessions[0].sidechainEntries).toBe(1);
    expect(sessions[0].firstTs).toBe(Date.parse('2026-01-01T12:00:00Z'));
    expect(sessions[0].lastTs).toBe(Date.parse('2026-01-01T12:30:00Z'));
    const limited = meter.aggregateSessions(entries, { pricing: PRICING, limit: 2 });
    expect(limited.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

describe('formatters', () => {
  it('formatTokens tiers', () => {
    expect(meter.formatTokens(950)).toBe('950');
    expect(meter.formatTokens(12340)).toBe('12.3k');
    expect(meter.formatTokens(1234000)).toBe('1.23M');
  });

  it('formatUSD tiers', () => {
    expect(meter.formatUSD(0.042)).toBe('$0.0420');
    expect(meter.formatUSD(12.345)).toBe('$12.35');
    expect(meter.formatUSD(250)).toBe('$250');
  });

  it('formatDurationMs and shortModel', () => {
    expect(meter.formatDurationMs(2 * HOUR + 7 * 60 * 1000)).toBe('2h07m');
    expect(meter.formatDurationMs(45 * 60 * 1000)).toBe('45m');
    expect(meter.formatDurationMs(38 * 1000)).toBe('38s');
    expect(meter.shortModel('claude-fable-5')).toBe('fable-5');
    expect(meter.shortModel('gpt-x')).toBe('gpt-x');
  });
});

// ---------------------------------------------------------------------------
// Hostile metadata quarantine (transcripts are artifact input)
// ---------------------------------------------------------------------------

describe('extractEntry — hostile metadata quarantine', () => {
  it('a model failing the charset is quarantined to the sentinel, tokens kept', () => {
    const raw = JSON.parse(line({ input: 7 }));
    raw.message.model = 'bad\n[usage-gate] FORGED\u001b[31m';
    const e = meter.extractEntry(raw);
    expect(e.model).toBe(meter.INVALID_MODEL);
    expect(e.input).toBe(7);
  });

  it('ids failing the charset become null (no dedup key, unknown session)', () => {
    const raw = JSON.parse(line({}));
    raw.message.id = 'msg\u0000evil';
    raw.requestId = 'req\ninjected';
    raw.sessionId = 'sess\u001b[31m';
    const e = meter.extractEntry(raw);
    expect(e.messageId).toBeNull();
    expect(e.requestId).toBeNull();
    expect(e.sessionId).toBeNull();
  });

  it('real-world ids and models pass the charset unchanged', () => {
    const raw = JSON.parse(line({ model: 'claude-fable-5', msgId: 'msg_011CcABC', reqId: 'req_011CcDEF' }));
    const e = meter.extractEntry(raw);
    expect(e.model).toBe('claude-fable-5');
    expect(e.messageId).toBe('msg_011CcABC');
    expect(e.requestId).toBe('req_011CcDEF');
  });

  it('rollup model maps are null-prototype ("__proto__" is a plain own key)', () => {
    const hostile = { ...mkEntry('2026-01-01T10:00:00Z', { input: 5 }), model: '__proto__' };
    const r = meter.rollup([hostile], PRICING);
    expect(r.models['__proto__'].tokens.input).toBe(5);
    expect({}.polluted).toBeUndefined();
    expect(Object.prototype.polluted).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// File-level failures (settle once, stay visible — the gate must never lie)
// ---------------------------------------------------------------------------

describe('parseTranscriptFile / loadEntries — file-level failure visibility', () => {
  it('a vanished file settles once with fileError (no throw, no crash)', async () => {
    const res = await meter.parseTranscriptFile(path.join(tmpRoot, 'not-there.jsonl'));
    expect(res.entries).toEqual([]);
    expect(res.fileError).toBeTruthy();
  });

  it('an unreadable (mode 000) file counts as fileReadErrors; readable files still load', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return; // root ignores modes
    writeTranscript('slug/good.jsonl', [line({ msgId: 'm1', reqId: 'r1', input: 5 })]);
    const bad = writeTranscript('slug/bad.jsonl', [line({ msgId: 'm2', reqId: 'r2', input: 7 })]);
    fs.chmodSync(bad, 0o000);
    try {
      const res = await meter.loadEntries({ dirs: [tmpRoot] });
      expect(res.fileReadErrors).toBe(1);
      expect(res.entries.length).toBe(1);
      expect(res.entries[0].input).toBe(5);
    } finally {
      fs.chmodSync(bad, 0o644);
    }
  });

  it('malformed-only corpus: zero entries, parseErrors counted, no throw', async () => {
    writeTranscript('slug/garbage.jsonl', ['{ nope', 'still not json', '{"type":"assistant"']);
    const res = await meter.loadEntries({ dirs: [tmpRoot] });
    expect(res.entries.length).toBe(0);
    expect(res.parseErrors).toBe(3);
  });

  it('mixed good/bad file: good entries load, bad lines counted', async () => {
    writeTranscript('slug/mixed.jsonl', ['{ broken', line({ msgId: 'm1', reqId: 'r1', input: 3 }), 'garbage tail']);
    const res = await meter.loadEntries({ dirs: [tmpRoot] });
    expect(res.entries.length).toBe(1);
    expect(res.parseErrors).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Pricing row validation (fail-visible, never zero-filled)
// ---------------------------------------------------------------------------

describe('loadPricing — row validation', () => {
  it('rows missing/invalid on any of the five rates are rejected into rowErrors', () => {
    const p = path.join(tmpRoot, 'rows.json');
    fs.writeFileSync(p, JSON.stringify({
      models: {
        good: { input: 1, output: 2, cache_write_5m: 1.25, cache_write_1h: 2, cache_read: 0.1 },
        empty: {},
        partial: { input: 1, output: 2 },
        negative: { input: -1, output: 2, cache_write_5m: 1, cache_write_1h: 2, cache_read: 0.1 },
        nonnumeric: { input: '3', output: 2, cache_write_5m: 1, cache_write_1h: 2, cache_read: 0.1 },
      },
    }));
    const pricing = meter.loadPricing({ path: p });
    expect(Object.keys(pricing.models)).toEqual(['good']);
    expect(pricing.rowErrors.length).toBe(4);
    expect(meter.resolveModelPricing(pricing, 'partial-model')).toBeNull();
  });

  it('a rejected row leaves its model unpriced-and-flagged, never confidently $0', () => {
    const p = path.join(tmpRoot, 'rows2.json');
    fs.writeFileSync(p, JSON.stringify({ models: { 'test-b': { input: 1 } } }));
    const pricing = meter.loadPricing({ path: p });
    const { costUSD, unpriced } = meter.entryCostUSD(mkEntry('2026-01-01T10:00:00Z', { input: 1e6 }), pricing);
    expect(unpriced).toBe(true);
    expect(costUSD).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Prefilter parity (the gate correctness invariant)
// ---------------------------------------------------------------------------

describe('mtime prefilter parity with full scan', () => {
  it('an old gap-isolated file changes total blocks but never the active block', async () => {
    const now = Date.parse('2026-01-03T12:30:00Z');
    const at = (hoursAgo) => new Date(now - hoursAgo * HOUR).toISOString();
    // Old file: activity 40h-35h ago, mtime aged past a 30h lookback. Isolated
    // from the recent chain by a 9h (>5h) dead gap — the condition under which
    // the prefilter is exact (an unbroken chain across the cutoff is the
    // documented theoretical divergence case and does not occur with daily
    // >=5h idle gaps).
    const oldPath = writeTranscript('slug/old.jsonl', [
      line({ ts: at(40), msgId: 'o1', reqId: 'r1', input: 11 }),
      line({ ts: at(35), msgId: 'o2', reqId: 'r2', input: 13 }),
    ]);
    const oldDate = new Date(now - 35 * HOUR);
    fs.utimesSync(oldPath, oldDate, oldDate);
    // Recent chain: <5h gaps, crossing a file boundary, reaching an active block.
    writeTranscript('slug/recent-1.jsonl', [
      line({ ts: at(26), msgId: 'a1', reqId: 'r1', input: 1 }),
      line({ ts: at(22), msgId: 'a2', reqId: 'r2', input: 2 }),
      line({ ts: at(18), msgId: 'a3', reqId: 'r3', input: 4 }),
    ]);
    writeTranscript('slug/recent-2.jsonl', [
      line({ ts: at(14), msgId: 'b1', reqId: 'r1', input: 8 }),
      line({ ts: at(10), msgId: 'b2', reqId: 'r2', input: 16 }),
      line({ ts: at(6), msgId: 'b3', reqId: 'r3', input: 32 }),
      line({ ts: at(2), msgId: 'b4', reqId: 'r4', input: 64 }),
      line({ ts: at(0.5), msgId: 'b5', reqId: 'r5', input: 128 }),
    ]);

    const full = await meter.loadEntries({ dirs: [tmpRoot] });
    const pre = await meter.loadEntries({ dirs: [tmpRoot], sinceMs: now - 30 * HOUR });
    expect(pre.skippedByMtime).toBe(1);
    expect(full.entries.length).toBe(pre.entries.length + 2);

    const fullBlocks = meter.identifyBlocks(full.entries, { now });
    const preBlocks = meter.identifyBlocks(pre.entries, { now });
    const fullActive = fullBlocks.find((b) => b.isActive);
    const preActive = preBlocks.find((b) => b.isActive);
    expect(fullActive).toBeTruthy();
    expect(preActive).toBeTruthy();
    expect(preActive.startMs).toBe(fullActive.startMs);
    expect(preActive.entries.length).toBe(fullActive.entries.length);
    expect(meter.sumTokens(preActive.entries).total).toBe(meter.sumTokens(fullActive.entries).total);
    expect(fullBlocks.length).toBeGreaterThan(preBlocks.length);
  });
});

// ---------------------------------------------------------------------------
// Source text hygiene (public-mirror: modules must stay grep-able text)
// ---------------------------------------------------------------------------

describe('source text hygiene', () => {
  it('usage-meter.cjs and usage.cjs contain no raw control bytes', () => {
    const sources = [
      _require.resolve('../usage-meter.cjs'),
      _require.resolve('../../bin/usage.cjs'),
    ];
    for (const src of sources) {
      const buf = fs.readFileSync(src);
      for (let i = 0; i < buf.length; i++) {
        const b = buf[i];
        const ok = b === 0x0a || b === 0x0d || b === 0x09 || b >= 0x20;
        if (!ok) {
          throw new Error(`raw control byte 0x${b.toString(16)} at offset ${i} in ${path.basename(src)}`);
        }
      }
    }
  });
});
