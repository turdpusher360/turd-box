// @ts-check
'use strict';
/**
 * jsonl-rotate.cjs — JSONL rotation utility for the Agentic OS
 *
 * Provides bounded JSONL file growth via entry-count and byte-size limits.
 * All operations are synchronous (hook context — no async allowed).
 *
 * Exports:
 *   appendJsonl(filePath, entry, opts) — serialize + append, rotating if needed
 *   rotateIfNeeded(filePath, opts)     — check limits and rotate if over threshold
 *
 * Rotation mechanics:
 *   1. Rename current file to {name}.{YYYY-MM-DD}.jsonl (or with collision suffix)
 *   2. Start a fresh file at the original path
 *   3. Delete oldest rotated files beyond maxRotated
 *
 * Defaults: 10,000 entries OR 5 MB, keep 3 rotated files.
 *
 * Opt-in coordinated mode serializes append/rotation with a directory lease.
 * On contention or an oversized entry, it publishes a complete immutable
 * archive. Readers must include findRotatedFiles(), not only the active file.
 * maxEntries: Infinity selects the byte-only fast path; maxRotated: Infinity
 * preserves all history. This bounds the active file, not total archive storage.
 * All producers and explicit rotation checks for a shared log must adopt the
 * coordinated option together. The legacy mode remains available unchanged.
 */

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const WAIT_CELL = new Int32Array(new SharedArrayBuffer(4));

/** @type {Readonly<{maxEntries: number, maxBytes: number, maxRotated: number, coordinated: boolean, lockTimeoutMs: number}>} */
const DEFAULT_OPTS = Object.freeze({
  maxEntries: 10_000,
  maxBytes: 5 * 1024 * 1024, // 5 MB
  maxRotated: 3,
  coordinated: false,
  lockTimeoutMs: 25,
});

/**
 * Resolve full options, merging caller opts with defaults.
 * @param {object|undefined} opts
 * @returns {{maxEntries: number, maxBytes: number, maxRotated: number, coordinated: boolean, lockTimeoutMs: number}}
 */
function resolveOpts(opts) {
  return Object.assign({}, DEFAULT_OPTS, opts);
}

/**
 * Count newline-terminated lines in a file without loading the full content.
 * Uses a streaming-chunk approach so large files are not fully buffered.
 * Returns 0 if the file does not exist or cannot be read.
 * @param {string} filePath
 * @returns {number}
 */
function countLines(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size === 0) return 0;

    // For large files read in 64 KB chunks counting '\n' bytes directly
    const CHUNK = 65536;
    const fd = fs.openSync(filePath, 'r');
    let count = 0;
    const buf = Buffer.allocUnsafe(CHUNK);
    let bytesRead;
    try {
      while ((bytesRead = fs.readSync(fd, buf, 0, CHUNK, null)) > 0) {
        for (let i = 0; i < bytesRead; i++) {
          if (buf[i] === 0x0a) count++; // 0x0a === '\n'
        }
      }
    } finally {
      fs.closeSync(fd);
    }
    return count;
  } catch {
    return 0;
  }
}

/**
 * Return the size of a file in bytes, or 0 if it does not exist.
 * @param {string} filePath
 * @returns {number}
 */
