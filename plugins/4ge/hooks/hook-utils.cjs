#!/usr/bin/env node
/**
 * Shared utilities for forge plugin hooks.
 *
 * Provides readStdinJson() with a 5-second timeout to prevent Windows stdin hangs,
 * and parseToolInput() for safe access to tool_input fields.
 *
 * Usage:
 *   const { readStdinJson, parseToolInput } = require('./hook-utils.cjs');
 */

'use strict';

// Safety net: ensure this process exits within 30s even if parent CC dies.
// Prevents zombie hooks when teammate/subagent processes are terminated on
// Windows (TerminateProcess doesn't propagate to grandchild hook processes).
// unref() means this timer alone won't keep a healthy process alive.
const _selfDestruct = setTimeout(() => process.exit(0), 30000);
_selfDestruct.unref();

const MAX_STDIN = 1024 * 1024; // 1MB limit

/**
 * Read and parse JSON from stdin with a configurable timeout.
 * Resolves to {} on timeout, error, or malformed input — hooks never crash.
 *
 * @param {object} [options]
 * @param {number} [options.timeoutMs=5000] - Milliseconds before timeout resolves
 * @param {number} [options.maxSize=1048576] - Max stdin bytes to buffer
 * @returns {Promise<object>}
 */
function readStdinJson(options = {}) {
  const { timeoutMs = 5000, maxSize = MAX_STDIN } = options;

  return new Promise((resolve) => {
    let data = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        process.stdin.removeAllListeners('data');
        process.stdin.removeAllListeners('end');
        process.stdin.removeAllListeners('error');
        if (process.stdin.unref) process.stdin.unref();
        try {
          resolve(data.trim() ? JSON.parse(data) : {});
        } catch {
          resolve({});
        }
      }
    }, timeoutMs);

    process.stdin.setEncoding('utf8');

    process.stdin.on('data', chunk => {
      data += chunk;
      if (data.length > maxSize) {
        data = data.slice(0, maxSize);
      }
    });

    process.stdin.on('end', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        resolve(data.trim() ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });

    process.stdin.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({});
    });
  });
}

/**
 * Safely extract a nested field from the parsed hook input.
 * Mirrors the tool_input?.field access pattern used throughout hooks.
 *
 * @param {object} input - Parsed stdin JSON
 * @param {string} field - Field name within tool_input
 * @param {*} [defaultValue=''] - Fallback if field is missing
 * @returns {*}
 */
function parseToolInput(input, field, defaultValue = '') {
  return (input && input.tool_input && input.tool_input[field] !== undefined)
    ? input.tool_input[field]
    : defaultValue;
}

/**
 * Schedule a hard exit(0) after `ms` — keeps a wedged hook from blocking
 * the harness. unref()'d so it never keeps a healthy process alive.
 * (Additive: mirror of lib/hook-utils.cjs enforceTimeout for the
 * plugin-managed OS hooks.)
 *
 * @param {number} ms
 */
function enforceTimeout(ms) {
  setTimeout(() => process.exit(0), ms).unref();
}

// Cache for deriveNextHandoffNumber keyed by _runs/ dir mtime.
const _nextHandoffNumCache = new Map();

// A shipped handoff name: HANDOFF-S<N>.md (optional letter suffix) or
// HANDOFF-S<N>-<8 hex session id>.md (optional -R<k> round). Same rule as
// lib/hook-utils.cjs.
const SHIPPED_HANDOFF_RE = /^HANDOFF-S\d+[a-z]?(?:-[0-9a-f]{8}(?:-R\d+)?)?\.md$/i;

/**
 * Derive the next durable handoff number from _runs/HANDOFF-S*.md names: a
 * shipped handoff SN (SHIPPED_HANDOFF_RE) contributes N + 1, a pickup (name
 * ends -PICKUP.md, any case) contributes N, and any other HANDOFF-S name (a
 * mid-session wrap, notes or topic file) contributes nothing. Returns the max
 * contribution, or 1 when no handoffs exist (fresh installs). Cached per
 * _runs/ mtime.
 * (Additive: mirror of lib/hook-utils.cjs deriveNextHandoffNumber. The
 * returned value is a closeout candidate, not proof that the current
 * runtime session owns a durable S-number.)
 *
 * @param {string} [repoRoot=process.cwd()] - Project root containing _runs/
 * @returns {number}
 */
function deriveNextHandoffNumber(repoRoot) {
  const path = require('node:path');
  const fs = require('node:fs');
  const root = repoRoot || process.cwd();
  const runsDir = path.join(root, '_runs');

  try {
    const mtime = fs.statSync(runsDir).mtimeMs;
    const cached = _nextHandoffNumCache.get(runsDir);
    if (cached && cached.mtime === mtime) return cached.result;
  } catch { /* _runs missing — fall through */ }

  let maxShipped = 0;
  let maxPickup = 0;
  try {
    for (const entry of fs.readdirSync(runsDir)) {
      const m = entry.match(/^HANDOFF-S(\d+)/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (!Number.isFinite(n)) continue;
        if (/-PICKUP\.md$/i.test(entry)) {
          if (n > maxPickup) maxPickup = n;
        } else if (n > maxShipped && SHIPPED_HANDOFF_RE.test(entry)) {
          maxShipped = n;
        }
      }
    }
    try {
      const mtime = fs.statSync(runsDir).mtimeMs;
      _nextHandoffNumCache.set(runsDir, { mtime, result: Math.max(maxShipped + 1, maxPickup) });
    } catch { /* best-effort cache */ }
  } catch { /* no _runs dir */ }
  return Math.max(maxShipped + 1, maxPickup);
}

/**
 * Legacy alias retained for existing hook consumers (os-boot).
 * Prefer deriveNextHandoffNumber() for new code.
 */
function deriveSessionNumber(repoRoot) {
  return deriveNextHandoffNumber(repoRoot);
}

module.exports = { readStdinJson, parseToolInput, enforceTimeout, deriveNextHandoffNumber, deriveSessionNumber };
