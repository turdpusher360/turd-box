'use strict';

/**
 * capability-registry.cjs
 *
 * Manages capability lifecycle: discovery, dependency resolution,
 * boot sequencing, invocation routing, and health aggregation.
 *
 * Capabilities are CJS modules in lib/os/capabilities/ that export
 * a standard manifest + init/shutdown/actions interface.
 *
 * Architecture:
 *   - createCapabilityRegistry(osApi, opts?) returns a registry instance
 *   - discover(capDir) loads CJS modules, validates manifests
 *   - resolveDeps() runs Kahn's topo-sort over declared depends_on
 *   - boot() calls init(osContext) on each capability in topo order
 *   - invoke(name, action, args) routes calls, returns { ok, result|error }
 *   - query(name) returns current status + health snapshot
 *   - shutdown() tears down in reverse boot order
 */

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

// ---------------------------------------------------------------------------
// validateManifest
// ---------------------------------------------------------------------------

/**
 * Validate a capability manifest against the required schema.
 *
 * Required fields: name (string), version (string), depends_on (array),
 * actions (object with >= 1 entry), health (function).
 * Optional: description (string), resources (object).
 *
 * @param {object} manifest
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateManifest(manifest) {
  const errors = [];

  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, errors: ['manifest must be an object'] };
  }

  if (typeof manifest.name !== 'string' || !manifest.name) {
    errors.push('manifest.name is required (string)');
  }

  if (typeof manifest.version !== 'string' || !manifest.version) {
    errors.push('manifest.version is required (string)');
  }

  if (
    !manifest.actions ||
    typeof manifest.actions !== 'object' ||
    Object.keys(manifest.actions).length === 0
  ) {
    errors.push('manifest.actions is required (object with at least one action)');
  }

  if (!Array.isArray(manifest.depends_on)) {
    errors.push('manifest.depends_on is required (array)');
  }

  if (typeof manifest.health !== 'function') {
    errors.push('manifest.health is required (function)');
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// createCapabilityRegistry
// ---------------------------------------------------------------------------

/**
 * Create a capability registry instance.
 *
 * @param {object} osApi - The lib/os/index.cjs exports (lazy-getter API).
 * @param {object} [opts] - Options.
 * @param {string} [opts.stateDir] - Override for the state directory (for tests).
 * @returns {object} Registry with discover, resolveDeps, boot, invoke, query, shutdown, getBootStatus.
 */
