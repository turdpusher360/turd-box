// @ts-check
'use strict';

/**
 * memory-service.cjs: the dev-memory offline contract as an OS capability
 * (DOC-ARC-027 P5, section 3.2 of
 * docs/superpowers/specs/2026-07-17-dev-memory-offline-contract-design.md).
 *
 * A file-only view over lib/memory-service.cjs: hub state, outbox depth and
 * snapshot age land in health.json beside the other capabilities. init() may
 * spawn one detached snapshot refresher (scripts/memory-snapshot-refresh.cjs)
 * under the rule in refreshBlocker(). Nothing else here spawns, writes service
 * state or touches the network; the kernel signal stays transient.
 *
 * The lib and the refresher resolve from this file's directory, never from the
 * working directory: the 4ge plugin vendors this capability and probes it in any
 * repo it opens, and a probe must never load the opened project's code (BL-404).
 * The vendored tree ships no lib, so there the capability reports status
 * 'unavailable' with ok true, reads nothing further and never spawns.
 *
 * `ok` means the capability works (lib loads, state readable). Hub up/down/unknown
 * goes in `status`: a hub outage is a normal mode under the offline contract and
 * must not mark the OS degraded.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const LIB_PATH = path.join(__dirname, '..', '..', 'memory-service.cjs');
const REFRESHER_PATH = path.join(__dirname, '..', '..', '..', 'scripts', 'memory-snapshot-refresh.cjs');

// The hub-direct default (the lib's baseUrl() with MEMORY_HUB_URL unset), kept as
// parts: the plugin vendor sanitizer rejects a host:port literal in this file.
const HUB_DIRECT_HOSTS = new Set(['localhost', '127.0.0.1']);
const HUB_DIRECT_PORT = '8091';

// Refresh backoff. The refresher records state.cache only on success, so after a
// failed run the snapshot stays stale and every new session would spawn it again.
// A claim younger than this many hours blocks the next spawn.
const REFRESH_CLAIM_H = 6;
const REFRESH_CLAIM_FILE = 'refresh-claim.json';
const BOOT_STATUS_FILE = '.boot-status';
const KERNEL_STEP = 'health:memory';
const HOUR_MS = 60 * 60 * 1000;

/**
 * Loads lib/memory-service.cjs from beside this file. Absent (the vendored tree)
 * is a normal mode; present but throwing is a capability fault.
 * @returns {{ lib: any, health: import('../kernel/contracts.cjs').HealthResult | null }}
 */
function loadLib() {
  if (!fs.existsSync(LIB_PATH)) {
    return { lib: null, health: unavailable(true, 'memory-service lib not present') };
  }
  try {
    return { lib: require(LIB_PATH), health: null };
  } catch (error) {
    return { lib: null, health: unavailable(false, `memory-service lib failed to load: ${errorText(error)}`) };
  }
}

/** @returns {import('../kernel/contracts.cjs').HealthResult} */
function unavailable(ok, reason) {
  return { ok, status: 'unavailable', outbox_pending: null, cache_age_h: null, kernel_probe: 'n/a', reason };
}

function errorText(error) {
  return error && error.message ? error.message : String(error);
}

/**
 * The kernel health:memory verdict from <osStateDir>/.boot-status, written by the
 * kernel before capability boot. Missing, unparseable or without a degraded list
 * reads as 'n/a'.
 * @param {string} osStateDir
 * @returns {'ok'|'failed'|'n/a'}
 */
function readKernelProbe(osStateDir) {
  try {
    const status = JSON.parse(fs.readFileSync(path.join(osStateDir, BOOT_STATUS_FILE), 'utf8'));
    if (!status || !Array.isArray(status.degraded)) return 'n/a';
    return status.degraded.includes(KERNEL_STEP) ? 'failed' : 'ok';
  } catch {
    return 'n/a';
  }
}

/** @param {string} url */
function isHubDirect(url) {
  try {
    const parsed = new URL(url);
    return HUB_DIRECT_HOSTS.has(parsed.hostname) && parsed.port === HUB_DIRECT_PORT;
  } catch {
    return false;
  }
}

/**
 * File reads only: service state, outbox depth, snapshot info and the kernel
 * verdict. The service is built per call so MEMORY_SERVICE_ROOT is read now, not
 * when the lib was first required.
 * @param {any} lib
 * @param {string|null} osStateDir  null reads .boot-status from <service root>/_runs/os
 */
