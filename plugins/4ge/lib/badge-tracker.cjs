'use strict';

const fs = require('fs');
const path = require('path');

// --- Paths ---
// CLAUDE_PLUGIN_DATA persists across plugin version bumps; PLUGIN_ROOT is version-scoped
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
const DATA_DIR    = process.env.CLAUDE_PLUGIN_DATA || path.join(PLUGIN_ROOT, '.data');
const BADGES_FILE = path.join(DATA_DIR, 'badges.json');

// Zone modules the HUD renders — used by zone-builder + all-zones checks
const EXPECTED_ZONE_FILES = [
  'hud-zone-health.cjs',
  'hud-zone-face.cjs',
  'hud-zone-context.cjs',
  'hud-zone-forge.cjs',
  'hud-zone-caps.cjs',
  'hud-zone-badges.cjs',
  'hud-zone-session.cjs',
];

// Default empty badge state
function emptyState() {
  return { earned: {}, newThisSession: [] };
}

// --- Load / Save ---

function loadBadgeState(filePath) {
  const fp = filePath || BADGES_FILE;
  try {
    const raw = fs.readFileSync(fp, 'utf8');
    const data = JSON.parse(raw);
    return {
      earned: (data.earned && typeof data.earned === 'object') ? data.earned : {},
      newThisSession: Array.isArray(data.newThisSession) ? data.newThisSession : [],
    };
  } catch {
    return emptyState();
  }
}

