import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Use real temp directories — vi.mock('fs') doesn't intercept CJS require('fs').

let tmpRoot;

function requireFresh() {
  const modPath = path.resolve(__dirname, '../companion-config.cjs');
  delete require.cache[modPath];
  return require(modPath);
}

function writeConfig(root, companionObj) {
  const dir = path.join(root, '.4ge');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ companion: companionObj }),
  );
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-'));
  const mod = requireFresh();
  mod.clearCache();
});

afterEach(() => {
  const mod = requireFresh();
  mod.clearCache();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('companion-config', () => {

  describe('exports', () => {
    it('exports loadCompanionConfig function', () => {
      const { loadCompanionConfig } = requireFresh();
      expect(typeof loadCompanionConfig).toBe('function');
    });

    it('exports clearCache function', () => {
      const { clearCache } = requireFresh();
      expect(typeof clearCache).toBe('function');
    });

    it('exports DEFAULTS object', () => {
      const { DEFAULTS } = requireFresh();
      expect(typeof DEFAULTS).toBe('object');
      expect(DEFAULTS).not.toBeNull();
    });
  });

  describe('DEFAULTS shape', () => {
    it('has required timing fields', () => {
      const { DEFAULTS } = requireFresh();
      expect(typeof DEFAULTS.decayMs).toBe('number');
      expect(typeof DEFAULTS.dwellMs).toBe('number');
      expect(typeof DEFAULTS.idleThresholdS).toBe('number');
      expect(typeof DEFAULTS.longIdleS).toBe('number');
      expect(typeof DEFAULTS.minDwellFlashMs).toBe('number');
      expect(typeof DEFAULTS.minDwellSignalMs).toBe('number');
      expect(typeof DEFAULTS.minDwellCriticalMs).toBe('number');
    });

    it('has colorTop and colorBot as 3-element arrays', () => {
      const { DEFAULTS } = requireFresh();
      expect(DEFAULTS.colorTop).toHaveLength(3);
      expect(DEFAULTS.colorBot).toHaveLength(3);
    });

    it('insights has enabled, rotationMs, tone', () => {
      const { DEFAULTS } = requireFresh();
      expect(typeof DEFAULTS.insights.enabled).toBe('boolean');
      expect(typeof DEFAULTS.insights.rotationMs).toBe('number');
      expect(typeof DEFAULTS.insights.tone).toBe('string');
    });
  });

  describe('no config file', () => {
    it('returns DEFAULTS when .4ge/config.json does not exist', () => {
      const { loadCompanionConfig, DEFAULTS } = requireFresh();
      const cfg = loadCompanionConfig(tmpRoot);
      expect(cfg.decayMs).toBe(DEFAULTS.decayMs);
      expect(cfg.insights.enabled).toBe(DEFAULTS.insights.enabled);
    });

    it('returns object with all DEFAULTS keys', () => {
      const { loadCompanionConfig, DEFAULTS } = requireFresh();
      const cfg = loadCompanionConfig(tmpRoot);
      for (const key of Object.keys(DEFAULTS)) {
        expect(key in cfg).toBe(true);
      }
    });
  });

  describe('user config overrides', () => {
    it('merges companion keys over defaults', () => {
      writeConfig(tmpRoot, { decayMs: 9999 });
      const { loadCompanionConfig, clearCache } = requireFresh();
      clearCache();
      const cfg = loadCompanionConfig(tmpRoot);
      expect(cfg.decayMs).toBe(9999);
    });

    it('preserves defaults for keys not in user config', () => {
      writeConfig(tmpRoot, { decayMs: 5000 });
      const { loadCompanionConfig, clearCache, DEFAULTS } = requireFresh();
      clearCache();
      const cfg = loadCompanionConfig(tmpRoot);
      expect(cfg.dwellMs).toBe(DEFAULTS.dwellMs);
      expect(cfg.shimmer).toBe(DEFAULTS.shimmer);
    });

    it('reads companion key from root config (ignores other keys)', () => {
      const dir = path.join(tmpRoot, '.4ge');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'config.json'),
        JSON.stringify({ someOtherKey: 'ignored', companion: { blinkInterval: 12345 } }),
      );
      const { loadCompanionConfig, clearCache } = requireFresh();
      clearCache();
      const cfg = loadCompanionConfig(tmpRoot);
      expect(cfg.blinkInterval).toBe(12345);
    });
  });

  describe('nested insights merge', () => {
    it('overriding rotationMs preserves enabled and tone', () => {
      writeConfig(tmpRoot, { insights: { rotationMs: 90000 } });
      const { loadCompanionConfig, clearCache, DEFAULTS } = requireFresh();
      clearCache();
      const cfg = loadCompanionConfig(tmpRoot);
      expect(cfg.insights.rotationMs).toBe(90000);
      expect(cfg.insights.enabled).toBe(DEFAULTS.insights.enabled);
      expect(cfg.insights.tone).toBe(DEFAULTS.insights.tone);
    });

    it('disabling insights preserves other defaults', () => {
      writeConfig(tmpRoot, { insights: { enabled: false } });
      const { loadCompanionConfig, clearCache, DEFAULTS } = requireFresh();
      clearCache();
      const cfg = loadCompanionConfig(tmpRoot);
      expect(cfg.insights.enabled).toBe(false);
      expect(cfg.insights.rotationMs).toBe(DEFAULTS.insights.rotationMs);
    });

    it('overriding tone preserves rotationMs', () => {
      writeConfig(tmpRoot, { insights: { tone: 'technical' } });
      const { loadCompanionConfig, clearCache, DEFAULTS } = requireFresh();
      clearCache();
      const cfg = loadCompanionConfig(tmpRoot);
      expect(cfg.insights.tone).toBe('technical');
      expect(cfg.insights.rotationMs).toBe(DEFAULTS.insights.rotationMs);
    });
  });

  describe('color array validation', () => {
    it('falls back to default colorTop when length is wrong', () => {
      writeConfig(tmpRoot, { colorTop: [39, 63] });
      const { loadCompanionConfig, clearCache, DEFAULTS } = requireFresh();
      clearCache();
      const cfg = loadCompanionConfig(tmpRoot);
      expect(cfg.colorTop).toEqual(DEFAULTS.colorTop);
    });

    it('falls back to default colorBot when not an array', () => {
      writeConfig(tmpRoot, { colorBot: 'bad' });
      const { loadCompanionConfig, clearCache, DEFAULTS } = requireFresh();
      clearCache();
      const cfg = loadCompanionConfig(tmpRoot);
      expect(cfg.colorBot).toEqual(DEFAULTS.colorBot);
    });

    it('accepts valid 3-element colorTop', () => {
      writeConfig(tmpRoot, { colorTop: [100, 200, 300] });
      const { loadCompanionConfig, clearCache } = requireFresh();
      clearCache();
      const cfg = loadCompanionConfig(tmpRoot);
      expect(cfg.colorTop).toEqual([100, 200, 300]);
    });
  });

  describe('caching', () => {
    it('returns same reference on repeated calls', () => {
      const { loadCompanionConfig, clearCache } = requireFresh();
      clearCache();
      const a = loadCompanionConfig(tmpRoot);
      const b = loadCompanionConfig(tmpRoot);
      expect(a).toBe(b);
    });

    it('clearCache forces a re-read', () => {
      writeConfig(tmpRoot, { decayMs: 1111 });
      const { loadCompanionConfig, clearCache } = requireFresh();
      clearCache();
      expect(loadCompanionConfig(tmpRoot).decayMs).toBe(1111);
      writeConfig(tmpRoot, { decayMs: 2222 });
      clearCache();
      expect(loadCompanionConfig(tmpRoot).decayMs).toBe(2222);
    });
  });

  describe('dual-location merge (homedir global + project override)', () => {
    let homeRoot;
    let realHomedir;

    beforeEach(() => {
      // Stub os.homedir() to an isolated temp dir so we never touch the real ~/.4ge.
      homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-home-'));
      realHomedir = os.homedir;
      os.homedir = () => homeRoot;
    });

    afterEach(() => {
      os.homedir = realHomedir;
      fs.rmSync(homeRoot, { recursive: true, force: true });
    });

    it('picks up companion config written to the homedir (~/.4ge/config.json)', () => {
      // Mirrors first-run.cjs: config lives in homedir, not the project root.
      writeConfig(homeRoot, { decayMs: 7777 });
      const { loadCompanionConfig, clearCache } = requireFresh();
      clearCache();
      const cfg = loadCompanionConfig(tmpRoot); // project root has NO config
      expect(cfg.decayMs).toBe(7777);
    });

    it('project config overrides homedir config for the same key', () => {
      writeConfig(homeRoot, { decayMs: 7777, dwellMs: 4444 });
      writeConfig(tmpRoot, { decayMs: 1234 });
      const { loadCompanionConfig, clearCache, DEFAULTS } = requireFresh();
      clearCache();
      const cfg = loadCompanionConfig(tmpRoot);
      expect(cfg.decayMs).toBe(1234);       // project wins
      expect(cfg.dwellMs).toBe(4444);       // homedir-only key preserved
      expect(cfg.idleThresholdS).toBe(DEFAULTS.idleThresholdS); // untouched default
    });

    it('homedir config wins over DEFAULTS when project has none', () => {
      writeConfig(homeRoot, { blinkInterval: 55000 });
      const { loadCompanionConfig, clearCache, DEFAULTS } = requireFresh();
      clearCache();
      const cfg = loadCompanionConfig(tmpRoot);
      expect(cfg.blinkInterval).toBe(55000);
      expect(cfg.blinkInterval).not.toBe(DEFAULTS.blinkInterval);
    });

    it('merges nested insights with project overriding homedir', () => {
      writeConfig(homeRoot, { insights: { rotationMs: 80000, tone: 'technical' } });
      writeConfig(tmpRoot, { insights: { tone: 'minimal' } });
      const { loadCompanionConfig, clearCache } = requireFresh();
      clearCache();
      const cfg = loadCompanionConfig(tmpRoot);
      expect(cfg.insights.rotationMs).toBe(80000); // from homedir
      expect(cfg.insights.tone).toBe('minimal');   // project overrides homedir
    });

    it('zero-crash: returns DEFAULTS when neither homedir nor project config exists', () => {
      const { loadCompanionConfig, clearCache, DEFAULTS } = requireFresh();
      clearCache();
      const cfg = loadCompanionConfig(tmpRoot);
      expect(cfg.decayMs).toBe(DEFAULTS.decayMs);
    });
  });

  describe('Wave 1: faceMotion / zen / messages defaults + coercion', () => {
    it('DEFAULTS include faceMotion=false, zen=false, messages="all", anomalyRow=false', () => {
      const { DEFAULTS } = requireFresh();
      expect(DEFAULTS.faceMotion).toBe(false);
      expect(DEFAULTS.zen).toBe(false);
      expect(DEFAULTS.messages).toBe('all');
      expect(DEFAULTS.anomalyRow).toBe(false);
    });

    it('preserves the existing message timing knobs (messageCooldownS=45, dwellMs)', () => {
      const { DEFAULTS } = requireFresh();
      expect(DEFAULTS.messageCooldownS).toBe(45);
      expect(typeof DEFAULTS.dwellMs).toBe('number');
    });

    it('coerces faceMotion to boolean — only literal true enables (default-false idiom)', () => {
      writeConfig(tmpRoot, { faceMotion: true });
      const { loadCompanionConfig, clearCache } = requireFresh();
      clearCache();
      expect(loadCompanionConfig(tmpRoot).faceMotion).toBe(true);
    });

    it('coerces a bad faceMotion string to calm (false), never lively', () => {
      writeConfig(tmpRoot, { faceMotion: 'yes' });
      const { loadCompanionConfig, clearCache } = requireFresh();
      clearCache();
      // 'yes' is truthy but NOT literal true → must coerce to false (calm)
      expect(loadCompanionConfig(tmpRoot).faceMotion).toBe(false);
    });

    it('coerces zen the same way — bad string → false', () => {
      writeConfig(tmpRoot, { zen: 'true' });
      const { loadCompanionConfig, clearCache } = requireFresh();
      clearCache();
      expect(loadCompanionConfig(tmpRoot).zen).toBe(false);
    });

    it('zen=true (literal) enables', () => {
      writeConfig(tmpRoot, { zen: true });
      const { loadCompanionConfig, clearCache } = requireFresh();
      clearCache();
      expect(loadCompanionConfig(tmpRoot).zen).toBe(true);
    });

    it('accepts valid messages enum values', () => {
      for (const lvl of ['all', 'major', 'off']) {
        writeConfig(tmpRoot, { messages: lvl });
        const { loadCompanionConfig, clearCache } = requireFresh();
        clearCache();
        expect(loadCompanionConfig(tmpRoot).messages).toBe(lvl);
      }
    });

    it('falls back to "all" on an invalid messages level', () => {
      writeConfig(tmpRoot, { messages: 'loud' });
      const { loadCompanionConfig, clearCache } = requireFresh();
      clearCache();
      expect(loadCompanionConfig(tmpRoot).messages).toBe('all');
    });

    it('coerces anomalyRow with the default-false literal-true idiom', () => {
      writeConfig(tmpRoot, { anomalyRow: true });
      let { loadCompanionConfig, clearCache } = requireFresh();
      clearCache();
      expect(loadCompanionConfig(tmpRoot).anomalyRow).toBe(true);

      writeConfig(tmpRoot, { anomalyRow: 'true' });
      ({ loadCompanionConfig, clearCache } = requireFresh());
      clearCache();
      expect(loadCompanionConfig(tmpRoot).anomalyRow).toBe(false);
    });
  });

  describe('S440: message min-dwell knobs', () => {
    it('DEFAULTS protect visible messages long enough to read by tier', () => {
      const { DEFAULTS } = requireFresh();
      expect(DEFAULTS.minDwellFlashMs).toBe(6000);
      expect(DEFAULTS.minDwellSignalMs).toBe(10000);
      expect(DEFAULTS.minDwellCriticalMs).toBe(15000);
    });

    it('accepts valid min-dwell overrides', () => {
      writeConfig(tmpRoot, {
        minDwellFlashMs: 1000,
        minDwellSignalMs: 2000,
        minDwellCriticalMs: 3000,
      });
      const { loadCompanionConfig, clearCache } = requireFresh();
      clearCache();
      const cfg = loadCompanionConfig(tmpRoot);
      expect(cfg.minDwellFlashMs).toBe(1000);
      expect(cfg.minDwellSignalMs).toBe(2000);
      expect(cfg.minDwellCriticalMs).toBe(3000);
    });

    it('falls back to defaults on invalid min-dwell overrides', () => {
      writeConfig(tmpRoot, {
        minDwellFlashMs: -1,
        minDwellSignalMs: 'slow',
        minDwellCriticalMs: 999999,
      });
      const { loadCompanionConfig, clearCache, DEFAULTS } = requireFresh();
      clearCache();
      const cfg = loadCompanionConfig(tmpRoot);
      expect(cfg.minDwellFlashMs).toBe(DEFAULTS.minDwellFlashMs);
      expect(cfg.minDwellSignalMs).toBe(DEFAULTS.minDwellSignalMs);
      expect(cfg.minDwellCriticalMs).toBe(DEFAULTS.minDwellCriticalMs);
    });
  });

  describe('corrupt config', () => {
    it('returns DEFAULTS on invalid JSON', () => {
      const dir = path.join(tmpRoot, '.4ge');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'config.json'), 'INVALID{{{');
      const { loadCompanionConfig, clearCache, DEFAULTS } = requireFresh();
      clearCache();
      const cfg = loadCompanionConfig(tmpRoot);
      expect(cfg.decayMs).toBe(DEFAULTS.decayMs);
    });

    it('returns DEFAULTS when no companion key', () => {
      const dir = path.join(tmpRoot, '.4ge');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ unrelated: true }));
      const { loadCompanionConfig, clearCache, DEFAULTS } = requireFresh();
      clearCache();
      const cfg = loadCompanionConfig(tmpRoot);
      expect(cfg.decayMs).toBe(DEFAULTS.decayMs);
    });
  });
});