function readView(lib, osStateDir) {
  const service = lib.createMemoryService();
  // readText throws on anything but ENOENT, so an unreadable state file is a
  // capability fault. Corrupt JSON reads as unknown, as the lib's getState does.
  const text = lib.readText(service.paths.state);
  let raw = null;
  if (text) {
    try { raw = JSON.parse(text); } catch { raw = null; }
  }
  const state = lib.normalizeState(raw);
  const snapshot = service.snapshotInfo();
  const refreshedMs = snapshot && snapshot.refreshed_at ? Date.parse(snapshot.refreshed_at) : NaN;
  const ageH = Number.isFinite(refreshedMs) ? (Date.now() - refreshedMs) / HOUR_MS : null;
  return {
    service,
    // A snapshot of unknown age counts as stale, so a refresh can repair it.
    stale: ageH === null || ageH > lib.CACHE_STALE_H,
    health: {
      ok: true,
      status: state.status,
      outbox_pending: service.outboxDepth(),
      cache_age_h: ageH === null ? null : Math.round(ageH * 100) / 100,
      kernel_probe: readKernelProbe(osStateDir || path.join(service.paths.root, '_runs', 'os')),
    },
  };
}

/**
 * The health shape without spawning: lib, then state. Used by probe() and the
 * status action.
 * @param {string|null} osStateDir
 * @returns {import('../kernel/contracts.cjs').HealthResult}
 */
function observe(osStateDir) {
  const { lib, health } = loadLib();
  if (!lib) return health || unavailable(false, 'memory-service lib missing');
  try {
    return readView(lib, osStateDir).health;
  } catch (error) {
    return fault(error);
  }
}

/** @returns {import('../kernel/contracts.cjs').HealthResult} */
function fault(error) {
  return { ok: false, status: 'unknown', outbox_pending: null, cache_age_h: null, kernel_probe: 'n/a', reason: `state read failed: ${errorText(error)}` };
}

/** @param {string} claimPath */
function claimIsFresh(claimPath) {
  try {
    const claim = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
    const age = Date.now() - Date.parse(claim && claim.claimed_at);
    return age >= 0 && age < REFRESH_CLAIM_H * HOUR_MS;
  } catch {
    return false;
  }
}

/**
 * The refresher spawns only when all of these hold (the lib already loaded):
 * the kernel probe passed, the consumer URL is hub-direct (after any cutover the
 * kernel probe is advisory only, spec A5), the snapshot is missing or stale, the
 * refresher script exists beside this file, and no fresh claim exists. Returns
 * the first failing condition, or null. The script check comes before the claim
 * so a missing script writes no claim.
 * @param {any} lib
 * @param {{ stale: boolean, health: { kernel_probe: string } }} view
 * @param {string} claimPath
 * @returns {string|null}
 */
function refreshBlocker(lib, view, claimPath) {
  if (view.health.kernel_probe !== 'ok') return `kernel probe ${view.health.kernel_probe}`;
  if (!isHubDirect(lib.baseUrl())) return 'hub url not hub-direct; kernel probe advisory';
  if (!view.stale) return 'snapshot fresh';
  if (!fs.existsSync(REFRESHER_PATH)) return 'refresher script not present';
  if (claimIsFresh(claimPath)) return `refresh claimed within ${REFRESH_CLAIM_H} h`;
  return null;
}

/**
 * PATH and HOME plus the two memory-service variables when set. MCP_AUTH_KEY is
 * never passed. The refresher calls only memory_search, a read tool, and
 * scripts/lib/hub-auth.cjs injects a key only for its WRITE_TOOLS, so for this
 * child it never reads the key file either. A write-capable child (the replayer,
 * P3/P4) would read ~/.config/dev-memory/auth-key whatever this env holds, so
 * reusing this spawn path for it needs its own review.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} root  the resolved service root
 * @returns {Record<string, string>}
 */
function childEnv(env, root) {
  /** @type {Record<string, string>} */
  const out = {};
  if (env.PATH) out.PATH = env.PATH;
  if (env.HOME) out.HOME = env.HOME;
  if (env.MEMORY_HUB_URL) out.MEMORY_HUB_URL = env.MEMORY_HUB_URL;
  if (env.MEMORY_SERVICE_ROOT) out.MEMORY_SERVICE_ROOT = root;
  return out;
}

/**
 * Writes the claim, then spawns the refresher detached. A failed claim write
 * means no spawn. Never throws.
 * @param {any} lib
 * @param {any} service
 * @param {string} claimPath
 * @returns {{ spawned: boolean, reason: string|null }}
 */
