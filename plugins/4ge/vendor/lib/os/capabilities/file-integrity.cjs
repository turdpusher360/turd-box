'use strict';

/**
 * file-integrity.cjs — OS Capability
 *
 * Detects and repairs silent file reverts caused by Claude Code's internal
 * cache resync bug (anthropics/claude-code#42383).
 *
 * Three modes:
 *   Boot  (SessionStart)          — report dirty protected dirs without mutating
 *   Track (PostToolUse:Write|Edit) — SHA-256 snapshot of edited files
 *   Verify (PostToolUse:Bash)     — mtime comparison + hybrid repair
 *
 * Exports boot(), track(), verify(), getTrackedFiles() for unit testing.
 * When run as `require.main === module`, dispatches via stdin/CLI arg.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TARGETS = [
  '.claude/hooks/',
  '.claude/agents/',
  '.claude/rules/',
  'lib/os/',
  'plugins/4ge/bin/',
  'plugins/4ge/lib/',
];

const PREFIX = '[file-integrity]';

/** Files larger than this are tracked by hash only (no content snapshot) */
const MAX_CONTENT_SIZE = 100 * 1024; // 100KB

/** State entries older than this are purged on init */
const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Maximum total state file size before oldest entries are evicted */
const MAX_STATE_SIZE = 10 * 1024 * 1024; // 10MB

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256 hex digest of a string.
 * @param {string} content
 * @returns {string} 64-char hex hash
 */
