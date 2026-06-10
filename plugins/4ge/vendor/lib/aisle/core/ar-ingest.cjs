'use strict';

/**
 * ar-ingest.cjs — AR Measure Ingest (Phase D.1 skeleton)
 *
 * One-way adapter: reads AR measure JSONL baselines from the autoresearch
 * harness output and feeds signed confidence nudges into learning.processMeasure().
 *
 * Phase D.1 ships the plumbing GATED OFF. The kill switch is:
 *   aisle-config.json.arSubscriptions.enabled === true
 *
 * Default on disk: no arSubscriptions key (equivalent to enabled: false).
 * When disabled, ingest() returns {processed: 0, skipped: 'disabled'}
 * and touches NOTHING — no JSONL reads, no cursor ops, no learning calls.
 *
 * Data-flow invariants:
 *   - Read-only against JSONL files (never writes to _runs/)
 *   - Pull-based (no file watchers)
 *   - Idempotent via cursor file keyed by <domain>:<lineNumber>
 *   - All mutations go through learning.processMeasure() only
 *
 * Phase D.2 implements computeDelta() and deltaToNudge().
 * Phase D.3 adds multi-scanner subscriptions and scheduled trigger.
 */

const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Cursor file schema version. Version-gated on load — unknown versions start fresh. */
const CURSOR_VERSION = '1.0.0';

/** Default cursor filename, overridable via arSubscriptions.cursorPath config. */
const DEFAULT_CURSOR_PATH = 'ar-ingest-cursor.json';

// ---------------------------------------------------------------------------
// Kill-switch fast path
// ---------------------------------------------------------------------------

/**
 * Extract the arSubscriptions config block from a loaded config object.
 * Returns a minimal disabled-state object if the key is absent or malformed.
 *
 * @param {object|null} configModule - Full aisle-config.json object
 * @returns {{ enabled: boolean, cursorPath: string, maxNudgePerEvent: number, maxEventsPerScanner24h: number, scanners: object }}
 */
function extractArConfig(configModule) {
  const defaults = {
    enabled: false,
    cursorPath: DEFAULT_CURSOR_PATH,
    maxNudgePerEvent: 0.005,
    maxEventsPerScanner24h: 10,
    scanners: {},
  };

  if (!configModule || typeof configModule !== 'object') {
    return defaults;
  }

  const raw = configModule.arSubscriptions;

  // Missing key is treated as disabled — zero-cost default per spec §4.5
  if (raw === undefined || raw === null) {
    return defaults;
  }

  // Malformed (not an object) — treat as disabled; caller surfaces error via validateArConfig
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return defaults;
  }

  return {
    enabled: raw.enabled === true,
    cursorPath: typeof raw.cursorPath === 'string' && raw.cursorPath.length > 0
      ? raw.cursorPath
      : defaults.cursorPath,
    maxNudgePerEvent: typeof raw.maxNudgePerEvent === 'number' && raw.maxNudgePerEvent >= 0 && raw.maxNudgePerEvent <= 0.02
      ? raw.maxNudgePerEvent
      : defaults.maxNudgePerEvent,
    maxEventsPerScanner24h: Number.isInteger(raw.maxEventsPerScanner24h) && raw.maxEventsPerScanner24h >= 0 && raw.maxEventsPerScanner24h <= 100
      ? raw.maxEventsPerScanner24h
      : defaults.maxEventsPerScanner24h,
    scanners: (raw.scanners && typeof raw.scanners === 'object' && !Array.isArray(raw.scanners))
      ? raw.scanners
      : {},
  };
}

/**
 * Validate the arSubscriptions scanner keys.
 * Scanner IDs must match ^[A-I]$ — same whitelist as learning.cjs:228.
 *
 * @param {object} scanners - arSubscriptions.scanners object
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateScannerKeys(scanners) {
  const errors = [];
  const VALID_SCANNER = /^[A-I]$/;

  for (const key of Object.keys(scanners)) {
    if (!VALID_SCANNER.test(key)) {
      errors.push(`arSubscriptions.scanners contains invalid scanner ID: "${key}" (must be A-I)`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Cursor persistence
// ---------------------------------------------------------------------------

/**
 * Load the AR ingest cursor from disk.
 * Cursor schema: { version: '1.0.0', updatedAt: ISO, domains: { <name>: <lastLineNumber> } }
 *
 * Graceful on missing or corrupt file — returns a fresh empty cursor.
 * Version-gated: non-1.x.x versions start fresh (cursor re-processes from tail).
 *
 * @param {string} stateDir - AISLE state directory path
 * @param {string} [cursorFilename] - Cursor filename (default: ar-ingest-cursor.json)
 * @returns {{ version: string, updatedAt: string|null, domains: object }}
 */
