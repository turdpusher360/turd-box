#!/usr/bin/env node
/**
 * Shared forge state utilities for plugin hooks.
 * Resolves state directory from CLAUDE_PLUGIN_DATA with _runs/ fallback.
 * Provides atomic migration for first-access state file moves.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Resolve the forge state directory.
 * Uses ${CLAUDE_PLUGIN_DATA}/forge/ if available, falls back to _runs/.
 *
 * @returns {string} Absolute path to forge state directory
 */
function resolveForgeStateDir() {
  const pluginData = process.env.CLAUDE_PLUGIN_DATA;
  if (pluginData) {
    const forgeDir = path.join(pluginData, 'forge');
    try {
      if (!fs.existsSync(forgeDir)) fs.mkdirSync(forgeDir, { recursive: true });
      return forgeDir;
    } catch {
      // Plugin data dir not writable — fall back to _runs/
    }
  }
  return path.join(process.cwd(), '_runs');
}

/**
 * Atomic migration: copy old file to new location if not already migrated.
 * Uses .migrating temp file + rename for atomicity. tmpPath and newPath share
 * the same directory, so renameSync is always on the same filesystem (no EXDEV).
 *
 * @param {string} oldPath - Source path (old location)
 * @param {string} newPath - Destination path (new location)
 */
function migrateIfNeeded(oldPath, newPath) {
  if (!fs.existsSync(oldPath) || fs.existsSync(newPath)) return;
  const tmpPath = newPath + '.migrating';
  try {
    fs.copyFileSync(oldPath, tmpPath);
    fs.renameSync(tmpPath, newPath); // atomic — tmpPath and newPath are in the same directory
    process.stderr.write(`[forge] Migrated state: ${path.basename(oldPath)} -> plugin data dir\n`);
  } catch {
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort tmpfile cleanup */ }
  }
}

module.exports = { resolveForgeStateDir, migrateIfNeeded };
