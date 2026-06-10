'use strict';
/**
 * anomaly-flagger.cjs — Detect actionable anomalies from recent tool history and HUD state.
 *
 * Input: recent tool events (ring buffer entries), canonical HUD state, current timestamp.
 *
 * Output: { anomalies: [{ type, severity, reason, metrics }], topSeverity }
 *   anomalies: list of active anomalies, ordered critical → signal → flash
 *   topSeverity: 'critical' | 'signal' | 'flash' | null
 *
 * Pure function: no I/O. The caller owns the tool ring buffer and state object.
 * All checks are fail-safe — missing state returns no anomaly for that check.
 */

// ── Severity constants ──
const SEVERITY_CRITICAL = 'critical';
const SEVERITY_SIGNAL   = 'signal';
const SEVERITY_FLASH    = 'flash';

// Ranked for topSeverity resolution
const SEVERITY_RANK = { critical: 3, signal: 2, flash: 1 };

// ── Thresholds ──
const RAPID_ERROR_WINDOW_MS       = 2 * 60 * 1000;  // 2 minutes
const RAPID_ERROR_COUNT            = 3;               // ≥3 errors in window
const STALE_DIRTY_THRESHOLD_MS    = 30 * 60 * 1000; // 30 minutes without commit
const CTX_BURN_RATE_PCT_PER_MIN   = 10;              // >10%/min extrapolated
const RATE_LIMIT_USED_THRESHOLD   = 0.70;            // >70% of 5h window
const RATE_LIMIT_RESET_MIN_MS     = 2 * 60 * 60 * 1000; // reset ≥2h away
const LONG_IDLE_THRESHOLD_MS      = 5 * 60 * 1000;  // 5 minutes with no tool

// ── Helpers ──

/** Extract bash command strings from event list. */
function bashCommands(events) {
  return events.filter(e => e.tool === 'Bash' && e.command).map(e => e.command);
}

/** True if a bash command string looks like it produced an error. */
function looksLikeError(cmd) {
  return /error|failed|fail|exception|stderr|exit code [^0]/i.test(cmd);
}

/**
 * True if an event is a tool failure marker.
 * Callers embed { isError: true } on failure entries from the ring.
 */
function isErrorEvent(e) {
  return e.isError === true || looksLikeError(e.command || '');
}

/** Safely read nested state.session.rateLimits object. */
function getRateLimits(state) {
  return (state && state.session && typeof state.session.rateLimits === 'object')
    ? state.session.rateLimits
    : null;
}

/** Safely read git state. */
function getGit(state) {
  return (state && state.git) || null;
}

// ── Anomaly Checkers ──
// Each returns an anomaly object or null.

/**
 * rapid-error-cascade — ≥RAPID_ERROR_COUNT error events within RAPID_ERROR_WINDOW_MS.
 */
function checkRapidErrorCascade(events, now) {
  const windowStart = now - RAPID_ERROR_WINDOW_MS;
  const recentErrors = events.filter(e => e.ts >= windowStart && isErrorEvent(e));
  if (recentErrors.length >= RAPID_ERROR_COUNT) {
    return {
      type: 'rapid-error-cascade',
      severity: SEVERITY_CRITICAL,
      reason: `${recentErrors.length} error events in last 2 minutes`,
      metrics: { errorCount: recentErrors.length, windowMs: RAPID_ERROR_WINDOW_MS },
    };
  }
  return null;
}

/**
 * stale-dirty-work — uncommitted changes AND no commit for STALE_DIRTY_THRESHOLD_MS.
 * Uses state.git.uncommittedFiles and state.git.lastCommitTs.
 * lastCommitTs may be: number (epoch ms or seconds), or ISO 8601 string from
 * smart-order.readGitState. Normalize both to ms before differencing.
 */
function checkStaleDirtyWork(state, now) {
  const git = getGit(state);
  if (!git) return null;
  const dirty = Number(git.uncommittedFiles) || 0;
  if (dirty === 0) return null;

  // Prefer explicit commitAgeMs (emitted by smart-order.cjs:72-75 alongside
  // lastCommitTs); fall back to parsing lastCommitTs. Both fields are
  // producer-provided; using the pre-computed age avoids date-parse drift.
  let age;
  if (Number.isFinite(git.commitAgeMs)) {
    age = Number(git.commitAgeMs);
  } else {
    const lastCommitTs = git.lastCommitTs;
    if (lastCommitTs == null) return null;
    const lastMs = typeof lastCommitTs === 'number'
      ? (lastCommitTs < 1e12 ? lastCommitTs * 1000 : lastCommitTs)
      : new Date(lastCommitTs).getTime();
    if (!Number.isFinite(lastMs)) return null;
    age = now - lastMs;
  }
  if (age >= STALE_DIRTY_THRESHOLD_MS) {
    const mins = Math.round(age / 60000);
    return {
      type: 'stale-dirty-work',
      severity: SEVERITY_SIGNAL,
      reason: `${dirty} uncommitted file(s), last commit ${mins}m ago`,
      metrics: { uncommittedFiles: dirty, lastCommitAgeMs: age },
    };
  }
  return null;
}

