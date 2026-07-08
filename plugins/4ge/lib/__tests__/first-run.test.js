import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import path from 'path';
import fs from 'fs';
import os from 'os';

const require = createRequire(import.meta.url);

// Load modules once — they resolve paths dynamically via os.homedir() at call time
const fr = require('../first-run.cjs');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tempDir;

function dotFgeDir() {
  return path.join(tempDir, '.4ge');
}

function dotFgeExists() {
  return fs.existsSync(dotFgeDir());
}

function readConfig() {
  const configPath = path.join(dotFgeDir(), 'config.json');
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'first-run-test-'));
  vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
  delete process.env.FORGE_TIER_OVERRIDE;
});

afterEach(() => {
  vi.restoreAllMocks();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ok */ }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('first-run', () => {
  describe('isFirstRun()', () => {
    it('returns true when ~/.4ge/ does not exist', () => {
      expect(fr.isFirstRun()).toBe(true);
    });

    it('returns false when ~/.4ge/ exists', () => {
      fs.mkdirSync(dotFgeDir(), { recursive: true });
      expect(fr.isFirstRun()).toBe(false);
    });

    it('returns false after completeSetup() has been called', () => {
      expect(fr.isFirstRun()).toBe(true);
      fr.completeSetup({ tier: 'free', memory: 'none' });
      expect(fr.isFirstRun()).toBe(false);
    });
  });

  describe('getSetupSteps()', () => {
    it('returns an array of exactly 3 steps', () => {
      const steps = fr.getSetupSteps();
      expect(Array.isArray(steps)).toBe(true);
      expect(steps).toHaveLength(3);
    });

    it('each step has step number, title, and text properties', () => {
      const steps = fr.getSetupSteps();
      for (const step of steps) {
        expect(step).toHaveProperty('step');
        expect(step).toHaveProperty('title');
        expect(step).toHaveProperty('text');
        expect(typeof step.step).toBe('number');
        expect(typeof step.title).toBe('string');
        expect(typeof step.text).toBe('string');
      }
    });

    it('step numbers are 1, 2, 3 in order', () => {
      const steps = fr.getSetupSteps();
      expect(steps[0].step).toBe(1);
      expect(steps[1].step).toBe(2);
      expect(steps[2].step).toBe(3);
    });

    it('step 1 title is Welcome', () => {
      const steps = fr.getSetupSteps();
      expect(steps[0].title).toBe('Welcome');
    });

    it('step 2 title is Memory Connection', () => {
      const steps = fr.getSetupSteps();
      expect(steps[1].title).toBe('Memory Connection');
    });

    it('step 3 title is Ready', () => {
      const steps = fr.getSetupSteps();
      expect(steps[2].title).toBe('Ready');
    });

    it('step 1 text contains upgrade URL', () => {
      const steps = fr.getSetupSteps();
      expect(steps[0].text).toContain('https://3sixtyco.dev/4ge');
    });

    it('step 1 text uses durable Pro command copy instead of a stale command count', () => {
      const steps = fr.getSetupSteps();
      const staleCountPattern = new RegExp(String.raw`\b(?:all )?30\s+commands\b`);
      expect(steps[0].text).toContain('all Pro commands');
      expect(steps[0].text).not.toMatch(staleCountPattern);
    });

    it('step 2 text includes all three memory options', () => {
      const steps = fr.getSetupSteps();
      expect(steps[1].text).toContain('Local Docker');
      expect(steps[1].text).toContain('Hosted');
      expect(steps[1].text).toContain('Skip');
    });

    it('step 2 hosted-memory line names Team $39, not Pro $19 (S410 honesty fix)', () => {
      // Hosted memory is a Team-tier capability (honesty package, S404 B1).
      // The old copy sold it as "requires Pro, $19/mo" — a live violation in
      // every new install's setup flow.
      const steps = fr.getSetupSteps();
      expect(steps[1].text).not.toContain('requires Pro, $19');
      expect(steps[1].text).toContain('requires Team, $39/seat/mo');
    });

    it('step 3 text includes first commands to try', () => {
      const steps = fr.getSetupSteps();
      expect(steps[2].text).toContain('/ship');
      expect(steps[2].text).toContain('/recall --map');
      expect(steps[2].text).toContain('/recall');
      expect(steps[2].text).toContain('/help');
    });

    it('step 1 text shows current tier label', () => {
      // No license file in tempDir → free
      const steps = fr.getSetupSteps();
      expect(steps[0].text).toContain('Free');
    });
  });

  describe('completeSetup()', () => {
    it('creates ~/.4ge/ directory', () => {
      expect(dotFgeExists()).toBe(false);
      fr.completeSetup({ tier: 'free', memory: 'none' });
      expect(dotFgeExists()).toBe(true);
    });

    it('writes config.json with correct structure', () => {
      fr.completeSetup({ tier: 'free', memory: 'none' });
      const config = readConfig();
      expect(config.setupComplete).toBe(true);
      expect(config.tier).toBe('free');
      expect(config.memory).toBe('none');
      expect(typeof config.setupDate).toBe('string');
      expect(typeof config.version).toBe('string');
    });

    it('uses provided tier and memory in config.json', () => {
      fr.completeSetup({ tier: 'pro', memory: 'local' });
      const config = readConfig();
      expect(config.tier).toBe('pro');
      expect(config.memory).toBe('local');
    });

    it('defaults tier to free and memory to none when options omitted', () => {
      fr.completeSetup();
      const config = readConfig();
      expect(config.tier).toBe('free');
      expect(config.memory).toBe('none');
    });

    it('setupDate is a valid ISO-8601 string', () => {
      fr.completeSetup({});
      const config = readConfig();
      const parsed = new Date(config.setupDate);
      expect(isNaN(parsed.getTime())).toBe(false);
    });

    it('returns the written config object', () => {
      const result = fr.completeSetup({ tier: 'free', memory: 'local' });
      expect(result.setupComplete).toBe(true);
      expect(result.tier).toBe('free');
      expect(result.memory).toBe('local');
    });

    it('is idempotent — calling twice overwrites config without error', () => {
      fr.completeSetup({ tier: 'free', memory: 'none' });
      fr.completeSetup({ tier: 'pro', memory: 'hosted' });
      const config = readConfig();
      expect(config.tier).toBe('pro');
      expect(config.memory).toBe('hosted');
    });
  });

  // ---------------------------------------------------------------------------
  // Wave 2B: suggestNext() and --tour chain
  // ---------------------------------------------------------------------------

  describe('suggestNext()', () => {
    it('prints "What to do next" header', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      fr.suggestNext(tempDir);
      const output = spy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(output).toContain('What to do next');
      spy.mockRestore();
    });

    it('always suggests /4ge tour regardless of project type', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      fr.suggestNext(tempDir);
      const output = spy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(output).toContain('/4ge tour');
      spy.mockRestore();
    });

    it('suggests /4ge recall --map when package.json exists in projectRoot', () => {
      fs.writeFileSync(path.join(tempDir, 'package.json'), '{"name":"test"}');
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      fr.suggestNext(tempDir);
      const output = spy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(output).toContain('/4ge recall --map');
      spy.mockRestore();
    });

    it('does not suggest /4ge recall --map when package.json is absent', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      fr.suggestNext(tempDir);
      const output = spy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(output).not.toContain('/4ge recall --map');
      spy.mockRestore();
    });

    it('suggests /4ge forge when .git directory exists in projectRoot', () => {
      fs.mkdirSync(path.join(tempDir, '.git'));
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      fr.suggestNext(tempDir);
      const output = spy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(output).toContain('/4ge forge');
      spy.mockRestore();
    });

    it('does not suggest /4ge forge when .git is absent', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      fr.suggestNext(tempDir);
      const output = spy.mock.calls.map(c => c.join(' ')).join('\n');
      expect(output).not.toContain('/4ge forge');
      spy.mockRestore();
    });
  });

  describe('getTourStep1()', () => {
    it('returns a non-empty string containing tour step 1 content', () => {
      const text = fr.getTourStep1();
      expect(typeof text).toBe('string');
      expect(text.length).toBeGreaterThan(0);
      expect(text).toContain('Step 1');
    });

    it('tour step 1 content mentions /help', () => {
      const text = fr.getTourStep1();
      expect(text).toContain('/help');
    });
  });

  describe('--tour flag behavior', () => {
    it('existing 3-step flow is unchanged when --tour flag is absent', () => {
      // getSetupSteps() returns exactly 3 steps — no extra steps injected
      const steps = fr.getSetupSteps();
      expect(steps).toHaveLength(3);
      expect(steps[0].title).toBe('Welcome');
      expect(steps[1].title).toBe('Memory Connection');
      expect(steps[2].title).toBe('Ready');
    });

    it('hasTourFlag() returns true when process.argv includes --tour', () => {
      const original = process.argv;
      process.argv = ['node', 'first-run.cjs', '--tour'];
      expect(fr.hasTourFlag()).toBe(true);
      process.argv = original;
    });

    it('hasTourFlag() returns false when --tour is absent', () => {
      const original = process.argv;
      process.argv = ['node', 'first-run.cjs'];
      expect(fr.hasTourFlag()).toBe(false);
      process.argv = original;
    });
  });
});
