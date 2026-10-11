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
 * Resolution layers for the OS module tree (used by every plugin hook that
 * loads an OS module):
 *   1. <CLAUDE_PLUGIN_DATA>/vendor/lib/os — synced vendored copy (stable dir)
 *   2. <CLAUDE_PLUGIN_ROOT>/vendor/lib/os — installed plugin cache
 *   3. <__dirname>/../vendor/lib/os       — source-tree fallback
 *
 * The project directory is never a layer (BL-404): the plugin ships publicly,
 * so loading <cwd>/lib/os would run any opened repo's code at SessionStart and
 * on tool calls. A project that manages its own OS wires its own hooks, and
 * isProjectManaged() makes the plugin's os-boot/os-accounting defer to them.
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
 * Returns { root, source } where source is 'plugin-data' | 'plugin-root' |
 * 'plugin-dirname', or null when the plugin carries no OS tree.
 *
 * @param {string} [_cwd] - ignored; kept so existing callers stay valid
 * @returns {{root: string, source: string} | null}
 */
function resolveOsRoot(_cwd) {
  // The runtime sets both as absolute paths. A relative value would resolve
  // against the project cwd, so it is ignored.
  const dataDir = process.env.CLAUDE_PLUGIN_DATA;
  const rootDir = process.env.CLAUDE_PLUGIN_ROOT;
  const candidates = [
    dataDir && path.isAbsolute(dataDir)
      ? { root: path.join(dataDir, 'vendor'), source: 'plugin-data' }
      : null,
    rootDir && path.isAbsolute(rootDir)
      ? { root: path.join(rootDir, 'vendor'), source: 'plugin-root' }
      : null,
    { root: path.join(__dirname, '..', 'vendor'), source: 'plugin-dirname' },
  ].filter(Boolean);

  for (const cand of candidates) {
    if (fs.existsSync(path.join(cand.root, 'lib', 'os', 'index.cjs'))) return cand;
  }
  return null;
}

/**
 * Absolute path of a module inside the plugin's OS tree, e.g.
 * resolveOsModule('services', 'ipc.cjs'), or null when the plugin carries no
 * OS tree. Callers treat null as "feature unavailable" and skip it.
 *
 * @param {...string} segments - path under lib/os
 * @returns {string | null}
 */
function resolveOsModule(...segments) {
  const osRoot = resolveOsRoot();
  return osRoot ? path.join(osRoot.root, 'lib', 'os', ...segments) : null;
}

/**
 * resolveOsModule(), gated on the project carrying the same module at
 * <cwd>/lib/os/<segments>. The project file is only stat()ed, never loaded:
 * it keeps hooks that used to load <cwd>/lib/os inert in projects without an
 * OS tree, while the code that runs is always the plugin's copy (BL-404).
 *
 * @param {string} cwd - project root
 * @param {...string} segments - path under lib/os
 * @returns {string | null}
 */
function resolveOsModuleIfProjectHas(cwd, ...segments) {
  if (!fs.existsSync(path.join(cwd || process.cwd(), 'lib', 'os', ...segments))) return null;
  return resolveOsModule(...segments);
}

module.exports = { isProjectManaged, resolveOsRoot, resolveOsModule, resolveOsModuleIfProjectHas };
