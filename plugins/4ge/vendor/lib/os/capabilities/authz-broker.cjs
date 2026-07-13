'use strict';

/**
 * authz-broker.cjs — Authorization Broker OS Capability Registration
 *
 * Registers the AISLE authorization broker as an OS capability so operator/
 * requester surfaces can discover it via the capability registry. This is a
 * THIN wrapper over the enforcement core in lib/aisle/broker/*.cjs — the core is
 * deliberately importable WITHOUT OS boot so privileged scripts require() the
 * verifier directly. This module adds only the request/pending/audit read+queue
 * surface that belongs on the OS bus.
 *
 * This is a NEW capability, NOT an extension of aisle.cjs — aisle.cjs is coupled
 * to the shelved gate-era boot/scanner-registry. This module has ZERO imports
 * from lib/aisle/core/boot.cjs, scanner-registry.cjs, gate-evaluator.cjs, or
 * quarantine-manager.cjs.
 *
 * Design notes (mirrors aisle.cjs conventions):
 *   - init() is synchronous
 *   - manifest.actions = metadata only (for registry discovery)
 *   - module-level actions = invocable functions
 *   - depends_on: [] — the broker stands alone
 *   - health() in manifest returns cached health from last init/probe
 *   - `consume` is intentionally NOT an action: consuming a token is a privileged
 *     script concern (it require()s token-store directly), never an OS-bus call
 *   - `request` returns a token id + awaiting status only — NEVER the nonce or
 *     paste-token (those live solely on the operator CLI render path)
 */

const store = require('../../aisle/broker/token-store.cjs');
const audit = require('../../aisle/broker/audit.cjs');

module.exports = {
  manifest: {
    name: 'authz-broker',
    version: '1.0.0',
    description: 'AISLE authorization broker — out-of-band operator approval of gated privileged actions (disk-bound, single-use, TTL-scoped tokens)',
    depends_on: [],
    actions: {
      request: { description: 'Queue an authorization request for operator approval (returns token id only)', args: ['action_class', 'targets', 'artifact_paths'] },
      pending: { description: 'List pending authorization requests with disk-computed bindings', args: [] },
      audit:   { description: 'Tail the broker audit log', args: ['limit'] },
    },
    health() {
      return module.exports._healthCache || { ok: false, reason: 'not initialized' };
    },
    resources: { typical_duration: '<1s' },
  },

  _os: null,
  _stateDir: null,
  _healthCache: { ok: false, reason: 'not initialized' },

  probeCost: 'cheap',
  probe() {
    try {
      const fs = require('node:fs');
      const d = store._dirs({});
      // Passive infra: the broker is healthy as long as its state dir is
      // reachable. Absence of the pending dir just means no tokens yet — still
      // ready. Never throws.
      const exists = fs.existsSync(d.brokerDir);
      const result = exists
        ? { ok: true, state: 'ready' }
        : { ok: true, state: 'ready', note: 'broker state dir not yet created' };
      this._healthCache = result;
      return result;
    } catch (e) {
      const result = { ok: false, reason: `probe threw: ${e.message}` };
      this._healthCache = result;
      return result;
    }
  },

  /**
   * Initialize the authorization broker capability.
   * Resolves the state dir and idempotently creates the broker subtree
   * (module-owned mkdir per brief O6 — STATE_SUBDIRS is not touched).
   *
   * @param {object} os - OS context
   * @param {object} [_args]
   * @returns {{ health: object, state: string }}
   */
  init(os, _args) {
    const obs = os.observability;
    const t0 = Date.now();
    obs.log('capability', 'init-start', { capability: 'authz-broker', severity: 'info' });

    try {
      this._os = os;
      const fs = require('node:fs');
      const d = store._dirs({});
      this._stateDir = d.stateDir;
      // Idempotent, module-owned mkdir of the broker subtree.
      fs.mkdirSync(d.pending, { recursive: true });
      fs.mkdirSync(d.consumed, { recursive: true });

      this._healthCache = { ok: true, state: 'ready' };

      obs.log('capability', 'init-complete', {
        capability: 'authz-broker',
        severity: 'info',
        durationMs: Date.now() - t0,
        state: 'ready',
      });

      return { health: this._healthCache, state: 'ready' };
    } catch (e) {
      this._healthCache = { ok: false, reason: e.message };
      obs.log('capability', 'init-error', {
        capability: 'authz-broker',
        severity: 'error',
        message: e.message,
        durationMs: Date.now() - t0,
      });
      // Do not throw — a broker whose state dir could not be created is degraded,
      // not fatal to OS boot. Privileged scripts fail closed independently.
      return { health: this._healthCache, state: 'degraded' };
    }
  },

  shutdown() {
    // Nothing to tear down — the broker holds no processes, ports, or handles.
  },

  actions: {
    /**
     * Queue an authorization request for operator approval. Returns only the
     * public token id and awaiting status — NEVER the nonce or paste-token
     * (those are minted and rendered solely on the operator CLI).
     *
     * @param {{action_class: string, targets: string[], artifact_paths: string[]}} args
     * @returns {{token_id: string, status: string}}
     */
    request(args, _os) {
      const req = {
        action_class: (args && args.action_class) || '',
        targets: (args && args.targets) || [],
        artifact_paths: (args && args.artifact_paths) || [],
      };
      return store.createRequest(req, { stateDir: module.exports._stateDir });
    },

    /**
     * List pending authorization requests, each augmented with disk-computed
     * bindings and TTL. No secrets — hashes and public handles only.
     *
     * @returns {object[]}
     */
    pending(_args, _os) {
      return store.listPending({ stateDir: module.exports._stateDir });
    },

    /**
     * Tail the broker audit log.
     *
     * @param {{limit?: number}} args
     * @returns {object[]}
     */
    audit(args, _os) {
      const limit = args && Number.isFinite(args.limit) ? args.limit : 50;
      return audit.tailAudit(module.exports._stateDir, limit);
    },
  },
};
