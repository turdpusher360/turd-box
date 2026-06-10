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
 */

const fs = require('fs');
const path = require('path');

/** @type {Readonly<{maxEntries: number, maxBytes: number, maxRotated: number}>} */
const DEFAULT_OPTS = Object.freeze({
  maxEntries: 10_000,
  maxBytes: 5 * 1024 * 1024, // 5 MB
  maxRotated: 3,
});

/**
 * Resolve full options, merging caller opts with defaults.
 * @param {object|undefined} opts
 * @returns {{maxEntries: number, maxBytes: number, maxRotated: number}}
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

  const bytes = fileBytes(filePath);
  if (bytes >= o.maxBytes) {
    rotate(filePath, o);
    return true;
  }

  const lines = countLines(filePath);
  if (lines >= o.maxEntries) {
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
 */
function appendJsonl(filePath, entry, opts) {
  const o = resolveOpts(opts);

  // Ensure parent directory exists
  const dir = path.dirname(filePath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // already exists or unrecoverable — attempt write anyway
  }

  // Rotate BEFORE appending so the entry lands in the fresh file
  rotateIfNeeded(filePath, o);

  const line = JSON.stringify(entry) + '\n';
  fs.appendFileSync(filePath, line, 'utf8');
}

module.exports = { appendJsonl, rotateIfNeeded, rotate, countLines, fileBytes, findRotatedFiles };
