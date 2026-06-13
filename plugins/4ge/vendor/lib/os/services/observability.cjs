'use strict';

/**
 * observability.cjs
 *
 * Unified observability module for the Agentic OS kernel.
 *
 * Responsibilities:
 *   - Write structured event entries to a unified JSONL log
 *   - Support filtered queries over the log (stream, event, agentId, since, limit)
 *   - Produce aggregate summaries (total, byStream, byEvent, uniqueAgents)
 *   - Rolling-trim activity.jsonl to the last 1000 entries (bounded UI buffer)
 *
 * Line count is tracked in-memory to avoid re-reading the file on every append.
 * The prior 5000-entry rotation archive path (jsonl-rotate.cjs) was unreachable
 * because the 1000-entry trim always fired first; it was removed along with
 * ROTATION_THRESHOLD and MAX_ROTATED constants.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Filename for the unified event log */
const JSONL_FILE = 'activity.jsonl';

/** Rolling trim threshold — keep at most this many entries in the active file */
const TRIM_THRESHOLD = 1000;

/**
 * Valid stream names for observability events.
 * Consumers may log any stream; this constant documents the known set.
 */
const VALID_STREAMS = [
  'process',
  'capability',
  'resource',
  'ipc',
  'boot',
  'kernel',
  'scheduler',
  'hook',
  'session',
  'alert',
];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Read and parse all lines from the JSONL file.
 * Returns an empty array if the file does not exist or is empty.
 *
 * @param {string} jsonlPath
 * @returns {object[]}
 */