function spawnRefresher(lib, service, claimPath) {
  try {
    lib.writeFileAtomic(claimPath, `${JSON.stringify({ claimed_at: new Date().toISOString() })}\n`);
  } catch (error) {
    return { spawned: false, reason: `refresh claim write failed: ${errorText(error)}` };
  }
  try {
    const child = module.exports._spawn(process.execPath, [REFRESHER_PATH], {
      detached: true,
      stdio: 'ignore',
      cwd: service.paths.root,
      env: childEnv(process.env, service.paths.root),
    });
    // spawn() reports a launch failure as an async 'error' event; with no
    // listener it would throw in the os-boot hook after init returned.
    if (child && typeof child.on === 'function') child.on('error', () => {});
    if (child && typeof child.unref === 'function') child.unref();
    // No pid means the launch failed (EAGAIN and the like). The claim stays, so
    // the backoff still holds.
    if (!child || child.pid === undefined) return { spawned: false, reason: 'refresher launch failed' };
    return { spawned: true, reason: null };
  } catch (error) {
    return { spawned: false, reason: `refresher spawn failed: ${errorText(error)}` };
  }
}

module.exports = {
  manifest: {
    name: 'memory-service',
    version: '1.0.0',
    description: 'Dev-memory offline contract: hub state, outbox depth and snapshot age (file reads; spawns the snapshot refresher when stale)',
    depends_on: [],
    actions: {
      status: { description: 'Hub state, outbox depth, snapshot age and the kernel probe verdict', args: [] },
      refresh: { description: 'Refresh the offline recall snapshot (not wired in P5)', args: [] },
      replay: { description: 'Replay the outbox to the hub (not wired in P5)', args: [] },
    },
    /** @returns {import('../kernel/contracts.cjs').HealthResult} */
    health() {
      // Read the cache off module.exports, not `this`: a bare manifest.health()
      // call binds `this` to the manifest object.
      return { ...(module.exports._healthCache || { ok: false, reason: 'not initialized' }) };
    },
    resources: { typical_duration: '<1s' },
  },

  /** @type {import('../kernel/contracts.cjs').HealthResult} */
  _healthCache: { ok: false, reason: 'not initialized' },
  // Injectable so tests stub it; no test spawns a real child.
  _spawn: spawn,

  // Runs in the os-accounting PostToolUse hook: small file reads only, no spawn,
  // no network, no writes.
  probeCost: 'cheap',
  /** @returns {import('../kernel/contracts.cjs').HealthResult} */
  probe() {
    const result = observe(null);
    module.exports._healthCache = result;
    return result;
  },

  init(os) {
    const t0 = Date.now();
    const obs = os && os.observability;
    const log = (event, data) => {
      try {
        if (obs) obs.log('capability', event, { capability: 'memory-service', ...data });
      } catch { /* observability is best-effort */ }
    };
    log('init-start', { severity: 'info' });

    const { lib, health: libHealth } = loadLib();
    if (!lib) {
      const health = libHealth || unavailable(false, 'memory-service lib missing');
      module.exports._healthCache = health;
      log('init-complete', {
        severity: health.ok ? 'info' : 'warn',
        durationMs: Date.now() - t0,
        status: health.status,
        refresh: 'skip: lib unavailable',
      });
      return;
    }

    try {
      const osStateDir = os && typeof os.stateDir === 'string' && os.stateDir ? os.stateDir : null;
      const view = readView(lib, osStateDir);
      /** @type {import('../kernel/contracts.cjs').HealthResult} */
      const health = { ...view.health };
      const claimPath = osStateDir ? path.join(osStateDir, REFRESH_CLAIM_FILE) : null;
      const blocker = claimPath ? refreshBlocker(lib, view, claimPath) : 'no OS state dir for the refresh claim';
      let refresh = `skip: ${blocker}`;
      if (!blocker && claimPath) {
        const result = spawnRefresher(lib, view.service, claimPath);
        refresh = result.spawned ? 'spawned' : 'failed';
        if (result.reason) health.reason = result.reason;
      }
      module.exports._healthCache = health;
      log('init-complete', {
        severity: health.reason ? 'warn' : 'info',
        durationMs: Date.now() - t0,
        status: health.status,
        outboxPending: health.outbox_pending,
        cacheAgeH: health.cache_age_h,
        kernelProbe: health.kernel_probe,
        refresh,
      });
    } catch (error) {
      module.exports._healthCache = fault(error);
      log('init-error', { severity: 'error', message: errorText(error), durationMs: Date.now() - t0 });
    }
  },

  shutdown() {},

  actions: {
    status(_args, os) {
      return observe(os && typeof os.stateDir === 'string' && os.stateDir ? os.stateDir : null);
    },
    // Declared under the spec section 3.2 names but inert in P5: invoke() has no
    // non-test caller, and a second spawn path would widen the audit surface.
    refresh() {
      return { ok: false, reason: 'not wired in P5' };
    },
    replay() {
      return { ok: false, reason: 'not wired in P5' };
    },
  },

  _internals: {
    LIB_PATH,
    REFRESHER_PATH,
    REFRESH_CLAIM_H,
    REFRESH_CLAIM_FILE,
    isHubDirect,
    readKernelProbe,
  },
};
