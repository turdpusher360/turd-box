#!/usr/bin/env node
/**
 * os-guard.cjs — collision guard for plugin-managed Agentic OS hooks. [D3]
 *
 * The 4ge plugin vendors the Agentic OS (plugins/4ge/vendor/) and wires
 * os-boot/os-accounting via plugin hooks.json. Projects that manage their
 * own OS (the source monorepo itself, or any Blueprint-installed project)
 * wire the SAME hooks via the project's .claude/settings.json — so both
 * would fire in one session.
 *
 * Precedence rule: the PROJECT-managed OS always wins. This module gives
 * plugin hooks a cheap, deterministic, order-independent check; the
 * PID boot-sentinel remains the second line of defense for same-harness
 * double-boot.
 *
 * Resolution layers for the OS module tree (used by plugin os-boot):
 *   1. <cwd>/lib/os                       — project-managed source of truth
 *   2. <CLAUDE_PLUGIN_DATA>/vendor/lib/os — synced vendored copy (stable dir)
 *   3. <CLAUDE_PLUGIN_ROOT>/vendor/lib/os — installed plugin cache
 *   4. <__dirname>/../vendor/lib/os       — source-tree fallback
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * True when the project's own .claude/settings.json wires a hook whose
 * command mentions `hookName` (e.g. 'os-boot', 'os-accounting') under any
 * hook event. Read is best-effort: unreadable/absent settings → false.
 *
 * @param {string} cwd - project root
 * @param {string} hookName - substring to look for in hook commands
 * @returns {boolean}
 */
function isProjectManaged(cwd, hookName) {
  try {
    const settingsPath = path.join(cwd || process.cwd(), '.claude', 'settings.json');
    if (!fs.existsSync(settingsPath)) return false;
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const hooks = settings && settings.hooks;
    if (!hooks || typeof hooks !== 'object') return false;
    for (const matchers of Object.values(hooks)) {
      if (!Array.isArray(matchers)) continue;
      for (const matcher of matchers) {
        const entries = (matcher && matcher.hooks) || [];
        for (const entry of entries) {
          if (entry && typeof entry.command === 'string' && entry.command.includes(hookName)) {
            return true;
          }
        }
      }
    }
    return false;
  } catch {
    // Unreadable settings — assume not project-managed rather than
    // disabling the plugin OS for a parse hiccup.
    return false;
  }
}

/**
 * Resolve the root of the OS module tree (the directory that CONTAINS
 * lib/os, lib/aisle, scripts/pin-hooks.cjs with source geometry).
 *
 * Returns { root, source } where source is 'project' | 'plugin-data' |
 * 'plugin-root' | 'plugin-dirname', or null when no OS tree exists.
 *
 * @param {string} cwd - project root
 * @returns {{root: string, source: string} | null}
 */
function resolveOsRoot(cwd) {
  const projectRoot = cwd || process.cwd();
  const candidates = [
    { root: projectRoot, source: 'project' },
    process.env.CLAUDE_PLUGIN_DATA
      ? { root: path.join(process.env.CLAUDE_PLUGIN_DATA, 'vendor'), source: 'plugin-data' }
      : null,
    process.env.CLAUDE_PLUGIN_ROOT
      ? { root: path.join(process.env.CLAUDE_PLUGIN_ROOT, 'vendor'), source: 'plugin-root' }
      : null,
    { root: path.join(__dirname, '..', 'vendor'), source: 'plugin-dirname' },
  ].filter(Boolean);

  for (const cand of candidates) {
    if (fs.existsSync(path.join(cand.root, 'lib', 'os', 'index.cjs'))) return cand;
  }
  return null;
}

module.exports = { isProjectManaged, resolveOsRoot };
