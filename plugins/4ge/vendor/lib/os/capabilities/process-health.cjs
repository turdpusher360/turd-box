'use strict';

/**
 * process-health.cjs
 *
 * OS capability providing structured process health data for CLI presentation.
 * Reads from process-registry and computes health indicators, summary stats,
 * and alerts per ZOM-PRV-002 spec section 7.
 *
 * Auto-discovered by capability-registry from lib/os/capabilities/.
 */

/** Average memory per agent process (MB) — heuristic for summary estimation */
const ESTIMATED_MB_PER_PROCESS = 120;

// ---------------------------------------------------------------------------
// Health indicator computation (spec section 7.2)
// ---------------------------------------------------------------------------

/**
 * Compute health indicator for a single process entry.
 *
 * @param {object} entry - Process registry entry.
 * @param {number} staleThresholdMs - Heartbeat staleness threshold in ms.
 * @returns {'green'|'yellow'|'red'|'killed'}
 */
function computeHealthIndicator(entry, staleThresholdMs) {
  // Killed processes get their own indicator
  if (entry.killPhase !== null && entry.killPhase !== undefined) {
    return 'killed';
  }

  const now = Date.now();

  // Check heartbeat staleness
  const lastBeat = entry.lastHeartbeat ? Date.parse(entry.lastHeartbeat) : 0;
  const heartbeatStale = (now - lastBeat) > staleThresholdMs;

  // Check deadline expiry
  const deadlineMs = entry.deadlineAt ? Date.parse(entry.deadlineAt) : 0;
  const deadlineExpired = deadlineMs > 0 && now > deadlineMs;

  // Red: stale heartbeat OR expired deadline
  if (heartbeatStale || deadlineExpired) {
    return 'red';
  }

  // Yellow: deadline < 50% remaining
  if (deadlineMs > 0) {
    const spawnMs = entry.spawnedAt ? Date.parse(entry.spawnedAt) : now;
    const totalWindow = deadlineMs - spawnMs;
    const remaining = deadlineMs - now;
    if (totalWindow > 0 && remaining < totalWindow * 0.5) {
      return 'yellow';
    }
  }

  return 'green';
}

/**
 * Format milliseconds as a human-readable duration string.
 *
 * @param {number} ms
 * @returns {string} e.g. "1h 23m" or "45m" or "0m"
 */