function loadCursor(stateDir, cursorFilename) {
  const filename = cursorFilename || DEFAULT_CURSOR_PATH;
  const cursorPath = path.join(stateDir, filename);
  const empty = { version: CURSOR_VERSION, updatedAt: null, domains: {} };

  try {
    if (!fs.existsSync(cursorPath)) {
      return empty;
    }
    const raw = fs.readFileSync(cursorPath, 'utf8');
    const parsed = JSON.parse(raw);

    // Version gate — unknown versions start fresh
    if (!parsed.version || !parsed.version.startsWith('1.')) {
      process.stderr.write(`[AISLE:ar-ingest] Unknown cursor version ${parsed.version} — starting fresh\n`);
      return empty;
    }

    return {
      version: parsed.version,
      updatedAt: parsed.updatedAt || null,
      domains: (parsed.domains && typeof parsed.domains === 'object' && !Array.isArray(parsed.domains))
        ? parsed.domains
        : {},
    };
  } catch (err) {
    process.stderr.write(`[AISLE:ar-ingest] Failed to load cursor: ${err.message} — starting fresh\n`);
    return empty;
  }
}

/**
 * Persist the AR ingest cursor to disk.
 * Skips write on error (does not throw — ingest continues without persistence).
 *
 * @param {string} stateDir - AISLE state directory path
 * @param {{ version: string, updatedAt: string|null, domains: object }} cursor
 * @param {string} [cursorFilename] - Cursor filename (default: ar-ingest-cursor.json)
 */
function saveCursor(stateDir, cursor, cursorFilename) {
  const filename = cursorFilename || DEFAULT_CURSOR_PATH;
  const cursorPath = path.join(stateDir, filename);

  try {
    const payload = {
      version: cursor.version || CURSOR_VERSION,
      updatedAt: new Date().toISOString(),
      domains: cursor.domains || {},
    };
    fs.writeFileSync(cursorPath, JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    process.stderr.write(`[AISLE:ar-ingest] Failed to save cursor: ${err.message}\n`);
  }
}

// ---------------------------------------------------------------------------
// Main ingest entry point (D.1 skeleton — kill switch only)
// ---------------------------------------------------------------------------

/**
 * Main ingest entry point.
 *
 * Phase D.1: Implements the kill switch and config extraction only.
 * When enabled=false (default), returns immediately with no side effects.
 * When enabled=true, validates config and returns a stub result (D.2 fills real delta logic).
 *
 * @param {string} stateDir - AISLE state directory path
 * @param {object|null} configModule - Full aisle-config.json object (may be null)
 * @returns {{ processed: number, skipped?: string, errors?: string[], events?: object[] }}
 */
function ingest(stateDir, configModule) {
  const arConfig = extractArConfig(configModule);

  // Kill switch: fast return with zero side effects
  if (!arConfig.enabled) {
    return { processed: 0, skipped: 'disabled' };
  }

  // Validate scanner keys — reject unknown IDs before touching any files
  const keyValidation = validateScannerKeys(arConfig.scanners);
  if (!keyValidation.valid) {
    process.stderr.write(`[AISLE:ar-ingest] Config validation failed: ${keyValidation.errors.join('; ')}\n`);
    // Disable Phase D gracefully — AISLE continues with operator-feedback path unaffected
    return { processed: 0, skipped: 'config-invalid', errors: keyValidation.errors };
  }

  // Phase D.1 stub: enabled but no subscriptions → nothing to process
  const subscribedScanners = Object.keys(arConfig.scanners).filter(id => {
    const scanner = arConfig.scanners[id];
    return Array.isArray(scanner.domains) && scanner.domains.length > 0;
  });

  if (subscribedScanners.length === 0) {
    return { processed: 0, skipped: 'no-subscriptions' };
  }

  // D.2 will implement JSONL delta computation and learning calls here.
  // For D.1, we return a stub result indicating the channel is enabled but not yet active.
  return {
    processed: 0,
    skipped: 'phase-d2-not-implemented',
    subscribedScanners,
  };
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

module.exports = {
  ingest,
  loadCursor,
  saveCursor,

  // Exposed for testing
  _internals: {
    extractArConfig,
    validateScannerKeys,
    CURSOR_VERSION,
    DEFAULT_CURSOR_PATH,
  },
};
