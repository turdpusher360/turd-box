'use strict';

/**
 * health-monitor.cjs
 *
 * Aggregates scanner health, checks data freshness, runs canaries,
 * and reports degraded Rule-of-Two compound triggers.
 *
 * All methods are synchronous. No npm dependencies.
 * Scanner D (integrity) degradation is the CRITICAL invariant.
 *
 * Design invariants:
 *   - Scanner D degraded -> overall posture is CRITICAL (not merely degraded)
 *   - >50% degraded scanners -> CRITICAL
 *   - checkStaleness reads mtime of files in <stateDir>/scanner-cache/
 *   - runCanaries calls scanner.selfTest() synchronously and degrades on failure
 *   - getDegradedCompoundTriggers maps each scanner to its Rule-of-Two dimension
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maps scanner ID to the Rule-of-Two flag dimension it contributes.
 * Scanners not listed here do not participate in Rule-of-Two.
 *
 * A = untrusted source (provenance)
 * B = sensitive content (data sensitivity)
 * E = external egress (external dimension)
 *
 * When any of these scanners degrades its dimension can no longer be reliably
 * assessed, making compound Rule-of-Two escalation unreachable.
 */
const RULE_OF_TWO_DIMENSIONS = {
  A: 'untrusted',
  B: 'sensitive',
  E: 'external',
};

// Stale = past TTL but within 2× TTL. Expired = beyond 2× TTL.
const STALE_MULTIPLIER = 2;

// ---------------------------------------------------------------------------
// getPosture(registry, config) -> PostureReport
// ---------------------------------------------------------------------------

/**
 * Aggregate health from all registered scanners and produce a PostureReport.
 *
 * Overall rules (in precedence order):
 *   1. Scanner D degraded            -> 'critical'
 *   2. >50% of scanners degraded     -> 'critical'
 *   3. Any scanner degraded          -> 'degraded'
 *   4. All scanners healthy          -> 'healthy'
 *
 * @param {object} registry  - Scanner registry (getAll, getState)
 * @param {object} config    - AISLE config (tiers, etc.)
 * @returns {PostureReport}
 */
function getPosture(registry, _config) {
  const allScanners = registry.getAll();
  const scannerReport = {};

  let degradedCount = 0;
  let scannerDDegraded = false;

  for (const scanner of allScanners) {
    const state = registry.getState(scanner.id);
    const isDegraded = state === 'DEGRADE' || state === 'DISABLE';

    // Prefer scanner.health() if available; fall back to deriving from state.
    let healthInfo;
    if (typeof scanner.health === 'function') {
      try {
        healthInfo = scanner.health();
      } catch (_err) {
        healthInfo = null;
      }
    }

    const status = isDegraded ? 'degraded' : (healthInfo ? healthInfo.status : 'healthy');
    const lastScan = (healthInfo && healthInfo.lastScan) ? healthInfo.lastScan : null;
    const findingCount = (healthInfo && healthInfo.findingCount != null) ? healthInfo.findingCount : 0;

    scannerReport[scanner.id] = { status, lastScan, findingCount };

    if (status === 'degraded' || isDegraded) {
      degradedCount++;
      if (scanner.id === 'D') {
        scannerDDegraded = true;
      }
    }
  }

  // Determine overall posture
  let overall;
  const total = allScanners.length;

  if (scannerDDegraded) {
    overall = 'critical';
  } else if (total > 0 && degradedCount / total > 0.5) {
    overall = 'critical';
  } else if (degradedCount > 0) {
    overall = 'degraded';
  } else {
    overall = 'healthy';
  }

  return {
    timestamp: Date.now(),
    overall,
    scanners: scannerReport,
    canaries: {},
    events: { sessionBlocks: 0, sessionWarns: 0, sessionLogs: 0 },
  };
}

// ---------------------------------------------------------------------------
// checkStaleness(stateDir, config) -> { [scannerId]: { status, age, ttl } }
// ---------------------------------------------------------------------------

/**
 * Check data source freshness by reading mtimes from <stateDir>/scanner-cache/.
 *
 * For each scanner listed in config.ttl:
 *   - File not found: status = 'expired'
 *   - age <= ttl:       status = 'fresh'
 *   - ttl < age <= 2×ttl: status = 'stale'
 *   - age > 2×ttl:     status = 'expired'
 *
 * @param {string} stateDir  - Absolute path to AISLE state directory
 * @param {object} config    - Config with optional ttl map { [scannerId]: seconds }
 * @returns {{ [scannerId]: { status: 'fresh'|'stale'|'expired', ageMs: number, ttlMs: number } }}
 */
