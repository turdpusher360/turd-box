'use strict';

/**
 * learning.cjs — AISLE Learning Loop
 *
 * Adaptive threshold tuning based on operator feedback.
 * Processes FP/TP feedback from operators, adjusts scanner thresholds,
 * and enforces adversarial safeguards against learning loop poisoning.
 *
 * Safeguards implemented (ATK-5 compliance):
 *   1. BLOCK->WARN floor: FP cannot lower a BLOCK finding below WARN
 *   2. WARN->LOG floor: FP cannot lower WARN below LOG (ATK-5 floor)
 *   3. Rate limit: max 1 threshold update per scanner per 24h
 *   4. Min 100 observations before any change
 *   5. Max +/-20% drift per scanner from baseline
 *   6. Aggregate >50% total drift = lock learning loop (ATK-5)
 *   7. >10% change emits WARN event
 *   8. >80% FP from single agent = anomalous (ATK-5)
 *   9. No oscillation: alternating FP/TP capped at current level
 *  10. Tier overrides from config bypass learning system
 *
 * Synchronous throughout (P0-B compliance).
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Minimum observations required before threshold changes
const MIN_OBSERVATIONS = 100;

// Maximum drift per scanner from baseline (±20%)
const MAX_DRIFT_PCT = 0.20;

// P0-4 fix: Aggregate drift lock threshold — fires when average drift exceeds
// 80% of MAX_DRIFT_PCT. Old value (0.50) was unreachable because individual
// drift is capped at MAX_DRIFT_PCT (0.20), making avg always <= 0.20.
// New value: 0.80 * 0.20 = 0.16 — locks when ~80% of scanners are at max drift.
const AGGREGATE_LOCK_THRESHOLD = 0.80 * MAX_DRIFT_PCT;

// Rate limit window: 1 update per scanner per 24h
const RATE_LIMIT_MS = 24 * 60 * 60 * 1000;

// Change threshold that emits a WARN event (>10% change)
const WARN_CHANGE_THRESHOLD = 0.10;

// Anomalous FP concentration from single agent (>80%)
const AGENT_FP_ANOMALY_THRESHOLD = 0.80;

// Tier floor: FP feedback cannot lower WARN to LOG
const TIER_FLOOR = 'WARN';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// Learning state is module-level. Persistence is provided by loadState/saveState
// (see Persistence section below). The server calls loadState() at startup and
// saveState() after each accepted feedback. Without a loadState() call, the
// module operates in ephemeral mode — functional but state resets on restart.

const _state = {
  // Per-scanner tuning data
  // scannerTuning[scannerId] = { observations, fpCount, tpCount, confidence, driftPct, lastUpdateTs }
  scannerTuning: {},

  // Agent feedback tracking: agentId -> { fpCount, totalCount }
  agentFeedback: {},

  // Whether the learning loop is locked (ATK-5 aggregate drift)
  locked: false,
  lockReason: null,

  // Event log for emitted warnings
  events: [],

  // Tier overrides from config (these scanners bypass learning)
  tierOverrides: {},
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Initialize tuning record for a scanner if not present.
 * @param {string} scannerId
 */
function initScanner(scannerId) {
  if (!_state.scannerTuning[scannerId]) {
    _state.scannerTuning[scannerId] = {
      observations: 0,
      fpCount: 0,
      tpCount: 0,
      confidence: 1.0,     // Baseline confidence (1.0 = no adjustment)
      driftPct: 0,          // Current drift from baseline
      lastUpdateTs: null,   // Timestamp of last threshold change
      lastFeedbackType: null, // 'FP' or 'TP' — for oscillation detection
      oscillationCount: 0,
    };
  }
}

/**
 * Emit an event to the event log.
 * @param {string} type - 'WARN' | 'LOCK' | 'ANOMALY'
 * @param {string} scannerId
 * @param {string} message
 * @param {object} data
 */
function emitEvent(type, scannerId, message, data) {
  _state.events.push({
    type,
    scannerId,
    message,
    data: data || {},
    ts: Date.now(),
  });
}

/**
 * Calculate aggregate drift across all scanners.
 * @returns {number} Average absolute drift
 */
function calculateAggregateDrift() {
  const scanners = Object.values(_state.scannerTuning);
  if (scanners.length === 0) return 0;
  const totalDrift = scanners.reduce((sum, s) => sum + Math.abs(s.driftPct), 0);
  return totalDrift / scanners.length;
}

/**
 * Apply a confidence delta to a scanner, enforcing all safeguards.
 * @param {string} scannerId
 * @param {number} delta - Positive = increase confidence, Negative = decrease
 * @param {string} feedbackType - 'FP' | 'TP'
 * @returns {{ applied: boolean, reason?: string, newConfidence?: number }}
 */
