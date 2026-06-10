'use strict';

/**
 * scanner-registry.cjs
 *
 * Loads, validates, freezes, and manages lifecycle of AISLE scanner modules.
 *
 * Design invariants:
 *   - Object.freeze() on every scanner after load — prevents prototype pollution / require.cache tampering
 *   - _internals nulled in non-test environments before freeze
 *   - Scanner D (integrity) degradation triggers global fail-closed
 *   - Duplicate scanner IDs are rejected at load time
 *   - All state transitions are validated against the lifecycle state machine
 */

// -- Internal state --

/** @type {Map<string, object>} scannerId -> frozen scanner instance */
const _scanners = new Map();

/** @type {Map<string, string>} scannerId -> current lifecycle state */
const _states = new Map();

/** @type {boolean} Set true when Scanner D degrades — causes gate-evaluator to fail-closed */
let _globalFailClosed = false;

// -- Lifecycle state machine --

/**
 * Valid transitions: from-state -> Set of allowed to-states
 *
 * LOAD -> VALIDATE -> REGISTER -> SELF-TEST -> INIT -> ARMED
 *                                     |                  |
 *                                     v            REFRESH -> ARMED | DEGRADE
 *                                  DEGRADE
 *                                     |
 *                                  DISABLE
 */
const TRANSITIONS = {
  'LOAD':      new Set(['VALIDATE']),
  'VALIDATE':  new Set(['REGISTER']),
  'REGISTER':  new Set(['SELF-TEST']),
  'SELF-TEST': new Set(['INIT', 'DEGRADE']),
  'INIT':      new Set(['ARMED']),
  'ARMED':     new Set(['REFRESH']),
  'REFRESH':   new Set(['ARMED', 'DEGRADE']),
  'DEGRADE':   new Set(['DISABLE']),
  'DISABLE':   new Set(),
};

// Required methods every scanner must export
const REQUIRED_METHODS = ['scan', 'evaluate', 'selfTest', 'health'];

// Required metadata fields every scanner must declare
const REQUIRED_METADATA = ['id', 'name', 'version', 'defaultTier', 'cadence'];

// ------------------------------------------------------------------
// Internal helpers
// ------------------------------------------------------------------

/**
 * Reset module-level state. Used internally for test isolation when the
 * module is re-required via freshRegistry() in tests.
 */
function _reset() {
  _scanners.clear();
  _states.clear();
  _globalFailClosed = false;
}

/**
 * Reset only the global fail-closed flag.
 * P1-7 fix: called at start of each boot() to clear stale fail-closed state
 * from a previous boot without clearing scanner registrations (which are
 * managed by the OS capability system, not by boot.cjs itself).
 *
 * If a previous boot set _globalFailClosed due to Scanner D degradation,
 * that flag persists across process calls (module-level state). Resetting it
 * at boot start allows a recovery scenario where Scanner D is repaired.
 */
function _resetFailClosed() {
  _globalFailClosed = false;
}

// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

/**
 * Load a scanner module from disk, validate its contract, register it,
 * and Object.freeze() it.
 *
 * Sets scanner._internals = null before freeze when NODE_ENV !== 'test'.
 *
 * @param {string} scannerPath - Absolute path to the scanner .cjs file
 * @returns {{ success: boolean, error?: string }}
 */
function load(scannerPath) {
  let scanner;

  try {
    scanner = require(scannerPath);
  } catch (err) {
    return { success: false, error: `module load failed: ${err.message}` };
  }

  // Validate contract before registration
  const validation = validate(scanner);
  if (!validation.valid) {
    return { success: false, error: `validation failed: ${validation.errors.join(', ')}` };
  }

  const { id } = scanner;

  // Reject duplicate IDs
  if (_scanners.has(id)) {
    return { success: false, error: `duplicate scanner ID: ${id}` };
  }

  // Null _internals in non-test environments before freezing
  if (process.env.NODE_ENV !== 'test') {
    // _internals may not exist; setting it here creates it before freeze
    scanner._internals = null;
  }

  // Freeze the scanner to prevent post-load tampering
  Object.freeze(scanner);

  _scanners.set(id, scanner);
  _states.set(id, 'LOAD');

  return { success: true };
}

