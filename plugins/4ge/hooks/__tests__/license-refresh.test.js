import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

// CJS require for the hook module (CommonJS). require.main !== module here, so
// the auto-run/process.exit tail does NOT fire on import.
const require = createRequire(import.meta.url);
const { isEnabled, maybeSpawnRefresh } = require('../license-refresh.cjs');

let tempDir;

function writeConfig(cfg) {
  const dir = path.join(tempDir, '.4ge');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg), 'utf8');
}
function writeLicense(lic) {
  const dir = path.join(tempDir, '.4ge');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'license.json'), JSON.stringify(lic), 'utf8');
}
function fakeSpawn() {
  const unref = vi.fn();
  const spawn = vi.fn(() => ({ unref }));
  return { spawn, unref };
}

const STALE = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(); // 48h
const FRESH = new Date().toISOString();

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'license-refresh-test-'));
  // tier-gate.cjs (_readLicense) and readConfig both resolve via os.homedir().
  vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
});
afterEach(() => {
  vi.restoreAllMocks();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ok */ }
});

describe('license-refresh hook — isEnabled() (default-on, suppressible)', () => {
  it('is enabled by default when no config is present', () => {
    expect(isEnabled({})).toBe(true);
  });

  it('stays enabled with unrelated config or an explicit autoRefresh:true', () => {
    writeConfig({ tier: 'free', setupComplete: true });
    expect(isEnabled({})).toBe(true);
    writeConfig({ license: { autoRefresh: true } });
    expect(isEnabled({})).toBe(true);
  });

  it('is disabled ONLY by an explicit opt-out (license.autoRefresh === false)', () => {
    writeConfig({ license: { autoRefresh: false } });
    expect(isEnabled({})).toBe(false);
  });

  it('hard kill-switch FORGE_NO_LICENSE_REFRESH wins even when enabled', () => {
    writeConfig({ license: { autoRefresh: true } });
    expect(isEnabled({ FORGE_NO_LICENSE_REFRESH: '1' })).toBe(false);
  });
});

describe('license-refresh hook — maybeSpawnRefresh() spawn decision (default-on)', () => {
  it('does NOT spawn when explicitly opted out, even with a stale licensed email', () => {
    writeConfig({ license: { autoRefresh: false } });
    writeLicense({ tier: 'pro', email: 'a@b.com', validatedAt: STALE });
    const { spawn } = fakeSpawn();
    expect(maybeSpawnRefresh({ env: {}, spawn })).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('does NOT spawn (default-on) when the license is FRESH (<24h)', () => {
    writeLicense({ tier: 'pro', email: 'a@b.com', validatedAt: FRESH });
    const { spawn } = fakeSpawn();
    expect(maybeSpawnRefresh({ env: {}, spawn })).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('does NOT spawn (default-on) when there is no license (free session never egresses)', () => {
    const { spawn } = fakeSpawn();
    expect(maybeSpawnRefresh({ env: {}, spawn })).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('does NOT spawn when the kill-switch is set, even with a stale licensed email', () => {
    writeLicense({ tier: 'pro', email: 'a@b.com', validatedAt: STALE });
    const { spawn } = fakeSpawn();
    expect(maybeSpawnRefresh({ env: { FORGE_NO_LICENSE_REFRESH: '1' }, spawn })).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('spawns exactly one detached, unref\'d `tier-gate.cjs --refresh` worker (default-on) when stale + licensed', () => {
    writeLicense({ tier: 'pro', email: 'a@b.com', validatedAt: STALE });
    const { spawn, unref } = fakeSpawn();
    expect(maybeSpawnRefresh({ env: { PATH: '/x', HOME: tempDir }, spawn })).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = spawn.mock.calls[0];
    expect(bin).toBe(process.execPath);
    expect(args[0]).toMatch(/tier-gate\.cjs$/);
    expect(args[args.length - 1]).toBe('--refresh');
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toBe('ignore');
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it('propagates FORGE_LICENSE_ENDPOINT and proxy/CA knobs to the worker env when present', () => {
    writeLicense({ tier: 'pro', email: 'a@b.com', validatedAt: STALE });
    const { spawn } = fakeSpawn();
    maybeSpawnRefresh({
      env: {
        HOME: tempDir,
        FORGE_LICENSE_ENDPOINT: 'https://example.test/v1/entitlements',
        HTTPS_PROXY: 'http://proxy.test:8080',
        NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem',
      },
      spawn,
    });
    const opts = spawn.mock.calls[0][2];
    expect(opts.env.FORGE_LICENSE_ENDPOINT).toBe('https://example.test/v1/entitlements');
    expect(opts.env.HTTPS_PROXY).toBe('http://proxy.test:8080');
    expect(opts.env.NODE_EXTRA_CA_CERTS).toBe('/etc/ssl/corp.pem');
  });

  it('omits only-when-present knobs from the worker env when unset (no empty keys)', () => {
    writeLicense({ tier: 'pro', email: 'a@b.com', validatedAt: STALE });
    const { spawn } = fakeSpawn();
    maybeSpawnRefresh({ env: { HOME: tempDir }, spawn });
    const opts = spawn.mock.calls[0][2];
    expect('FORGE_LICENSE_ENDPOINT' in opts.env).toBe(false);
    expect('HTTPS_PROXY' in opts.env).toBe(false);
  });

  it('never throws even if spawn itself throws (non-fatal, returns false)', () => {
    writeLicense({ tier: 'pro', email: 'a@b.com', validatedAt: STALE });
    const spawn = vi.fn(() => { throw new Error('EAGAIN'); });
    expect(() => maybeSpawnRefresh({ env: { HOME: tempDir }, spawn })).not.toThrow();
    expect(maybeSpawnRefresh({ env: { HOME: tempDir }, spawn })).toBe(false);
  });
});