function fileBytes(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

/**
 * Build the rotation destination path.
 * Format: {dir}/{stem}.{YYYY-MM-DD}.jsonl
 * If that path already exists, append a numeric suffix (.1, .2, ...).
 * @param {string} filePath
 * @returns {string}
 */
function buildRotatePath(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath, '.jsonl');
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  let candidate = path.join(dir, `${base}.${date}.jsonl`);

  if (!fs.existsSync(candidate)) return candidate;

  for (let i = 1; i <= 9999; i++) {
    candidate = path.join(dir, `${base}.${date}.${i}.jsonl`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  // Fallback: use timestamp millis (extremely unlikely to collide)
  return path.join(dir, `${base}.${Date.now()}.jsonl`);
}

/**
 * Find all rotated files for a given base JSONL path.
 * Matches {stem}.*.jsonl in the same directory, sorted oldest-first by mtime.
 * @param {string} filePath  — the live (current) JSONL path
 * @returns {string[]}  — absolute paths, oldest first
 */
function findRotatedFiles(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath, '.jsonl');
  const liveBase = path.basename(filePath);

  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const pattern = new RegExp(`^${escapeRegex(base)}\\..+\\.jsonl$`);

  return entries
    .filter(name => name !== liveBase && pattern.test(name))
    .map(name => path.join(dir, name))
    .sort((a, b) => {
      try {
        return fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs;
      } catch {
        return 0;
      }
    });
}

/**
 * Escape special regex chars in a string (used for file-name matching).
 * @param {string} s
 * @returns {string}
 */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Prune oldest rotated files to stay within maxRotated.
 * @param {string} filePath — live JSONL path
 * @param {number} maxRotated
 */
function pruneOldRotated(filePath, maxRotated) {
  // Infinity explicitly preserves audit history and avoids directory scans.
  if (maxRotated === Infinity) return;
  const rotated = findRotatedFiles(filePath);
  const excess = rotated.length - maxRotated;
  if (excess <= 0) return;

  for (let i = 0; i < excess; i++) {
    try {
      fs.unlinkSync(rotated[i]);
    } catch {
      // best-effort; skip if already gone
    }
  }
}

/**
 * A directory lease is shared by native Windows and WSL producers on the same
 * volume. Never guess whether a foreign/stale PID is safe to evict. On bounded
 * contention, appenders publish an immutable archive instead of losing an event.
 * @param {string} filePath
 * @param {number} waitMs
 * @returns {null|(() => void)}
 */
function acquireWriterLease(filePath, waitMs) {
  const lockPath = `${filePath}.writer-lock`;
  const ownerPath = path.join(lockPath, 'owner.json');
  const token = randomUUID();
  const deadline = performance.now() + Math.min(1000, Math.max(0, Number.isFinite(waitMs) ? waitMs : 25));
  for (;;) {
    try {
      fs.mkdirSync(lockPath);
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      // Windows may report a directory pending deletion as EPERM rather than
      // EEXIST. Do not force the lease or change permissions; retain this event
      // in its own archive when the lease path is unavailable.
      if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') return null;
      if (code !== 'EEXIST') throw error;
      if (performance.now() >= deadline) return null;
      Atomics.wait(WAIT_CELL, 0, 0, Math.min(2, Math.max(0, deadline - performance.now())));
      continue;
    }
    try {
      fs.writeFileSync(ownerPath, JSON.stringify({ token, pid: process.pid, platform: process.platform }), { flag: 'wx' });
    } catch (error) {
      try { fs.rmdirSync(lockPath); } catch { /* do not remove unknown contents */ }
      throw error;
    }
    return () => {
      try {
        if (JSON.parse(fs.readFileSync(ownerPath, 'utf8')).token !== token) return;
        fs.unlinkSync(ownerPath);
        fs.rmdirSync(lockPath);
      } catch { /* an unavailable lease causes future events to use archives */ }
    };
  }
}

/**
 * Publish a complete event by rename. Temporary files are not JSONL archives.
 * Callers/readers must collect the active file AND findRotatedFiles(filePath).
 * Use maxRotated: Infinity when every audit event must be retained.
 * @param {string} filePath
 * @param {string} line
 * @param {string} reason
 */
function archiveEvent(filePath, line, reason) {
  const stem = path.basename(filePath, '.jsonl');
  const destination = path.join(path.dirname(filePath), `${stem}.${new Date().toISOString().slice(0, 10)}.${reason}.${randomUUID()}.jsonl`);
  const temporary = `${destination}.tmp`;
  let descriptor;
  let created = false;
  try {
    descriptor = fs.openSync(temporary, 'wx');
    created = true;
    fs.writeFileSync(descriptor, line, 'utf8');
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, destination);
  } catch (error) {
    if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch { /* retain original failure */ } }
    if (created) { try { fs.unlinkSync(temporary); } catch { /* retain original failure */ } }
    throw error;
  }
  return { status: 'archived', reason, path: destination };
}

/** Atomic rename only; copy/delete can lose writes and is not a safe fallback.
 * @param {string} filePath
 * @param {{maxRotated: number}} opts
 * @returns {{rotated: true}|{rotated: false, code: string}}
 */
function rotateAtomically(filePath, opts) {
  if (!fs.existsSync(filePath)) return { rotated: false, code: 'ENOENT' };
  try { fs.renameSync(filePath, buildRotatePath(filePath)); } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    // Keep the filesystem identity without returning arbitrary exception text.
    return { rotated: false, code: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'UNKNOWN' };
  }
  pruneOldRotated(filePath, opts.maxRotated);
  return { rotated: true };
}

/** @param {string} filePath
 * @param {{maxBytes: number, maxEntries: number}} opts
 * @param {number} [incomingBytes]
 */
function coordinatedRotationNeeded(filePath, opts, incomingBytes = 0) {
  const bytes = fileBytes(filePath);
  return bytes >= opts.maxBytes || (bytes > 0 && bytes + incomingBytes > opts.maxBytes)
    || (Number.isFinite(opts.maxEntries) && countLines(filePath) >= opts.maxEntries);
}

