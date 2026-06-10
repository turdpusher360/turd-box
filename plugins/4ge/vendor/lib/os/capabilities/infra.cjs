'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// --- Lazy Docker info cache ---
// Populated on first call to getDockerInfo(); expires after 30s.
let _dockerInfoCache = null;
let _dockerInfoCacheTs = 0;
const DOCKER_INFO_TTL_MS = 30_000;

// [4ge-vendor transform] The container registry is configuration, not code.
// Stacks load from <cwd>/.4ge/config.json `infra.containers` — an array of
// { name, stack, service, composePath, dependsOn, hasHealthCheck }.
// Default: empty. /infra reports Docker reachability either way; container
// monitoring activates once the user declares their stacks.
function _loadContainerRegistry() {
  try {
    const cfgPath = path.join(process.cwd(), '.4ge', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const list = cfg && cfg.infra && Array.isArray(cfg.infra.containers)
      ? cfg.infra.containers
      : [];
    return list.filter(c =>
      c && typeof c.name === 'string' && typeof c.composePath === 'string'
    );
  } catch {
    return [];
  }
}
const CONTAINER_REGISTRY = _loadContainerRegistry();

// CWE-78: validate interpolated values before shell execution
const SAFE_DOCKER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const SAFE_PATH = /^[a-zA-Z0-9/_.-]+$/;
function assertSafeName(val) {
  if (!SAFE_DOCKER_NAME.test(val)) throw new Error(`Unsafe docker name: ${val}`);
  return val;
}
function assertSafePath(val) {
  if (!SAFE_PATH.test(val)) throw new Error(`Unsafe docker path: ${val}`);
  return val;
}

/**
 * Cheap synchronous check: is the Docker daemon socket present?
 * Avoids spawning WSL on every SessionStart.
 *
 * Linux:   /var/run/docker.sock
 * Windows: \\.\pipe\docker_engine  (path used by Docker Desktop for Windows)
 *
 * Returns true if the socket/pipe file exists, false otherwise.
 * @returns {boolean}
 */
function isDockerPresent() {
  try {
    if (process.env.FORGE_DOCKER_SOCKET_PATH) {
      return fs.existsSync(process.env.FORGE_DOCKER_SOCKET_PATH);
    }
    if (process.platform === 'win32') {
      return fs.existsSync('\\\\.\\pipe\\docker_engine');
    }
    return fs.existsSync('/var/run/docker.sock');
  } catch {
    return false;
  }
}

/**
 * Lazy, cached `docker info` spawn.  Runs the actual WSL docker call at most
 * once every 30 seconds.  Intended for the `/infra check` action path, NOT
 * for the hot init() path.
 *
 * @returns {{ ok: boolean, dockerVersion?: string, reason?: string }}
 */
function getDockerInfo() {
  const now = Date.now();
  if (_dockerInfoCache !== null && now - _dockerInfoCacheTs < DOCKER_INFO_TTL_MS) {
    return _dockerInfoCache;
  }
  const probe = dockerCmd('docker info --format "{{.ServerVersion}}" 2>/dev/null', 5_000);
  _dockerInfoCache = probe.ok
    ? { ok: true, dockerVersion: probe.stdout }
    : { ok: false, reason: 'Docker not reachable via WSL' };
  _dockerInfoCacheTs = now;
  return _dockerInfoCache;
}

/**
 * Run a Docker command via WSL.
 * @param {string} cmd - full docker command (callers validate inputs against CONTAINER_REGISTRY)
 * @param {number} [timeoutMs=15000] - command timeout
 * @returns {{ ok: boolean, stdout: string, stderr: string }}
 */
function dockerCmd(cmd, timeoutMs = 15_000) {
  const isLinux = process.platform === 'linux' || process.platform === 'darwin';
  const [bin, args] = isLinux
    ? ['bash', ['-c', cmd]]
    : ['wsl', ['bash', '-c', cmd]];
  const result = spawnSync(bin, args, {
    timeout: timeoutMs,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  return {
    ok: result.status === 0,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
  };
}

/**
 * Derive container status from Docker state (spec Section 1.3).
 */
function deriveStatus(state) {
  if (!state) return 'unknown';
  const { Status: dockerState, Health } = state;
  const health = Health?.Status || 'none';

  if (dockerState === 'exited' || dockerState === 'dead') return 'down';
  if (dockerState === 'restarting') return 'recovering';
  if (dockerState === 'running' && health === 'healthy') return 'healthy';
  if (dockerState === 'running' && health === 'unhealthy') return 'degraded';
  if (dockerState === 'running' && health === 'starting') return 'recovering';
  if (dockerState === 'running' && health === 'none') return 'healthy';
  return 'unknown';
}

module.exports = {
  manifest: {
    name: 'infra',
    version: '1.0.0',
    description: 'Docker container health monitoring, auto-remediation',
    depends_on: [],
    actions: {
      check: { description: 'Check all container health', args: [] },
      heal:  { description: 'Restart a degraded/down container', args: ['container'] },
    },
    health() {
      return { ...(this._healthCache || { ok: false, reason: 'not initialized' }) };
    },
    resources: { typical_duration: '30s' },
  },

  probeCost: 'expensive',
  probe() {
    // Use cached getDockerInfo() to avoid re-spawning WSL within the 30s TTL.
    const info = getDockerInfo();
    this._healthCache = info;
    return { ok: info.ok, docker: info.ok ? 'reachable' : 'unreachable' };
  },

  _os: null,
  _stateDir: null,
  _healthCache: { ok: false, reason: 'not initialized' },
  _lastCheck: null,

  init(os) {
    const obs = os.observability;
    const t0 = Date.now();
    obs.log('capability', 'init-start', { capability: 'infra', severity: 'info' });

    try {
      this._os = os;
      this._stateDir = os.capDir;

      // Cheap boot-time check: stat the Docker socket/pipe — no WSL spawn.
      // Actual docker info is deferred to the first /infra action via getDockerInfo().
      const socketPresent = isDockerPresent();
      this._healthCache = socketPresent
        ? { ok: true, dockerVersion: 'deferred' }
        : { ok: false, reason: 'Docker socket not found (daemon not running or not installed)' };

      obs.log('capability', 'init-complete', {
        capability: 'infra',
        severity: this._healthCache.ok ? 'info' : 'warn',
        durationMs: Date.now() - t0,
        dockerPresent: socketPresent,
        dockerReachable: 'deferred',
        containerCount: CONTAINER_REGISTRY.length,
      });
    } catch (e) {
      obs.log('capability', 'init-error', {
        capability: 'infra',
        severity: 'error',
        message: e.message,
        durationMs: Date.now() - t0,
      });
      throw e;
    }
  },

  shutdown() {},

  actions: {
    check(_args, _os) {
      // Ensure Docker is reachable before iterating containers.
      // getDockerInfo() is cached for 30s so repeated /infra checks are cheap.
      const dockerInfo = getDockerInfo();
      if (!dockerInfo.ok) {
        return { error: dockerInfo.reason || 'Docker not reachable', total: 0, healthy: 0, degraded: 0, down: 0, recovering: 0, unknown: 0, containers: [] };
      }

      const results = [];

      for (const container of CONTAINER_REGISTRY) {
        const inspect = dockerCmd(
          `docker inspect --format '{{json .State}}' ${assertSafeName(container.name)} 2>/dev/null`
        );

        if (!inspect.ok) {
          results.push({
            name: container.name,
            stack: container.stack,
            service: container.service,
            status: 'unknown',
            error: 'inspect failed',
          });
          continue;
        }

        try {
          const state = JSON.parse(inspect.stdout);
          const status = deriveStatus(state);
          results.push({
            name: container.name,
            stack: container.stack,
            service: container.service,
            status,
            dockerState: state.Status,
            health: state.Health?.Status || 'none',
            exitCode: state.ExitCode ?? null,
            startedAt: state.StartedAt || null,
          });
        } catch {
          results.push({
            name: container.name,
            stack: container.stack,
            service: container.service,
            status: 'unknown',
            error: 'parse failed',
          });
        }
      }

      const healthy = results.filter(r => r.status === 'healthy').length;
      const summary = {
        total: results.length,
        healthy,
        degraded: results.filter(r => r.status === 'degraded').length,
        down: results.filter(r => r.status === 'down').length,
        recovering: results.filter(r => r.status === 'recovering').length,
        unknown: results.filter(r => r.status === 'unknown').length,
      };

      this._lastCheck = { timestamp: new Date().toISOString(), summary, containers: results };

      // Emit container-state-change events for non-healthy containers
      const os = module.exports._os;
      if (os && os.observability) {
        for (const container of results) {
          if (container.status !== 'healthy') {
            os.observability.log('capability', 'container-state-change', {
              capability: 'infra',
              severity: container.status === 'down' ? 'error' : 'warn',
              container: container.name,
              stack: container.stack,
              service: container.service,
              status: container.status,
              message: `Container ${container.name} is ${container.status}`,
            });
          }
        }
      }

      // Persist last check to state dir
      try {
        fs.mkdirSync(this._stateDir, { recursive: true });
        fs.writeFileSync(
          path.join(this._stateDir, 'last-check.json'),
          JSON.stringify(this._lastCheck, null, 2) + '\n'
        );
      } catch { /* best-effort */ }

      return { ...summary, containers: results };
    },

    heal(args, _os) {
      const { container: containerName } = args || {};
      if (!containerName) return { error: 'container name required' };

      const entry = CONTAINER_REGISTRY.find(c => c.name === containerName);
      if (!entry) return { error: `unknown container: ${containerName}` };

      // Check dependencies are healthy first
      for (const dep of entry.dependsOn) {
        const depInspect = dockerCmd(
          `docker inspect --format '{{json .State}}' ${assertSafeName(dep)} 2>/dev/null`
        );
        if (!depInspect.ok) {
          return { error: `dependency ${dep} not accessible — heal it first` };
        }
        try {
          const depState = JSON.parse(depInspect.stdout);
          const depStatus = deriveStatus(depState);
          if (depStatus !== 'healthy') {
            return { error: `dependency ${dep} is ${depStatus} — heal it first` };
          }
        } catch {
          return { error: `dependency ${dep} state unparseable — check manually` };
        }
      }

      // Restart via docker compose
      const restart = dockerCmd(
        `cd ${assertSafePath(entry.composePath)} && docker --config /tmp/docker-nocreds compose restart ${assertSafeName(entry.service)}`
      );

      return {
        container: containerName,
        action: 'restart',
        success: restart.ok,
        message: restart.ok
          ? `Restarted ${entry.service} in ${entry.stack} stack`
          : `Restart failed: ${restart.stderr}`,
      };
    },
  },

  // Expose internals for unit testing
  _internals: { deriveStatus, CONTAINER_REGISTRY, dockerCmd, isDockerPresent, getDockerInfo },
};