/**
 * Validate a scanner object against the required interface contract.
 *
 * Checks:
 *   - 4 required methods: scan, evaluate, selfTest, health
 *   - 5 required metadata fields: id, name, version, defaultTier, cadence
 *
 * @param {object} scanner
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validate(scanner) {
  const errors = [];

  if (!scanner || typeof scanner !== 'object') {
    return { valid: false, errors: ['scanner must be an object'] };
  }

  // Method checks
  for (const method of REQUIRED_METHODS) {
    if (typeof scanner[method] !== 'function') {
      errors.push(`missing required method: ${method}()`);
    }
  }

  // Metadata checks
  for (const field of REQUIRED_METADATA) {
    if (scanner[field] == null) {
      errors.push(`missing required metadata field: ${field}`);
    }
  }

  // cadence must be an array
  if (scanner.cadence != null && !Array.isArray(scanner.cadence)) {
    errors.push('cadence must be an array');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Get all scanners whose cadence includes 'per-tool' and whose toolFilter
 * matches the given toolType.
 *
 * If a scanner has no toolFilter (or an empty one), it matches all tools.
 *
 * @param {string} toolType - e.g. 'Write', 'Edit', 'Bash', 'Agent', 'mcp__*'
 * @returns {object[]} Array of matching frozen scanner instances
 */
function getForTool(toolType) {
  const results = [];

  for (const scanner of _scanners.values()) {
    // Must include 'per-tool' in cadence
    if (!Array.isArray(scanner.cadence) || !scanner.cadence.includes('per-tool')) {
      continue;
    }

    // If toolFilter is specified and non-empty, check for match
    if (Array.isArray(scanner.toolFilter) && scanner.toolFilter.length > 0) {
      if (!scanner.toolFilter.includes(toolType)) {
        continue;
      }
    }
    // No toolFilter = matches all tool types

    results.push(scanner);
  }

  return results;
}

/**
 * Get a registered scanner by single-letter ID.
 *
 * @param {string} id - Single-letter scanner ID (A-J)
 * @returns {object|null} Frozen scanner instance, or null if not registered
 */
function get(id) {
  return _scanners.get(id) || null;
}

/**
 * Get all registered scanners.
 *
 * @returns {object[]} Array of all frozen scanner instances
 */
function getAll() {
  return Array.from(_scanners.values());
}

/**
 * Transition a scanner's lifecycle state.
 *
 * Valid transitions are defined in the TRANSITIONS map above.
 * Scanner D degradation sets the global fail-closed flag.
 *
 * @param {string} scannerId
 * @param {string} newState
 * @returns {{ success: boolean, error?: string }}
 */
function transition(scannerId, newState) {
  const currentState = _states.get(scannerId);

  if (currentState == null) {
    return { success: false, error: `unknown scanner ID: ${scannerId}` };
  }

  const allowed = TRANSITIONS[currentState];
  if (!allowed) {
    return { success: false, error: `invalid transition: no transitions defined from state ${currentState}` };
  }

  if (!allowed.has(newState)) {
    return {
      success: false,
      error: `invalid transition: ${currentState} -> ${newState} is not allowed`,
    };
  }

  _states.set(scannerId, newState);

  // Scanner D (integrity) special invariant: degradation = global fail-closed
  if (scannerId === 'D' && (newState === 'DEGRADE' || newState === 'DISABLE')) {
    _globalFailClosed = true;
    // Downstream components (event-bus, gate-evaluator) read isFailClosed() to act on this.
    // Emitting a CRITICAL event is handled by the caller (boot.cjs / health-monitor.cjs)
    // since event-bus is not yet available at registry load time.
  }

  return { success: true };
}

/**
 * Get the current lifecycle state of a scanner.
 *
 * @param {string} scannerId
 * @returns {string|null} Current state string, or null if not registered
 */
function getState(scannerId) {
  return _states.get(scannerId) || null;
}

/**
 * Returns true if the global fail-closed flag has been set.
 * This happens when Scanner D (integrity) degrades.
 *
 * gate-evaluator.cjs checks this before every evaluation.
 *
 * @returns {boolean}
 */
function isFailClosed() {
  return _globalFailClosed;
}

// ------------------------------------------------------------------
// Module exports
// ------------------------------------------------------------------

module.exports = {
  load,
  validate,
  getForTool,
  get,
  getAll,
  transition,
  getState,
  isFailClosed,
  // Exposed for test isolation only — freshRegistry() in tests re-requires the module
  _reset,
  // P1-7: Reset only fail-closed flag (not scanner registrations) for boot() recovery
  _resetFailClosed,
};
