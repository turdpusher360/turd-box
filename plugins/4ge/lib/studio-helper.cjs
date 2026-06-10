'use strict';

const fs = require('fs');
const path = require('path');

// --- Paths ---
const REPO_ROOT = process.cwd();
const OS_DIR = path.join(REPO_ROOT, '_runs', 'os');
const DATA_DIR = path.join(__dirname, '..', '.data');

const BOOT_STATUS_FILE = path.join(OS_DIR, 'boot-status.json');
const HEALTH_FILE = path.join(OS_DIR, 'health.json');
const BADGES_FILE = path.join(DATA_DIR, 'badges.json');
const HUD_CONTEXT_FILE = path.join(OS_DIR, 'hud-context.json');
const STUDIO_MODE_FILE = path.join(OS_DIR, 'studio-mode.json');

// --- Safe JSON read ---
function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

// --- Ensure directory exists ---
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Build the full HUD state object for studio mode.
 * Merges OS state files, badge state, and forge context into canonical state.
 * @returns {object} Canonical state with mode:'full' and context.trigger:'studio'
 */
function buildStudioState() {
  const bootStatus = readJsonSafe(BOOT_STATUS_FILE, {});
  const health = readJsonSafe(HEALTH_FILE, {});
  const badgeData = readJsonSafe(BADGES_FILE, { earned: {}, newThisSession: [] });
  const hudContext = readJsonSafe(HUD_CONTEXT_FILE, {});

  // Merge capabilities from boot status and health
  const bootCaps = (bootStatus.capabilities && typeof bootStatus.capabilities === 'object')
    ? bootStatus.capabilities : {};
  const healthCaps = (health && typeof health === 'object') ? health : {};

  const capabilities = { ...bootCaps };
  for (const [name, hData] of Object.entries(healthCaps)) {
    if (!capabilities[name]) {
      capabilities[name] = { ok: !!hData.ok, status: hData.ok ? 'ready' : 'degraded', init_ms: 0 };
    } else {
      capabilities[name] = { ...capabilities[name], ok: hData.ok !== undefined ? !!hData.ok : capabilities[name].ok };
    }
  }

  return {
    mode: 'full',
    os: {
      overallHealth: bootStatus.overallHealth || 'unknown',
      bootTime: bootStatus.bootTime || 0,
      capabilities,
    },
    badges: {
      earned: badgeData.earned || {},
      newThisSession: badgeData.newThisSession || [],
    },
    forge: hudContext.forge || {},
    session: hudContext.session || {},
    context: {
      trigger: 'studio',
      event: 'boot',
      zone: null,
    },
  };
}

/**
 * Activate studio mode: writes marker file and returns state + badge summary.
 * @returns {{ state: object, badgeCount: number, activatedAt: string }}
 */
function activateStudio() {
  const state = buildStudioState();
  const activatedAt = new Date().toISOString();

  ensureDir(OS_DIR);
  fs.writeFileSync(STUDIO_MODE_FILE, JSON.stringify({ active: true, activatedAt }, null, 2));

  const badgeCount = Object.keys((state.badges && state.badges.earned) || {}).length;
  return { state, badgeCount, activatedAt };
}

/**
 * Deactivate studio mode: removes marker file.
 * @returns {{ active: false }}
 */
function deactivateStudio() {
  try {
    if (fs.existsSync(STUDIO_MODE_FILE)) {
      fs.unlinkSync(STUDIO_MODE_FILE);
    }
  } catch {
    // best-effort removal
  }
  return { active: false };
}

/**
 * Returns structured status object for the /studio status display.
 * @returns {{ active: boolean, activatedAt: string|null, badgeCount: number, earnedBadges: string[] }}
 */
function getStudioStatus() {
  const modeData = readJsonSafe(STUDIO_MODE_FILE, null);
  const active = !!(modeData && modeData.active);
  const activatedAt = (modeData && modeData.activatedAt) || null;

  const badgeData = readJsonSafe(BADGES_FILE, { earned: {}, newThisSession: [] });
  const earnedBadges = Object.keys(badgeData.earned || {});

  return {
    active,
    activatedAt,
    badgeCount: earnedBadges.length,
    earnedBadges,
  };
}

/**
 * Boolean check — is studio mode currently active?
 * @returns {boolean}
 */
function isStudioActive() {
  const modeData = readJsonSafe(STUDIO_MODE_FILE, null);
  return !!(modeData && modeData.active);
}

module.exports = {
  buildStudioState,
  activateStudio,
  deactivateStudio,
  getStudioStatus,
  isStudioActive,
  // Exported for testing
  STUDIO_MODE_FILE,
  BADGES_FILE,
  BOOT_STATUS_FILE,
  HEALTH_FILE,
  HUD_CONTEXT_FILE,
};