function checkStaleness(stateDir, config) {
  const cacheDir = path.join(stateDir, 'scanner-cache');
  const ttlMap = (config && config.ttl) ? config.ttl : {};
  const result = {};
  const nowMs = Date.now();

  for (const [scannerId, ttlSeconds] of Object.entries(ttlMap)) {
    const ttlMs = ttlSeconds * 1000;
    // P1-11: Filename must match what boot/gate-evaluator writes: <id>.json
    // Old: scanner-<id>.json (never matched, always reported expired)
    const filePath = path.join(cacheDir, `${scannerId}.json`);

    if (!fs.existsSync(filePath)) {
      result[scannerId] = { status: 'expired', ageMs: Infinity, ttlMs };
      continue;
    }

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (_err) {
      result[scannerId] = { status: 'expired', ageMs: Infinity, ttlMs };
      continue;
    }

    const ageMs = nowMs - stat.mtimeMs;

    let status;
    if (ageMs <= ttlMs) {
      status = 'fresh';
    } else if (ageMs <= ttlMs * STALE_MULTIPLIER) {
      status = 'stale';
    } else {
      status = 'expired';
    }

    result[scannerId] = { status, ageMs, ttlMs };
  }

  return result;
}

// ---------------------------------------------------------------------------
// runCanaries(registry) -> { results, allPass }
// ---------------------------------------------------------------------------

/**
 * Run all registered scanner selfTest() methods synchronously.
 *
 * On failure (selfTest returns { pass: false } or throws):
 *   - Records scanner as 'fail'
 *   - Calls registry.transition(scannerId, 'DEGRADE')
 *   - Scanner D failure triggers global fail-closed via registry
 *
 * @param {object} registry  - Scanner registry (getAll, transition)
 * @returns {{ results: { [scannerId]: 'pass'|'fail' }, allPass: boolean }}
 */
function runCanaries(registry) {
  const results = {};
  let allPass = true;

  for (const scanner of registry.getAll()) {
    try {
      const result = scanner.selfTest();
      results[scanner.id] = result.pass ? 'pass' : 'fail';
      if (!result.pass) {
        allPass = false;
        registry.transition(scanner.id, 'DEGRADE');
      }
    } catch (_err) {
      results[scanner.id] = 'fail';
      allPass = false;
      registry.transition(scanner.id, 'DEGRADE');
    }
  }

  return { results, allPass };
}

// ---------------------------------------------------------------------------
// getDegradedCompoundTriggers(registry) -> Array<TriggerReport>
// ---------------------------------------------------------------------------

/**
 * Report which Rule-of-Two triggers are inactive due to degraded scanners.
 *
 * Each scanner mapped in RULE_OF_TWO_DIMENSIONS contributes a flag dimension
 * (untrusted | sensitive | external). If that scanner is degraded, the dimension
 * it covers cannot be reliably assessed, making compound escalation unreachable.
 *
 * Returns an entry per degraded scanner that participates in Rule of Two.
 * Returns empty array when all such scanners are healthy.
 *
 * @param {object} registry  - Scanner registry (getAll, getState)
 * @returns {Array<{ scannerId: string, dimension: string, inactive: boolean }>}
 */
function getDegradedCompoundTriggers(registry) {
  const report = [];

  for (const scanner of registry.getAll()) {
    const dimension = RULE_OF_TWO_DIMENSIONS[scanner.id];
    if (!dimension) {
      // This scanner does not participate in Rule of Two
      continue;
    }

    const state = registry.getState(scanner.id);
    const isDegraded = state === 'DEGRADE' || state === 'DISABLE';

    if (isDegraded) {
      report.push({
        scannerId: scanner.id,
        dimension,
        inactive: true,
        reason: `Scanner ${scanner.id} is ${state} — "${dimension}" Rule-of-Two dimension unreachable`,
      });
    }
  }

  return report;
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

module.exports = {
  getPosture,
  checkStaleness,
  runCanaries,
  getDegradedCompoundTriggers,
};
