'use strict';
/**
 * session-arc.cjs — Classify where we are in the session lifecycle.
 *
 * Sibling to intent-detector.cjs. Where intent-detector answers "what are you
 * doing right now?", session-arc answers "how far into the session are you and
 * how is the energy trending?"
 *
 * Input:
 *   recentTools — last ≤30 tool events { tool, command?, filePath?, ts, replaceAll? }
 *   state       — canonical HUD state (session.uptime, session.toolCount, git.*, forge.*)
 *   now         — current epoch ms (injectable for tests)
 *
 * Output: { phase, confidence, reason, metrics }
 *   phase:      warmup | locked-in | drift | winding-down | cold | unknown
 *   confidence: 0..1
 *   reason:     short human-readable why
 *   metrics:    { toolsPerMinute, gapMs, avgIntervalMs }
 *
 * Pure function: no I/O, no side effects.
 */

// ── Time thresholds (ms) ─────────────────────────────────────────────────────

const COLD_THRESHOLD_MS          = 15 * 60 * 1000;  // 15 min — deeper than intent's idle (5 min)
const DRIFT_GAP_MS               = 2  * 60 * 1000;  // 2 min gap signals deceleration
const LOCKED_IN_WINDOW_MS        = 3  * 60 * 1000;  // 3 min window for velocity check
const LOCKED_IN_MIN_TOOLS        = 5;                // ≥5 tools in 3 min = locked-in
const LOCKED_IN_INTERVAL_JITTER  = 0.5;              // 50% jitter tolerance for "consistent"
const WARMUP_TOOL_COUNT          = 10;               // <10 tools = still warming up
const WARMUP_TIME_MS             = 5  * 60 * 1000;  // OR <5 min uptime = warmup
const DRIFT_RECENT_GAPS          = 3;                // examine last N intervals for drift
const VELOCITY_WINDOW_MS         = 5  * 60 * 1000;  // 5 min window for tpm metric

// ── Winding-down signal patterns ─────────────────────────────────────────────

const WINDING_DOWN_FILE_PATS = [
  /HANDOFF/i,
  /handoff/,
  /session-end/i,
  /\.decisions\.jsonl$/,
  /\.constraints\.jsonl$/,
  /session-cartridge/i,
];

// ── Exported constants ────────────────────────────────────────────────────────

