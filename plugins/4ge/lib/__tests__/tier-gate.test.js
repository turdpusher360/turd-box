import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
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
      // help, recall, fix, hud are free
      expect(tg.PRO_GATED).not.toContain('help');
    });

    it('pins the exact 11-entry regraded set (S410 regrade + resp4wn stub retirement, order-insensitive)', () => {
      // The regrade (S410, _runs/s410/tier-regrade.md §3) shrank PRO_GATED
      // from 24 to 12: only multi-agent machinery, professional judgment
      // surfaces, business artifacts, and their redirect stubs remained gated.
      // resp4wn's retirement (redirect stub deleted) trimmed it further to 11.
      const expected = [
        'forge', 'dfe', 'audit', 'aisle',
        'outhouse', 'wizard', 'maintain',
        'autoresearch', 'evolve', 'export',
        'respawn',
      ];
      expect(tg.PRO_GATED).toHaveLength(11);
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
      // The 13 commands moved Free in S410 (commodity wrappers, file append/read
      // utilities, legacy redirects, demo/charm assets, bootstrap, and infra).
      // /commit was one of them but has since been retired (redirect stub
      // deleted) — dropped from this list along with its command file.
      const freed = [
        'blueprint', 'constraint', 'decide', 'hitchhiker', 'infra',
        'lint', 'lounge', 'pr', 'releases', 'ship', 'signoff', 'studio',
        'substrate',
      ];
      for (const cmd of freed) expect(tg.PRO_GATED).not.toContain(cmd);
    });
  });

  describe('redirect coherence (R3 — stubs inherit their target tier)', () => {
    const pairs = [
      ['maintain', 'outhouse'],
      ['hitchhiker', 'recall'],
      ['superdupersecret', 'secret'],
    ];

    for (const [stub, target] of pairs) {
      it(`/${stub} and /${target} share a tier`, () => {
        expect(tg.PRO_GATED.includes(stub)).toBe(tg.PRO_GATED.includes(target));
      });
    }
  });

  // -------------------------------------------------------------------------
  // Phase 2 — remote re-validation against the live license-worker
  // -------------------------------------------------------------------------

  describe('refresh() — remote re-validation (Phase 2)', () => {
    let originalFetch;
    const STALE = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(); // 48h old
    const FRESH = new Date().toISOString();
    const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const PERIOD_END_SECS = Math.floor((Date.now() + 30 * 24 * 60 * 60 * 1000) / 1000);

    function mockFetch(impl) {
      const fn = vi.fn(impl);
      globalThis.fetch = fn;
      return fn;
    }
    function entitlementsResponse(products, status = 'active', entitled = true) {
      return { ok: true, json: async () => ({ entitled, products, status }) };
    }
    function readWritten() {
      return JSON.parse(
        fs.readFileSync(path.join(tempDir, '.4ge', 'license.json'), 'utf8')
      );
    }

    beforeEach(() => { originalFetch = globalThis.fetch; });
    afterEach(() => { globalThis.fetch = originalFetch; });

    it('upgrades a stale cached tier from a successful entitled response and rewrites the cache', async () => {
      writeLicense({ tier: 'free', email: 'buyer@example.com', validatedAt: STALE, expiresAt: FUTURE });
      const fetchFn = mockFetch(async () =>
        entitlementsResponse([
          { product: '4ge_pro', status: 'active', entitled: true, currentPeriodEnd: PERIOD_END_SECS },
        ])
      );
      const tier = await tg.refresh(50);
      expect(tier).toBe('pro');
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(fetchFn.mock.calls[0][0]).toContain('email=buyer%40example.com');
      const written = readWritten();
      expect(written.tier).toBe('pro');
      expect(new Date(written.validatedAt).getTime()).toBeGreaterThan(new Date(STALE).getTime());
      expect(written.expiresAt).toBe(new Date(PERIOD_END_SECS * 1000).toISOString());
      expect(tg.current()).toBe('pro'); // next synchronous read reflects the refresh
    });

    it('prefers team when both 4ge_pro and 4ge_team are entitled', async () => {
      writeLicense({ tier: 'free', email: 'buyer@example.com', validatedAt: STALE, expiresAt: FUTURE });
      mockFetch(async () =>
        entitlementsResponse([
          { product: '4ge_pro', status: 'active', entitled: true, currentPeriodEnd: PERIOD_END_SECS },
          { product: '4ge_team', status: 'active', entitled: true, currentPeriodEnd: PERIOD_END_SECS },
        ])
      );
      expect(await tg.refresh(50)).toBe('team');
    });

    it('ignores non-4ge products (dropstream_streamer, blueprint_pack)', async () => {
      writeLicense({ tier: 'free', email: 'buyer@example.com', validatedAt: STALE, expiresAt: FUTURE });
      mockFetch(async () =>
        entitlementsResponse([
          { product: 'dropstream_streamer', status: 'active', entitled: true, currentPeriodEnd: PERIOD_END_SECS },
          { product: 'blueprint_pack', status: 'active', entitled: true, currentPeriodEnd: null },
        ])
      );
      expect(await tg.refresh(50)).toBe('free');
    });

    it('does NOT touch the network when the cache is fresh (<24h)', async () => {
      writeLicense({ tier: 'pro', email: 'buyer@example.com', validatedAt: FRESH, expiresAt: FUTURE });
      const fetchFn = mockFetch(async () => entitlementsResponse([]));
      expect(await tg.refresh(50)).toBe('pro');
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it('does NOT touch the network when the license has no email', async () => {
      writeLicense({ tier: 'pro', validatedAt: STALE, expiresAt: FUTURE });
      const fetchFn = mockFetch(async () => entitlementsResponse([]));
      expect(await tg.refresh(50)).toBe('pro'); // cached tier preserved
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it('returns free and skips the network when no license file exists', async () => {
      const fetchFn = mockFetch(async () => entitlementsResponse([]));
      expect(await tg.refresh(50)).toBe('free');
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it('never downgrades a stale valid license on a network timeout (cache untouched)', async () => {
      writeLicense({ tier: 'pro', email: 'buyer@example.com', validatedAt: STALE, expiresAt: FUTURE });
      mockFetch(async () => {
        throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      });
      expect(await tg.refresh(50)).toBe('pro');
      const written = readWritten();
      expect(written.tier).toBe('pro');
      expect(written.validatedAt).toBe(STALE);
    });

    it('never downgrades on a non-2xx response', async () => {
      writeLicense({ tier: 'team', email: 'buyer@example.com', validatedAt: STALE, expiresAt: FUTURE });
      mockFetch(async () => ({ ok: false, status: 500, json: async () => ({}) }));
      expect(await tg.refresh(50)).toBe('team');
    });

    // --- 403 fail-closed endpoint (S553-CR-03) -------------------------------
    // The live worker (license-worker.zmbhhvhmdy.workers.dev) is deployed
    // FAIL-CLOSED: an unkeyed caller (which the distributed plugin always is)
    // gets HTTP 403 with body {"entitled":false,"error":"forbidden"} until the
    // operator sets ENTITLEMENTS_PUBLIC=true. A 403 means "endpoint requires
    // opt-in/credentials", NOT "user not entitled". `_validateRemote` returns
    // null on any `!res.ok` BEFORE the body is parsed, so the body's misleading
    // entitled:false is never read — but pin it so no future refactor reads a
    // 403 body as an authoritative verdict.
    it('treats a live-worker 403 (fail-closed) as transport failure — keeps cache, starts NO strike', async () => {
      writeLicense({ tier: 'pro', email: 'buyer@example.com', validatedAt: STALE, expiresAt: FUTURE });
      mockFetch(async () => ({ ok: false, status: 403, json: async () => ({ entitled: false, error: 'forbidden' }) }));
      expect(await tg.refresh(50)).toBe('pro');            // cached tier held, never downgraded
      const w = readWritten();
      expect(w.tier).toBe('pro');
      expect(w.validatedAt).toBe(STALE);                   // validatedAt NOT refreshed
      expect(w.notEntitledSince).toBeUndefined();          // a 403 never STARTS a two-strike
    });

    it('a 403 never ADVANCES a pending two-strike to a downgrade (a fail-closed endpoint cannot drive revocation)', async () => {
      // A 25h-old strike WOULD trigger downgrade on a 2nd *authoritative*
      // not-entitled. A 403 body carries entitled:false, but because it is
      // non-authoritative it must reset the strike (favor the holder), never
      // consume it — otherwise the fail-closed endpoint would silently revoke
      // every paid user 24h after the first 403.
      const priorStrike = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      writeLicense({ tier: 'pro', email: 'buyer@example.com', validatedAt: STALE, expiresAt: FUTURE, notEntitledSince: priorStrike });
      mockFetch(async () => ({ ok: false, status: 403, json: async () => ({ entitled: false, error: 'forbidden' }) }));
      expect(await tg.refresh(50)).toBe('pro');            // NOT downgraded despite a 25h-old strike
      const w = readWritten();
      expect(w.tier).toBe('pro');
      expect(w.notEntitledSince).toBeUndefined();          // strike reset, not advanced to downgrade
      expect(w.expiresAt).toBe(FUTURE);                    // entitlement untouched
    });

    it('treats a 401 (unauthorized) exactly like 403 — non-authoritative, strike-free, no downgrade', async () => {
      // If ENTITLEMENTS_REQUIRE_KEY is ever turned on, an unkeyed plugin gets
      // 401 instead of 403. Same rule: non-2xx → null → keep cache, no strike.
      writeLicense({ tier: 'team', email: 'buyer@example.com', validatedAt: STALE, expiresAt: FUTURE });
      mockFetch(async () => ({ ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) }));
      expect(await tg.refresh(50)).toBe('team');           // cached tier held, never downgraded
      const w = readWritten();
      expect(w.tier).toBe('team');
      expect(w.validatedAt).toBe(STALE);                   // validatedAt unchanged
      expect(w.notEntitledSince).toBeUndefined();          // no strike written
    });

    // --- Two-strike revocation (operator-ratified 2026-07-09) ---------------
    // A single authoritative not-entitled response NO LONGER downgrades; that
    // absorbs the known email-correlation false-negative window. Downgrade only
    // on the 2nd consecutive authoritative not-entitled response >=24h apart.
    const TWO_HOURS_AGO = () => new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const TWENTY_FIVE_HOURS_AGO = () => new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

    it('first not-entitled response records a strike but does NOT downgrade', async () => {
      writeLicense({ tier: 'pro', email: 'lapsed@example.com', validatedAt: STALE, expiresAt: FUTURE });
      mockFetch(async () => entitlementsResponse([], null, false));
      expect(await tg.refresh(50)).toBe('pro');            // cached tier held
      const w = readWritten();
      expect(w.tier).toBe('pro');
      expect(typeof w.notEntitledSince).toBe('string');    // strike recorded
      expect(w.validatedAt).toBe(STALE);                   // validatedAt NOT refreshed
    });

    it('second not-entitled response within 24h of the first still does NOT downgrade', async () => {
      const first = TWO_HOURS_AGO();
      writeLicense({ tier: 'pro', email: 'lapsed@example.com', validatedAt: STALE, expiresAt: FUTURE, notEntitledSince: first });
      mockFetch(async () => entitlementsResponse([], null, false));
      expect(await tg.refresh(50)).toBe('pro');
      const w = readWritten();
      expect(w.tier).toBe('pro');
      expect(w.notEntitledSince).toBe(first);              // original strike timestamp preserved
    });

    it('second not-entitled response >=24h after the first downgrades to free', async () => {
      writeLicense({ tier: 'pro', email: 'lapsed@example.com', validatedAt: STALE, expiresAt: FUTURE, notEntitledSince: TWENTY_FIVE_HOURS_AGO() });
      mockFetch(async () => entitlementsResponse([], null, false));
      expect(await tg.refresh(50)).toBe('free');
      const w = readWritten();
      expect(w.tier).toBe('free');
      expect(w.notEntitledSince).toBeUndefined();          // strike cleared on downgrade
      expect(w.expiresAt).toBeUndefined();                 // moot expiry dropped
      expect(tg.current()).toBe('free');
    });

    it('an entitled response resets a pending strike (reset-on-success)', async () => {
      writeLicense({ tier: 'pro', email: 'buyer@example.com', validatedAt: STALE, expiresAt: FUTURE, notEntitledSince: TWO_HOURS_AGO() });
      mockFetch(async () =>
        entitlementsResponse([
          { product: '4ge_pro', status: 'active', entitled: true, currentPeriodEnd: PERIOD_END_SECS },
        ])
      );
      expect(await tg.refresh(50)).toBe('pro');
      const w = readWritten();
      expect(w.tier).toBe('pro');
      expect(w.notEntitledSince).toBeUndefined();          // strike cleared
    });

    it('a contract-invalid 200 resets a pending strike, no downgrade, no validatedAt refresh', async () => {
      writeLicense({ tier: 'pro', email: 'buyer@example.com', validatedAt: STALE, expiresAt: FUTURE, notEntitledSince: TWO_HOURS_AGO() });
      mockFetch(async () => ({ ok: true, json: async () => ({ error: 'nope' }) }));
      expect(await tg.refresh(50)).toBe('pro');
      const w = readWritten();
      expect(w.tier).toBe('pro');
      expect(w.notEntitledSince).toBeUndefined();          // consecutive chain broken → reset
      expect(w.validatedAt).toBe(STALE);                   // validatedAt untouched
    });

    // --- Finding 10: malformed / contract-invalid success is not authoritative
    it('treats a malformed (unparseable) 200 like a failure — keeps cache, no strike', async () => {
      writeLicense({ tier: 'pro', email: 'buyer@example.com', validatedAt: STALE, expiresAt: FUTURE });
      mockFetch(async () => ({ ok: true, json: async () => { throw new SyntaxError('bad json'); } }));
      expect(await tg.refresh(50)).toBe('pro');
      const w = readWritten();
      expect(w.tier).toBe('pro');
      expect(w.validatedAt).toBe(STALE);                   // NOT refreshed
      expect(w.notEntitledSince).toBeUndefined();          // a malformed body is never a strike
    });

    it('treats a contract-invalid 200 (products not an array) as a failure, never not-entitled', async () => {
      writeLicense({ tier: 'team', email: 'buyer@example.com', validatedAt: STALE, expiresAt: FUTURE });
      mockFetch(async () => ({ ok: true, json: async () => ({ entitled: true, products: 'nope', status: 'active' }) }));
      expect(await tg.refresh(50)).toBe('team');           // cached tier preserved, NOT downgraded
      expect(readWritten().tier).toBe('team');
      expect(readWritten().validatedAt).toBe(STALE);
    });

    it('an entitled response with null currentPeriodEnd clears a stale stored expiry (finding 10)', async () => {
      writeLicense({ tier: 'pro', email: 'buyer@example.com', validatedAt: STALE, expiresAt: FUTURE });
      mockFetch(async () =>
        entitlementsResponse([
          { product: '4ge_pro', status: 'active', entitled: true, currentPeriodEnd: null },
        ])
      );
      expect(await tg.refresh(50)).toBe('pro');
      const w = readWritten();
      expect(w.tier).toBe('pro');
      expect(w.expiresAt).toBeUndefined();                 // stale FUTURE expiry cleared, not preserved
      expect(new Date(w.validatedAt).getTime()).toBeGreaterThan(new Date(STALE).getTime());
    });

    it('degrades to the cached tier when global fetch is unavailable', async () => {
      writeLicense({ tier: 'pro', email: 'buyer@example.com', validatedAt: STALE, expiresAt: FUTURE });
      globalThis.fetch = undefined;
      expect(await tg.refresh(50)).toBe('pro');
    });
  });

  describe('_validateRemote() / _entitlementFromSummary() internals (Phase 2)', () => {
    let originalFetch;
    beforeEach(() => { originalFetch = globalThis.fetch; });
    afterEach(() => { globalThis.fetch = originalFetch; });

    it('_entitlementFromSummary maps an entitled 4ge_pro to pro with its period end', () => {
      const out = tg._entitlementFromSummary({
        entitled: true,
        products: [{ product: '4ge_pro', status: 'active', entitled: true, currentPeriodEnd: 123 }],
      });
      expect(out).toEqual({ tier: 'pro', currentPeriodEnd: 123 });
    });

    it('_entitlementFromSummary returns free for an empty or malformed summary', () => {
      expect(tg._entitlementFromSummary(null)).toEqual({ tier: 'free', currentPeriodEnd: null });
      expect(tg._entitlementFromSummary({})).toEqual({ tier: 'free', currentPeriodEnd: null });
      expect(tg._entitlementFromSummary({ products: 'nope' })).toEqual({ tier: 'free', currentPeriodEnd: null });
    });

    it('_entitlementFromSummary ignores a product whose entitled flag is false', () => {
      const out = tg._entitlementFromSummary({
        products: [{ product: '4ge_team', status: 'canceled', entitled: false, currentPeriodEnd: 9 }],
      });
      expect(out.tier).toBe('free');
    });

    it('_isValidSummary accepts a well-formed entitlements summary', () => {
      expect(tg._isValidSummary({
        entitled: true,
        products: [{ product: '4ge_pro', status: 'active', entitled: true, currentPeriodEnd: 123 }],
        status: 'active',
      })).toBe(true);
      expect(tg._isValidSummary({ entitled: false, products: [], status: null })).toBe(true);
      // one-time product period end is null — still valid
      expect(tg._isValidSummary({
        entitled: true,
        products: [{ product: 'blueprint_pack', status: 'active', entitled: true, currentPeriodEnd: null }],
        status: 'active',
      })).toBe(true);
    });

    it('_isValidSummary rejects malformed / contract-invalid bodies', () => {
      expect(tg._isValidSummary(null)).toBe(false);
      expect(tg._isValidSummary('nope')).toBe(false);
      expect(tg._isValidSummary([])).toBe(false);                              // array, not object
      expect(tg._isValidSummary({})).toBe(false);                             // missing entitled + products
      expect(tg._isValidSummary({ entitled: true })).toBe(false);             // missing products
      expect(tg._isValidSummary({ entitled: 'yes', products: [] })).toBe(false); // entitled not boolean
      expect(tg._isValidSummary({ entitled: true, products: 'nope' })).toBe(false); // products not array
      expect(tg._isValidSummary({ entitled: true, products: [{ status: 'active' }] })).toBe(false); // product missing key + flag
      expect(tg._isValidSummary({ entitled: true, products: [{ product: '4ge_pro', entitled: true, currentPeriodEnd: 'soon' }] })).toBe(false); // bad period type
    });

    it('_validateRemote returns null on a rejected fetch (never throws to the caller)', async () => {
      globalThis.fetch = vi.fn(async () => { throw new Error('offline'); });
      expect(await tg._validateRemote({ email: 'x@example.com' }, 50)).toBeNull();
    });

    it('_validateRemote skips the network and returns null when the license has no email', async () => {
      const fetchFn = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
      globalThis.fetch = fetchFn;
      expect(await tg._validateRemote({}, 50)).toBeNull();
      expect(fetchFn).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // shouldRefresh() — the staleness+email predicate that gates out-of-band
  // re-validation (used by the SessionStart license-refresh hook to avoid
  // forking a no-op worker). Keys on staleness ALONE, never on the strike.
  // -------------------------------------------------------------------------
  describe('shouldRefresh()', () => {
    const STALE = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(); // 48h
    const FRESH = new Date().toISOString();

    it('returns false for a null / non-object license', () => {
      expect(tg.shouldRefresh(null)).toBe(false);
      expect(tg.shouldRefresh(undefined)).toBe(false);
      expect(tg.shouldRefresh('nope')).toBe(false);
    });

    it('returns false when the license carries no email (endpoint is email-keyed)', () => {
      expect(tg.shouldRefresh({ tier: 'pro', validatedAt: STALE })).toBe(false);
      expect(tg.shouldRefresh({ tier: 'pro', email: '   ', validatedAt: STALE })).toBe(false);
    });

    it('returns false when a licensed email is fresh (<24h)', () => {
      expect(tg.shouldRefresh({ tier: 'pro', email: 'a@b.com', validatedAt: FRESH })).toBe(false);
    });

    it('returns true when a licensed email is stale (>24h)', () => {
      expect(tg.shouldRefresh({ tier: 'pro', email: 'a@b.com', validatedAt: STALE })).toBe(true);
    });

    it('returns true when validatedAt is absent (never validated)', () => {
      expect(tg.shouldRefresh({ tier: 'pro', email: 'a@b.com' })).toBe(true);
    });

    it('returns true when validatedAt is unparseable (treated as stale)', () => {
      expect(tg.shouldRefresh({ tier: 'pro', email: 'a@b.com', validatedAt: 'not-a-date' })).toBe(true);
    });

    it('still fires while a two-strike revocation is pending (staleness, not the strike)', () => {
      // A first strike deliberately leaves validatedAt stale so the next session
      // re-checks; shouldRefresh must keep returning true so the 24h strike
      // clock can elapse. It must not be silenced by notEntitledSince.
      const pendingStrike = {
        tier: 'pro', email: 'lapsed@b.com', validatedAt: STALE,
        notEntitledSince: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      };
      expect(tg.shouldRefresh(pendingStrike)).toBe(true);
    });

    it('honors an injected clock at the 24h boundary', () => {
      const base = Date.parse('2026-01-10T00:00:00.000Z');
      const validatedAt = new Date(base).toISOString();
      expect(tg.shouldRefresh({ email: 'a@b.com', validatedAt }, base + 23 * 60 * 60 * 1000)).toBe(false);
      expect(tg.shouldRefresh({ email: 'a@b.com', validatedAt }, base + 25 * 60 * 60 * 1000)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // CLI entry (require.main === module) — the explicit `--refresh` subcommand
  // AND the worker the SessionStart hook spawns. Exercised as a real subprocess
  // with an isolated HOME (no license → free) and an unreachable endpoint, so
  // it stays deterministic and never egresses.
  // -------------------------------------------------------------------------
  describe('CLI entry', () => {
    const tierGatePath = require.resolve('../tier-gate.cjs');
    let cliHome;

    beforeEach(() => { cliHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-gate-cli-')); });
    afterEach(() => { try { fs.rmSync(cliHome, { recursive: true, force: true }); } catch { /* ok */ } });

    function runCli(args) {
      return execFileSync(process.execPath, [tierGatePath, ...args], {
        env: {
          HOME: cliHome,
          USERPROFILE: cliHome,
          PATH: process.env.PATH || '',
          // Unreachable — guarantees no real egress even if logic changed.
          FORGE_LICENSE_ENDPOINT: 'http://127.0.0.1:1/nope',
        },
        timeout: 15000,
        encoding: 'utf8',
      });
    }

    it('`--refresh` prints the resolved tier and exits 0 (no license → free, no network)', () => {
      expect(runCli(['--refresh']).trim()).toBe('free');
    });

    it('a bare invocation prints the current cached tier and exits 0', () => {
      expect(runCli([]).trim()).toBe('free');
    });

    it('`--refresh` returns a cached fresh tier without a network round-trip (offline-safe)', () => {
      const dir = path.join(cliHome, '.4ge');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'license.json'), JSON.stringify({
        tier: 'pro',
        email: 'buyer@example.com',
        validatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      }));
      expect(runCli(['--refresh']).trim()).toBe('pro');
    });
  });
});
