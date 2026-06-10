'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SESSION_FILE = '.outhouse-session.json';
const SESSION_VERSION = '1.0.0';
const DEFAULT_STALE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Resolve the session file path relative to project root.
 * @param {string} [cwd] - project root (defaults to process.cwd())
 * @returns {string}
 */
function sessionPath(cwd) {
  return path.join(cwd || process.cwd(), SESSION_FILE);
}

/**
 * Atomic write: write to .tmp, then rename.
 * @param {string} filePath
 * @param {Object} data
 */
function atomicWrite(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, filePath);
}

/**
 * Create a new wizard session.
 * @param {string} mode - wizard mode name (e.g., "outhouse", "fix")
 * @param {Object} [flags] - parsed CLI flags
 * @param {Object} [options]
 * @param {string} [options.cwd] - project root
 * @param {string} [options.configHash] - SHA-256 of merged config
 * @returns {Object} session state
 */
function create(mode, flags, options) {
  const opts = options || {};
  const filePath = sessionPath(opts.cwd);
  const now = new Date().toISOString();
  const sessionId = crypto.randomUUID();

  const session = {
    version: SESSION_VERSION,
    wizard_type: mode,
    session_id: sessionId,
    started_at: now,
    updated_at: now,
    current_stage: 1,
    stages_completed: [],
    config_hash: opts.configHash || null,
    flags: flags || {},
  };

  atomicWrite(filePath, session);
  return session;
}

/**
 * Update the current session with stage results.
 * @param {Object} stageData - data to merge into the session
 * @param {Object} [options]
 * @param {string} [options.cwd] - project root
 * @returns {Object} updated session state
 */
function update(stageData, options) {
  const opts = options || {};
  const filePath = sessionPath(opts.cwd);
  const session = read(opts);

  if (!session) {
    throw new Error('No active wizard session to update');
  }

  // Merge stage data
  Object.assign(session, stageData);
  session.updated_at = new Date().toISOString();

  // Track stage completion
  if (stageData.current_stage && !session.stages_completed.includes(stageData.current_stage - 1)) {
    const prevStage = stageData.current_stage - 1;
    if (prevStage >= 1 && prevStage <= 6) {
      session.stages_completed.push(prevStage);
      session.stages_completed.sort((a, b) => a - b);
    }
  }

  atomicWrite(filePath, session);
  return session;
}

/**
 * Read the current session state.
 * @param {Object} [options]
 * @param {string} [options.cwd] - project root
 * @returns {Object|null} session state or null if no session
 */
function read(options) {
  const opts = options || {};
  const filePath = sessionPath(opts.cwd);

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * End (finalize) the current session.
 * @param {Object} result - final result data (scores, grade, etc.)
 * @param {Object} [options]
 * @param {string} [options.cwd] - project root
 * @param {boolean} [options.archive] - if true, write to _runs/ before deleting
 * @returns {Object|null} final session state, or null if no session
 */
function end(result, options) {
  const opts = options || {};
  const filePath = sessionPath(opts.cwd);
  const session = read(opts);

  if (!session) return null;

  // Finalize
  session.ended_at = new Date().toISOString();
  session.updated_at = session.ended_at;
  session.result = result || {};

  // Archive if requested
  if (opts.archive) {
    const cwd = opts.cwd || process.cwd();
    const runsDir = path.join(cwd, '_runs', 'outhouse');
    try {
      fs.mkdirSync(runsDir, { recursive: true });
      const archivePath = path.join(runsDir, `session-${session.session_id}.json`);
      atomicWrite(archivePath, session);
    } catch {
      // Archive failure is non-fatal
    }
  }

  // Delete active session file
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Already gone
  }

  return session;
}

/**
 * Check if the current session is stale (abandoned).
 * @param {number} [maxAgeMs] - max age in milliseconds (default 10 minutes)
 * @param {Object} [options]
 * @param {string} [options.cwd] - project root
 * @returns {{ stale: boolean, session: Object|null, ageMs: number }}
 */
function isStale(maxAgeMs, options) {
  const opts = options || {};
  const maxAge = maxAgeMs || DEFAULT_STALE_MS;
  const session = read(opts);

  if (!session) {
    return { stale: false, session: null, ageMs: 0 };
  }

  const updatedAt = new Date(session.updated_at).getTime();
  const ageMs = Date.now() - updatedAt;

  return {
    stale: ageMs > maxAge,
    session,
    ageMs,
  };
}

module.exports = {
  create,
  update,
  read,
  end,
  isStale,
  SESSION_FILE,
  SESSION_VERSION,
};
