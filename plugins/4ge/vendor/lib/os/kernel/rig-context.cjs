'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_HANDOFF_MAX_HOURS = 24;
const DEFAULT_GENERATED_STATE_MAX_MINUTES = 60;
const DEFAULT_STALE_AFTER_MS = 60 * 60 * 1000;

function toDate(value) {
  if (value instanceof Date) return value;
  const date = new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return new Date();
  return date;
}

function roundAgeHours(ms) {
  return Math.round(ms / (60 * 60 * 1000));
}

function roundAgeMinutes(ms) {
  return Math.round(ms / (60 * 1000));
}

function safeStat(filePath, fsImpl = fs) {
  try {
    return fsImpl.statSync(filePath);
  } catch {
    return null;
  }
}

function latestHandoff(cwd, fsImpl = fs) {
  const runsDir = path.join(cwd, '_runs');
  let entries;
  try {
    entries = fsImpl.readdirSync(runsDir);
  } catch {
    return null;
  }

  let best = null;
  for (const entry of entries) {
    const match = /^HANDOFF-S(\d+)\.md$/.exec(entry);
    if (!match) continue;
    const sessionNumber = Number(match[1]);
    if (!best || sessionNumber > best.sessionNumber) {
      best = {
        sessionNumber,
        path: path.join(runsDir, entry),
        relative_path: path.join('_runs', entry),
      };
    }
  }
  return best;
}

function checkHandoff({ cwd, now, maxAgeHours = DEFAULT_HANDOFF_MAX_HOURS, fsImpl = fs }) {
  const handoff = latestHandoff(cwd, fsImpl);
  if (!handoff) {
    return {
      status: 'warn',
      summary: 'No _runs/HANDOFF-S*.md found',
    };
  }

  const stat = safeStat(handoff.path, fsImpl);
  if (!stat) {
    return {
      status: 'warn',
      summary: `Latest handoff missing: ${handoff.relative_path}`,
      path: handoff.relative_path,
    };
  }

  const ageMs = Math.max(0, now.getTime() - stat.mtime.getTime());
  const ageHours = roundAgeHours(ageMs);
  const status = ageHours > maxAgeHours ? 'warn' : 'ok';
  return {
    status,
    summary: status === 'ok'
      ? `Latest handoff ${handoff.relative_path} is fresh`
      : `Latest handoff ${handoff.relative_path} is stale`,
    path: handoff.relative_path,
    session_number: handoff.sessionNumber,
    age_hours: ageHours,
    max_age_hours: maxAgeHours,
    mtime: stat.mtime.toISOString(),
  };
}

function checkGeneratedState({ cwd, stateDir, now, maxAgeMinutes = DEFAULT_GENERATED_STATE_MAX_MINUTES, fsImpl = fs }) {
  const candidates = [
    path.join(cwd, '_runs', 'session-cartridge.json'),
    path.join(stateDir, 'boot-status.json'),
    path.join(stateDir, '.boot-status'),
  ];

  const files = candidates.map(filePath => {
    const stat = safeStat(filePath, fsImpl);
    const rel = path.relative(cwd, filePath) || filePath;
    if (!stat) {
      return {
        path: rel,
        status: 'unknown',
        summary: 'missing',
      };
    }

    const ageMs = Math.max(0, now.getTime() - stat.mtime.getTime());
    const ageMinutes = roundAgeMinutes(ageMs);
    const status = ageMinutes > maxAgeMinutes ? 'warn' : 'ok';
    return {
      path: rel,
      status,
      summary: status === 'ok' ? 'fresh' : 'stale',
      age_minutes: ageMinutes,
      max_age_minutes: maxAgeMinutes,
      mtime: stat.mtime.toISOString(),
    };
  });

  const present = files.filter(file => file.status !== 'unknown');
  if (present.length === 0) {
    return {
      status: 'unknown',
      summary: 'No generated session or boot state files found',
      files,
    };
  }

  const stale = present.filter(file => file.status === 'warn');
  return {
    status: stale.length > 0 ? 'warn' : 'ok',
    summary: stale.length > 0
      ? `${stale.length} generated state file(s) stale`
      : `${present.length} generated state file(s) fresh`,
    files,
  };
}

function checkNodeModules({ cwd, fsImpl = fs }) {
  const packagePath = path.join(cwd, 'package.json');
  if (!safeStat(packagePath, fsImpl)) {
    return {
      status: 'unknown',
      summary: 'No package.json found',
    };
  }

  const nodeModules = path.join(cwd, 'node_modules');
  const exists = Boolean(safeStat(nodeModules, fsImpl));
  return {
    status: exists ? 'ok' : 'warn',
    summary: exists ? 'node_modules present' : 'node_modules missing for package.json workspace',
    path: 'node_modules',
  };
}