/** @param {string} filePath
 * @param {string} line
 * @param {ReturnType<typeof resolveOpts>} opts
 */
function appendCoordinated(filePath, line, opts) {
  const incomingBytes = Buffer.byteLength(line, 'utf8');
  if (incomingBytes > opts.maxBytes) return archiveEvent(filePath, line, 'oversized');
  const release = acquireWriterLease(filePath, opts.lockTimeoutMs);
  if (!release) return archiveEvent(filePath, line, 'lease-unavailable');
  try {
    if (coordinatedRotationNeeded(filePath, opts, incomingBytes)) {
      const rotation = rotateAtomically(filePath, opts);
      if (rotation.rotated === false) return {
        ...archiveEvent(filePath, line, 'rotation-unavailable'),
        diagnostic: {
          subsystem: 'jsonl-rotate', operation: 'rename', phase: 'rotation', resource: filePath,
          code: rotation.code, message: 'Active log rotation failed; incoming event preserved in an archive.',
          recovery: 'Read the active log and archives; inspect the filesystem error before retrying rotation.',
          proof_plane: 'runtime-artifact',
        },
      };
    }
    fs.appendFileSync(filePath, line, 'utf8');
    return { status: 'appended', path: filePath };
  } finally { release(); }
}

/**
 * Perform an immediate rotation of filePath.
 * Renames the live file to a dated archive, then prunes excess rotated files.
 * After this call, filePath does NOT exist — the next appendJsonl will create it fresh.
 *
 * @param {string} filePath
 * @param {{maxRotated: number}} opts
 */
function rotate(filePath, opts) {
  if (!fs.existsSync(filePath)) return; // nothing to rotate

  const dest = buildRotatePath(filePath);
  try {
    fs.renameSync(filePath, dest);
  } catch {
    // If rename fails (e.g. cross-device), fall back to copy+delete
    try {
      fs.copyFileSync(filePath, dest);
      fs.unlinkSync(filePath);
    } catch {
      return; // give up — don't corrupt the live file
    }
  }

  pruneOldRotated(filePath, opts.maxRotated);
}

/**
 * Check whether filePath needs rotation and rotate if so.
 * Returns true if a rotation was performed.
 *
 * @param {string} filePath
 * @param {object} [opts]
 * @param {number} [opts.maxEntries=10000]
 * @param {number} [opts.maxBytes=5242880]
 * @param {number} [opts.maxRotated=3]
 * @returns {boolean}
 */
function rotateIfNeeded(filePath, opts) {
  const o = resolveOpts(opts);

  if (!fs.existsSync(filePath)) return false;

  if (o.coordinated) {
    const release = acquireWriterLease(filePath, o.lockTimeoutMs);
    if (!release) return false;
    try { return coordinatedRotationNeeded(filePath, o) && rotateAtomically(filePath, o).rotated; }
    finally { release(); }
  }

  const bytes = fileBytes(filePath);
  if (bytes >= o.maxBytes) {
    rotate(filePath, o);
    return true;
  }

  if (Number.isFinite(o.maxEntries) && countLines(filePath) >= o.maxEntries) {
    rotate(filePath, o);
    return true;
  }

  return false;
}

/**
 * Serialize entry as a JSON line and append it to filePath.
 * Rotates first if the file is at or over the configured limits.
 * Ensures the parent directory exists before writing.
 *
 * @param {string} filePath
 * @param {object} entry — must be JSON-serializable
 * @param {object} [opts]
 * @param {number} [opts.maxEntries=10000]
 * @param {number} [opts.maxBytes=5242880]
 * @param {number} [opts.maxRotated=3]
 * @param {boolean} [opts.coordinated=false] All producers of a shared file must opt in together.
 * @param {number} [opts.lockTimeoutMs=25] Bounded wait before publishing a complete archive.
 */
function appendJsonl(filePath, entry, opts) {
  const o = resolveOpts(opts);
  const serialized = JSON.stringify(entry);
  if (serialized === undefined) throw new TypeError('JSONL entry must be JSON-serializable');
  const line = serialized + '\n';

  // Ensure parent directory exists
  const dir = path.dirname(filePath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // already exists or unrecoverable — attempt write anyway
  }

  if (o.coordinated) return appendCoordinated(filePath, line, o);

  // Rotate BEFORE appending so the entry lands in the fresh file
  rotateIfNeeded(filePath, o);

  fs.appendFileSync(filePath, line, 'utf8');
}

module.exports = { appendJsonl, rotateIfNeeded, rotate, countLines, fileBytes, findRotatedFiles };
