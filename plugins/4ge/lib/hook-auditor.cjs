// plugins/4ge/lib/hook-auditor.cjs
'use strict';

const fs = require('fs');
const path = require('path');

const SHARED_UTILS = [
  'hook-utils.cjs',
  'memory-capture-utils.cjs',
  'ollama-utils.cjs',
  'session-end-git.cjs',
  'session-end-tasking.cjs',
  'forge-utils.cjs',
  '4ge-hook-utils.cjs',
  '4ge-hook-utils-v2.cjs',
];

/**
 * Extracts hook filenames referenced in settings.json.
 * @param {string} settingsPath - Absolute path to .claude/settings.json
 * @returns {Set<string>} Set of hook filenames (basename only, e.g. 'aisle-gate.cjs')
 */
function extractWiredHooks(settingsPath) {
  if (!fs.existsSync(settingsPath)) return new Set();

  let settings;
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    // Strip // line comments before parsing (settings.json allows them)
    const clean = raw.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    settings = JSON.parse(clean);
  } catch {
    return new Set();
  }

  const wired = new Set();
  const hooks = settings.hooks || {};

  for (const event of Object.values(hooks)) {
    if (!Array.isArray(event)) continue;
    for (const matcher of event) {
      const hookList = matcher.hooks || [matcher];
      for (const h of hookList) {
        const cmd = h.command || '';
        // Match the last path segment ending in .cjs
        const match = cmd.match(/[\\/]([^/\\\s]+\.cjs)/);
        if (match) wired.add(match[1]);
      }
    }
  }

  return wired;
}

/**
 * Finds .cjs hook files in .claude/hooks/ that are not wired in settings.json.
 * Excludes known shared utility files that are never wired directly.
 *
 * @param {string} root - Project root directory
 * @returns {string[]} Array of unwired hook filenames
 */
function findUnwiredHooks(root) {
  const hooksDir = path.join(root, '.claude', 'hooks');
  const settingsPath = path.join(root, '.claude', 'settings.json');

  if (!fs.existsSync(hooksDir)) return [];

  const files = fs.readdirSync(hooksDir).filter(f => f.endsWith('.cjs'));
  const wired = extractWiredHooks(settingsPath);

  return files.filter(f => !wired.has(f) && !SHARED_UTILS.includes(f));
}

/**
 * Finds wired entries in settings.json that point to hook files that do not exist on disk.
 *
 * @param {string} root - Project root directory
 * @returns {string[]} Array of orphaned hook filenames
 */
function findOrphanedWirings(root) {
  const settingsPath = path.join(root, '.claude', 'settings.json');
  const wired = extractWiredHooks(settingsPath);
  const orphaned = [];

  for (const hookFile of wired) {
    const absPath = path.join(root, '.claude', 'hooks', hookFile);
    if (!fs.existsSync(absPath)) {
      orphaned.push(hookFile);
    }
  }

  return orphaned;
}

/**
 * Full audit: returns both unwired hooks and orphaned wirings.
 *
 * @param {string} root - Project root directory
 * @returns {{ unwired: string[], orphaned: string[] }}
 */
function auditHooks(root) {
  return {
    unwired: findUnwiredHooks(root),
    orphaned: findOrphanedWirings(root),
  };
}

module.exports = { findUnwiredHooks, findOrphanedWirings, auditHooks, extractWiredHooks };
