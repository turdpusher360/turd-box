'use strict';

/**
 * backlog-staleness.cjs
 *
 * Reads BACKLOG.md's "Last-reconciled: S###" marker and compares it against
 * the current session number to detect when BACKLOG.md has drifted stale
 * relative to live work. upstream root cause: BACKLOG.md sat unreconciled
 * upstream (~47 sessions), and 15+ open lanes silently rotted with no
 * parking decision. Surfaces a one-line warning for the SessionStart boot
 * brief when the gap exceeds a threshold (default 12 sessions).
 *
 * Fail-open by design: any missing file, unparseable content, or unexpected
 * shape returns null (no warning) rather than throwing. This is an advisory
 * tripwire, not a gate -- it must never break boot.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_THRESHOLD = 12;

/**
 * Parse the "Last-reconciled: S###" marker out of BACKLOG.md text.
 *
 * @param {string} text - Raw BACKLOG.md contents
 * @returns {number|null} Parsed session number, or null if the marker is absent/malformed
 */
function parseLastReconciledSession(text) {
  if (typeof text !== 'string') return null;
  const match = text.match(/Last-reconciled:\s*S(\d+)/i);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Derive the current session number from _runs/session-cartridge.json.
 *
 * The cartridge has no single dedicated "current session number" field --
 * inspected upstream: `decisions[].session` is populated on some older entries
 * and absent on the newest ones, so it is not a reliable structured field to
 * key off. The signal that IS reliable in practice is the highest S###
 * token found anywhere in the cartridge's raw JSON text -- session numbers
 * get mentioned in decision/summary prose even on entries where the
 * structured `session` field is empty. Falls back to null if the file is
 * missing, unparseable as text, or contains no S### token at all.
 *
 * @param {string} cartridgePath - Absolute path to _runs/session-cartridge.json
 * @returns {number|null}
 */
function getCurrentSessionNumber(cartridgePath) {
  let raw;
  try {
    raw = fs.readFileSync(cartridgePath, 'utf8');
  } catch {
    return null;
  }
  const matches = raw.match(/S(\d{3,4})\b/g);
  if (!matches || matches.length === 0) return null;
  let max = null;
  for (const m of matches) {
    const n = parseInt(m.slice(1), 10);
    if (Number.isFinite(n) && (max === null || n > max)) max = n;
  }
  return max;
}

/**
 * Check BACKLOG.md staleness relative to the current session.
 *
 * @param {{ repoRoot?: string, threshold?: number }} [opts]
 * @returns {{
 *   warning: string|null,
 *   gap: number|null,
 *   lastReconciled: number|null,
 *   currentSession: number|null,
 * }}
 */
function checkBacklogStaleness(opts) {
  const options = opts || {};
  const repoRoot = options.repoRoot || process.cwd();
  const threshold = Number.isFinite(options.threshold) ? options.threshold : DEFAULT_THRESHOLD;

  const empty = { warning: null, gap: null, lastReconciled: null, currentSession: null };

  try {
    const backlogPath = path.join(repoRoot, 'BACKLOG.md');
    const cartridgePath = path.join(repoRoot, '_runs', 'session-cartridge.json');

    let backlogText;
    try {
      backlogText = fs.readFileSync(backlogPath, 'utf8');
    } catch {
      return empty; // no BACKLOG.md in this repo -- nothing to warn about
    }

    const lastReconciled = parseLastReconciledSession(backlogText);
    const currentSession = getCurrentSessionNumber(cartridgePath);

    const result = { warning: null, gap: null, lastReconciled, currentSession };
    if (lastReconciled === null || currentSession === null) return result;

    const gap = currentSession - lastReconciled;
    result.gap = gap;

    if (gap > threshold) {
      result.warning =
        `BACKLOG.md last reconciled S${lastReconciled}, current session ~S${currentSession} ` +
        `(${gap} sessions stale) — run /reconcile`;
    }

    return result;
  } catch {
    // Fail-open: a tripwire must never break boot.
    return empty;
  }
}

module.exports = {
  parseLastReconciledSession,
  getCurrentSessionNumber,
  checkBacklogStaleness,
  DEFAULT_THRESHOLD,
};