function formatDuration(ms) {
  if (ms <= 0) return '0m';
  const totalMins = Math.floor(ms / 60000);
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/**
 * Derive a display status from a process entry.
 *
 * @param {object} entry
 * @param {string} healthIndicator
 * @returns {'running'|'stopped'|'stale'|'expired'|'killed'}
 */
function deriveStatus(entry, healthIndicator) {
  if (entry.stoppedAt !== null) return 'stopped';
  if (healthIndicator === 'killed') return 'killed';
  if (healthIndicator === 'red') {
    // Distinguish stale from expired
    const now = Date.now();
    const deadlineMs = entry.deadlineAt ? Date.parse(entry.deadlineAt) : 0;
    if (deadlineMs > 0 && now > deadlineMs) return 'expired';
    return 'stale';
  }
  return 'running';
}

// ---------------------------------------------------------------------------
// Alert generation
// ---------------------------------------------------------------------------

/**
 * Generate alerts for processes that need attention.
 *
 * @param {object[]} processes - Enriched process objects with healthIndicator.
 * @returns {Array<{level: 'warning'|'critical', message: string}>}
 */
function generateAlerts(processes) {
  const alerts = [];

  for (const proc of processes) {
    if (proc.status === 'stopped') continue;

    if (proc.healthIndicator === 'red' || proc.healthIndicator === 'killed' || proc.status === 'expired' || proc.status === 'stale') {
      alerts.push({
        level: 'critical',
        message: `PID ${proc.pid} ${proc.status} (${proc.agentType})`,
      });
    } else if (proc.healthIndicator === 'yellow') {
      const remaining = proc.remainingMs > 0 ? formatDuration(proc.remainingMs) : 'unknown';
      alerts.push({
        level: 'warning',
        message: `PID ${proc.pid} at >50% of deadline (${remaining} remaining)`,
      });
    }
  }

  return alerts;
}

// ---------------------------------------------------------------------------
// Capability module
// ---------------------------------------------------------------------------

/** Default heartbeat staleness threshold: 10 minutes */
const DEFAULT_STALE_MS = 10 * 60 * 1000;

module.exports = {
  manifest: {
    name: 'process-health',
    version: '1.0.0',
    description: 'Process health dashboard data model for /ps',
    depends_on: [],
    actions: {
      ps: { description: 'Process health status summary + per-process details + alerts', args: [] },
    },
    health() {
      return { ...(this._healthCache || { ok: false, reason: 'not initialized' }) };
    },
    resources: {},
  },

  _os: null,
  _stateDir: null,
  _healthCache: { ok: false, reason: 'not initialized' },
  _bootTime: null,

  probeCost: 'cheap',
  probe() {
    try {
      const osDir = require('node:path').join(process.cwd(), '_runs', 'os');
      const exists = require('node:fs').existsSync(osDir);
      const result = exists
        ? { ok: true, state_dir: 'accessible' }
        : { ok: false, reason: 'state dir missing' };
      this._healthCache = result;
      return result;
    } catch (e) {
      const result = { ok: false, reason: `probe threw: ${e.message}` };
      this._healthCache = result;
      return result;
    }
  },

  init(os) {
    const obs = os.observability;
    const t0 = Date.now();
    obs.log('capability', 'init-start', { capability: 'process-health', severity: 'info' });

    try {
      this._os = os;
      this._stateDir = os.capDir;
      this._bootTime = t0;

      const registry = os.kernel && os.kernel.registry;
      if (registry && typeof registry.list === 'function') {
        this._healthCache = { ok: true };
      } else {
        this._healthCache = { ok: false, reason: 'process registry unavailable' };
      }

      obs.log('capability', 'init-complete', {
        capability: 'process-health',
        severity: 'info',
        durationMs: Date.now() - t0,
        registryAvailable: this._healthCache.ok,
      });
    } catch (e) {
      obs.log('capability', 'init-error', {
        capability: 'process-health',
        severity: 'error',
        message: e.message,
        durationMs: Date.now() - t0,
      });
      throw e;
    }
  },

  shutdown() {
    this._os = null;
    this._healthCache = { ok: false, reason: 'shutdown' };
  },

  actions: {
    /**
     * Return the full process health status per spec section 7.1.
     *
     * @returns {{ summary: object, processes: object[], alerts: object[] }}
     */
    ps(_args, os) {
      const registry = os && os.kernel && os.kernel.registry;
      if (!registry || typeof registry.list !== 'function') {
        return { error: 'process registry unavailable' };
      }

      const staleMs = DEFAULT_STALE_MS;
      const now = Date.now();

      // Get all processes (active = not stopped)
      const active = typeof registry.getActiveProcesses === 'function'
        ? registry.getActiveProcesses()
        : registry.list();

      // Build enriched process list
      const processes = active.map(entry => {
        const healthIndicator = computeHealthIndicator(entry, staleMs);
        const deadlineMs = entry.deadlineAt ? Date.parse(entry.deadlineAt) : 0;
        const remainingMs = deadlineMs > 0 ? Math.max(0, deadlineMs - now) : 0;
        const status = deriveStatus(entry, healthIndicator);

        return {
          pid: entry.pid,
          agentType: entry.agentType,
          status,
          spawnedAt: entry.spawnedAt,
          lastHeartbeat: entry.lastHeartbeat,
          deadlineAt: entry.deadlineAt,
          remainingMs,
          processCategory: entry.processCategory || 'agent',
          allowlisted: entry.allowlisted || false,
          parentPid: entry.parentPid,
          children: [],
          healthIndicator,
        };
      });

      // Fill children arrays
      const byPid = new Map(processes.map(p => [p.pid, p]));
      for (const proc of processes) {
        if (proc.parentPid !== null && proc.parentPid !== undefined) {
          const parent = byPid.get(proc.parentPid);
          if (parent) parent.children.push(proc.pid);
        }
      }

      // Compute summary
      const zombieCandidates = typeof registry.getZombieCandidates === 'function'
        ? registry.getZombieCandidates(staleMs)
        : [];

      const totalKilled = processes.filter(p => p.status === 'killed').length;
      const sessionUptime = this._bootTime
        ? formatDuration(now - this._bootTime)
        : '0m';

      const summary = {
        totalRunning: processes.filter(p => p.status === 'running').length,
        totalStopped: 0,
        totalZombieCandidates: zombieCandidates.length,
        totalKilledThisSession: totalKilled,
        sessionUptime,
        estimatedMemoryMb: processes.length * ESTIMATED_MB_PER_PROCESS,
      };

      // Generate alerts
      const alerts = generateAlerts(processes);

      // Log alerts to observability if available
      if (os.observability && alerts.length > 0) {
        for (const alert of alerts) {
          os.observability.log('alert', 'process_health', {
            level: alert.level,
            message: alert.message,
          });
        }
      }

      return { summary, processes, alerts };
    },
  },
};

// Export internals for testing
module.exports._internals = {
  computeHealthIndicator,
  formatDuration,
  deriveStatus,
  generateAlerts,
  DEFAULT_STALE_MS,
  ESTIMATED_MB_PER_PROCESS,
};
