'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TIER_ORDER = ['free', 'pro', 'team'];

// 11 entries: multi-agent machinery, professional judgment surfaces,
// business artifacts, and their redirect stubs. Redirects inherit target tier
// (maintain -> /outhouse).
const PRO_GATED = [
  'forge', 'dfe', 'audit', 'aisle',
  'outhouse', 'wizard', 'maintain',       // maintain -> /outhouse (redirect inherits)
  'autoresearch', 'evolve', 'export',
  'respawn',
];

// Upgrade-prompt copy for the 11 gated commands. Keys must equal PRO_GATED
// members exactly — ungated commands have no entry (require_() falls back to a
// safe generic string). Tested by tier-gate.test.js.
const DESCRIPTIONS = {
  forge:       'Forge orchestrates multi-agent teams through a 7-phase pipeline: scope, brainstorm, spec, plan, execute, review, ship.',
  dfe:         'DFE runs 5 domain passes plus 1 adversarial pass on every change, surfacing bugs that single-pass reviewers overlook.',
  audit:       'Audit runs 70 checks across 10 domains to score your codebase against production-readiness criteria.',
  aisle:       'AISLE reports security posture and routes scans; the old fail-closed 9-scanner gate is shelved until ADR criteria are met.',
  outhouse:    'Outhouse is the repository maintenance wizard — cleans orphans, resolves conflicts, and reports technical debt.',
  wizard:      'Wizard launches guided configuration suites for complex 4ge setup tasks.',
  maintain:    'Maintain redirects to /outhouse — the repository maintenance wizard.',
  autoresearch: 'Autoresearch runs self-improving measurement loops that surface gaps and track domain knowledge over time.',
  evolve:      'Evolve analyzes usage telemetry and suggests config improvements.',
  export:      'Export packages session work as a business-ready deliverable: brief, deck, or handoff document.',
  respawn:     'Respawn extracts the decision chain and prepares a fresh Claude instance with full context.',
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const STALE_THRESHOLD_MS = MS_PER_DAY;        // >24h since validatedAt triggers refresh attempt
const DEFAULT_GRACE_DAYS = 7;
const REMOTE_TIMEOUT_MS = 3000;               // hard cap on the license-worker call

// Live license-worker entitlement oracle. Email-keyed:
//   GET /v1/entitlements?email= ->
//     { entitled, products:[{product,status,entitled,currentPeriodEnd}], status }
// Product keys 4ge_pro / 4ge_team map to the pro / team tiers. Override the base
// for tests or self-hosting via FORGE_LICENSE_ENDPOINT.
const DEFAULT_LICENSE_ENDPOINT =
  'https://license-worker.zmbhhvhmdy.workers.dev/v1/entitlements';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _licensePath() {
  // Resolved dynamically so os.homedir() mocks work in tests
  return path.join(os.homedir(), '.4ge', 'license.json');
}

function _tierIndex(tier) {
  const idx = TIER_ORDER.indexOf(tier);
  return idx === -1 ? 0 : idx;
}

function _readLicense() {
  try {
    const raw = fs.readFileSync(_licensePath(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function _writeLicense(license) {
  const p = _licensePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(license, null, 2), 'utf8');
}

function _endpoint() {
  return process.env.FORGE_LICENSE_ENDPOINT || DEFAULT_LICENSE_ENDPOINT;
}

// Map a license-worker entitlement summary to a 4ge tier + the subscription's
// period end. Precedence: an entitled 4ge_team beats an entitled 4ge_pro; any
// non-4ge product (dropstream_streamer, blueprint_pack) is ignored.
function _entitlementFromSummary(summary) {
  const out = { tier: 'free', currentPeriodEnd: null };
  const products = summary && Array.isArray(summary.products) ? summary.products : [];
  const entitled = products.filter((p) => p && p.entitled === true);
  const chosen =
    entitled.find((p) => p.product === '4ge_team') ||
    entitled.find((p) => p.product === '4ge_pro') ||
    null;
  if (!chosen) return out;
  out.tier = chosen.product === '4ge_team' ? 'team' : 'pro';
  out.currentPeriodEnd =
    typeof chosen.currentPeriodEnd === 'number' ? chosen.currentPeriodEnd : null;
  return out;
}

// Contract-validate a license-worker entitlements response. The worker's
// EntitlementSummary shape is:
//   { entitled: boolean,
//     products: [{ product: string, status: string,
//                  entitled: boolean, currentPeriodEnd: number|null }],
//     status: string|null }
// A parseable-but-contract-invalid HTTP 200 (an error body, a wrong-shape
// object, products missing or not an array, a product lacking its key/flag)
// must NOT be read as an authoritative not-entitled verdict — it is treated
// like a transport failure so a downgrade can only ever follow a well-formed
// response. `status` and per-product `status` are advisory (unused by the tier
// decision) so they are tolerated absent; the load-bearing fields are checked.
function _isValidSummary(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return false;
  if (typeof s.entitled !== 'boolean') return false;
  if (!Array.isArray(s.products)) return false;
  for (const p of s.products) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
    if (typeof p.product !== 'string') return false;
    if (typeof p.entitled !== 'boolean') return false;
    if (!(p.currentPeriodEnd === null
          || p.currentPeriodEnd === undefined
          || typeof p.currentPeriodEnd === 'number')) return false;
  }
  return true;
}

// Phase 2: resolve the live entitlement for this license's email against the
// deployed license-worker. Async + hard-timeout-bounded. Returns the parsed
// { tier, currentPeriodEnd } on a successful AUTHORITATIVE + contract-valid
// response (entitled or not), or null on ANY non-authoritative outcome
// (unreachable, timeout, non-2xx, unparseable, contract-invalid) so the caller
// keeps the cached tier — neither a network failure nor a malformed 200 may
// downgrade a valid license.
async function _validateRemote(license, timeoutMs = REMOTE_TIMEOUT_MS) {
  if (typeof fetch !== 'function') return null;   // pre-fetch node — degrade to cache
  const email =
    license && typeof license.email === 'string' ? license.email.trim() : '';
  if (!email) return null;                        // endpoint is email-keyed; nothing to ask
  const url = `${_endpoint()}?email=${encodeURIComponent(email)}`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: globalThis.AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    let body;
    try {
      body = await res.json();
    } catch {
      return null;                                // unparseable 200 — treat as failure
    }
    if (!_isValidSummary(body)) return null;      // contract-invalid 200 — treat as failure
    return _entitlementFromSummary(body);
  } catch {
    return null;                                  // timeout / network — keep cache
  }
}

function _resolveTier() {
  // Dev override (logged to stderr, dev-only)
  if (process.env.FORGE_TIER_OVERRIDE) {
    const override = process.env.FORGE_TIER_OVERRIDE;
    if (TIER_ORDER.includes(override)) {
      process.stderr.write(
        `[tier-gate] FORGE_TIER_OVERRIDE=${override} — dev override active\n`
      );
      return override;
    }
  }

  const license = _readLicense();

  if (!license) {
    return 'free';
  }

  const now = Date.now();
  const expiresAt = license.expiresAt ? new Date(license.expiresAt).getTime() : null;
  const graceDays = typeof license.offlineGraceDays === 'number'
    ? license.offlineGraceDays
    : DEFAULT_GRACE_DAYS;

  // Check if expired
  if (expiresAt && now > expiresAt) {
    const daysPastExpiry = (now - expiresAt) / MS_PER_DAY;
    if (daysPastExpiry <= graceDays) {
      // Within grace window — still allow cached tier
      return license.tier || 'free';
    }
    // Past grace window
    return 'free';
  }

  // Whether fresh or stale, the synchronous resolver returns the cached tier and
  // never blocks on the network. Stale caches are re-validated out-of-band by
  // the async refresh() below — the only path that may rewrite the cache or
  // downgrade a license.
  return license.tier || 'free';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * check(requiredTier) — returns { allowed, currentTier, reason }
 */
function check(requiredTier) {
  const currentTier = _resolveTier();
  const currentIdx = _tierIndex(currentTier);
  const requiredIdx = _tierIndex(requiredTier);
  const allowed = currentIdx >= requiredIdx;

  const reason = allowed
    ? `Current tier '${currentTier}' meets requirement '${requiredTier}'`
    : `Current tier '${currentTier}' does not meet requirement '${requiredTier}'`;

  return { allowed, currentTier, reason };
}

/**
 * require(requiredTier, commandName?) — returns true or prints upgrade message and returns false
 */
function require_(requiredTier, commandName) {
  const result = check(requiredTier);

  if (result.allowed) {
    return true;
  }

  const cmd = commandName || 'this command';
  const price = requiredTier === 'team' ? '$39/seat/mo' : '$19/mo';
  const description = DESCRIPTIONS[cmd] || `/${cmd} is a Pro feature.`;

  process.stderr.write(
    `\n  /${cmd} requires Pro (${price})\n\n` +
    `  ${description}\n\n` +
    `  Upgrade: https://3sixtyco.dev/4ge\n` +
    `  Trial:   FORGE_LICENSE_KEY=trial-xxx (7 days)\n\n`
  );

  return false;
}

/**
 * current() — returns 'free'|'pro'|'team'
 */
function current() {
  return _resolveTier();
}

/**
 * info() — returns { tier, expiresAt, daysRemaining, licensedTo } or null
 */
function info() {
  const license = _readLicense();

  if (!license) {
    return null;
  }

  const now = Date.now();
  const expiresAt = license.expiresAt || null;
  let daysRemaining = null;

  if (expiresAt) {
    const ms = new Date(expiresAt).getTime() - now;
    daysRemaining = Math.max(0, Math.ceil(ms / MS_PER_DAY));
  }

  return {
    tier: license.tier || 'free',
    expiresAt,
    daysRemaining,
    licensedTo: license.email || null,
  };
}

/**
 * refresh(timeoutMs?) — async re-validation against the live license-worker.
 *
 * The synchronous gate (check/current/require) is cache-only and never blocks
 * on the network. `refresh()` is the ONLY path that may rewrite the cache or
 * downgrade a license. It is intentionally NOT wired into any command path yet
 * (no `await refresh()` at any gate); the two-strike precondition below is the
 * bar that must be satisfied before an owned async boundary lands. Only hits
 * the network when the cached license is STALE (>24h since validatedAt),
 * matching _resolveTier's design.
 *
 * Outcomes:
 *  - non-authoritative (unreachable / timeout / non-2xx / unparseable /
 *    contract-invalid 200): never downgrade, never refresh validatedAt; clear a
 *    pending revocation strike (the "consecutive" chain is broken).
 *  - authoritative + entitled: set tier + validatedAt, clear any strike, and set
 *    expiry DELIBERATELY from currentPeriodEnd — a null period end clears a stale
 *    stored expiry rather than silently preserving it.
 *  - authoritative + not-entitled: TWO-STRIKE revocation. The first such
 *    response records a strike (no downgrade); a downgrade to free happens only
 *    on the second consecutive authoritative not-entitled response landing >=24h
 *    after the first (operator-ratified 2026-07-09). This absorbs the known
 *    email-correlation false-negative window without an indefinite lockout.
 *
 * Never throws.
 *
 * @returns {Promise<'free'|'pro'|'team'>}
 */
async function refresh(timeoutMs = REMOTE_TIMEOUT_MS) {
  const license = _readLicense();
  if (!license) {
    return 'free';
  }

  const now = Date.now();
  const validatedAt = license.validatedAt
    ? new Date(license.validatedAt).getTime()
    : null;
  const isStale = !validatedAt || now - validatedAt > STALE_THRESHOLD_MS;
  if (!isStale) {
    return _resolveTier();
  }

  const ent = await _validateRemote(license, timeoutMs);

  // Non-authoritative: unreachable / timeout / non-2xx / unparseable /
  // contract-invalid. Never downgrade, never refresh validatedAt. A pending
  // strike depends on CONSECUTIVE authoritative not-entitled responses, so a
  // gap resets it (favor the license holder).
  if (ent === null) {
    if (license.notEntitledSince) {
      const cleared = { ...license };
      delete cleared.notEntitledSince;
      try { _writeLicense(cleared); } catch { /* read-only home — resolves next run */ }
    }
    return _resolveTier();
  }

  // Authoritative + entitled — trust it. Clear any strike, refresh validatedAt,
  // and set expiry DELIBERATELY: a numeric currentPeriodEnd becomes the expiry;
  // a null one CLEARS any stale stored expiry (never silently preserved).
  if (ent.tier !== 'free') {
    const updated = { ...license, tier: ent.tier, validatedAt: new Date(now).toISOString() };
    delete updated.notEntitledSince;
    if (typeof ent.currentPeriodEnd === 'number') {
      updated.expiresAt = new Date(ent.currentPeriodEnd * 1000).toISOString();
    } else {
      delete updated.expiresAt;
    }
    try { _writeLicense(updated); } catch { /* read-only home — resolves next run */ }
    return ent.tier;
  }

  // Authoritative + not-entitled — two-strike revocation.
  const firstStrike = license.notEntitledSince
    ? new Date(license.notEntitledSince).getTime()
    : null;

  if (firstStrike === null || Number.isNaN(firstStrike)) {
    // First strike — record it, hold the cached tier, and leave validatedAt
    // stale so the next run re-checks and the 24h clock can elapse.
    const struck = { ...license, notEntitledSince: new Date(now).toISOString() };
    try { _writeLicense(struck); } catch { /* read-only home — resolves next run */ }
    return license.tier || 'free';
  }

  if (now - firstStrike >= STALE_THRESHOLD_MS) {
    // Second strike >=24h after the first — revoke. Confirm free, clear the
    // strike, refresh validatedAt, drop the now-moot expiry.
    const downgraded = { ...license, tier: 'free', validatedAt: new Date(now).toISOString() };
    delete downgraded.notEntitledSince;
    delete downgraded.expiresAt;
    try { _writeLicense(downgraded); } catch { /* read-only home — resolves next run */ }
    return 'free';
  }

  // Second strike too soon (<24h after the first) — hold the cached tier and
  // keep the original strike timestamp so the clock runs from the first strike.
  return license.tier || 'free';
}

/**
 * shouldRefresh(license) — pure predicate: is an out-of-band re-validation
 * warranted for this cached license right now?
 *
 * True only when a license exists, carries an email (the worker endpoint is
 * email-keyed — a license without one can never be validated), AND its
 * validatedAt is missing or older than STALE_THRESHOLD_MS (24h). This mirrors
 * refresh()'s own internal staleness gate plus _validateRemote's email
 * precondition, so a caller can cheaply skip spawning a worker that would
 * no-op. refresh() re-checks staleness itself, so this is an optimization, not
 * a correctness dependency — and it keys on staleness ALONE (never on
 * notEntitledSince), so a pending two-strike revocation still re-fires each
 * session until its 24h clock elapses (a first strike deliberately leaves
 * validatedAt stale, so shouldRefresh keeps returning true across sessions).
 *
 * @param {object|null} license  parsed ~/.4ge/license.json (or null)
 * @param {number} [now]         injectable clock for tests
 * @returns {boolean}
 */
function shouldRefresh(license, now = Date.now()) {
  if (!license || typeof license !== 'object') return false;
  const email = typeof license.email === 'string' ? license.email.trim() : '';
  if (!email) return false;
  const validatedAt = license.validatedAt ? new Date(license.validatedAt).getTime() : null;
  return !validatedAt || Number.isNaN(validatedAt) || now - validatedAt > STALE_THRESHOLD_MS;
}

module.exports = {
  check,
  require: require_,
  current,
  info,
  refresh,
  shouldRefresh,
  PRO_GATED,
  // Exported for testing
  DESCRIPTIONS,
  _resolveTier,
  _readLicense,
  _validateRemote,
  _entitlementFromSummary,
  _isValidSummary,
};

// ---------------------------------------------------------------------------
// CLI entry — `node tier-gate.cjs --refresh` awaits a live re-validation and
// prints the resolved tier; a bare invocation prints the current cached tier.
// This is BOTH the explicit on-demand refresh subcommand AND the worker the
// SessionStart license-refresh hook spawns (detached). It calls refresh() /
// current() directly, so it never re-enters any spawn path — no recursion
// guard is needed. Never throws; always exits 0.
// ---------------------------------------------------------------------------
if (require.main === module) {
  if (process.argv.includes('--refresh')) {
    refresh()
      .then((tier) => { process.stdout.write(`${tier}\n`); })
      .catch(() => { /* offline / error — refresh() left the cache untouched */ })
      .finally(() => process.exit(0));
  } else {
    try { process.stdout.write(`${current()}\n`); } catch { /* ignore */ }
    process.exit(0);
  }
}
