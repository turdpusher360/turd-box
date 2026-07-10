'use strict';

/**
 * backup-staleness.cjs
 *
 * Boot-time tripwire for the backup pipeline (R-01a, upstream recurring-failures
 * register, `_runs/s547/recurring-failures-register.md`). `backup.sh` was
 * written ~Feb 2026 and never ran successfully on a schedule; PR #412
 * (repair) is still unmerged and the crontab carries zero backup/pg_dump
 * entries as of upstream. ABSENCE of backup artifacts IS the signal this
 * tripwire exists to surface -- it is expected to fire RED on the live repo
 * today, and that is the point: the gap has been invisible for 25+ sessions.
 *
 * Fail-open by design: only an unexpected internal throw returns the silent
 * null-shape. A confirmed "no backups exist" or "backups are stale" result
 * is a real, loud warning -- suppressing that would defeat the tripwire.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_AGE_DAYS = 7;
const DEFAULT_DIRS = ['_runs/backups'];
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Read `.4ge-config.json` at repoRoot and return `backup.artifact_dirs` if
 * it is a non-empty array of strings. Fail-open: any read/parse error or
 * unexpected shape returns null.
 *
 * @param {string} repoRoot
 * @returns {string[]|null}
 */
function readConfiguredDirs(repoRoot) {
  try {
    const configPath = path.join(repoRoot, '.4ge-config.json');
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    const dirs = parsed && parsed.backup && parsed.backup.artifact_dirs;
    if (Array.isArray(dirs) && dirs.length > 0 && dirs.every((d) => typeof d === 'string')) {
      return dirs;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Recursively walk a directory and return the mtimeMs of every regular file
 * found beneath it. Guarded per-entry: any stat/readdir error on a subpath
 * is skipped rather than thrown, so one unreadable entry cannot blank the
 * whole scan.
 *
 * @param {string} dirPath
 * @returns {number[]} mtimeMs values of files found
 */
function collectFileMtimes(dirPath) {
  const mtimes = [];
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return mtimes;
  }
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    try {
      if (entry.isDirectory()) {
        mtimes.push(...collectFileMtimes(entryPath));
      } else if (entry.isFile()) {
        mtimes.push(fs.statSync(entryPath).mtimeMs);
      }
    } catch {
      // guarded per-entry -- skip and keep scanning
    }
  }
  return mtimes;
}

/**
 * Check backup artifact staleness across one or more directories.
 *
 * Directory resolution order: `opts.dirs` -> `.4ge-config.json`
 * `backup.artifact_dirs` (fail-open read) -> default `['_runs/backups']`.
 * Relative entries resolve against `repoRoot`; absolute entries pass through.
 *
 * @param {{
 *   repoRoot?: string,
 *   dirs?: string[],
 *   maxAgeDays?: number,
 *   now?: number|Date,
 * }} [opts]
 * @returns {{
 *   warning: string|null,
 *   newestAgeDays: number|null,
 *   scannedDirs: string[]|null,
 *   fileCount: number|null,
 * }}
 */
function checkBackupStaleness(opts) {
  const options = opts || {};
  const NULL_SHAPE = { warning: null, newestAgeDays: null, scannedDirs: null, fileCount: null };

  try {
    const repoRoot = options.repoRoot || process.cwd();
    const maxAgeDays = Number.isFinite(options.maxAgeDays) ? options.maxAgeDays : DEFAULT_MAX_AGE_DAYS;
    const now = options.now instanceof Date
      ? options.now.getTime()
      : Number.isFinite(options.now)
        ? options.now
        : Date.now();

    let dirs = Array.isArray(options.dirs) && options.dirs.length > 0 ? options.dirs : null;
    if (!dirs) dirs = readConfiguredDirs(repoRoot);
    if (!dirs) dirs = DEFAULT_DIRS;

    const resolvedDirs = dirs.map((d) => (path.isAbsolute(d) ? d : path.join(repoRoot, d)));

    let allMtimes = [];
    for (const dir of resolvedDirs) {
      try {
        if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
          allMtimes = allMtimes.concat(collectFileMtimes(dir));
        }
      } catch {
        // guarded per-dir -- skip and keep scanning the rest
      }
    }

    const fileCount = allMtimes.length;

    if (fileCount === 0) {
      return {
        warning:
          `no backup artifacts found under ${resolvedDirs.join(', ')} — backup pipeline has ` +
          `never run on a schedule (PR#412 unmerged, no crontab entry; see operator packet)`,
        newestAgeDays: null,
        scannedDirs: resolvedDirs,
        fileCount: 0,
      };
    }

    const newestMtime = Math.max(...allMtimes);
    // Clamp at 0: a just-written file's mtime can land a few ms AFTER Date.now()
    // (kernel coarse-clock skew), and Math.floor of that tiny negative age
    // yields -1 — seen as a CI-only flake in the fresh-file test 2026-07-10.
    const newestAgeDays = Math.max(0, Math.floor((now - newestMtime) / MS_PER_DAY));

    if (newestAgeDays > maxAgeDays) {
      return {
        warning: `newest backup artifact is ${newestAgeDays}d old (>${maxAgeDays}d) — backup schedule appears dead`,
        newestAgeDays,
        scannedDirs: resolvedDirs,
        fileCount,
      };
    }

    return { warning: null, newestAgeDays, scannedDirs: resolvedDirs, fileCount };
  } catch {
    // Fail-open: a tripwire must never break boot.
    return NULL_SHAPE;
  }
}

module.exports = {
  checkBackupStaleness,
  readConfiguredDirs,
  collectFileMtimes,
  DEFAULT_MAX_AGE_DAYS,
  DEFAULT_DIRS,
};
