'use strict';

/**
 * model-window.cjs
 *
 * Boot-time tripwire for time-boxed model availability windows (R-10, upstream
 * recurring-failures register). Fable/model-availability doctrine was
 * rewritten >=5x in 29 days (upstream unavailable -> upstream promo -> upstream
 * window extensions) because time-varying platform state was written
 * directly into durable prose files instead of one machine-readable state
 * file -- the same state-in-prose defect the autonomy charter's Activation
 * Record was built to kill. This service reads `_runs/os/model-window.json`
 * and renders a single boot line; doctrine shrinks to a pointer plus the
 * re-probe procedure.
 *
 * Fail-open by design: a missing or malformed state file returns the
 * null-shape (no line rendered) rather than throwing.
 */

const fs = require('node:fs');
const path = require('node:path');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Check a model-availability window against `now`.
 *
 * State file shape: `{ model: string, window_until: "YYYY-MM-DD",
 * source_session: string }`. The window is treated as open through the end
 * of `window_until` in UTC (`<window_until>T23:59:59Z`).
 *
 * @param {{ statePath?: string, repoRoot?: string, now?: number|Date }} [opts]
 * @returns {{
 *   model: string|null,
 *   daysLeft: number|null,
 *   expired: boolean|null,
 *   line: string|null,
 * }}
 */
function checkModelWindow(opts) {
  const options = opts || {};
  const NULL_SHAPE = { model: null, daysLeft: null, expired: null, line: null };

  try {
    const statePath =
      options.statePath || path.join(options.repoRoot || process.cwd(), '_runs', 'os', 'model-window.json');
    const now = options.now instanceof Date
      ? options.now.getTime()
      : Number.isFinite(options.now)
        ? options.now
        : Date.now();

    let raw;
    try {
      raw = fs.readFileSync(statePath, 'utf8');
    } catch {
      return NULL_SHAPE;
    }

    let state;
    try {
      state = JSON.parse(raw);
    } catch {
      return NULL_SHAPE;
    }

    if (!state || typeof state.model !== 'string' || typeof state.window_until !== 'string') {
      return NULL_SHAPE;
    }

    const windowEndMs = Date.parse(`${state.window_until}T23:59:59Z`);
    if (!Number.isFinite(windowEndMs)) {
      return NULL_SHAPE;
    }

    const daysLeft = Math.ceil((windowEndMs - now) / MS_PER_DAY);
    const expired = windowEndMs < now;

    const line = expired
      ? `${state.model} window: EXPIRED ${state.window_until} — re-probe with a cheap spawn before routing to it (R-10)`
      : `${state.model} window: ${daysLeft}d left (until ${state.window_until}) — re-probe availability after expiry, never park work on it (R-10)`;

    return { model: state.model, daysLeft, expired, line };
  } catch {
    // Fail-open: a tripwire must never break boot.
    return NULL_SHAPE;
  }
}

module.exports = {
  checkModelWindow,
  MS_PER_DAY,
};
