'use strict';

const DEFAULT_COMPACT_THRESHOLD = 75; // tool calls before suggesting compact

/**
 * Estimates remaining tool calls before compact threshold.
 *
 * @param {number} threshold - The compact threshold (max tool calls)
 * @param {number} current - Current tool call count
 * @returns {number}
 */
function estimateCallsRemaining(threshold, current) {
  return Math.max(0, threshold - current);
}

/**
 * Gets urgency level based on usage percentage.
 *
 * @param {number} current - Current tool call count
 * @param {number} threshold - The compact threshold
 * @returns {'low'|'medium'|'high'}
 */
function getUrgencyLevel(current, threshold) {
  const pct = (current / threshold) * 100;
  if (pct >= 90) return 'high';
  if (pct >= 50) return 'medium';
  return 'low';
}

/**
 * Forecasts context budget remaining.
 *
 * @param {{ tool_calls: number, session_started: string, compact_threshold?: number }} params
 * @returns {{ calls_remaining: number, rate_per_minute: number, estimated_minutes_remaining: number|null, urgency: string, percentage_used: number }}
 */
function forecastBudget(params) {
  const threshold = params.compact_threshold || DEFAULT_COMPACT_THRESHOLD;
  const current = params.tool_calls || 0;
  const callsRemaining = estimateCallsRemaining(threshold, current);
  const urgency = getUrgencyLevel(current, threshold);

  const elapsedMs = Date.now() - new Date(params.session_started).getTime();
  // Sub-second sessions produce absurd rates from 1-2ms of wall-clock jitter
  // and are operationally equivalent to zero elapsed time.
  const elapsedMinutes = elapsedMs >= 1000 ? elapsedMs / 60000 : 0;
  const ratePerMinute = elapsedMinutes > 0 ? current / elapsedMinutes : 0;

  const estimatedMinutesRemaining = ratePerMinute > 0
    ? Math.round(callsRemaining / ratePerMinute * 10) / 10
    : null;

  return {
    calls_remaining: callsRemaining,
    rate_per_minute: Math.round(ratePerMinute * 100) / 100,
    estimated_minutes_remaining: estimatedMinutesRemaining,
    urgency,
    percentage_used: Math.round((current / threshold) * 100),
  };
}

module.exports = { forecastBudget, estimateCallsRemaining, getUrgencyLevel, DEFAULT_COMPACT_THRESHOLD };
