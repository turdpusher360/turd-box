'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TIER_ORDER = ['free', 'pro', 'team'];

// 12 entries: multi-agent machinery, professional judgment surfaces,
// business artifacts, and their redirect stubs. Redirects inherit target tier
// (maintain -> /outhouse, resp4wn -> /respawn).
const PRO_GATED = [
  'forge', 'dfe', 'audit', 'aisle',
  'outhouse', 'wizard', 'maintain',       // maintain -> /outhouse (redirect inherits)
  'autoresearch', 'evolve', 'export',
  'respawn', 'resp4wn',                   // resp4wn -> /respawn (redirect inherits)
];

// Upgrade-prompt copy for the 12 gated commands. Keys must equal PRO_GATED
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
  resp4wn:     'Legacy spelling of /respawn — Context Respawn.',
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const STALE_THRESHOLD_MS = MS_PER_DAY;        // >24h since validatedAt triggers refresh attempt
const DEFAULT_GRACE_DAYS = 7;

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

// Phase 1 stub: always returns cached tier (Phase 2 adds real server call)
function _validateRemote(license) {
  return license ? license.tier : 'free';
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
  const validatedAt = license.validatedAt ? new Date(license.validatedAt).getTime() : null;
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

  // Check if stale (>24h since validation) — attempt refresh
  if (validatedAt && (now - validatedAt) > STALE_THRESHOLD_MS) {
    const refreshedTier = _validateRemote(license);
    return refreshedTier || license.tier || 'free';
  }

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

module.exports = {
  check,
  require: require_,
  current,
  info,
  PRO_GATED,
  // Exported for testing
  DESCRIPTIONS,
  _resolveTier,
  _readLicense,
};