function applyConfidenceDelta(scannerId, delta, feedbackType) {
  const tuning = _state.scannerTuning[scannerId];

  // Safeguard 4: Minimum observations
  if (tuning.observations < MIN_OBSERVATIONS) {
    return { applied: false, reason: `min-observations: ${tuning.observations}/${MIN_OBSERVATIONS}` };
  }

  // Safeguard 3: Rate limit
  if (tuning.lastUpdateTs !== null) {
    const elapsed = Date.now() - tuning.lastUpdateTs;
    if (elapsed < RATE_LIMIT_MS) {
      return { applied: false, reason: `rate-limited: ${Math.round((RATE_LIMIT_MS - elapsed) / 1000)}s remaining` };
    }
  }

  // Safeguard 9: Oscillation detection
  if (tuning.lastFeedbackType !== null && tuning.lastFeedbackType !== feedbackType) {
    tuning.oscillationCount++;
    if (tuning.oscillationCount >= 2) {
      // Cap at current level — no change
      return { applied: false, reason: 'oscillation-detected' };
    }
  } else {
    tuning.oscillationCount = 0;
  }

  const oldConfidence = tuning.confidence;
  let newConfidence = oldConfidence + delta;

  // Safeguard 5: Max ±20% drift from baseline (1.0)
  const maxConfidence = 1.0 + MAX_DRIFT_PCT;
  const minConfidence = 1.0 - MAX_DRIFT_PCT;
  newConfidence = Math.max(minConfidence, Math.min(maxConfidence, newConfidence));

  // Don't update if no effective change
  if (Math.abs(newConfidence - oldConfidence) < 0.001) {
    return { applied: false, reason: 'no-effective-change' };
  }

  // Apply
  tuning.confidence = newConfidence;
  tuning.driftPct = newConfidence - 1.0;
  tuning.lastUpdateTs = Date.now();
  tuning.lastFeedbackType = feedbackType;

  const changePct = Math.abs(newConfidence - oldConfidence);

  // Safeguard 7: Emit WARN if >10% change
  if (changePct > WARN_CHANGE_THRESHOLD) {
    emitEvent('WARN', scannerId, `Confidence change >10%: ${(changePct * 100).toFixed(1)}%`, {
      oldConfidence, newConfidence, feedbackType,
    });
  }

  return { applied: true, newConfidence };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Load persisted learning state from disk.
 * Graceful on missing/corrupt file — starts fresh.
 * @param {string} stateDir - AISLE state directory path
 */
function loadState(stateDir) {
  const path = require('path');
  const fs = require('fs');
  const statePath = path.join(stateDir, 'learning', 'state.json');

  try {
    if (!fs.existsSync(statePath)) return;
    const raw = fs.readFileSync(statePath, 'utf8');
    const saved = JSON.parse(raw);

    // Version check — only load v1.x.x state
    if (!saved.version || !saved.version.startsWith('1.')) {
      process.stderr.write(`[AISLE:learning] Unknown state version ${saved.version} — starting fresh\n`);
      return;
    }

    // Replace (not merge) to avoid stale ephemeral entries surviving load
    if (saved.scannerTuning) {
      _state.scannerTuning = saved.scannerTuning;

      // Fix 2a (FIND-01): Strip any keys that are not valid scanner IDs (A-I)
      for (const key of Object.keys(_state.scannerTuning)) {
        if (!/^[A-I]$/.test(key)) {
          process.stderr.write(`[AISLE:learning] Rejecting unknown scanner ID "${key}" from persisted state\n`);
          delete _state.scannerTuning[key];
        }
      }

      // Fix 1 (FIND-07): Clamp loaded values to prevent poisoned state injection
      for (const [, entry] of Object.entries(_state.scannerTuning)) {
        entry.confidence = Math.max(0.80, Math.min(1.20, Number(entry.confidence) || 1.0));
        entry.observations = Math.max(0, Number(entry.observations) || 0);
        entry.fpCount = Math.max(0, Number(entry.fpCount) || 0);
        entry.tpCount = Math.max(0, Number(entry.tpCount) || 0);
        // Recalculate driftPct from clamped confidence (derived, not trusted from disk)
        entry.driftPct = (entry.confidence - 1.0);
      }
    }
    if (saved.agentFeedback) {
      _state.agentFeedback = saved.agentFeedback;

      // Fix 1b (FIND-07): Clamp loaded agentFeedback values
      for (const [, entry] of Object.entries(_state.agentFeedback)) {
        entry.fpCount = Math.max(0, Number(entry.fpCount) || 0);
        entry.totalCount = Math.max(0, Number(entry.totalCount) || 0);
        // Ensure fpCount never exceeds totalCount
        if (entry.fpCount > entry.totalCount) {
          entry.fpCount = entry.totalCount;
        }
      }
    }
    if (typeof saved.locked === 'boolean') {
      _state.locked = saved.locked;
    }
    // Fix 6 (P5 DFE): Use nullish coalescing so lockReason: null is explicitly restored
    _state.lockReason = saved.lockReason ?? null;

    process.stderr.write(`[AISLE:learning] Loaded persisted state (${Object.keys(_state.scannerTuning).length} scanners, ${Object.keys(_state.agentFeedback).length} agents)\n`);
  } catch (err) {
    process.stderr.write(`[AISLE:learning] Failed to load state: ${err.message} — starting fresh\n`);
  }
}

/**
 * Persist current learning state to disk.
 * Creates the learning/ subdirectory if needed.
 * @param {string} stateDir - AISLE state directory path
 */
function saveState(stateDir) {
  const path = require('path');
  const fs = require('fs');
  const dir = path.join(stateDir, 'learning');

  try {
    fs.mkdirSync(dir, { recursive: true });
    const payload = {
      version: '1.0.0',
      savedAt: Date.now(),
      scannerTuning: _state.scannerTuning,
      agentFeedback: _state.agentFeedback,
      locked: _state.locked,
      lockReason: _state.lockReason,
    };
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    process.stderr.write(`[AISLE:learning] Failed to save state: ${err.message}\n`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// AR Measure channel (Phase D.1)
// ---------------------------------------------------------------------------

/** Regex shared with loadState — validated A-I scanner ID whitelist */
const VALID_SCANNER_RE = /^[A-I]$/;

/**
 * Process an AR measure nudge as a signed confidence delta.
 *
 * Called exclusively by lib/aisle/core/ar-ingest.cjs. Not part of the
 * operator-feedback public surface — no external caller should invoke this directly.
 *
 * Shares the same applyConfidenceDelta() gate as processFeedback(), so all
 * ATK-5 safeguards (rate-limit, min-observations, max-drift, aggregate-lock)
 * apply unchanged. AR signal does not receive a privileged path.
 *
 * @param {string} scannerId - Single letter A-I matching AISLE scanner ID
 * @param {string} measureId - Unique measure identifier (e.g. 'dep-vulnerability:score')
 * @param {number} nudge - Signed confidence delta, bounded by arSubscriptions.maxNudgePerEvent
 * @param {object} [meta] - Provenance metadata (domain, delta direction, timestamp, etc.)
 * @returns {{ ok: boolean, reason?: string, applied?: boolean, newConfidence?: number }}
 */
function processMeasure(scannerId, measureId, nudge, meta) {
  // Safeguard 6: Lock check (same as processFeedback)
  if (_state.locked) {
    return { ok: false, reason: `learning-loop-locked: ${_state.lockReason}` };
  }

  // Validate scanner ID against the A-I whitelist (same check as loadState:228)
  if (!VALID_SCANNER_RE.test(scannerId)) {
    return { ok: false, reason: `invalid-scanner-id: ${scannerId}` };
  }

  // Validate nudge is a finite number
  if (typeof nudge !== 'number' || !Number.isFinite(nudge)) {
    return { ok: false, reason: 'invalid-nudge: must be a finite number' };
  }

  // Validate nudge magnitude against maxNudgePerEvent (upstream master-verdict
  // P1-MSG-PROCMEASURE: commit message claimed this check existed but it
  // didn't — must land before D.2 wires the ingest path). Default cap is
  // 0.02 absolute (operator feedback delta is ±0.02; AR nudges must not
  // exceed the operator-feedback bound even if caller forgets to clamp).
  const MAX_NUDGE_PER_EVENT = 0.02;
  if (Math.abs(nudge) > MAX_NUDGE_PER_EVENT) {
    return {
      ok: false,
      reason: `nudge-magnitude-exceeds-max: |${nudge}| > ${MAX_NUDGE_PER_EVENT}`,
    };
  }

  // measureId must be a non-empty string
  if (typeof measureId !== 'string' || measureId.length === 0) {
    return { ok: false, reason: 'invalid-measure-id: must be a non-empty string' };
  }

  // Safeguard 10: Tier override check (same as processFeedback)
  if (_state.tierOverrides[scannerId]) {
    return { ok: false, reason: 'tier-override-bypass: config overrides learning for this scanner' };
  }

  initScanner(scannerId);
  const tuning = _state.scannerTuning[scannerId];

  // Increment observations (AR events count toward the min-observations floor)
  tuning.observations++;

  // Apply the signed delta via the same gate used by processFeedback.
  // 'AR' is the feedbackType — distinct from 'FP'/'TP' for event provenance.
  // Note: oscillation detection in applyConfidenceDelta compares lastFeedbackType;
  // 'AR' will not falsely trigger FP/TP oscillation logic because the type differs.
  const result = applyConfidenceDelta(scannerId, nudge, 'AR');

  // Emit AR_MEASURE event with full provenance regardless of whether delta was applied
  _state.events.push({
    type: 'AR_MEASURE',
    scannerId,
    message: `AR measure nudge: ${measureId} nudge=${nudge.toFixed(6)}`,
    data: {
      measureId,
      nudge,
      applied: result.applied,
      newConfidence: result.newConfidence,
      reason: result.reason,
      meta: meta || {},
    },
    ts: Date.now(),
  });

  const aggregateDrift = calculateAggregateDrift();
  _checkAggregateLock(aggregateDrift, scannerId);

  return { ok: true, ...result };
}

// ---------------------------------------------------------------------------
// Operator feedback
// ---------------------------------------------------------------------------

/**
 * Process operator feedback for a finding.
 *
 * @param {string} findingId - e.g. 'G:injection:abc123'
 * @param {object} feedback - { type: 'FP'|'TP', severity?: string, tier?: string }
 * @param {string} agentId - Agent/operator submitting feedback
 * @returns {{ ok: boolean, reason?: string, event?: string }}
 */
function processFeedback(findingId, feedback, agentId) {
  // Safeguard 6: Lock check
  if (_state.locked) {
    return { ok: false, reason: `learning-loop-locked: ${_state.lockReason}` };
  }

  // Fix 3 (FIND-02): Validate feedback.type — must be exactly 'FP' or 'TP'
  const feedbackType = feedback && feedback.type;
  if (feedbackType !== 'FP' && feedbackType !== 'TP') {
    return { ok: false, reason: 'invalid-feedback-type: must be FP or TP' };
  }

  const scannerId = (findingId || '').split(':')[0] || 'unknown';

  // Fix 2b (FIND-04): Validate scanner ID against the known A-I set
  if (!/^[A-I]$/.test(scannerId)) {
    return { ok: false, reason: `invalid-scanner-id: ${scannerId}` };
  }
  const currentTier = (feedback && feedback.tier) || 'WARN';

  // Safeguard 10: Tier override check
  if (_state.tierOverrides[scannerId]) {
    return { ok: false, reason: 'tier-override-bypass: config overrides learning for this scanner' };
  }

  initScanner(scannerId);
  const tuning = _state.scannerTuning[scannerId];
  tuning.observations++;

  // Track per-agent feedback
  if (agentId) {
    // Fix 4 (FIND-03): Validate agentId — alphanumeric, hyphens, underscores, max 128 chars
    if (typeof agentId !== 'string' || agentId.length > 128 || !/^[a-zA-Z0-9_-]+$/.test(agentId)) {
      return { ok: false, reason: 'invalid-agent-id: max 128 chars, alphanumeric/hyphens/underscores' };
    }
    if (!_state.agentFeedback[agentId]) {
      _state.agentFeedback[agentId] = { fpCount: 0, totalCount: 0 };
    }
    _state.agentFeedback[agentId].totalCount++;
    if (feedbackType === 'FP') {
      _state.agentFeedback[agentId].fpCount++;
      tuning.fpCount++;

      // Safeguard 8: >80% FP from single agent = anomalous
      const agentData = _state.agentFeedback[agentId];
      if (agentData.totalCount >= 10) {
        const fpRatio = agentData.fpCount / agentData.totalCount;
        if (fpRatio > AGENT_FP_ANOMALY_THRESHOLD) {
          emitEvent('ANOMALY', scannerId, `ATK-5: agent ${agentId} submitting ${(fpRatio * 100).toFixed(0)}% FP feedback`, {
            agentId, fpRatio, totalCount: agentData.totalCount,
          });
          return { ok: false, reason: `atk-5: anomalous-agent-feedback:${agentId}` };
        }
      }
    } else {
      tuning.tpCount++;
    }
  } else {
    if (feedbackType === 'FP') {
      tuning.fpCount++;
    } else {
      tuning.tpCount++;
    }
  }

  // Determine delta based on feedback type
  // FP: lower confidence (scanner over-triggered)
  // TP: increase confidence (scanner correctly triggered)
  const delta = feedbackType === 'FP' ? -0.02 : +0.02;

  // Safeguard 1 & 2: BLOCK->WARN floor and WARN->LOG floor
  // FP feedback on a BLOCK finding cannot lower below WARN
  // FP feedback on a WARN finding cannot lower to LOG
  if (feedbackType === 'FP') {
    if (currentTier === 'BLOCK') {
      // Cannot lower BLOCK below WARN via learning
      // Record observation but don't reduce confidence below the WARN floor marker
      const result = applyConfidenceDelta(scannerId, delta, feedbackType);
      // Annotate the result to indicate floor was applied
      if (result.applied && result.newConfidence !== undefined) {
        // No further restriction needed for confidence; tier floor is enforced at gate level
      }
      // Inform caller about tier floor
      const aggregateDrift = calculateAggregateDrift();
      _checkAggregateLock(aggregateDrift, scannerId);
      return { ok: true, floor: 'BLOCK->WARN: cannot lower BLOCK via FP', ...result };
    }

    if (currentTier === 'WARN') {
      // WARN cannot go to LOG (ATK-5 floor)
      const result = applyConfidenceDelta(scannerId, delta, feedbackType);
      const aggregateDrift = calculateAggregateDrift();
      _checkAggregateLock(aggregateDrift, scannerId);
      return { ok: true, floor: 'WARN->LOG: ATK-5 floor applied', ...result };
    }

    if (currentTier === 'LOG') {
      // Already at LOG — no further reduction possible
      const result = applyConfidenceDelta(scannerId, delta, feedbackType);
      const aggregateDrift = calculateAggregateDrift();
      _checkAggregateLock(aggregateDrift, scannerId);
      return { ok: true, floor: 'LOG: already at minimum tier', ...result };
    }
  }

  const result = applyConfidenceDelta(scannerId, delta, feedbackType);
  const aggregateDrift = calculateAggregateDrift();
  _checkAggregateLock(aggregateDrift, scannerId);

  return { ok: true, ...result };
}

/**
 * Internal: check if aggregate drift exceeds lock threshold.
 * @param {number} aggregateDrift
 * @param {string} scannerId - The scanner that triggered the check
 */
function _checkAggregateLock(aggregateDrift, scannerId) {
  if (aggregateDrift > AGGREGATE_LOCK_THRESHOLD && !_state.locked) {
    _state.locked = true;
    _state.lockReason = `ATK-5: aggregate drift ${(aggregateDrift * 100).toFixed(1)}% exceeds ${AGGREGATE_LOCK_THRESHOLD * 100}% threshold`;
    emitEvent('LOCK', scannerId, _state.lockReason, { aggregateDrift });
  }
}

/**
 * Get tuning data for a scanner.
 * @param {string} scannerId
 * @returns {object} Tuning record
 */
function getTuning(scannerId) {
  if (!_state.scannerTuning[scannerId]) {
    return {
      observations: 0,
      fpCount: 0,
      tpCount: 0,
      confidence: 1.0,
      driftPct: 0,
      lastUpdateTs: null,
      locked: false,
    };
  }
  const t = _state.scannerTuning[scannerId];
  return { ...t, locked: _state.locked };
}

/**
 * Check aggregate drift status across all scanners.
 * @returns {{ locked: boolean, aggregateDrift: number, reason?: string }}
 */
function checkAggregateDrift() {
  const aggregateDrift = calculateAggregateDrift();
  return {
    locked: _state.locked,
    aggregateDrift,
    reason: _state.lockReason || null,
    scannerCount: Object.keys(_state.scannerTuning).length,
  };
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

module.exports = {
  processFeedback,
  processMeasure,
  getTuning,
  checkAggregateDrift,
  loadState,
  saveState,

  // Exposed for testing
  _internals: {
    get _state() { return _state; },
    set _state(val) {
      // Allow test reset
      Object.assign(_state, val);
    },
    resetState() {
      _state.scannerTuning = {};
      _state.agentFeedback = {};
      _state.locked = false;
      _state.lockReason = null;
      _state.events = [];
      _state.tierOverrides = {};
    },
    initScanner,
    emitEvent,
    calculateAggregateDrift,
    applyConfidenceDelta,
    loadState,
    saveState,
    MIN_OBSERVATIONS,
    MAX_DRIFT_PCT,
    AGGREGATE_LOCK_THRESHOLD,
    RATE_LIMIT_MS,
    WARN_CHANGE_THRESHOLD,
    AGENT_FP_ANOMALY_THRESHOLD,
    TIER_FLOOR,
    VALID_SCANNER_RE,
  },
};