/**
 * ctx-burn-rate-high — contextPct growing >CTX_BURN_RATE_PCT_PER_MIN extrapolated.
 * Requires state.session.contextPct (current) + state.session.uptime (ms since session start).
 */
function checkCtxBurnRate(state, now) {
  const session = state && state.session;
  if (!session) return null;
  const pct    = Number(session.contextPct);
  const uptime = Number(session.uptime);
  if (!Number.isFinite(pct) || !Number.isFinite(uptime) || uptime <= 0) return null;
  const rate = (pct / uptime) * 60000; // %/min
  if (rate > CTX_BURN_RATE_PCT_PER_MIN) {
    return {
      type: 'ctx-burn-rate-high',
      severity: SEVERITY_SIGNAL,
      reason: `context burning at ${rate.toFixed(1)}%/min (${pct.toFixed(0)}% used in ${Math.round(uptime / 60000)}m)`,
      metrics: { contextPct: pct, uptimeMs: uptime, ratePctPerMin: rate },
    };
  }
  return null;
}

/**
 * rate-limit-approaching — any rate window >70% used AND reset ≥2h away.
 *
 * Canonical rateLimits shape (per hud-data-loader.cjs:229-239):
 *   { fiveHour, sevenDay, fiveHourResetsAt, sevenDayResetsAt }
 * where percentages are 0-100 numbers and resetsAt is epoch seconds/ms or ISO string.
 *
 * Checks both windows; returns the worst offender if multiple qualify.
 */
function checkRateLimitApproaching(state, now) {
  // Disabled by default — rate-limit data from session-meta is often stale
  // or inaccurate, producing spurious popups. Opt in via env var for users
  // who have reliable rate-limit state. See _runs/HANDOFF notes for context.
  if (process.env.ANOMALY_RATE_LIMIT !== '1') return null;

  const rl = getRateLimits(state);
  if (!rl) return null;

  const windows = [
    { label: '5h', pct: Number(rl.fiveHour), resetsAt: rl.fiveHourResetsAt },
    { label: '7d', pct: Number(rl.sevenDay), resetsAt: rl.sevenDayResetsAt },
  ];

  let worst = null;
  for (const w of windows) {
    if (!Number.isFinite(w.pct) || w.resetsAt == null) continue;
    // resetsAt normalization: harness API spec emits unix seconds; ISO string also possible
    // from some producers. `< 1e12` is the canonical seconds-vs-ms heuristic (any ms value
    // after 2001 exceeds 1e12; any seconds value before year 33000 is below it).
    const resetMs = typeof w.resetsAt === 'number'
      ? (w.resetsAt < 1e12 ? w.resetsAt * 1000 : w.resetsAt)
      : new Date(w.resetsAt).getTime();
    if (!Number.isFinite(resetMs)) continue;

    const timeUntilReset = resetMs - now;
    if (w.pct >= RATE_LIMIT_USED_THRESHOLD * 100 && timeUntilReset >= RATE_LIMIT_RESET_MIN_MS) {
      if (!worst || w.pct > worst.pct) {
        worst = { ...w, timeUntilReset };
      }
    }
  }

  if (worst) {
    const hrsLeft = (worst.timeUntilReset / 3600000).toFixed(1);
    return {
      type: 'rate-limit-approaching',
      severity: SEVERITY_CRITICAL,
      reason: `${worst.label} ${worst.pct.toFixed(0)}% used, resets in ${hrsLeft}h`,
      metrics: { window: worst.label, usedPct: worst.pct, timeUntilResetMs: worst.timeUntilReset },
    };
  }
  return null;
}

/**
 * error-regression — a test-pass event followed by a test-fail event (regression).
 * Detects from bash command strings matching vitest/jest with pass/fail indicators.
 */
