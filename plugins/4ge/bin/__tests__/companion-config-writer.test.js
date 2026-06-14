import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Real temp dirs — vi.mock('fs') doesn't intercept CJS require('fs').

let tmpRoot;

function requireFresh(rel) {
  const modPath = path.resolve(__dirname, '..', rel);
  delete require.cache[modPath];
  return require(modPath);
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-writer-'));
  requireFresh('companion-config.cjs').clearCache();
});

afterEach(() => {
  requireFresh('companion-config.cjs').clearCache();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function readConfig() {
  return JSON.parse(fs.readFileSync(path.join(tmpRoot, '.4ge', 'config.json'), 'utf8'));
}

describe('companion-config-writer', () => {
  it('exports setCompanionKeys', () => {
    const { setCompanionKeys } = requireFresh('companion-config-writer.cjs');
    expect(typeof setCompanionKeys).toBe('function');
  });

  it('creates .4ge/config.json with the companion block when none exists', () => {
    const { setCompanionKeys } = requireFresh('companion-config-writer.cjs');
    setCompanionKeys({ faceMotion: true }, { projectRoot: tmpRoot });
    const cfg = readConfig();
    expect(cfg.companion.faceMotion).toBe(true);
  });

  it('PRESERVES sibling top-level keys (setupComplete/tier/version) — no whole-file overwrite', () => {
    const dir = path.join(tmpRoot, '.4ge');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      setupComplete: true, tier: 'pro', version: '2.5.0', hooks: { a: 1 },
      companion: { decayMs: 9999 },
    }));
    const { setCompanionKeys } = requireFresh('companion-config-writer.cjs');
    setCompanionKeys({ messages: 'major' }, { projectRoot: tmpRoot });
    const cfg = readConfig();
    expect(cfg.setupComplete).toBe(true);
    expect(cfg.tier).toBe('pro');
    expect(cfg.version).toBe('2.5.0');
    expect(cfg.hooks).toEqual({ a: 1 });
    // existing companion key preserved, new key merged in
    expect(cfg.companion.decayMs).toBe(9999);
    expect(cfg.companion.messages).toBe('major');
  });

  it('stamps companion._version with the plugin version', () => {
    const { setCompanionKeys } = requireFresh('companion-config-writer.cjs');
    setCompanionKeys({ zen: true }, { projectRoot: tmpRoot });
    const cfg = readConfig();
    expect(typeof cfg.companion._version).toBe('string');
    expect(cfg.companion._version.length).toBeGreaterThan(0);
  });

  it('does not stamp _version when stampVersion:false', () => {
    const { setCompanionKeys } = requireFresh('companion-config-writer.cjs');
    setCompanionKeys({ zen: true }, { projectRoot: tmpRoot, stampVersion: false });
    const cfg = readConfig();
    expect(cfg.companion._version).toBeUndefined();
  });

  it('shallow-merges nested insights without dropping siblings', () => {
    const dir = path.join(tmpRoot, '.4ge');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      companion: { insights: { enabled: true, tone: 'warm' } },
    }));
    const { setCompanionKeys } = requireFresh('companion-config-writer.cjs');
    setCompanionKeys({ insights: { tone: 'technical' } }, { projectRoot: tmpRoot });
    const cfg = readConfig();
    expect(cfg.companion.insights.enabled).toBe(true);     // preserved
    expect(cfg.companion.insights.tone).toBe('technical');  // updated
  });

  it('the written config round-trips through loadCompanionConfig with correct coercion', () => {
    const { setCompanionKeys } = requireFresh('companion-config-writer.cjs');
    setCompanionKeys({ faceMotion: true, messages: 'off' }, { projectRoot: tmpRoot });
    const cc = requireFresh('companion-config.cjs');
    cc.clearCache();
    const loaded = cc.loadCompanionConfig(tmpRoot);
    expect(loaded.faceMotion).toBe(true);
    expect(loaded.messages).toBe('off');
  });

  it('zero-crash: corrupt existing config is replaced (start fresh) rather than throwing', () => {
    const dir = path.join(tmpRoot, '.4ge');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), 'INVALID{{{');
    const { setCompanionKeys } = requireFresh('companion-config-writer.cjs');
    expect(() => setCompanionKeys({ zen: true }, { projectRoot: tmpRoot })).not.toThrow();
    const cfg = readConfig();
    expect(cfg.companion.zen).toBe(true);
  });
});
