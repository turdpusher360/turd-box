'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Default return values for missing/corrupt files
const BOOT_DEFAULTS = { capsReady: 0, capsDegraded: 0, bootMs: 0, degradedList: [] };
const HEALTH_DEFAULTS = { allOk: true, failedCaps: [] };
const GIT_DEFAULTS = { branch: 'main', dirty: false, uncommitted: 0, ahead: 0, behind: 0 };

/**
 * Safely read and parse a JSON file.
 * Returns null on any error (missing, corrupt, etc.).
 * @param {string} filePath
 * @returns {object | null}
 */
function readJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Parse boot-status.json into a BootSummary.
 * @param {object | null} data
 * @returns {{ capsReady: number, capsDegraded: number, bootMs: number, degradedList: string[] }}
 */
function parseBootStatus(data) {
  if (!data || typeof data !== 'object') {
    return { ...BOOT_DEFAULTS };
  }

  // capabilities may be an object map or array
  const caps = data.capabilities;
  if (!caps || typeof caps !== 'object') {
    return {
      capsReady: 0,
      capsDegraded: 0,
      bootMs: typeof data.total_boot_ms === 'number' ? data.total_boot_ms : 0,
      degradedList: [],
    };
  }

  const entries = Array.isArray(caps) ? caps : Object.entries(caps).map(([name, val]) => ({ name, ...val }));

  let capsReady = 0;
  let capsDegraded = 0;
  const degradedList = [];

  for (const entry of entries) {
    const status = entry.status;
    const name = entry.name || entry.id || String(entry);
    if (status === 'ready') {
      capsReady += 1;
    } else if (status === 'degraded') {
      capsDegraded += 1;
      degradedList.push(name);
    }
  }

  return {
    capsReady,
    capsDegraded,
    bootMs: typeof data.total_boot_ms === 'number' ? data.total_boot_ms : 0,
    degradedList,
  };
}

/**
 * Parse health.json into a HealthSummary.
 * @param {object | null} data
 * @returns {{ allOk: boolean, failedCaps: string[] }}
 */
function parseHealth(data) {
  if (!data || typeof data !== 'object') {
    return { ...HEALTH_DEFAULTS };
  }

  const failedCaps = [];
  for (const [capName, capData] of Object.entries(data)) {
    if (!capData || capData.ok !== true) {
      failedCaps.push(capName);
    }
  }

  return {
    allOk: failedCaps.length === 0,
    failedCaps,
  };
}

/**
 * Parse git-state.json into a GitSummary.
 * @param {object | null} data
 * @returns {{ branch: string, dirty: boolean, uncommitted: number, ahead: number, behind: number }}
 */
function parseGitState(data) {
  if (!data || typeof data !== 'object') {
    return { ...GIT_DEFAULTS };
  }

  return {
    branch: typeof data.branch === 'string' ? data.branch : 'main',
    dirty: data.dirty === true,
    uncommitted: typeof data.uncommittedFiles === 'number' ? data.uncommittedFiles : 0,
    ahead: typeof data.ahead === 'number' ? data.ahead : 0,
    behind: typeof data.behind === 'number' ? data.behind : 0,
  };
}

/**
 * Read OS state files and produce awareness signals for the wizard engine.
 *
 * @param {string} [projectRoot] - project root directory (defaults to process.cwd())
 * @returns {{ boot: BootSummary, health: HealthSummary, git: GitSummary }}
 */
function scanOs(projectRoot) {
  const root = projectRoot || process.cwd();
  const runsDir = path.join(root, '_runs', 'os');

  const bootData = readJson(path.join(runsDir, 'boot-status.json'));
  const healthData = readJson(path.join(runsDir, 'health.json'));
  const gitData = readJson(path.join(runsDir, 'git-state.json'));

  return {
    boot: parseBootStatus(bootData),
    health: parseHealth(healthData),
    git: parseGitState(gitData),
  };
}

module.exports = { scanOs };
