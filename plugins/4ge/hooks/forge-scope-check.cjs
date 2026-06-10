#!/usr/bin/env node
/**
 * PreToolUse Hook: forge-scope-check
 *
 * Warns when a file write targets a path outside any active
 * teammate's assigned scope during a forge session.
 * Fast exit when no .forge-session.json exists (<1ms).
 *
 * Exit codes:
 * - 0: Always (warn only)
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readStdinJson, parseToolInput } = require('./hook-utils.cjs');

const SESSION_FILE = '.forge-session.json';

const DRIFT_THRESHOLD = 3;

// Lazy-load rotation utility — falls back to plain appendFileSync if unavailable
function safeAppendJsonl(filePath, entry) {
  try {
    const { appendJsonl } = require(path.join(process.cwd(), 'lib', 'os', 'jsonl-rotate.cjs'));
    appendJsonl(filePath, entry);
  } catch {
    try { fs.appendFileSync(filePath, JSON.stringify(entry) + '\n'); } catch { /* best effort */ }
  }
}

/**
 * Normalize a path or scope-prefix to a common comparison axis: absolute,
 * forward-slashed, lowercased.
 *
 * Teammate scopes are declared RELATIVE to the project root ("src/components/**"),
 * but the Edit/Write tools pass ABSOLUTE file_paths ("/proj/src/components/Foo.tsx").
 * Resolving both against process.cwd() (the project root at hook runtime) puts them
 * on the same axis so prefix matching works. Without this, an absolute path never
 * startsWith a relative prefix, so the check warned on EVERY legitimate in-scope
 * write — a meaningless always-firing signal. See ADR-SEC-002.
 *
 * @param {string} p - Absolute or project-relative path / scope prefix.
 * @returns {string} Absolute, forward-slashed, lowercased path.
 */
function toScopeAxis(p) {
  return path.resolve(process.cwd(), p).replace(/\\/g, '/').toLowerCase();
}

function checkScope(filePath, session) {
  if (!filePath || !session || !session.teammates) return;

  const activeTeammates = session.teammates.filter(t => t.status === 'active');

  // If no active teammates have scopes configured, skip the check entirely
  const anyHasScope = activeTeammates.some(t => (t.scope || []).length > 0);
  if (!anyHasScope) return;

  const fileAxis = toScopeAxis(filePath);

  for (const teammate of activeTeammates) {
    for (const scopeGlob of (teammate.scope || [])) {
      // Strip the first wildcard segment onward → a literal directory/file prefix.
      const rawPrefix = scopeGlob.replace(/\*.*$/, '');
      if (!rawPrefix) continue; // pure-wildcard / suffix glob carries no usable prefix
      const prefixAxis = toScopeAxis(rawPrefix);
      // Exact-file scope — literal file path (no wildcard was stripped).
      if (fileAxis === prefixAxis) return;
      // Directory-prefix scope — enforce a "/" boundary so src/comp does not match
      // src/completely-different/.
      const dirPrefix = prefixAxis.endsWith('/') ? prefixAxis : prefixAxis + '/';
      if (fileAxis.startsWith(dirPrefix)) return; // inside scope
    }
  }

  const scopes = activeTeammates
    .map(t => (t.scope || []).join(', '))
    .join('; ');

  return `[forge-scope-check] File "${filePath}" is outside active teammate scopes (${scopes}). Verify this edit is intentional.`;
}

/**
 * Checks if a file path is within the assigned scope for a teammate.
 *
 * @param {string} filePath - File being written/edited
 * @param {string} teammateName - Name of the teammate
 * @param {object} session - Forge session with teammates array
 * @returns {{ inScope: boolean, scope: string[] }}
 */
function checkScopeDrift(filePath, teammateName, session) {
  const teammate = (session.teammates || []).find(t => t.name === teammateName);
  if (!teammate || !teammate.scope || teammate.scope.length === 0) {
    return { inScope: true, scope: [] };
  }

  const inScope = teammate.scope.some(scopePrefix => filePath.startsWith(scopePrefix));

  if (!inScope) {
    // Log drift to JSONL — best effort, rotation-bounded
    try {
      const driftPath = path.join(process.cwd(), '_runs', 'scope-drift.jsonl');
      safeAppendJsonl(driftPath, {
        timestamp: new Date().toISOString(),
        teammate: teammateName,
        file: filePath,
        scope: teammate.scope,
      });
    } catch { /* best effort logging */ }
  }

  return { inScope, scope: teammate.scope };
}

/**
 * Increments the drift violation counter for a named teammate.
 *
 * @param {object} counters - Mutable counter map keyed by teammate name
 * @param {string} teammateName - Name of the teammate
 */
function incrementDriftCounter(counters, teammateName) {
  counters[teammateName] = (counters[teammateName] || 0) + 1;
}

/**
 * Returns the current drift violation count for a named teammate.
 *
 * @param {object} counters - Counter map keyed by teammate name
 * @param {string} teammateName - Name of the teammate
 * @returns {number}
 */
function getDriftCount(counters, teammateName) {
  return counters[teammateName] || 0;
}

// Export functions for testing (must be BEFORE the hook entry point guard)
module.exports = { checkScope, checkScopeDrift, incrementDriftCounter, getDriftCount, DRIFT_THRESHOLD };

// --- Hook entry point (only runs when executed directly, not when require'd) ---
if (require.main === module) {
  (async () => {
    try {
      // Fast exit: no forge session
      if (!fs.existsSync(SESSION_FILE)) {
        process.exit(0);
      }

      let session;
      try {
        session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      } catch {
        process.exit(0);
      }

      const input = await readStdinJson();
      const filePath = parseToolInput(input, 'file_path', '');

      if (!filePath) {
        process.exit(0);
      }

      const warning = checkScope(filePath, session);
      if (warning) {
        console.log(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            additionalContext: warning
          }
        }));
      }
    } catch {
      // Hooks never crash
    }
    process.exit(0);
  })();
}
