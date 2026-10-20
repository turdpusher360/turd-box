import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cache = require('../../lib/hud-statusline-cache.cjs');

const ENGINE = path.resolve(__dirname, '..', 'hud-engine.cjs');

function sample(overrides = {}) {
  return Object.assign({
    session_id: 'sess-a',
    transcript_path: null,
    cwd: '/tmp/x',
    model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
    context_window: { used_percentage: 12, total_input_tokens: 1000 },
    cost: { total_cost_usd: 1.5, total_duration_ms: 1000, total_api_duration_ms: 500 },
  }, overrides);
}

describe('hud-statusline-cache', () => {
  let dir;
  let transcript;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-sl-cache-test-'));
    transcript = path.join(dir, 't.jsonl');
    fs.writeFileSync(transcript, '{"a":1}\n');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('cache hit returns the identical output', () => {
    const s = sample({ transcript_path: transcript });
    const out = '\x1b[38;5;75mrow1\x1b[0m\nrow2\n\n\n\n';
    expect(cache.store(s, out, { dir, now: 1000 })).toBe(true);
    expect(cache.lookup(s, { dir, now: 2000 })).toBe(out);
  });

  it('ignores the per-poll duration counters', () => {
    const s = sample({ transcript_path: transcript });
    cache.store(s, 'frame', { dir, now: 1000 });
    const later = sample({ transcript_path: transcript, cost: { total_cost_usd: 1.5, total_duration_ms: 3000, total_api_duration_ms: 900 } });
    expect(cache.lookup(later, { dir, now: 3000 })).toBe('frame');
  });

  it('a fingerprint change re-renders (model, context, cwd, transcript, extra)', () => {
    const s = sample({ transcript_path: transcript });
    cache.store(s, 'frame', { dir, now: 1000, extra: { argv: ['--mode=statusline'] } });
    const opts = { dir, now: 2000, extra: { argv: ['--mode=statusline'] } };
    expect(cache.lookup(s, opts)).toBe('frame');
    expect(cache.lookup(sample({ transcript_path: transcript, model: { id: 'claude-sonnet-5-5' } }), opts)).toBeNull();
    expect(cache.lookup(sample({ transcript_path: transcript, context_window: { used_percentage: 13 } }), opts)).toBeNull();
    expect(cache.lookup(sample({ transcript_path: transcript, cwd: '/tmp/y' }), opts)).toBeNull();
    expect(cache.lookup(s, Object.assign({}, opts, { extra: { argv: ['--mode=statusline', '--max-rows=4'] } }))).toBeNull();
    fs.appendFileSync(transcript, '{"b":2}\n');
    expect(cache.lookup(s, opts)).toBeNull();
  });

  it('TTL expiry re-renders', () => {
    const s = sample({ transcript_path: transcript });
    cache.store(s, 'frame', { dir, now: 1000 });
    expect(cache.lookup(s, { dir, now: 1000 + cache.CACHE_TTL_MS - 1 })).toBe('frame');
    expect(cache.lookup(s, { dir, now: 1000 + cache.CACHE_TTL_MS })).toBeNull();
    expect(cache.lookup(s, { dir, now: 999 })).toBeNull(); // clock went backwards
  });

  it('a corrupt or missing cache file is a miss, never a throw', () => {
    const s = sample({ transcript_path: transcript });
    expect(cache.lookup(s, { dir, now: 1 })).toBeNull();
    fs.writeFileSync(cache.cacheFileFor(s.session_id, dir), '{not json');
    expect(cache.lookup(s, { dir, now: 1 })).toBeNull();
    fs.writeFileSync(cache.cacheFileFor(s.session_id, dir), JSON.stringify({ v: 1, sid: 'sess-a', at: 1, fp: 'x', out: '' }));
    expect(cache.lookup(s, { dir, now: 2 })).toBeNull();
  });

  it('two session_ids do not share a cache', () => {
    const a = sample({ transcript_path: transcript });
    const b = sample({ transcript_path: transcript, session_id: 'sess-b' });
    cache.store(a, 'frame-a', { dir, now: 1000 });
    expect(cache.lookup(b, { dir, now: 1001 })).toBeNull();
    cache.store(b, 'frame-b', { dir, now: 1000 });
    expect(cache.lookup(a, { dir, now: 1001 })).toBe('frame-a');
    expect(cache.lookup(b, { dir, now: 1001 })).toBe('frame-b');
    expect(cache.cacheFileFor('sess-a', dir)).not.toBe(cache.cacheFileFor('sess-b', dir));
  });

  it('no session_id means no cache', () => {
    const s = sample({ session_id: undefined });
    expect(cache.store(s, 'frame', { dir })).toBe(false);
    expect(cache.lookup(s, { dir })).toBeNull();
  });

  it('path-unsafe session ids stay inside the cache dir', () => {
    const f = cache.cacheFileFor('../../etc/passwd', dir);
    expect(path.dirname(f)).toBe(dir);
  });

  it('store leaves no temp files behind', () => {
    cache.store(sample({ transcript_path: transcript }), 'frame', { dir, now: 1 });
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  describe('engine CLI', () => {
    function run(stdin, cacheDir) {
      const childEnv = Object.assign({}, process.env, { FORGE_HUD_STATUSLINE_CACHE_DIR: cacheDir });
      delete childEnv.CLAUDE_PROJECT_DIR;
      const r = spawnSync(process.execPath, [ENGINE, '--mode=statusline', '--max-rows=8'], {
        input: JSON.stringify(stdin), env: childEnv, encoding: 'utf8', timeout: 30000,
      });
      return r;
    }

    it('serves the cached frame on a hit and renders in full on a corrupt cache', () => {
      const cacheDir = path.join(dir, 'c');
      const s = sample({ transcript_path: transcript, cwd: dir, workspace: { project_dir: dir } });
      const first = run(s, cacheDir);
      expect(first.status).toBe(0);
      expect(first.stdout.length).toBeGreaterThan(0);
      const file = cache.cacheFileFor(s.session_id, cacheDir);
      const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(entry.out).toBe(first.stdout);

      // Plant a sentinel frame: only the hit path can print it.
      entry.out = 'CACHED-SENTINEL\n';
      fs.writeFileSync(file, JSON.stringify(entry));
      const hit = run(s, cacheDir);
      expect(hit.status).toBe(0);
      expect(hit.stdout).toBe('CACHED-SENTINEL\n');

      fs.writeFileSync(file, 'garbage');
      const full = run(s, cacheDir);
      expect(full.status).toBe(0);
      expect(full.stdout).not.toBe('CACHED-SENTINEL\n');
      expect(full.stdout.length).toBeGreaterThan(0);
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).out).toBe(full.stdout);
    }, 60000);
  });
});
