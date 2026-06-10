'use strict';
/**
 * atomic-write.cjs — Atomic file-write helpers for plugin state files.
 *
 * Centralizes the tmp+rename pattern that was duplicated across:
 *   - tool-ring.cjs  (trimFile)
 *   - hud-reactive.cjs  (recordRender)
 *   - companion-state.cjs  (saveState)
 *
 * Extracted in S303 C8 after the Windows EPERM race in hud-reactive's
 * recordRender was traced to duplicated implementations — one site had a
 * retry guard, the others didn't. Centralizing means the guard lives once.
 *
 * ## Why tmp+rename?
 * A direct `writeFileSync(target, data)` is NOT atomic: a concurrent reader
 * may see an empty or half-written file if the write is interrupted. The
 * tmp+rename pattern is atomic on POSIX (rename(2) is atomic per POSIX.1).
 * On Windows it is best-effort — rename can fail with EPERM when another
 * process has the target file open (file-handle race). The retry below
 * handles the common case.
 *
 * ## Fallback policy
 * If tmp+rename fails after retrying, fall back to a direct write. Silent
 * data loss (no write at all) is worse than a briefly inconsistent file.
 * Callers that cannot tolerate any inconsistency should handle errors at
 * the call site.
 */

const fs   = require('node:fs');
const path = require('node:path');

/**
 * Sleep synchronously for `ms` milliseconds using a spin-wait.
 * Used only in the EPERM retry path (one call, 5ms max).
 * Not safe for long durations — 100 hook budget budget would expire.
 */
function spinWaitMs(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* spin */ }
}

/**
 * writeFileAtomic — sync atomic write via tmp+rename.
 *
 * @param {string} targetPath   Destination file path.
 * @param {string|Buffer} content  Data to write.
 * @param {object} [opts]
 * @param {string} [opts.encoding='utf8']  Encoding passed to writeFileSync.
 *
 * Behaviour:
 *   1. Writes `targetPath.${process.pid}.tmp`
 *   2. Renames tmp → target (atomic on POSIX, best-effort on Windows)
 *   3. On Windows EPERM: retries rename once after 5 ms
 *   4. If rename still fails: falls back to direct writeFileSync on target
 *   5. Never throws — all errors are swallowed (callers use best-effort pattern)
 */
function writeFileAtomic(targetPath, content, opts) {
  const encoding = (opts && opts.encoding) || 'utf8';
  const tmp = `${targetPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, content, encoding);
    try {
      fs.renameSync(tmp, targetPath);
    } catch (renameErr) {
      // Windows EPERM: file-handle race — another process may have the target
      // open for reading. Retry once after a short yield.
      if (renameErr.code === 'EPERM') {
        spinWaitMs(5);
        try {
          fs.renameSync(tmp, targetPath);
        } catch {
          // Retry also failed — fall back to direct write to avoid data loss.
          // The tmp file still contains the correct content; write it directly.
          try {
            fs.writeFileSync(targetPath, content, encoding);
          } catch { /* best-effort */ }
          // Clean up tmp if it exists
          try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        }
      } else {
        // Non-EPERM failure (e.g. EXDEV cross-device rename) — direct fallback
        try {
          fs.writeFileSync(targetPath, content, encoding);
        } catch { /* best-effort */ }
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      }
    }
  } catch { /* writeFileSync on tmp failed — nothing we can do */ }
}

/**
 * appendFileAtomic — sync append with O_APPEND atomicity.
 *
 * A direct `appendFileSync` with the default flags already uses O_APPEND,
 * which is atomic at the OS level for small writes — concurrent appenders
 * each get their bytes written without clobbering each other.
 *
 * This wrapper exists for API symmetry and to centralise the encoding default.
 *
 * @param {string} targetPath
 * @param {string|Buffer} content
 * @param {object} [opts]
 * @param {string} [opts.encoding='utf8']
 */
function appendFileAtomic(targetPath, content, opts) {
  const encoding = (opts && opts.encoding) || 'utf8';
  try {
    fs.appendFileSync(targetPath, content, encoding);
  } catch { /* best-effort */ }
}

module.exports = { writeFileAtomic, appendFileAtomic };
