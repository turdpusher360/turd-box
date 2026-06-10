// plugins/4ge/__tests__/4ge-hook-utils-v2.test.js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const cjsRequire = createRequire(import.meta.url);
const fs = cjsRequire('fs');
const { read4geConfig, appendJsonl, readRecentJsonl } = cjsRequire('../hooks/4ge-hook-utils-v2.cjs');

describe('4ge-hook-utils-v2', () => {
  let existsSyncSpy;
  let readFileSyncSpy;
  let appendFileSyncSpy;
  let mkdirSyncSpy;
  let statSyncSpy;

  beforeEach(() => {
    existsSyncSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    readFileSyncSpy = vi.spyOn(fs, 'readFileSync').mockReturnValue('{}');
    appendFileSyncSpy = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {});
    mkdirSyncSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
    statSyncSpy = vi.spyOn(fs, 'statSync').mockReturnValue({ size: 100 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns safe defaults when config file is missing', () => {
    existsSyncSpy.mockReturnValue(false);
    const config = read4geConfig('/fake');
    expect(config.version).toBe('2.1.0');
    expect(config.design_suite).toEqual({ enabled: false, modes: ['visual', 'api', 'data', 'system'], default_mode: 'visual' });
    expect(config.telemetry).toEqual({ enabled: false, retention_days: 90 });
    expect(config.trust).toEqual({ level: 'guided', score: 0 });
    expect(config.lounge).toEqual({ enabled: false, max_options: 4 });
  });

  it('reads and parses existing config file', () => {
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(JSON.stringify({ version: '2.1.0', tier: 'full', design_suite: { enabled: true } }));
    const config = read4geConfig('/fake');
    expect(config.tier).toBe('full');
    expect(config.design_suite.enabled).toBe(true);
  });

  it('merges safe defaults for missing sections', () => {
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(JSON.stringify({ version: '2.0.0', tier: 'standard' }));
    const config = read4geConfig('/fake');
    expect(config.trust).toEqual({ level: 'guided', score: 0 });
  });

  it('appends JSONL entry to file', () => {
    appendJsonl('/fake/_runs/test.jsonl', { key: 'value' });
    expect(appendFileSyncSpy).toHaveBeenCalledWith(
      '/fake/_runs/test.jsonl',
      expect.stringContaining('"key":"value"')
    );
  });

  it('reads recent JSONL entries with limit', () => {
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(
      '{"a":1}\n{"a":2}\n{"a":3}\n{"a":4}\n{"a":5}\n'
    );
    const entries = readRecentJsonl('/fake/test.jsonl', 3);
    expect(entries).toHaveLength(3);
    expect(entries[0].a).toBe(5); // most recent first (slice last 3, then reverse)
  });
});