function saveBadgeState(state, filePath) {
  const fp = filePath || BADGES_FILE;
  try {
    const dir = path.dirname(fp);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(state, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

// --- Earn ---

/**
 * Marks a badge as earned if not already earned.
 * Mutates badgeState in place.
 * Returns true if newly earned, false if already earned.
 */
function earnBadge(badgeState, badgeId) {
  if (badgeState.earned[badgeId]) return false;
  badgeState.earned[badgeId] = new Date().toISOString();
  if (!badgeState.newThisSession.includes(badgeId)) {
    badgeState.newThisSession.push(badgeId);
  }
  return true;
}

// --- Individual Badge Checks ---
// Each returns true if condition met. Designed to be fast (file existence / glob counts).
// Never throws — always returns false on error.

/**
 * forge-master: 5+ forge session HANDOFF files in _runs/
 */
function checkForgeMaster(ctx) {
  try {
    const runsDir = ctx.runsDir || path.resolve(process.cwd(), '_runs');
    if (!fs.existsSync(runsDir)) return false;
    const entries = fs.readdirSync(runsDir);
    const count = entries.filter(e => e.startsWith('HANDOFF-') && e.endsWith('.md')).length;
    return count >= 5;
  } catch {
    return false;
  }
}

/**
 * audit-clean: Last audit directory has a report with 0 P0 findings.
 * Reads _runs/audit/<latest-date>/ for files containing "P0" with count 0.
 */
function checkAuditClean(ctx) {
  try {
    const auditDir = ctx.auditDir || path.resolve(process.cwd(), '_runs/audit');
    if (!fs.existsSync(auditDir)) return false;

    const dateDirs = fs.readdirSync(auditDir)
      .filter(e => /^\d{4}-\d{2}-\d{2}$/.test(e))
      .sort()
      .reverse();

    if (dateDirs.length === 0) return false;

    const latestDir = path.join(auditDir, dateDirs[0]);
    const reports = fs.readdirSync(latestDir).filter(f => f.endsWith('.md') || f.endsWith('.json'));
    if (reports.length === 0) return false;

    // Look for any report that explicitly states 0 P0 findings
    for (const report of reports) {
      try {
        const content = fs.readFileSync(path.join(latestDir, report), 'utf8');
        // Match patterns like "P0: 0", "P0 findings: 0", "0 P0", "P0 count: 0"
        if (/\bP0\b.*\b0\b|\b0\b.*\bP0\b|P0 findings.*:\s*0|"p0":\s*0/i.test(content)) {
          return true;
        }
      } catch { /* skip unreadable */ }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * full-deploy: Git log has at least one commit mentioning /ship or /commit.
 * Reads the git log from _runs/ marker or falls back to a quick log scan approach.
 */
function checkFullDeploy(ctx) {
  try {
    // Check for a marker file written by the ship workflow
    const markerPath = ctx.deployMarker || path.resolve(process.cwd(), '_runs/.last-ship');
    if (fs.existsSync(markerPath)) return true;

    // Fallback: scan recent git COMMIT_EDITMSG files in .git/
    const repoRoot = ctx.repoRoot || process.cwd();
    const commitMsgPath = path.join(repoRoot, '.git', 'COMMIT_EDITMSG');
    if (!fs.existsSync(commitMsgPath)) return false;

    // Only read the most recent commit message
    const msg = fs.readFileSync(commitMsgPath, 'utf8');
    return /\/ship|\/commit/i.test(msg);
  } catch {
    return false;
  }
}

/**
 * zone-builder: All 7 expected zone module files exist in plugins/4ge/bin/
 */
function checkZoneBuilder(ctx) {
  try {
    const binDir = ctx.binDir || path.join(PLUGIN_ROOT, 'bin');
    return EXPECTED_ZONE_FILES.every(f => fs.existsSync(path.join(binDir, f)));
  } catch {
    return false;
  }
}

/**
 * test-green: Last vitest run had 0 failures.
 * Checks for a JSON test result marker in _runs/ or .data/
 */
function checkTestGreen(ctx) {
  try {
    // Check for vitest JSON output marker (written by post-test hook or manually)
    const markerPath = ctx.testMarker || path.resolve(process.cwd(), '_runs/.last-test-result.json');
    if (!fs.existsSync(markerPath)) return false;

    const data = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    // Supports { failures: 0, passed: N } or { numFailedTests: 0 }
    const failures = data.failures ?? data.numFailedTests ?? data.failed ?? null;
    return failures !== null && Number(failures) === 0;
  } catch {
    return false;
  }
}

/**
 * export-ready: 3+ files in H:/Dropbox/BizOps/ matching session export patterns.
 * Pattern: files modified in the last 30 days that look like session deliverables.
 */
function checkExportReady(ctx) {
  try {
    const exportDir = ctx.exportDir || 'H:/Dropbox/BizOps';
    if (!fs.existsSync(exportDir)) return false;

    const cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);
    const entries = fs.readdirSync(exportDir);

    // Session deliverables: .md, .pdf, .zip, .png, .json files
    const exportExts = new Set(['.md', '.pdf', '.zip', '.png', '.json', '.txt']);
    let count = 0;

    for (const entry of entries) {
      const ext = path.extname(entry).toLowerCase();
      if (!exportExts.has(ext)) continue;
      try {
        const stat = fs.statSync(path.join(exportDir, entry));
        if (stat.isFile() && stat.mtimeMs >= cutoff) count++;
      } catch { /* skip */ }
    }

    return count >= 3;
  } catch {
    return false;
  }
}

/**
 * studio-mode: Meta-badge. All required zones present AND companion-v2 earned.
 * Avoids circular dep — reads badge state passed in.
 */
function checkStudioMode(ctx, badgeState) {
  try {
    const zonesOk = checkZoneBuilder(ctx);
    const companionEarned = !!(badgeState && badgeState.earned && badgeState.earned['companion-v2']);
    return zonesOk && companionEarned;
  } catch {
    return false;
  }
}

/**
 * all-zones: Same zone file check as zone-builder (render success not detectable at rest).
 * Kept separate so the badge represents a distinct milestone if criteria diverge later.
 */
function checkAllZones(ctx) {
  return checkZoneBuilder(ctx);
}

/**
 * companion-v2: expression resolver has 6+ distinct rule names wired.
 */
function checkCompanionV2(ctx) {
  try {
    const expressionsPath = ctx.expressionsPath ||
      path.join(PLUGIN_ROOT, 'bin', 'hud-expressions.cjs');
    if (!fs.existsSync(expressionsPath)) return false;

    // Clear from require cache so we always read current state
    delete require.cache[require.resolve(expressionsPath)];
    const { EXPRESSION_RULES, getExpressionName } = require(expressionsPath);
    if (!Array.isArray(EXPRESSION_RULES)) return false;
    if (typeof getExpressionName !== 'function') return false;

    const names = new Set(
      EXPRESSION_RULES
        .map(rule => rule && rule.expr)
        .filter(expr => typeof expr === 'string' && expr.length > 0)
    );
    return names.size >= 6;
  } catch {
    return false;
  }
}

/**
 * memory-keeper: Memory hub has 50+ stored memories.
 * Reads from a stats snapshot file written by the memory MCP or a session hook.
 */
function checkMemoryKeeper(ctx) {
  try {
    const statsPath = ctx.memoryStatsPath ||
      path.resolve(process.cwd(), '_runs/.memory-stats.json');
    if (!fs.existsSync(statsPath)) return false;

    const data = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
    // Supports { total: N } or { count: N } or { total_memories: N }
    const total = data.total ?? data.count ?? data.total_memories ?? null;
    return total !== null && Number(total) >= 50;
  } catch {
    return false;
  }
}

// --- Badge check registry ---
// Maps badge id -> check function (ctx, badgeState) -> boolean
const BADGE_CHECKS = {
  'forge-master':  (ctx, _state) => checkForgeMaster(ctx),
  'audit-clean':   (ctx, _state) => checkAuditClean(ctx),
  'full-deploy':   (ctx, _state) => checkFullDeploy(ctx),
  'zone-builder':  (ctx, _state) => checkZoneBuilder(ctx),
  'test-green':    (ctx, _state) => checkTestGreen(ctx),
  'export-ready':  (ctx, _state) => checkExportReady(ctx),
  'studio-mode':   (ctx, state)  => checkStudioMode(ctx, state),
  'all-zones':     (ctx, _state) => checkAllZones(ctx),
  'companion-v2':  (ctx, _state) => checkCompanionV2(ctx),
  'memory-keeper': (ctx, _state) => checkMemoryKeeper(ctx),
};

// --- Main API ---

/**
 * checkBadges(sessionContext, options)
 *
 * Evaluates all 10 badge conditions against the current environment.
 * Auto-earns any newly qualifying badges and persists state.
 *
 * sessionContext: optional object with path overrides for testing:
 *   { runsDir, auditDir, binDir, exportDir, deployMarker, testMarker,
 *     repoRoot, expressionsPath, memoryStatsPath }
 *
 * options: { filePath, dryRun }
 *   filePath — override badge state file path (default: .data/badges.json)
 *   dryRun   — if true, compute but do not save
 *
 * Returns { badgeState, newlyEarned: string[] }
 */
function checkBadges(sessionContext, options) {
  const ctx = sessionContext || {};
  const opts = options || {};
  const filePath = opts.filePath || BADGES_FILE;

  const badgeState = loadBadgeState(filePath);
  const newlyEarned = [];

  for (const [badgeId, checkFn] of Object.entries(BADGE_CHECKS)) {
    // Skip already-earned badges
    if (badgeState.earned[badgeId]) continue;

    let earned = false;
    try {
      earned = checkFn(ctx, badgeState);
    } catch {
      earned = false;
    }

    if (earned) {
      earnBadge(badgeState, badgeId);
      newlyEarned.push(badgeId);
    }
  }

  if (!opts.dryRun && newlyEarned.length > 0) {
    saveBadgeState(badgeState, filePath);
  }

  return { badgeState, newlyEarned };
}

/**
 * getBadgeState(options)
 *
 * Returns current badge state without running checks.
 * Used by the HUD engine render path.
 *
 * options: { filePath }
 */
function getBadgeState(options) {
  const opts = options || {};
  return loadBadgeState(opts.filePath || BADGES_FILE);
}

module.exports = {
  // Main API
  checkBadges,
  getBadgeState,

  // Persistence
  loadBadgeState,
  saveBadgeState,
  earnBadge,

  // Individual checks (exported for testing)
  checkForgeMaster,
  checkAuditClean,
  checkFullDeploy,
  checkZoneBuilder,
  checkTestGreen,
  checkExportReady,
  checkStudioMode,
  checkAllZones,
  checkCompanionV2,
  checkMemoryKeeper,

  // Internals (exported for testing)
  BADGES_FILE,
  BADGE_CHECKS,
  EXPECTED_ZONE_FILES,
  emptyState,
};
