'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TIER_ORDER = ['free', 'pro', 'team'];

const PRO_GATED = [
  'forge', 'dfe', 'audit', 'autoresearch', 'outhouse', 'wizard',
  'export', 'substrate', 'studio', 'blueprint', 'ship', 'commit',
  'pr', 'aisle', 'hitchhiker', 'evolve', 'lint', 'lounge',
  'signoff', 'releases', 'respawn', 'decide', 'constraint', 'infra',
];

const DESCRIPTIONS = {
  forge:       'Forge orchestrates multi-agent teams through a 7-phase pipeline: scope, brainstorm, spec, plan, execute, review, ship.',
  dfe:         'DFE runs 5 domain passes plus 1 adversarial pass on every change, surfacing bugs that single-pass reviewers overlook.',
  audit:       'Audit runs 70 checks across 10 domains to score your codebase against production-readiness criteria.',
  autoresearch: 'Autoresearch runs self-improving measurement loops that surface gaps and track domain knowledge over time.',
  outhouse:    'Outhouse is the repository maintenance wizard — cleans orphans, resolves conflicts, and reports technical debt.',
  wizard:      'Wizard launches guided configuration suites for complex 4ge setup tasks.',
  export:      'Export packages session work as a business-ready deliverable: brief, deck, or handoff document.',
  substrate:   'Substrate renders text and OS state through Unicode combining marks, Math Alphanumerics, and block elements.',
  studio:      'Studio Mode activates the full HUD engine with reactive hooks and badge tracking.',
  blueprint:   'Blueprint bootstraps or updates a Claude Code environment from templates.',
  ship:        'Ship runs tsc + eslint + vitest, commits, and pushes — the full delivery pipeline.',
  commit:      'Commit redirects to /ship; use /ship --no-push to commit without pushing.',
  pr:          'PR verifies, commits, pushes, and opens a pull request.',
  aisle:       'AISLE reports security posture and routes scans; the old fail-closed 9-scanner gate is shelved until ADR criteria are met.',
  hitchhiker:  'Hitchhiker searches persistent memory and reports hub status; the old seed/update pipeline is retired.',
  evolve:      'Evolve analyzes usage telemetry and suggests config improvements.',
  lint:        'Lint shows rule follow-through rates and flags under-followed rules for demotion.',
  lounge:      'Lounge enables mouse-free minimal-effort coding mode — every decision is numbered.',
  signoff:     'Signoff produces a structured sign-off for completed work.',
  releases:    'Releases shows recent release notes from shipped sessions.',
  respawn:     'Respawn extracts the decision chain and prepares a fresh Claude instance with full context.',
  decide:      'Decide logs a decision to the DCD enrichment file for context continuity.',
  constraint:  'Constraint logs a dead-end to the DCD enrichment file so future instances avoid the same path.',
  infra:       'Infra monitors Docker container health and provides one-command healing.',
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
    `  Upgrade: https://4ge.dev/pro\n` +
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
  _resolveTier,
  _readLicense,
};
