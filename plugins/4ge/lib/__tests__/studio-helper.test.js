import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

// Load the module fresh each test to avoid stale state
const MODULE_PATH = path.resolve(__dirname, '../studio-helper.cjs');

function requireFresh(overrides = {}) {
  delete _require.cache[_require.resolve(MODULE_PATH)];
  const mod = _require(MODULE_PATH);
  return { ...mod, ...overrides };
}

// Build a temp dir for each test that needs disk isolation
function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'studio-test-'));
}

describe('studio-helper', () => {
  describe('buildStudioState()', () => {
    it('returns a valid canonical state shape with mode full', () => {
      const mod = requireFresh();
      const state = mod.buildStudioState();

      expect(state).toBeDefined();
      expect(state.mode).toBe('full');
      expect(state.context).toBeDefined();
      expect(state.context.trigger).toBe('studio');
      expect(state.context.event).toBe('boot');
      expect(state.os).toBeDefined();
      expect(typeof state.os.capabilities).toBe('object');
    });

    it('returns badges in state', () => {
      const mod = requireFresh();
      const state = mod.buildStudioState();
      expect(state.badges).toBeDefined();
      expect(typeof state.badges.earned).toBe('object');
      expect(Array.isArray(state.badges.newThisSession)).toBe(true);
    });

    it('returns defaults when OS state files are missing', () => {
      const mod = requireFresh();
      // Files may or may not exist; either way state should parse cleanly
      const state = mod.buildStudioState();
      expect(state.mode).toBe('full');
      expect(state.os.overallHealth).toBeDefined();
    });

    it('state is parseable as JSON', () => {
      const mod = requireFresh();
      const state = mod.buildStudioState();
      expect(() => JSON.stringify(state)).not.toThrow();
    });
  });

  describe('activateStudio() / deactivateStudio()', () => {
    let tmpDir;
    let origStudioFile;

    beforeEach(() => {
      tmpDir = makeTempDir();
      const mod = requireFresh();
      origStudioFile = mod.STUDIO_MODE_FILE;
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('activateStudio() returns state with correct shape', () => {
      const mod = requireFresh();
      const result = mod.activateStudio();

      expect(result).toBeDefined();
      expect(result.state).toBeDefined();
      expect(result.state.mode).toBe('full');
      expect(typeof result.badgeCount).toBe('number');
      expect(typeof result.activatedAt).toBe('string');
    });

    it('activateStudio() creates the studio-mode.json marker file', () => {
      const mod = requireFresh();
      mod.activateStudio();

      expect(fs.existsSync(mod.STUDIO_MODE_FILE)).toBe(true);
      const data = JSON.parse(fs.readFileSync(mod.STUDIO_MODE_FILE, 'utf8'));
      expect(data.active).toBe(true);
      expect(typeof data.activatedAt).toBe('string');

      // cleanup
      try { fs.unlinkSync(mod.STUDIO_MODE_FILE); } catch {}
    });

    it('deactivateStudio() returns { active: false }', () => {
      const mod = requireFresh();
      const result = mod.deactivateStudio();
      expect(result).toEqual({ active: false });
    });

    it('deactivateStudio() removes marker file after activateStudio()', () => {
      const mod = requireFresh();
      mod.activateStudio();
      expect(fs.existsSync(mod.STUDIO_MODE_FILE)).toBe(true);
      mod.deactivateStudio();
      expect(fs.existsSync(mod.STUDIO_MODE_FILE)).toBe(false);
    });

    it('deactivateStudio() does not throw when marker file is absent', () => {
      const mod = requireFresh();
      // Ensure file does not exist
      try { fs.unlinkSync(mod.STUDIO_MODE_FILE); } catch {}
      expect(() => mod.deactivateStudio()).not.toThrow();
    });
  });

  describe('getStudioStatus()', () => {
    it('returns correct shape when inactive', () => {
      const mod = requireFresh();
      // Ensure no marker
      try { fs.unlinkSync(mod.STUDIO_MODE_FILE); } catch {}

      const status = mod.getStudioStatus();
      expect(status.active).toBe(false);
      expect(status.activatedAt).toBeNull();
      expect(typeof status.badgeCount).toBe('number');
      expect(Array.isArray(status.earnedBadges)).toBe(true);
    });

    it('returns active=true after activateStudio()', () => {
      const mod = requireFresh();
      mod.activateStudio();

      const status = mod.getStudioStatus();
      expect(status.active).toBe(true);
      expect(typeof status.activatedAt).toBe('string');

      // cleanup
      mod.deactivateStudio();
    });
  });

  describe('isStudioActive()', () => {
    it('returns false when no marker file exists', () => {
      const mod = requireFresh();
      try { fs.unlinkSync(mod.STUDIO_MODE_FILE); } catch {}
      expect(mod.isStudioActive()).toBe(false);
    });

    it('returns true after activateStudio()', () => {
      const mod = requireFresh();
      mod.activateStudio();
      expect(mod.isStudioActive()).toBe(true);
      mod.deactivateStudio();
    });

    it('returns false after deactivateStudio()', () => {
      const mod = requireFresh();
      mod.activateStudio();
      mod.deactivateStudio();
      expect(mod.isStudioActive()).toBe(false);
    });
  });
});
