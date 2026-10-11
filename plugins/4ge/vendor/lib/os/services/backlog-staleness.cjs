// @ts-check
'use strict';

/**
 * backlog-staleness.cjs
 *
 * Reads BACKLOG.md's reconcile marker and compares it against
 * the current session number to detect when BACKLOG.md has drifted stale
 * relative to live work. upstream root cause: BACKLOG.md sat unreconciled
 * upstream (~47 sessions), and 15+ open lanes silently rotted with no
 * parking decision. Surfaces a one-line warning for the SessionStart boot
 * brief when the gap exceeds a threshold (default 12 sessions).
 *
 * Marker forms (BL-608). Three are in use, and the first line holding any of
 * them is the marker line:
 *   - "Last-reconciled: S<N>"
 *   - "reconciled as of S<N>"                (the form /reconcile writes)
 *   - "Reconciled <YYYY-MM-DD> through S<N>"
 * A BACKLOG.md that is no longer the live backlog carries FROZEN_PHRASE on
 * that same marker line, and the stale nag is skipped. The phrase counts only
 * on the marker line, so a mention of it in the body cannot switch the nag off.
 * parseBacklogMarker is shared with .claude/hooks/handoff-record-check.cjs.
 *
 * Fail-open by design: any missing file, unparseable content, or unexpected
 * shape returns null (no warning) rather than throwing. This is an advisory
 * tripwire, not a gate -- it must never break boot.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_THRESHOLD = 12;

/** Reconcile marker forms, tried in order on each line; group 1 is the session number. */
const MARKER_FORMS = Object.freeze([
  /Last-reconciled:\s*S(\d+)/i,
  /reconciled as of S(\d+)/i,
  /Reconciled\s+\d{4}-\d{2}-\d{2}\s+through\s+S(\d+)/i,
]);

/** Fixed phrase that marks BACKLOG.md as a frozen snapshot. Exact match, on the marker line only. */
const FROZEN_PHRASE = 'Frozen snapshot, not the live backlog';

/**
 * Parse BACKLOG.md's reconcile marker. The first line that holds any marker
 * form wins; `frozen` is true only when that same line also holds FROZEN_PHRASE.
 *
 * @param {unknown} text - Raw BACKLOG.md contents
 * @returns {{ session: number|null, frozen: boolean }}
 */
function parseBacklogMarker(text) {
  if (typeof text !== 'string') return { session: null, frozen: false };
  for (const line of text.split(/\r?\n/)) {
    for (const form of MARKER_FORMS) {
      const match = line.match(form);
      if (!match) continue;
      const n = parseInt(match[1], 10);
      return { session: Number.isFinite(n) ? n : null, frozen: line.includes(FROZEN_PHRASE) };
    }
  }
  return { session: null, frozen: false };
}

/**
 * Parse the session number out of BACKLOG.md's reconcile marker (any of the
 * three forms; see parseBacklogMarker).
 *
 * @param {unknown} text - Raw BACKLOG.md contents
 * @returns {number|null} Parsed session number, or null if the marker is absent/malformed
 */
function parseLastReconciledSession(text) {
  return parseBacklogMarker(text).session;
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
 * A frozen BACKLOG.md gets no warning (its header names the live backlog). A
 * BACKLOG.md with no marker gets its own warning, since staleness cannot be
 * measured without one.
 *
 * @param {{ repoRoot?: string, threshold?: number }} [opts]
 * @returns {{
 *   warning: string|null,
 *   gap: number|null,
 *   lastReconciled: number|null,
 *   currentSession: number|null,
 *   frozen: boolean,
 * }}
 */
function checkBacklogStaleness(opts) {
  const options = opts || {};
  const repoRoot = options.repoRoot || process.cwd();
  const threshold = Number.isFinite(options.threshold) ? options.threshold : DEFAULT_THRESHOLD;

  const empty = { warning: null, gap: null, lastReconciled: null, currentSession: null, frozen: false };

  try {
    const backlogPath = path.join(repoRoot, 'BACKLOG.md');
    const cartridgePath = path.join(repoRoot, '_runs', 'session-cartridge.json');

    let backlogText;
    try {
      backlogText = fs.readFileSync(backlogPath, 'utf8');
    } catch {
      return empty; // no BACKLOG.md in this repo -- nothing to warn about
    }

    const { session: lastReconciled, frozen } = parseBacklogMarker(backlogText);
    const currentSession = getCurrentSessionNumber(cartridgePath);

    const result = { warning: null, gap: null, lastReconciled, currentSession, frozen };
    if (frozen) return result; // frozen snapshot: not the live backlog, nothing to reconcile

    if (lastReconciled === null) {
      result.warning =
        'BACKLOG.md has no reconcile marker (expected "Last-reconciled: S<N>", ' +
        '"reconciled as of S<N>" or "Reconciled <date> through S<N>") — run /reconcile';
      return result;
    }
    if (currentSession === null) return result;

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
  parseBacklogMarker,
  parseLastReconciledSession,
  getCurrentSessionNumber,
  checkBacklogStaleness,
  DEFAULT_THRESHOLD,
  MARKER_FORMS,
  FROZEN_PHRASE,
};