function readAllEntries(jsonlPath) {
  if (!fs.existsSync(jsonlPath)) return [];

  let raw;
  try {
    raw = fs.readFileSync(jsonlPath, 'utf8');
  } catch (_) {
    return [];
  }

  if (!raw || raw.trim() === '') return [];

  const entries = [];
  for (const line of raw.trim().split('\n')) {
    try {
      entries.push(JSON.parse(line));
    } catch (_) {
      // Skip malformed lines
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Create an observability instance backed by `stateDir`.
 *
 * @param {string} stateDir - Directory where the unified JSONL log lives.
 * @returns {{
 *   log(stream: string, event: string, data: object, meta?: object): void,
 *   query(opts: {stream?: string, event?: string, agentId?: string, since?: string, limit?: number}): object[],
 *   summary(): {total: number, byStream: object, byEvent: object, uniqueAgents: number},
 * }}
 */
function createObservability(stateDir) {
  fs.mkdirSync(stateDir, { recursive: true });

  const jsonlPath = path.join(stateDir, JSONL_FILE);

  /** Track JSONL line count in memory to avoid re-reading the file on every append */
  let jsonlLineCount = 0;
  try {
    if (fs.existsSync(jsonlPath)) {
      const existing = fs.readFileSync(jsonlPath, 'utf8');
      jsonlLineCount = existing.trim() === '' ? 0 : existing.trim().split('\n').length;
    }
  } catch (_) { /* start at 0 */ }

  // ---------------------------------------------------------------------------
  // Alert state (per-instance)
  // ---------------------------------------------------------------------------

  /** @type {Array<{stream: string, event: string, threshold: number, windowMs: number, callback: Function}>} */
  const alertRules = [];

  /** @type {Map<string, {count: number, windowStart: number}>} */
  const alertCounters = new Map();

  // ---------------------------------------------------------------------------
  // Alert helpers
  // ---------------------------------------------------------------------------

  /**
   * Check alert rules for a given stream+event after a log call.
   * Fires callback and resets counter when threshold is reached within the window.
   *
   * @param {string} stream
   * @param {string} event
   */
  function _checkAlerts(stream, event) {
    for (const rule of alertRules) {
      if (rule.stream !== stream || rule.event !== event) continue;

      const key = `${stream}:${event}:${alertRules.indexOf(rule)}`;
      const now = Date.now();
      let counter = alertCounters.get(key);

      if (!counter) {
        counter = { count: 0, windowStart: now };
      }

      // Reset window if expired
      if (now - counter.windowStart > rule.windowMs) {
        counter.count = 0;
        counter.windowStart = now;
      }

      counter.count++;
      alertCounters.set(key, counter);

      if (counter.count >= rule.threshold) {
        rule.callback({ stream, event, count: counter.count, windowMs: rule.windowMs });
        counter.count = 0;
        counter.windowStart = Date.now();
      }
    }
  }

  /**
   * Register a threshold-based alert rule.
   *
   * @param {string} stream - Stream to watch (e.g. 'process').
   * @param {string} event - Event name to watch (e.g. 'spawn').
   * @param {{threshold: number, windowMs: number, callback: Function}} opts
   *   threshold  - Number of occurrences that triggers the alert.
   *   windowMs   - Rolling window in milliseconds.
   *   callback   - Function called with { stream, event, count, windowMs }.
   */
  function registerAlert(stream, event, { threshold, windowMs, callback }) {
    alertRules.push({ stream, event, threshold, windowMs, callback });
  }

  // ---------------------------------------------------------------------------
  // log
  // ---------------------------------------------------------------------------

  /**
   * Append an event to the unified log.
   * Rolling-trims activity.jsonl to the last TRIM_THRESHOLD entries after each append.
   *
   * @param {string} stream - Event stream (e.g. 'process', 'capability').
   * @param {string} event - Event name (e.g. 'spawn', 'deny').
   * @param {object} data - Arbitrary event payload merged into the entry.
   * @param {object} [meta] - Optional additional metadata merged into the entry.
   */
  function log(stream, event, data, meta) {
    const entry = {
      ...data,
      ...meta,
      ts: new Date().toISOString(),
      stream,
      event,
    };

    fs.appendFileSync(jsonlPath, JSON.stringify(entry) + '\n', 'utf8');
    jsonlLineCount++;

    // Rolling trim: keep at most TRIM_THRESHOLD entries for UI consumers.
    // Uses the in-memory counter as a fast pre-check to avoid file reads on every call.
    if (jsonlLineCount > TRIM_THRESHOLD) {
      try {
        const raw = fs.readFileSync(jsonlPath, 'utf8');
        const lines = raw.split('\n').filter(Boolean);
        if (lines.length > TRIM_THRESHOLD) {
          fs.writeFileSync(jsonlPath, lines.slice(-TRIM_THRESHOLD).join('\n') + '\n');
          jsonlLineCount = TRIM_THRESHOLD;
        }
      } catch (_) { /* best-effort — never crash log() */ }
    }

    _checkAlerts(stream, event);
  }

  // ---------------------------------------------------------------------------
  // query
  // ---------------------------------------------------------------------------

  /**
   * Query the unified log with optional filters.
   *
   * @param {object} opts
   * @param {string} [opts.stream] - Filter by stream name.
   * @param {string} [opts.event] - Filter by event name.
   * @param {string} [opts.agentId] - Filter by `agent_id` field in the entry.
   * @param {string} [opts.since] - ISO timestamp; return entries with `ts >= since`.
   * @param {number} [opts.limit] - Return the last N matching entries (most recent).
   * @returns {object[]}
   */
  function query(opts) {
    const { stream, event, agentId, since, limit } = opts || {};

    let entries = readAllEntries(jsonlPath);

    if (stream !== undefined) {
      entries = entries.filter(e => e.stream === stream);
    }

    if (event !== undefined) {
      entries = entries.filter(e => e.event === event);
    }

    if (agentId !== undefined) {
      entries = entries.filter(e => e.agent_id === agentId);
    }

    if (since !== undefined) {
      entries = entries.filter(e => e.ts >= since);
    }

    if (limit !== undefined && limit > 0) {
      // Return the last `limit` entries (most recent)
      entries = entries.slice(-limit);
    }

    return entries;
  }

  // ---------------------------------------------------------------------------
  // summary
  // ---------------------------------------------------------------------------

  /**
   * Produce aggregate counts over the entire log.
   *
   * @returns {{total: number, byStream: object, byEvent: object, uniqueAgents: number}}
   */
  function summary() {
    const entries = readAllEntries(jsonlPath);

    const byStream = {};
    const byEvent = {};
    const agentIds = new Set();

    for (const entry of entries) {
      if (entry.stream !== undefined) {
        byStream[entry.stream] = (byStream[entry.stream] || 0) + 1;
      }

      if (entry.event !== undefined) {
        byEvent[entry.event] = (byEvent[entry.event] || 0) + 1;
      }

      if (entry.agent_id !== undefined) {
        agentIds.add(entry.agent_id);
      }
    }

    return {
      total: entries.length,
      byStream,
      byEvent,
      uniqueAgents: agentIds.size,
    };
  }

  // ---------------------------------------------------------------------------
  // getEventSummary
  // ---------------------------------------------------------------------------

  /**
   * Produce a session-oriented summary of logged events.
   * Groups by stream, by event type, and reports an approximate session duration
   * based on the timestamp of the first logged entry.
   *
   * @returns {{
   *   totalEvents: number,
   *   eventsByStream: object,
   *   eventsByType: object,
   *   durationMinutes: number,
   * }}
   */
  function getEventSummary() {
    const entries = readAllEntries(jsonlPath);

    const eventsByStream = {};
    const eventsByType = {};

    for (const entry of entries) {
      if (entry.stream !== undefined) {
        eventsByStream[entry.stream] = (eventsByStream[entry.stream] || 0) + 1;
      }
      if (entry.event !== undefined) {
        eventsByType[entry.event] = (eventsByType[entry.event] || 0) + 1;
      }
    }

    const firstEntry = entries[0];
    const durationMinutes = firstEntry
      ? (Date.now() - Date.parse(firstEntry.ts)) / 60000
      : 0;

    return {
      totalEvents: entries.length,
      eventsByStream,
      eventsByType,
      durationMinutes,
    };
  }

  // ---------------------------------------------------------------------------

  return { log, query, summary, registerAlert, getEventSummary };
}

module.exports = { createObservability, VALID_STREAMS };
