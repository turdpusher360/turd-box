'use strict';

// Phase 2 pre-positioning: this module will be wired into os-boot.cjs and
// consumed by capabilities that need runtime feature flags. Currently tested
// but not imported by any runtime code. Wire during Orchestrator Evolution Phase 2.
//
// Singleton pattern: call createFeatureGates() once at boot and share the
// returned instance. reload() allows mid-session refresh without re-instantiation.

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG_PATH = path.resolve(__dirname, '../config/gates.json');

/**
 * Create a new feature-gates instance by reading the JSON config at the
 * given path.
 *
 * Design notes:
 * - ENOENT (file not found): silently default all gates to false.
 * - Parse errors: log to stderr and default all gates to false.
 * - Non-boolean values: treated as false (only `=== true` enables a gate).
 * - `list()` returns a shallow copy so callers cannot mutate internal state.
 * - `reload()` re-reads gates from disk; on failure, retains current gates.
 *
 * @param {string} [configPath] - Absolute or relative path to gates.json.
 *   Defaults to `lib/os/config/gates.json` relative to this module.
 * @returns {{ isEnabled: (gate: string) => boolean, list: () => object, reload: () => void }}
 */
function createFeatureGates(configPath) {
  const resolvedPath = configPath !== undefined ? configPath : DEFAULT_CONFIG_PATH;

  /** @type {object} */
  let gates = {};

  try {
    const raw = fs.readFileSync(resolvedPath, 'utf8');
    gates = JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      // Missing file: silently default all gates to false.
      gates = {};
    } else {
      // Parse error or other I/O failure: log to stderr, default all gates to false.
      process.stderr.write(
        `[feature-gates] Failed to load config from "${resolvedPath}": ${err.message}\n`
      );
      gates = {};
    }
  }

  /**
   * Returns true only when the gate's value is exactly `true`.
   * Unknown gates and non-boolean values both return false.
   *
   * @param {string} gate
   * @returns {boolean}
   */
  function isEnabled(gate) {
    return gates[gate] === true;
  }

  /**
   * Returns a shallow copy of the internal gates object.
   * Mutations to the returned object do not affect internal state.
   *
   * @returns {object}
   */
  function list() {
    return Object.assign({}, gates);
  }

  /**
   * Re-reads the gates config from disk.
   * On ENOENT (missing file): silently retains current gates.
   * On other errors: logs to stderr and retains current gates.
   *
   * @returns {void}
   */
  function reload() {
    try {
      const raw = fs.readFileSync(resolvedPath, 'utf8');
      gates = JSON.parse(raw);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        process.stderr.write(`[feature-gates] Reload failed: ${err.message}\n`);
      }
      // On failure, retain current gates
    }
  }

  return { isEnabled, list, reload };
}

module.exports = { createFeatureGates };