function checkLockfile({ cwd, fsImpl = fs }) {
  const packagePath = path.join(cwd, 'package.json');
  if (!safeStat(packagePath, fsImpl)) {
    return {
      status: 'unknown',
      summary: 'No package.json found',
    };
  }

  const lockfiles = [
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lockb',
  ];
  const found = lockfiles
    .map(name => ({ name, stat: safeStat(path.join(cwd, name), fsImpl) }))
    .filter(entry => entry.stat);

  if (found.length === 0) {
    return {
      status: 'warn',
      summary: 'No package lockfile found for package.json workspace',
    };
  }

  const packageStat = safeStat(packagePath, fsImpl);
  const stale = found.filter(entry => packageStat && entry.stat.mtime.getTime() < packageStat.mtime.getTime());
  return {
    status: stale.length > 0 ? 'warn' : 'ok',
    summary: stale.length > 0
      ? `${stale.map(entry => entry.name).join(', ')} older than package.json`
      : `${found.map(entry => entry.name).join(', ')} present`,
    lockfiles: found.map(entry => entry.name),
  };
}

function checkDevMemory({ devMemoryProbe }) {
  if (typeof devMemoryProbe !== 'function') {
    return {
      status: 'unknown',
      summary: 'dev-memory TCP probe not provided',
    };
  }

  try {
    const result = devMemoryProbe();
    if (result && result.ok === true) {
      return {
        status: 'ok',
        summary: result.detail || 'dev-memory reachable',
      };
    }
    return {
      status: 'warn',
      summary: result && result.detail ? result.detail : 'dev-memory probe failed',
    };
  } catch (err) {
    return {
      status: 'warn',
      summary: `dev-memory probe threw: ${err.message}`,
    };
  }
}

function checkConcurrentSessions({ activeSessionCount }) {
  if (typeof activeSessionCount !== 'number') {
    return {
      status: 'unknown',
      summary: 'active session count not provided',
    };
  }

  if (activeSessionCount <= 1) {
    return {
      status: 'ok',
      summary: `${activeSessionCount} active session(s)`,
      active_session_count: activeSessionCount,
    };
  }

  return {
    status: 'warn',
    summary: `${activeSessionCount} active sessions may compete for control-plane state`,
    active_session_count: activeSessionCount,
  };
}

function collectRigContext(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const stateDir = path.resolve(options.stateDir || path.join(cwd, '_runs', 'os'));
  const now = toDate(options.now);
  const fsImpl = options.fsImpl || fs;

  return {
    version: 1,
    generated_at: now.toISOString(),
    cwd,
    state_dir: stateDir,
    session_id: options.sessionId || null,
    checks: {
      handoff: checkHandoff({
        cwd,
        now,
        maxAgeHours: options.maxHandoffAgeHours,
        fsImpl,
      }),
      generated_state: checkGeneratedState({
        cwd,
        stateDir,
        now,
        maxAgeMinutes: options.maxGeneratedStateAgeMinutes,
        fsImpl,
      }),
      node_modules: checkNodeModules({ cwd, fsImpl }),
      lockfile: checkLockfile({ cwd, fsImpl }),
      dev_memory: checkDevMemory({ devMemoryProbe: options.devMemoryProbe }),
      active_sessions: checkConcurrentSessions({ activeSessionCount: options.activeSessionCount }),
    },
  };
}

function statusRank(status) {
  switch (status) {
    case 'error': return 3;
    case 'warn': return 2;
    case 'unknown': return 1;
    case 'ok':
    default: return 0;
  }
}

function summarizeRigContext(context) {
  const checks = context && context.checks && typeof context.checks === 'object'
    ? context.checks
    : {};
  const issues = Object.entries(checks)
    .filter(([, check]) => check && check.status !== 'ok')
    .map(([name, check]) => ({
      name,
      status: check.status || 'unknown',
      summary: check.summary || 'No summary',
    }));

  const worst = Object.values(checks).reduce((current, check) => {
    const status = check && check.status ? check.status : 'unknown';
    return statusRank(status) > statusRank(current) ? status : current;
  }, 'ok');

  return {
    status: worst,
    issue_count: issues.length,
    headline: issues.length === 0
      ? 'rig context ok'
      : `${issues.length} rig checks need attention`,
    issues,
  };
}

function isRigContextStale(context, now = new Date(), maxAgeMs = DEFAULT_STALE_AFTER_MS) {
  if (!context || !context.generated_at) return true;
  const generatedAt = toDate(context.generated_at);
  const current = toDate(now);
  return Math.max(0, current.getTime() - generatedAt.getTime()) > maxAgeMs;
}

module.exports = {
  collectRigContext,
  summarizeRigContext,
  isRigContextStale,
  checkHandoff,
  checkGeneratedState,
  checkNodeModules,
  checkLockfile,
  checkDevMemory,
  checkConcurrentSessions,
};