function createCapabilityRegistry(osApi, opts = {}) {
  /** @type {Map<string, {module: object, manifest: object, status: string, reason: string|null, initMs: number, context: object|null}>} */
  const caps = new Map();
  let bootOrder = [];
  let _booted = false;
  const _stateDir = opts.stateDir || path.join(process.cwd(), '_runs', 'os');

  // Cache resolved lazy getters once — shared across all OS context objects (review fix #2)
  let _resolvedServices = null;

  // ---------------------------------------------------------------------------
  // _getResolvedServices
  // ---------------------------------------------------------------------------

  function _getResolvedServices() {
    if (!_resolvedServices) {
      _resolvedServices = {
        contracts: osApi.kernel?.contracts || null,
        registry: osApi.kernel?.getRegistry?.() || null,
        enforcer: osApi.kernel?.getEnforcer?.() || null,
        obs: osApi.services?.getObservability?.() || null,
        ipc: osApi.services?.getIPC?.() || null,
        pq: osApi.scheduler?.getPriorityQueue?.() || null,
        dag: osApi.scheduler?.getDAGExecutor?.() || null,
      };
    }
    return _resolvedServices;
  }

  // ---------------------------------------------------------------------------
  // _createOsContext
  // ---------------------------------------------------------------------------

  /**
   * Create an OS context facade for a capability.
   * Uses cached resolved services (resolved once, shared across all contexts).
   * Actions receive `this` bound to the module object via .call() (review fix #9).
   *
   * @param {string|null} capName - Capability name (sets capDir path).
   * @returns {object} OS context per spec Section 2.2
   */
  function _createOsContext(capName) {
    const svc = _getResolvedServices();
    const capStateDir = capName
      ? path.join(_stateDir, 'capabilities', capName)
      : null;

    return {
      // Cross-capability communication — the only valid IPC path
      invoke: (name, action, args) => invoke(name, action, args),
      query: (name) => query(name),

      kernel: {
        contracts: svc.contracts,
        registry: svc.registry,
        enforcer: svc.enforcer,
      },

      // Facade matches underlying API: log(stream, event, data) — 3 args (review fix #10)
      observability: {
        log(stream, event, data) {
          if (svc.obs) svc.obs.log(stream, event || 'info', data || {});
        },
        query(stream, queryOpts) {
          return svc.obs ? svc.obs.query({ stream, ...queryOpts }) : [];
        },
        summary() {
          return svc.obs
            ? svc.obs.summary()
            : { total: 0, byStream: {}, byEvent: {}, uniqueAgents: 0 };
        },
      },

      ipc: {
        send(to, type, payload) {
          return svc.ipc ? svc.ipc.send({ to, type, payload }) : null;
        },
        receive(recipient, rcvOpts) {
          return svc.ipc ? svc.ipc.receive(recipient, rcvOpts) : [];
        },
        broadcast(type, payload) {
          return svc.ipc ? svc.ipc.broadcast({ type, payload }) : null;
        },
      },

      scheduler: {
        enqueue(task, priority) { if (svc.pq) svc.pq.enqueue({ ...task, priority }); },
        dequeue() { return svc.pq ? svc.pq.dequeue() : null; },
        release(taskId) { if (svc.pq) svc.pq.release(taskId); },
        active() { return svc.pq ? svc.pq.active() : 0; },
        stats() { return svc.pq ? svc.pq.stats() : {}; },
        executeDAG(graph, callbacks) { if (svc.dag) svc.dag.execute(graph, callbacks); },
      },

      stateDir: _stateDir,
      capDir: capStateDir,
    };
  }

  // ---------------------------------------------------------------------------
  // discover
  // ---------------------------------------------------------------------------

  /**
   * Discover capabilities by loading CJS modules from capDir.
   *
   * @param {string} capDir - Directory containing *.cjs capability files
   * @returns {{ found: string[], invalid: Array<{file: string, errors: string[]}>, registered: number }}
   */
  function discover(capDir) {
    const found = [];
    const invalid = [];

    if (!fs.existsSync(capDir)) {
      return { found: [], invalid: [], registered: 0 };
    }

    const files = fs.readdirSync(capDir).filter(f => f.endsWith('.cjs'));

    for (const file of files) {
      const fullPath = path.join(capDir, file);
      try {
        // Clear require cache for fresh load (important in tests)
        delete require.cache[require.resolve(fullPath)];
        const mod = require(fullPath);

        const validation = validateManifest(mod.manifest);
        if (!validation.valid) {
          invalid.push({ file, errors: validation.errors });
          continue;
        }

        caps.set(mod.manifest.name, {
          module: mod,
          manifest: mod.manifest,
          status: 'pending',
          reason: null,
          initMs: 0,
          context: null,
        });

        found.push(mod.manifest.name);
      } catch (err) {
        invalid.push({ file, errors: [err.message] });
      }
    }

    return { found, invalid, registered: found.length };
  }

  // ---------------------------------------------------------------------------
  // resolveDeps
  // ---------------------------------------------------------------------------

  /**
   * Build dependency graph, detect cycles, produce topo-sorted boot order.
   * Uses Kahn's algorithm with sorted tie-breaking for determinism.
   *
   * @returns {{ order: string[], cycles: string[][], errors: string[] }}
   */
  function resolveDeps() {
    const names = Array.from(caps.keys());
    const errors = [];

    // Check for missing dependencies
    for (const [name, cap] of caps) {
      for (const dep of cap.manifest.depends_on || []) {
        if (!caps.has(dep)) {
          errors.push(`${name} depends on unknown capability: ${dep}`);
        }
      }
    }
    if (errors.length > 0) {
      return { order: [], cycles: [], errors };
    }

    // Kahn's algorithm
    const inDegree = new Map();
    const adjacency = new Map(); // dep -> [dependents]

    for (const name of names) {
      inDegree.set(name, 0);
      adjacency.set(name, []);
    }

    for (const [name, cap] of caps) {
      for (const dep of cap.manifest.depends_on || []) {
        adjacency.get(dep).push(name);
        inDegree.set(name, inDegree.get(name) + 1);
      }
    }

    // Seed queue with zero-degree nodes, sorted for determinism
    const queue = names.filter(n => inDegree.get(n) === 0).sort();
    const order = [];

    while (queue.length > 0) {
      const node = queue.shift();
      order.push(node);

      for (const neighbor of adjacency.get(node) || []) {
        inDegree.set(neighbor, inDegree.get(neighbor) - 1);
        if (inDegree.get(neighbor) === 0) {
          // Insert sorted for deterministic order
          const idx = queue.findIndex(q => q > neighbor);
          if (idx === -1) queue.push(neighbor);
          else queue.splice(idx, 0, neighbor);
        }
      }
    }

    // Nodes not in order = part of a cycle
    const cycles = [];
    if (order.length < names.length) {
      const inCycle = names.filter(n => !order.includes(n));
      cycles.push(inCycle);
    }

    bootOrder = order;
    return { order, cycles, errors: [] };
  }

  // ---------------------------------------------------------------------------
  // _writeJson
  // ---------------------------------------------------------------------------

  /** Helper: write JSON with mkdir -p */
  function _writeJson(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
  }

  // ---------------------------------------------------------------------------
  // boot
  // ---------------------------------------------------------------------------

  /**
   * Boot all discovered capabilities in dependency order.
   * Creates per-capability state dirs, calls init(osContext), runs health checks.
   * Writes boot-status.json and health.json to stateDir.
   *
   * Actions and init receive `this` bound to the module object via .call()
   * so capability code can use `this._os`, `this._stateDir`, etc. (review fix #9).
   *
   * @returns {object} Boot status (spec Section 3.2 format)
   */
  function boot() {
    if (bootOrder.length === 0 && caps.size === 0) {
      const failedStatus = {
        session_id: `session-${Date.now()}`,
        booted_at: new Date().toISOString(),
        capabilities: {},
        overall: 'failed',
        total_boot_ms: 0,
        reason: 'no capabilities discovered; expected Agentic OS capabilities',
      };
      fs.mkdirSync(_stateDir, { recursive: true });
      _writeJson(path.join(_stateDir, 'boot-status.json'), failedStatus);
      _writeJson(path.join(_stateDir, 'health.json'), {});
      _booted = true;
      return failedStatus;
    }

    if (bootOrder.length < caps.size) {
      const failedStatus = {
        session_id: `session-${Date.now()}`,
        booted_at: new Date().toISOString(),
        capabilities: {},
        overall: 'failed',
        total_boot_ms: 0,
        reason: 'capabilities discovered but dependency resolution did not produce a complete boot order',
      };
      fs.mkdirSync(_stateDir, { recursive: true });
      _writeJson(path.join(_stateDir, 'boot-status.json'), failedStatus);
      _writeJson(path.join(_stateDir, 'health.json'), {});
      _booted = true;
      return failedStatus;
    }

    fs.mkdirSync(_stateDir, { recursive: true });
    const capResults = {};
    const totalStart = performance.now();

    for (const name of bootOrder) {
      const cap = caps.get(name);
      const capStateDir = path.join(_stateDir, 'capabilities', name);
      fs.mkdirSync(capStateDir, { recursive: true });

      const start = performance.now();

      try {
        // Actions receive `this` bound to the module object via .call() (review fix #9)
        const ctx = _createOsContext(name);
        cap.context = ctx;
        cap.module.init.call(cap.module, ctx);

        const health = cap.manifest.health.call(cap.module);
        const initMs = Math.round(performance.now() - start);

        if (health && health.ok) {
          cap.status = 'ready';
        } else {
          cap.status = 'degraded';
          cap.reason = (health && health.reason) || 'health check returned not-ok';
        }
        cap.initMs = initMs;
      } catch (err) {
        cap.status = 'failed';
        cap.reason = err.message;
        cap.initMs = Math.round(performance.now() - start);
      }

      // If any dependency failed/degraded, mark this cap as degraded (review fix #4)
      const depsFailed = (cap.manifest.depends_on || []).filter(d => {
        const dep = caps.get(d);
        return dep && (dep.status === 'failed' || dep.status === 'degraded');
      });
      if (depsFailed.length > 0 && cap.status === 'ready') {
        cap.status = 'degraded';
        cap.reason = `dependency unavailable: ${depsFailed.join(', ')}`;
      }

      capResults[name] = {
        status: cap.status,
        init_ms: cap.initMs,
        ...(cap.manifest.depends_on.length > 0 ? { depends_on: cap.manifest.depends_on } : {}),
        ...(cap.reason ? { reason: cap.reason } : {}),
      };
    }

    _booted = true;

    const totalMs = Math.round(performance.now() - totalStart);

    // Determine overall status
    const statuses = Object.values(capResults).map(c => c.status);
    let overall = 'ready';
    if (statuses.includes('failed')) overall = 'failed';
    else if (statuses.includes('degraded')) overall = 'degraded';

    // Write health.json
    const healthData = {};
    for (const [name, cap] of caps) {
      try {
        healthData[name] = cap.manifest.health.call(cap.module);
      } catch {
        healthData[name] = { ok: false, error: 'health check threw' };
      }
    }
    _writeJson(path.join(_stateDir, 'health.json'), healthData);

    // Write boot-status.json (spec Section 3.2)
    const bootStatus = {
      session_id: `session-${Date.now()}`,
      booted_at: new Date().toISOString(),
      capabilities: capResults,
      overall,
      total_boot_ms: totalMs,
    };
    _writeJson(path.join(_stateDir, 'boot-status.json'), bootStatus);

    return bootStatus;
  }

  // ---------------------------------------------------------------------------
  // invoke
  // ---------------------------------------------------------------------------

  /**
   * Invoke a capability action. Actions receive `this` bound to the module
   * object via .call(), so capability code can use `this._os`, `this._stateDir`, etc.
   *
   * STATUS (upstream): the dispatch path works, but `invoke()` has NO real (non-test)
   * callers tree-wide — the 30 registered actions across 9 capabilities are reached
   * by direct module paths or acted out as LLM pseudocode in command `.md` files
   * (self-labeled at aisle.md:36), not by code calling this function. Capability
   * MODULES stay live via boot + `probe()` (do not prune); only this action-invocation
   * layer is aspirational. Do not describe the OS as "executing its capabilities'
   * actions" through `invoke()`.
   *
   * Error cases (in priority order):
   *   unknown_capability — capability not registered
   *   not_ready          — capability is still pending (not yet booted)
   *   failed             — capability init threw
   *   degraded           — capability health check failed or dep unavailable
   *   unknown_action     — action not in manifest or module
   *
   * @param {string} capName
   * @param {string} action
   * @param {any} args
   * @returns {{ ok: boolean, result?: any, error?: string }}
   */
  function invoke(capName, action, args) {
    const cap = caps.get(capName);

    if (!cap) {
      return { ok: false, error: `unknown_capability: ${capName}` };
    }

    // Guard: capability not yet booted (review fix #3)
    if (cap.status === 'pending') {
      return { ok: false, error: `not_ready: ${capName}` };
    }

    if (cap.status === 'failed') {
      return { ok: false, error: `failed: ${capName}` };
    }

    if (cap.status === 'degraded') {
      return { ok: false, error: `degraded: ${capName}: ${cap.reason || 'unknown'}` };
    }

    if (!cap.manifest.actions[action]) {
      return { ok: false, error: `unknown_action: ${capName}.${action}` };
    }

    if (!cap.module.actions || typeof cap.module.actions[action] !== 'function') {
      return { ok: false, error: `unknown_action: ${capName}.${action}` };
    }

    try {
      const ctx = cap.context || _createOsContext(capName);
      const result = cap.module.actions[action].call(cap.module, args, ctx);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // ---------------------------------------------------------------------------
  // query
  // ---------------------------------------------------------------------------

  /**
   * Query current status and health snapshot for a capability.
   *
   * @param {string} capName
   * @returns {{ status: string, health: object, manifest: object }|null}
   */
  function query(capName) {
    const cap = caps.get(capName);
    if (!cap) return null;

    let health;
    try {
      health = cap.manifest.health.call(cap.module);
    } catch {
      health = { ok: false, error: 'health check threw' };
    }

    return {
      status: cap.status,
      health,
      manifest: {
        name: cap.manifest.name,
        version: cap.manifest.version,
        description: cap.manifest.description,
        depends_on: cap.manifest.depends_on,
        actions: Object.keys(cap.manifest.actions),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // shutdown
  // ---------------------------------------------------------------------------

  /**
   * Tear down all capabilities in reverse boot order.
   * Best-effort: shutdown errors are swallowed.
   */
  function shutdown() {
    const reverseOrder = [...bootOrder].reverse();
    for (const name of reverseOrder) {
      const cap = caps.get(name);
      if (cap && typeof cap.module.shutdown === 'function') {
        try {
          cap.module.shutdown.call(cap.module);
        } catch {
          // best-effort — never block shutdown
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // getBootStatus
  // ---------------------------------------------------------------------------

  /**
   * Read the persisted boot-status.json from stateDir.
   * Returns null if not yet written or unreadable.
   *
   * @returns {object|null}
   */
  function getBootStatus() {
    const statusPath = path.join(_stateDir, 'boot-status.json');
    try {
      return JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------

  return {
    discover,
    resolveDeps,
    boot,
    invoke,
    query,
    shutdown,
    getBootStatus,
  };
}

// ---------------------------------------------------------------------------

module.exports = { validateManifest, createCapabilityRegistry };