function sha256(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Build the state file path for a given session ID.
 * @param {string} sessionId
 * @returns {string}
 */
function stateFilePath(sessionId) {
  return path.join(os.tmpdir(), `claude-file-integrity-${sessionId}.json`);
}

/**
 * Load the session state file. Returns empty object on any failure.
 * @param {string} sessionId
 * @returns {object}
 */
function loadState(sessionId) {
  try {
    const raw = fs.readFileSync(stateFilePath(sessionId), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Atomically save session state via tmp+rename.
 * Enforces MAX_STATE_SIZE by evicting oldest entries until under the cap.
 * @param {string} sessionId
 * @param {object} state
 */
function saveState(sessionId, state) {
  const target = stateFilePath(sessionId);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    let json = JSON.stringify(state, null, 2);

    // Evict oldest entries until under MAX_STATE_SIZE
    if (Buffer.byteLength(json, 'utf8') > MAX_STATE_SIZE) {
      const keys = Object.keys(state);
      // Sort by timestamp ascending (oldest first)
      keys.sort((a, b) => (state[a].ts || 0) - (state[b].ts || 0));
      while (keys.length > 0 && Buffer.byteLength(json, 'utf8') > MAX_STATE_SIZE) {
        const oldest = keys.shift();
        delete state[oldest];
        json = JSON.stringify(state, null, 2);
      }
    }

    fs.writeFileSync(tmp, json, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch {
    // best-effort — skip on failure
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/**
 * Append a repair event to the JSONL audit log.
 * @param {object} event
 */
function appendRepairLog(event) {
  try {
    const logDir = path.join(process.cwd(), '_runs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(
      path.join(logDir, 'file-integrity.jsonl'),
      JSON.stringify(event) + '\n'
    );
  } catch {
    // Non-critical — never crash
  }
}

/**
 * Normalize a resolved path for stable state-file keys.
 * @param {string} resolvedPath
 * @returns {string}
 */
function normalizeStatePath(resolvedPath) {
  return resolvedPath.replace(/\\/g, '/');
}

/**
 * True only when the resolved path is process.cwd() or a real descendant.
 * Prefix checks are unsafe: "/tmp/repo-evil" starts with "/tmp/repo".
 * @param {string} resolvedPath
 * @returns {boolean}
 */
function isInsideCwd(resolvedPath) {
  const cwd = path.resolve(process.cwd());
  const relative = path.relative(cwd, resolvedPath);
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

// ---------------------------------------------------------------------------
// Boot Mode
// ---------------------------------------------------------------------------

/**
 * Report dirty protected dirs. Zero dependencies on hook-utils.cjs.
 * SessionStart must not restore from HEAD because it cannot distinguish
 * Claude cache reversion from legitimate in-progress edits.
 *
 * @returns {{ restored: number, files: string[], skipped: number, reason?: string }}
 */
function boot() {
  try {
    const diffResult = spawnSync('git', [
      'diff', 'HEAD', '--name-only', '--', ...TARGETS,
    ], { encoding: 'utf8', timeout: 8000 });

    // Distinguish a timeout / spawn failure from a genuinely clean tree.
    // On drvfs (WSL Windows mounts) `git diff` can exceed a tight timeout; a
    // killed process returns null status with .error/.signal set, which used to
    // collapse into the same {skipped:0} as a clean tree — so the integrity
    // check reported healthy while never actually running (#42383 defense was a
    // silent no-op on the operator's primary box). Surface UNKNOWN, not clean.
    if (diffResult.error || diffResult.signal) {
      const reason = diffResult.error
        ? (diffResult.error.code || diffResult.error.message)
        : `killed:${diffResult.signal}`;
      process.stderr.write(
        `${PREFIX} WARNING: integrity check could not run (git diff ${reason}); status UNKNOWN, not clean\n`
      );
      return { restored: 0, files: [], skipped: 0, degraded: true, reason: `git-diff-failed:${reason}` };
    }

    if (diffResult.status !== 0 || !diffResult.stdout || !diffResult.stdout.trim()) {
      return { restored: 0, files: [], skipped: 0 };
    }

    const staleFiles = diffResult.stdout.trim().split('\n').filter(Boolean);

    if (staleFiles.length === 0) {
      return { restored: 0, files: [], skipped: 0 };
    }

    process.stderr.write(
      `${PREFIX} WARNING: ${staleFiles.length} protected file(s) differ from HEAD; leaving working tree untouched: ${staleFiles.join(', ')}\n`
    );

    return {
      restored: 0,
      files: staleFiles,
      skipped: staleFiles.length,
      reason: 'dirty-protected-files',
    };
  } catch {
    return { restored: 0, files: [], skipped: 0 };
  }
}

// ---------------------------------------------------------------------------
// Track Mode
// ---------------------------------------------------------------------------

/**
 * Snapshot a file's SHA-256 hash + content after Write/Edit.
 *
 * @param {string} filePath - Absolute path to the edited file
 * @param {string} sessionId - Session identifier for state isolation
 * @param {object} [options]
 * @param {() => number} [options.nowFn] - Injectable clock for testing
 * @returns {{ tracked: boolean, reason?: string }}
 */
function track(filePath, sessionId, options = {}) {
  const nowFn = options.nowFn || Date.now;

  if (!filePath || typeof filePath !== 'string') {
    return { tracked: false, reason: 'empty_path' };
  }

  if (!sessionId || typeof sessionId !== 'string') {
    return { tracked: false, reason: 'no_session_id' };
  }

  // Resolve and normalize
  const resolved = path.resolve(filePath);
  const normalized = normalizeStatePath(resolved);

  // Security: reject paths outside cwd
  if (!isInsideCwd(resolved)) {
    return { tracked: false, reason: 'outside_cwd' };
  }

  // Reject symlinks
  try {
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink()) {
      return { tracked: false, reason: 'symlink' };
    }
  } catch {
    return { tracked: false, reason: 'unreadable' };
  }

  // Read file content
  let content;
  try {
    content = fs.readFileSync(resolved, 'utf8');
  } catch {
    return { tracked: false, reason: 'unreadable' };
  }

  // Skip binary files
  if (content.includes('\0')) {
    return { tracked: false, reason: 'binary' };
  }

  const hash = sha256(content);
  const ts = nowFn();

  const state = loadState(sessionId);

  // Files >100KB: store hash only (no content snapshot) to bound state growth
  if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_SIZE) {
    state[normalized] = { hash, content: null, ts };
  } else {
    state[normalized] = { hash, content, ts };
  }
  saveState(sessionId, state);

  return { tracked: true };
}

// ---------------------------------------------------------------------------
// Verify Mode
// ---------------------------------------------------------------------------

/**
 * Re-hash all tracked files and repair any silent reverts.
 *
 * @param {string} sessionId - Session identifier
 * @param {object} [options]
 * @param {() => number} [options.nowFn] - Injectable clock for testing
 * @returns {{ checked: number, repaired: number, removed: number, details: object[] }}
 */
function verify(sessionId, options = {}) {
  const nowFn = options.nowFn || Date.now;

  if (!sessionId || typeof sessionId !== 'string') {
    return { checked: 0, repaired: 0, removed: 0, details: [] };
  }

  const state = loadState(sessionId);
  const keys = Object.keys(state);

  if (keys.length === 0) {
    return { checked: 0, repaired: 0, removed: 0, details: [] };
  }

  let repaired = 0;
  let removed = 0;
  const details = [];

  for (const normalizedPath of keys) {
    const entry = state[normalizedPath];

    // Convert normalized path back to OS path for fs operations, then
    // revalidate the state entry before any read/write repair action.
    const osPath = path.resolve(normalizedPath.replace(/\//g, path.sep));

    if (!isInsideCwd(osPath)) {
      process.stderr.write(`${PREFIX} Dropping tracked path outside cwd: ${normalizedPath}\n`);
      delete state[normalizedPath];
      removed++;
      details.push({ path: normalizedPath, action: 'removed', reason: 'outside_cwd' });
      continue;
    }

    // Check if file still exists
    if (!fs.existsSync(osPath)) {
      process.stderr.write(`${PREFIX} Tracked file deleted: ${normalizedPath}\n`);
      delete state[normalizedPath];
      removed++;
      details.push({ path: normalizedPath, action: 'removed', reason: 'deleted' });
      continue;
    }

    // Read current content
    let currentContent;
    try {
      currentContent = fs.readFileSync(osPath, 'utf8');
    } catch {
      details.push({ path: normalizedPath, action: 'skipped', reason: 'unreadable' });
      continue;
    }

    const currentHash = sha256(currentContent);

    // Hash matches — no revert
    if (currentHash === entry.hash) {
      details.push({ path: normalizedPath, action: 'ok' });
      continue;
    }

    // Hash differs — check mtime to distinguish legitimate edits from reverts
    let mtime;
    try {
      mtime = fs.statSync(osPath).mtimeMs;
    } catch {
      details.push({ path: normalizedPath, action: 'skipped', reason: 'stat_failed' });
      continue;
    }

    // If file was modified AFTER our snapshot, it's a legitimate external write
    if (mtime > entry.ts) {
      details.push({ path: normalizedPath, action: 'skipped', reason: 'legitimate_edit' });
      continue;
    }

    // Revert detected — restore from the snapshot captured at track() time.
    // The snapshot (entry.content) is authoritative: it is exactly what the file
    // held after the user's edit. `git checkout HEAD` was previously used for
    // git-tracked files "for durability", but that restores the COMMITTED blob,
    // not the snapshot — silently discarding any uncommitted edit the user made
    // after the last commit, and making the repair-log newHash (entry.hash) a
    // lie. Prefer the snapshot; skip hash-only large files when no snapshot exists.
    let method = 'write';

    if (entry.content !== null) {
      // Have the snapshot — restore it verbatim. Correct for both
      // committed-and-edited and purely-uncommitted files; no data loss.
      try {
        fs.writeFileSync(osPath, entry.content, 'utf8');
      } catch (err) {
        process.stderr.write(`${PREFIX} Failed to repair file: ${normalizedPath}: ${err.message}\n`);
        details.push({ path: normalizedPath, action: 'failed', reason: err.message });
        continue;
      }
    } else {
      // Hash-only entry (large file, no stored content): do not use
      // `git checkout` as a repair surrogate. HEAD cannot prove the tracked
      // post-edit snapshot, and using it can discard large uncommitted edits.
      process.stderr.write(`${PREFIX} Revert detected but no stored content (hash-only): ${normalizedPath}\n`);
      details.push({ path: normalizedPath, action: 'skipped', reason: 'hash_only_no_content' });
      continue;
    }

    process.stderr.write(`${PREFIX} REPAIRED: ${normalizedPath} was silently reverted, restored via snapshot\n`);

    // Update stored hash/ts to reflect the repair
    const now = nowFn();
    let repairedHash = entry.hash;
    try {
      const repairedContent = fs.readFileSync(osPath, 'utf8');
      repairedHash = sha256(repairedContent);
      state[normalizedPath] = { hash: repairedHash, content: repairedContent, ts: now };
    } catch {
      // If we can't re-read, remove from tracking
      delete state[normalizedPath];
    }

    appendRepairLog({
      ts: new Date().toISOString(),
      path: normalizedPath,
      action: 'repair',
      method,
      oldHash: currentHash,
      newHash: repairedHash,
    });

    repaired++;
    details.push({ path: normalizedPath, action: 'repaired', method });
  }

  saveState(sessionId, state);

  return { checked: keys.length, repaired, removed, details };
}

// ---------------------------------------------------------------------------
// getTrackedFiles
// ---------------------------------------------------------------------------

/**
 * Return the list of currently tracked file paths for a session.
 * @param {string} sessionId
 * @returns {string[]}
 */
function getTrackedFiles(sessionId) {
  if (!sessionId) return [];
  const state = loadState(sessionId);
  return Object.keys(state);
}

// ---------------------------------------------------------------------------
// Stable session ID (process-lifetime, NOT per-call)
// ---------------------------------------------------------------------------

/**
 * Returns a stable session ID for this process.
 * Priority: _runs/os/session-meta.json session_id → process-lifetime UUID fallback.
 * The fallback is generated once at module load and reused; never per-call.
 */
const _processLifetimeId = crypto.randomUUID();

function getStableSessionId() {
  try {
    const metaFile = path.join(process.cwd(), '_runs', 'os', 'session-meta.json');
    if (fs.existsSync(metaFile)) {
      const parsed = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      if (parsed && typeof parsed.session_id === 'string' && parsed.session_id) {
        return parsed.session_id;
      }
    }
  } catch { /* fall through */ }
  return _processLifetimeId;
}

// ---------------------------------------------------------------------------
// OS Capability manifest + actions
// ---------------------------------------------------------------------------

module.exports = {
  // Exported for direct testing
  boot,
  track,
  verify,
  getTrackedFiles,
  getStableSessionId,

  // Internal helpers exported for testing
  sha256,
  stateFilePath,
  loadState,
  saveState,

  // Constants exported for testing
  MAX_CONTENT_SIZE,
  STATE_TTL_MS,
  MAX_STATE_SIZE,

  manifest: {
    name: 'file-integrity',
    version: '1.0.0',
    description: 'Detects and repairs silent file reverts from CC cache resync bug',
    depends_on: [],
    actions: {
      sync:   { description: 'Force .claude/ sync from HEAD', args: [] },
      status: { description: 'Report tracked files and last verification', args: [] },
      check:  { description: 'Run verify mode on demand', args: [] },
    },
    health() {
      return { ...(this._healthCache || { ok: false, reason: 'not initialized' }) };
    },
    resources: {},
  },

  _os: null,
  _healthCache: { ok: false, reason: 'not initialized' },

  probeCost: 'cheap',
  probe() {
    try {
      const path = require('node:path');
      const fs = require('node:fs');
      const metaFile = path.join(process.cwd(), '_runs', 'os', 'session-meta.json');
      let sessionId = null;
      if (fs.existsSync(metaFile)) {
        try {
          sessionId = JSON.parse(fs.readFileSync(metaFile, 'utf8')).session_id || null;
        } catch { /* ignore */ }
      }
      const tracked = sessionId ? getTrackedFiles(sessionId) : [];
      const result = {
        ok: true,
        tracked_files: tracked.length,
        session_id: sessionId || 'unknown',
      };
      this._healthCache = { ...(this._healthCache || {}), ...result };
      return result;
    } catch (e) {
      const result = { ok: false, reason: `probe threw: ${e.message}` };
      this._healthCache = { ...(this._healthCache || {}), ...result };
      return result;
    }
  },

  /**
   * @param {object} osCtx - OS API context
   */
  init(osCtx) {
    const obs = osCtx.observability;
    const t0 = Date.now();
    obs.log('capability', 'init-start', { capability: 'file-integrity', severity: 'info' });

    try {
      this._os = osCtx;
      this._healthCache = { ok: false, reason: 'initializing' };
      const bootResult = boot();

      if (bootResult.restored > 0) {
        obs.log('capability', 'integrity-violation', {
          capability: 'file-integrity',
          severity: 'warn',
          message: `Boot restored ${bootResult.restored} reverted file(s)`,
          restoredCount: bootResult.restored,
          files: bootResult.files,
        });
      } else if (bootResult.skipped > 0) {
        obs.log('capability', 'integrity-warning', {
          capability: 'file-integrity',
          severity: 'warn',
          message: `Boot detected ${bootResult.skipped} protected dirty file(s); left working tree untouched`,
          skippedCount: bootResult.skipped,
          files: bootResult.files,
        });
      }

      // Purge stale state files older than STATE_TTL_MS (7 days)
      try {
        const tmpdir = os.tmpdir();
        const prefix = 'claude-file-integrity-';
        const now = Date.now();
        const entries = fs.readdirSync(tmpdir);
        for (const entry of entries) {
          if (!entry.startsWith(prefix) || !entry.endsWith('.json')) continue;
          const fullPath = path.join(tmpdir, entry);
          try {
            const stat = fs.statSync(fullPath);
            if (now - stat.mtimeMs > STATE_TTL_MS) {
              fs.unlinkSync(fullPath);
            }
          } catch { /* skip unreadable/already-deleted */ }
        }
      } catch { /* non-critical — never crash init */ }

      this._healthCache = {
        ok: true,
        tracked_files: 0,
        last_check_ms: null,
        reverts_repaired: 0,
        dirty_protected_files: bootResult.skipped || 0,
      };

      obs.log('capability', 'init-complete', {
        capability: 'file-integrity',
        severity: 'info',
        durationMs: Date.now() - t0,
        restoredOnBoot: bootResult.restored,
        skippedOnBoot: bootResult.skipped || 0,
      });
    } catch (e) {
      obs.log('capability', 'init-error', {
        capability: 'file-integrity',
        severity: 'error',
        message: e.message,
        durationMs: Date.now() - t0,
      });
      throw e;
    }
  },

  shutdown() {
    // No persistent resources to release
  },

  actions: {
    sync() {
      const result = boot();
      return {
        ok: true,
        message: `Checked protected files; restored ${result.restored} file(s), left ${result.skipped || 0} dirty file(s) untouched`,
      };
    },

    status() {
      return { ...(this._healthCache || { ok: false }) };
    },

    check(_args, osCtx) {
      const sessionId = getStableSessionId();
      const result = verify(sessionId);
      this._healthCache = {
        ...this._healthCache,
        last_check_ms: Date.now(),
        reverts_repaired: (this._healthCache.reverts_repaired || 0) + result.repaired,
      };

      // Emit integrity-violation event when verify() repairs silent reverts
      if (result.repaired > 0) {
        const os = module.exports._os;
        if (os && os.observability) {
          os.observability.log('capability', 'integrity-violation', {
            capability: 'file-integrity',
            severity: 'warn',
            message: `Verify repaired ${result.repaired} reverted file(s)`,
            checked: result.checked,
            repaired: result.repaired,
            removed: result.removed,
          });
        }
      }

      return { checked: result.checked, repaired: result.repaired };
    },
  },
};