const PHASE_THRESHOLDS = {
  COLD_THRESHOLD_MS,
  DRIFT_GAP_MS,
  LOCKED_IN_WINDOW_MS,
  LOCKED_IN_MIN_TOOLS,
  WARMUP_TOOL_COUNT,
  WARMUP_TIME_MS,
  VELOCITY_WINDOW_MS,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Compute timing metrics from the event ring.
 * @param {Array<{ts:number}>} events
 * @param {number} now
 * @returns {{ toolsPerMinute:number, gapMs:number, avgIntervalMs:number }}
 */
function computeMetrics(events, now) {
  const gapMs = events.length > 0
    ? now - events[events.length - 1].ts
    : Infinity;

  // tools per minute over last 5 min
  const cutoff = now - VELOCITY_WINDOW_MS;
  const recentCount = events.filter(e => e.ts >= cutoff).length;
  const toolsPerMinute = recentCount / (VELOCITY_WINDOW_MS / 60000);

  // average interval between consecutive tools (last 5 pairs → last 6 events)
  const tail = events.slice(-6);
  let avgIntervalMs = 0;
  if (tail.length >= 2) {
    let totalGap = 0;
    for (let i = 1; i < tail.length; i++) {
      totalGap += tail[i].ts - tail[i - 1].ts;
    }
    avgIntervalMs = totalGap / (tail.length - 1);
  }

  return { toolsPerMinute, gapMs, avgIntervalMs };
}

/**
 * Extract bash command strings from the event ring.
 * @param {Array<{tool:string, command?:string}>} events
 * @returns {string[]}
 */
function extractBashCommands(events) {
  return events
    .filter(e => e.tool === 'Bash' && e.command)
    .map(e => e.command);
}

// ── Phase classifiers ─────────────────────────────────────────────────────────
// Each returns { score:number, reason:string }.

/**
 * Cold: no tool activity for ≥15 min.
 */
function scoreCold(events, state, now) {
  if (events.length === 0) return { score: 0.5, reason: 'no tool history' };
  const gapMs = now - events[events.length - 1].ts;
  if (gapMs >= COLD_THRESHOLD_MS) {
    return { score: 0.95, reason: `${Math.floor(gapMs / 60000)}m since last tool` };
  }
  return { score: 0, reason: '' };
}

/**
 * Warmup: session too young (<10 tools or <5 min uptime).
 */
function scoreWarmup(events, state) {
  const uptime = (state && state.session && state.session.uptime) || 0;
  const toolCount = (state && state.session && state.session.toolCount) || events.length;

  if (toolCount < WARMUP_TOOL_COUNT) {
    return { score: 0.85, reason: `only ${toolCount} tools so far` };
  }
  if (uptime < WARMUP_TIME_MS) {
    return { score: 0.75, reason: `session ${Math.floor(uptime / 60000)}m old` };
  }
  return { score: 0, reason: '' };
}

/**
 * Locked-in: sustained high velocity with consistent intervals.
 * ≥5 tools in the last 3 min AND interval jitter ≤50%.
 */
function scoreLockedIn(events, now) {
  const cutoff = now - LOCKED_IN_WINDOW_MS;
  const recent = events.filter(e => e.ts >= cutoff);
  if (recent.length < LOCKED_IN_MIN_TOOLS) return { score: 0, reason: '' };

  // Measure interval consistency: coefficient of variation
  if (recent.length >= 2) {
    const intervals = [];
    for (let i = 1; i < recent.length; i++) {
      intervals.push(recent[i].ts - recent[i - 1].ts);
    }
    const mean = intervals.reduce((s, v) => s + v, 0) / intervals.length;
    if (mean <= 0) return { score: 0.8, reason: `${recent.length} tools in 3 min` };
    const variance = intervals.reduce((s, v) => s + (v - mean) ** 2, 0) / intervals.length;
    const cv = Math.sqrt(variance) / mean;       // coefficient of variation
    const isConsistent = cv <= LOCKED_IN_INTERVAL_JITTER;

    if (isConsistent) {
      return { score: 0.9, reason: `${recent.length} tools in 3 min, consistent pace` };
    }
    return { score: 0.75, reason: `${recent.length} tools in 3 min` };
  }

  return { score: 0.8, reason: `${recent.length} tools in 3 min` };
}

/**
 * Drift: slowing down — last 3 inter-tool gaps are ≥2 min each, but not yet cold.
 */
function scoreDrift(events, _now) {
  if (events.length < DRIFT_RECENT_GAPS + 1) return { score: 0, reason: '' };

  const tail = events.slice(-(DRIFT_RECENT_GAPS + 1));
  const gaps = [];
  for (let i = 1; i < tail.length; i++) {
    gaps.push(tail[i].ts - tail[i - 1].ts);
  }

  const allSlow = gaps.every(g => g >= DRIFT_GAP_MS);
  if (!allSlow) return { score: 0, reason: '' };

  const avgGapMin = Math.floor((gaps.reduce((s, g) => s + g, 0) / gaps.length) / 60000);
  return { score: 0.8, reason: `avg ${avgGapMin}m between last ${DRIFT_RECENT_GAPS} tools` };
}

/**
 * Winding-down: commit+push pattern OR handoff/session-end file edits.
 */
function scoreWindingDown(events) {
  const bash = extractBashCommands(events);
  const hasCommit = bash.some(c => c.includes('git commit'));
  const hasPush = bash.some(c => c.includes('git push'));

  // Handoff / session-end file signals
  const handoffEdits = events.filter(e =>
    (e.tool === 'Edit' || e.tool === 'Write') &&
    e.filePath &&
    WINDING_DOWN_FILE_PATS.some(p => p.test(e.filePath))
  ).length;

  if (hasCommit && hasPush && handoffEdits > 0) {
    return { score: 0.95, reason: 'commit + push + handoff file edit' };
  }
  if (hasCommit && hasPush) {
    return { score: 0.85, reason: 'commit + push' };
  }
  if (hasCommit && handoffEdits > 0) {
    return { score: 0.8, reason: 'commit + handoff file edit' };
  }
  if (handoffEdits >= 2) {
    return { score: 0.75, reason: `${handoffEdits} handoff/session-end file edits` };
  }
  if (handoffEdits === 1) {
    return { score: 0.55, reason: 'handoff file edit' };
  }
  return { score: 0, reason: '' };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Classify the current session arc phase.
 *
 * @param {object} opts
 * @param {Array<{tool:string, command?:string, filePath?:string, ts:number, replaceAll?:boolean}>} opts.recentTools
 * @param {object}  [opts.state]  - canonical HUD state snapshot
 * @param {number}  [opts.now]    - current epoch ms (injectable, defaults to Date.now())
 * @returns {{ phase:string, confidence:number, reason:string, metrics:object }}
 */
function detectArc(opts) {
  const events = (opts && opts.recentTools) || [];
  const state  = (opts && opts.state)       || {};
  const now    = (opts && opts.now)         || Date.now();

  const metrics = computeMetrics(events, now);

  // ── Cold check — absolute gate, overrides all other signals ──────────────
  const coldResult = scoreCold(events, state, now);
  if (coldResult.score >= 0.8 && events.length > 0) {
    return { phase: 'cold', confidence: coldResult.score, reason: coldResult.reason, metrics };
  }

  // ── Warmup — session is too young to have established a rhythm ───────────
  const warmupResult = scoreWarmup(events, state);
  if (warmupResult.score >= 0.75) {
    return { phase: 'warmup', confidence: warmupResult.score, reason: warmupResult.reason, metrics };
  }

  // ── Score the remaining mid-session phases and pick the winner ───────────
  const candidates = [
    { phase: 'locked-in',    ...scoreLockedIn(events, now) },
    { phase: 'drift',        ...scoreDrift(events, now) },
    { phase: 'winding-down', ...scoreWindingDown(events) },
  ];

  candidates.sort((a, b) => b.score - a.score);
  const top = candidates[0];

  if (top.score >= 0.5) {
    return { phase: top.phase, confidence: top.score, reason: top.reason, metrics };
  }

  // ── Ambiguous — not enough signal ────────────────────────────────────────
  return { phase: 'unknown', confidence: 0.2, reason: 'no clear pattern', metrics };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  detectArc,
  PHASE_THRESHOLDS,
  // helpers exported for test visibility
  computeMetrics,
  scoreCold,
  scoreWarmup,
  scoreLockedIn,
  scoreDrift,
  scoreWindingDown,
};
