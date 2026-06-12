import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import path from 'path';
import fs from 'fs';
import os from 'os';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tempDir;
let homedirSpy;

function writeLicense(data) {
  const dir = path.join(tempDir, '.4ge');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'license.json'), JSON.stringify(data), 'utf8');
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-gate-test-'));
  homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tempDir);
  delete process.env.FORGE_TIER_OVERRIDE;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.FORGE_TIER_OVERRIDE;
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ok */ }
});

// Load module once — it resolves paths dynamically via os.homedir() at call time
const tg = require('../tier-gate.cjs');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('tier-gate', () => {
  describe('current()', () => {
    it('returns free when no license file exists', () => {
      expect(tg.current()).toBe('free');
    });

    it('returns pro when valid license.json has tier:pro', () => {
      writeLicense({
        tier: 'pro',
        email: 'test@example.com',
        validatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        offlineGraceDays: 7,
      });
      expect(tg.current()).toBe('pro');
    });

    it('returns team when valid license.json has tier:team', () => {
      writeLicense({
        tier: 'team',
        email: 'team@example.com',
        validatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        offlineGraceDays: 7,
      });
      expect(tg.current()).toBe('team');
    });

    it('returns free when license is expired beyond grace window', () => {
      const graceDays = 7;
      writeLicense({
        tier: 'pro',
        email: 'test@example.com',
        validatedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
        expiresAt: new Date(Date.now() - (graceDays + 1) * 24 * 60 * 60 * 1000).toISOString(),
        offlineGraceDays: graceDays,
      });
      expect(tg.current()).toBe('free');
    });

    it('returns cached tier when license is expired within grace window', () => {
      const graceDays = 7;
      writeLicense({
        tier: 'pro',
        email: 'test@example.com',
        validatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        // Expired 3 days ago — within 7-day grace
        expiresAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
        offlineGraceDays: graceDays,
      });
      expect(tg.current()).toBe('pro');
    });
  });

  describe('FORGE_TIER_OVERRIDE', () => {
    it('overrides to the specified tier when env var is set', () => {
      process.env.FORGE_TIER_OVERRIDE = 'pro';
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => {});
      expect(tg.current()).toBe('pro');
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('FORGE_TIER_OVERRIDE=pro')
      );
    });

    it('ignores invalid tier values in FORGE_TIER_OVERRIDE', () => {
      process.env.FORGE_TIER_OVERRIDE = 'enterprise';
      // Falls through to normal resolution (no license = free)
      expect(tg.current()).toBe('free');
    });
  });

  describe('check()', () => {
    it('returns allowed:false when free tier checks for pro', () => {
      const result = tg.check('pro');
      expect(result.allowed).toBe(false);
      expect(result.currentTier).toBe('free');
      expect(result.reason).toContain('free');
    });

    it('returns allowed:true when pro tier checks for pro', () => {
      writeLicense({
        tier: 'pro',
        validatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      });
      const result = tg.check('pro');
      expect(result.allowed).toBe(true);
      expect(result.currentTier).toBe('pro');
    });

    it('returns allowed:true when team tier checks for pro (team >= pro)', () => {
      writeLicense({
        tier: 'team',
        validatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      });
      const result = tg.check('pro');
      expect(result.allowed).toBe(true);
      expect(result.currentTier).toBe('team');
    });

    it('returns allowed:true when free tier checks for free', () => {
      const result = tg.check('free');
      expect(result.allowed).toBe(true);
    });

    it('returns an object with allowed, currentTier, and reason fields', () => {
      const result = tg.check('pro');
      expect(result).toHaveProperty('allowed');
      expect(result).toHaveProperty('currentTier');
      expect(result).toHaveProperty('reason');
    });
  });

  describe('require()', () => {
    it('returns false and writes to stderr when free tier requires pro', () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => {});
      const result = tg.require('pro', 'forge');
      expect(result).toBe(false);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('/forge requires Pro'));
    });

    it('includes upgrade URL in stderr output', () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => {});
      tg.require('pro', 'dfe');
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('https://3sixtyco.dev/4ge'));
    });

    it('returns true when tier requirement is met', () => {
      writeLicense({
        tier: 'pro',
        validatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      });
      const result = tg.require('pro', 'forge');
      expect(result).toBe(true);
    });

    it('does not write to stderr when access is allowed', () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => {});
      writeLicense({
        tier: 'pro',
        validatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      });
      tg.require('pro', 'forge');
      expect(stderrSpy).not.toHaveBeenCalled();
    });
  });

  describe('info()', () => {
    it('returns null when no license file exists', () => {
      expect(tg.info()).toBeNull();
    });

    it('returns license info object when license exists', () => {
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      writeLicense({
        tier: 'pro',
        email: 'user@example.com',
        validatedAt: new Date().toISOString(),
        expiresAt,
        offlineGraceDays: 7,
      });
      const result = tg.info();
      expect(result).not.toBeNull();
      expect(result.tier).toBe('pro');
      expect(result.licensedTo).toBe('user@example.com');
      expect(result.expiresAt).toBe(expiresAt);
      expect(result.daysRemaining).toBeGreaterThan(0);
    });
  });

  describe('PRO_GATED array', () => {
    it('exports PRO_GATED as a non-empty array', () => {
      expect(Array.isArray(tg.PRO_GATED)).toBe(true);
      expect(tg.PRO_GATED.length).toBeGreaterThan(0);
    });

    it('includes forge in PRO_GATED', () => {
      expect(tg.PRO_GATED).toContain('forge');
    });

    it('does not include free commands in PRO_GATED', () => {
      // help, map, recall, fix, hud are free
      expect(tg.PRO_GATED).not.toContain('help');
      expect(tg.PRO_GATED).not.toContain('map');
    });

    it('pins the exact 12-entry regraded set (S410, order-insensitive)', () => {
      // The regrade (S410, _runs/s410/tier-regrade.md §3) shrank PRO_GATED
      // from 24 to 12: only multi-agent machinery, professional judgment
      // surfaces, business artifacts, and their redirect stubs remain gated.
      const expected = [
        'forge', 'dfe', 'audit', 'aisle',
        'outhouse', 'wizard', 'maintain',
        'autoresearch', 'evolve', 'export',
        'respawn', 'resp4wn',
      ];
      expect(tg.PRO_GATED).toHaveLength(12);
      expect([...tg.PRO_GATED].sort()).toEqual([...expected].sort());
    });

    it('DESCRIPTIONS keys equal PRO_GATED members exactly (no dead/missing entries)', () => {
      // Every gated command must have upgrade-prompt copy, and no ungated
      // command may carry dead copy (S410 §9 criterion 2).
      const descKeys = Object.keys(tg.DESCRIPTIONS).sort();
      const gated = [...tg.PRO_GATED].sort();
      expect(descKeys).toEqual(gated);
    });

    it('drops the commands the regrade freed', () => {
      // The 13 commands moved Free in S410 (commodity wrappers, file
      // append/read utilities, demo/charm assets, the front door + bootstrap).
      const freed = [
        'blueprint', 'commit', 'constraint', 'decide', 'hitchhiker', 'infra',
        'lint', 'lounge', 'pr', 'releases', 'ship', 'signoff', 'studio',
        'substrate',
      ];
      for (const cmd of freed) expect(tg.PRO_GATED).not.toContain(cmd);
    });
  });

  describe('redirect coherence (R3 — stubs inherit their target tier)', () => {
    const pairs = [
      ['commit', 'ship'],
      ['maintain', 'outhouse'],
      ['resp4wn', 'respawn'],
      ['hitchhiker', 'recall'],
      ['recon', 'recall'],
      ['map', 'recall'],
      ['superdupersecret', 'secret'],
    ];

    for (const [stub, target] of pairs) {
      it(`/${stub} and /${target} share a tier`, () => {
        expect(tg.PRO_GATED.includes(stub)).toBe(tg.PRO_GATED.includes(target));
      });
    }
  });
});
