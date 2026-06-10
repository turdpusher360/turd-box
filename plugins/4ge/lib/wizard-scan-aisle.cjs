'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Scanner IDs A-I (skip intel.json)
const SCANNER_IDS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];

/**
 * Resolve the AISLE state directory path.
 * Derives projectId from cwd using the same normalization as aisle-gate.cjs.
 * @returns {string}
 */
function resolveStateDir() {
  const projectId = process.cwd()
    .replace(/[\\/:\s_]/g, '-')
    .replace(/^-+/, '');
  return path.join(os.homedir(), '.claude', 'projects', projectId, 'aisle');
}

/**
 * Read and parse a single scanner cache file.
 * Returns null on any error (missing file, corrupt JSON, etc.).
 * @param {string} filePath
 * @returns {{ scannerId?: string, canaryPass?: boolean, timestamp?: number, findings?: Array, duration?: number, cachedState?: object, mtime?: number } | null}
 */
function readScannerFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    // Attach file mtime as fallback for age calculation
    parsed._mtime = stat.mtimeMs;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Determine scanner status from parsed cache data.
 * Handles two schemas:
 *   - Canary schema: { scannerId, canaryPass, timestamp }
 *   - Full schema: { findings, duration, cachedState }
 * @param {string} id - scanner letter A-I
 * @param {object} data - parsed JSON from cache file
 * @returns {{ id: string, canaryPass: boolean, ageMs: number, findingCount: number }}
 */
function buildScannerStatus(id, data) {
  const now = Date.now();

  // Canary schema detection: has explicit canaryPass field
  if (typeof data.canaryPass === 'boolean') {
    const ts = typeof data.timestamp === 'number' ? data.timestamp : (data._mtime || now);
    return {
      id,
      canaryPass: data.canaryPass,
      isCanarySchema: true,
      ageMs: now - ts,
      findingCount: 0,
    };
  }

  // Full schema: { findings, duration, cachedState }
  const findings = Array.isArray(data.findings) ? data.findings : [];
  const ts = data._mtime || now;
  return {
    id,
    canaryPass: findings.length === 0,
    isCanarySchema: false,
    ageMs: now - ts,
    findingCount: findings.length,
  };
}

/**
 * Read AISLE scanner cache files and produce security category findings.
 *
 * @param {object} [opts]
 * @param {string} [opts.stateDir] - override default AISLE state directory path
 * @returns {{ healthy: boolean, scanners: Array, findings: { security: object } }}
 */
function scanAisle(opts = {}) {
  const stateDir = opts.stateDir || resolveStateDir();
  const scannerCacheDir = path.join(stateDir, 'scanner-cache');

  // If stateDir does not exist, return no-data result (not a penalty)
  if (!fs.existsSync(stateDir)) {
    return {
      healthy: false,
      scanners: [],
      findings: { security: {} },
    };
  }

  const scanners = [];
  let pinMismatchCount = 0;
  let gitignoreGapCount = 0;

  for (const id of SCANNER_IDS) {
    const filePath = path.join(scannerCacheDir, `${id}.json`);
    const data = readScannerFile(filePath);

    if (data === null) {
      // Missing or corrupt file: skip silently, don't add to scanners
      continue;
    }

    const status = buildScannerStatus(id, data);
    scanners.push(status);

    if (status.isCanarySchema && !status.canaryPass) {
      // Only explicit canary failures map to infrastructure integrity
      pinMismatchCount += 1;
    }

    if (status.findingCount > 0) {
      // Full-schema findings map to gitignore_gap (security misconfiguration signal)
      gitignoreGapCount += status.findingCount;
    }
  }

  const healthy = scanners.length > 0 && scanners.every(s => s.canaryPass);

  return {
    healthy,
    scanners,
    findings: {
      security: {
        pin_mismatch: pinMismatchCount,
        gitignore_gap: gitignoreGapCount,
      },
    },
  };
}

module.exports = { scanAisle };