function checkErrorRegression(events) {
  const testEvents = events.filter(e =>
    e.tool === 'Bash' && e.command &&
    /vitest|jest|npm\s+test|npx\s+vitest/.test(e.command)
  );
  // Walk chronologically: look for a pass → fail transition.
  // Vitest/jest summaries land in tool_result (captured as e.output by
  // tool-ring.normalizeEntry); fall back to the command string for cases
  // where the summary is echoed inline. (final-dfe M2).
  let sawPass = false;
  for (const e of testEvents) {
    const cmd = e.command || '';
    const output = e.output || '';
    const haystack = output + '\n' + cmd;
    const failed = e.isError === true || /fail|FAIL|ERR|×/.test(haystack);
    const passed  = !failed && /pass|PASS|✓|all\s+\d+\s+tests?\s+passed|Tests\s+\d+\s+passed/.test(haystack);
    if (passed) { sawPass = true; continue; }
    if (failed && sawPass) {
      return {
        type: 'error-regression',
        severity: SEVERITY_SIGNAL,
        reason: 'test suite went from passing to failing',
        metrics: { regressionTs: e.ts },
      };
    }
  }
  return null;
}

/**
 * long-idle — no tool event in LONG_IDLE_THRESHOLD_MS.
 */
function checkLongIdle(events, now) {
  if (events.length === 0) return null; // session just started, not idle
  const lastTs = events[events.length - 1].ts || 0;
  const gap    = now - lastTs;
  if (gap >= LONG_IDLE_THRESHOLD_MS) {
    const mins = Math.round(gap / 60000);
    return {
      type: 'long-idle',
      severity: SEVERITY_FLASH,
      reason: `${mins}m since last tool activity`,
      metrics: { idleMs: gap },
    };
  }
  return null;
}

// ── Top Severity ──

function resolveTopSeverity(anomalies) {
  if (anomalies.length === 0) return null;
  return anomalies.reduce((top, a) => {
    if (!top) return a.severity;
    return (SEVERITY_RANK[a.severity] || 0) > (SEVERITY_RANK[top] || 0)
      ? a.severity
      : top;
  }, null);
}

// ── Public API ──

/**
 * Detect actionable anomalies from recent tool history and HUD state.
 *
 * @param {object} opts
 * @param {Array<{tool:string, command?:string, ts:number, isError?:boolean}>} opts.recentTools
 * @param {object} opts.state  — canonical HUD state
 * @param {number} [opts.now]  — current time in ms (injectable for tests)
 * @returns {{ anomalies: Array<{type:string, severity:string, reason:string, metrics:object}>, topSeverity: string|null }}
 */
function detectAnomalies(opts) {
  const events = (opts && Array.isArray(opts.recentTools)) ? opts.recentTools : [];
  const state  = (opts && opts.state) || {};
  const now    = (opts && typeof opts.now === 'number') ? opts.now : Date.now();

  const results = [];

  // Run all checkers; each is independently fail-safe
  try {
    const r = checkRapidErrorCascade(events, now);
    if (r) results.push(r);
  } catch { /* fail-safe */ }

  try {
    const r = checkStaleDirtyWork(state, now);
    if (r) results.push(r);
  } catch { /* fail-safe */ }

  try {
    const r = checkCtxBurnRate(state, now);
    if (r) results.push(r);
  } catch { /* fail-safe */ }

  try {
    const r = checkRateLimitApproaching(state, now);
    if (r) results.push(r);
  } catch { /* fail-safe */ }

  try {
    const r = checkErrorRegression(events);
    if (r) results.push(r);
  } catch { /* fail-safe */ }

  try {
    const r = checkLongIdle(events, now);
    if (r) results.push(r);
  } catch { /* fail-safe */ }

  // Sort: critical first, then signal, then flash
  results.sort((a, b) => (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0));

  return {
    anomalies: results,
    topSeverity: resolveTopSeverity(results),
  };
}

module.exports = {
  detectAnomalies,
  // Severity constants
  SEVERITY_CRITICAL,
  SEVERITY_SIGNAL,
  SEVERITY_FLASH,
  // Threshold constants
  RAPID_ERROR_WINDOW_MS,
  RAPID_ERROR_COUNT,
  STALE_DIRTY_THRESHOLD_MS,
  CTX_BURN_RATE_PCT_PER_MIN,
  RATE_LIMIT_USED_THRESHOLD,
  RATE_LIMIT_RESET_MIN_MS,
  LONG_IDLE_THRESHOLD_MS,
  // Helper (exported for tests)
  resolveTopSeverity,
  checkRapidErrorCascade,
  checkStaleDirtyWork,
  checkCtxBurnRate,
  checkRateLimitApproaching,
  checkErrorRegression,
  checkLongIdle,
};
