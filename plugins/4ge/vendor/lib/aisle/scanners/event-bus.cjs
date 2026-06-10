'use strict';

/**
 * event-bus.cjs — AISLE Scanner J
 *
 * Tamper-evident JSONL audit log with SHA-256 hash chain.
 * - One file per session per calendar day: events-YYYY-MM-DD-<sessionId>.jsonl
 * - prevHash chain: each line's prevHash = SHA-256(previous raw JSONL line)
 * - External anchor: first event prevHash = SHA-256(sessionId + bootTimestamp)
 * - Monotonic seq counter starting at 1 (gaps detectable even if hashes rebuilt)
 * - BLOCK and QUARANTINE events mirrored to process.stderr (out-of-band witness)
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// -------------------------------------------------------------------------
// Internal state (reset per fresh require())
// -------------------------------------------------------------------------

let _stateDir = null;
let _sessionId = null;
let _bootTimestamp = null;
let _eventsDir = null;
let _logPath = null;

// In-memory counters — source of truth for getStats()
let _eventSeq = 0;
let _sessionBlocks = 0;
let _sessionWarns = 0;
let _sessionLogs = 0;

// prevHash of the last line written (or the anchor before first emit)
let _prevHash = null;

// -------------------------------------------------------------------------
// Private helpers
// -------------------------------------------------------------------------

/** Compute SHA-256 hex digest of a string. */
function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

/** Format today's date as YYYY-MM-DD. */
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Build (or rebuild) the log file path for today + session.
 * Called lazily; also called on day rollover if needed.
 */
function resolveLogPath() {
  return path.join(_eventsDir, `events-${todayStr()}-${_sessionId}.jsonl`);
}

/**
 * Truncate the evidence field of an event object if the resulting JSON
 * line exceeds 10 KB.  Mutates and returns the same object.
 */
function guardLineSize(eventObj) {
  const MAX_BYTES = 10 * 1024;
  const serialized = JSON.stringify(eventObj);
  if (Buffer.byteLength(serialized, 'utf8') <= MAX_BYTES) {
    return eventObj;
  }
  // Truncate evidence first
  if (typeof eventObj.finding === 'string' && eventObj.finding.length > 200) {
    eventObj.finding = eventObj.finding.slice(0, 200) + '[truncated]';
  }
  return eventObj;
}

// -------------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------------

/**
 * Initialize the event bus.
 *
 * @param {string} stateDir      - AISLE state directory
 * @param {string} sessionId     - CC session ID (from stdin BaseHookInput, never env var)
 * @param {number} bootTimestamp - Boot epoch ms (for external anchor)
 */
function init(stateDir, sessionId, bootTimestamp) {
  _stateDir = stateDir;
  _sessionId = sessionId;
  _bootTimestamp = bootTimestamp;

  _eventsDir = path.join(stateDir, 'events');

  if (!fs.existsSync(_eventsDir)) {
    fs.mkdirSync(_eventsDir, { recursive: true });
  }

  _logPath = resolveLogPath();

  // Compute the external anchor: SHA-256(sessionId + bootTimestamp)
  _prevHash = sha256(sessionId + String(bootTimestamp));

  // Reset counters
  _eventSeq = 0;
  _sessionBlocks = 0;
  _sessionWarns = 0;
  _sessionLogs = 0;
}

/**
 * Emit a security event to the JSONL log.
 *
 * @param {object} event - Partial event matching Section 6.2 schema.
 *   Required: type ('BLOCK'|'WARN'|'LOG'|'QUARANTINE'|'SYSTEM'), scanner, tool, finding, decision
 * @returns {number} The eventSeq assigned to this event.
 */
function emit(event) {
  if (_eventsDir === null) {
    throw new Error('event-bus: init() must be called before emit()');
  }

  // Roll over log file if calendar day changed since init (long-running sessions)
  _logPath = resolveLogPath();

  _eventSeq += 1;

  const eventType = (event.type || 'LOG').toUpperCase();

  // Build the event record
  const record = guardLineSize({
    ts: event.ts !== undefined ? event.ts : Date.now(),
    seq: _eventSeq,
    prevHash: _prevHash,
    type: eventType,
    scanner: event.scanner || null,
    tool: event.tool || null,
    finding: event.finding || null,
    decision: event.decision || null,
  });

  let line;
  try {
    line = JSON.stringify(record);
  } catch (err) {
    // Circular reference or other stringify error — emit minimal error event instead
    const fallback = {
      ts: Date.now(),
      seq: _eventSeq,
      prevHash: _prevHash,
      type: 'SYSTEM',
      scanner: 'J',
      tool: null,
      finding: 'event-bus: JSON.stringify failed: ' + String(err.message),
      decision: null,
    };
    line = JSON.stringify(fallback);
  }

  // Append to JSONL file (newline-terminated)
  fs.appendFileSync(_logPath, line + '\n', 'utf8');

  // Advance the hash chain: prevHash for next event = SHA-256 of this raw line
  _prevHash = sha256(line);

  // Update counters
  if (eventType === 'BLOCK') {
    _sessionBlocks += 1;
  } else if (eventType === 'WARN') {
    _sessionWarns += 1;
  } else if (eventType === 'LOG') {
    _sessionLogs += 1;
  }
  // QUARANTINE and SYSTEM are counted in eventCount only

  // Mirror critical events to stderr (out-of-band witness)
  if (eventType === 'BLOCK' || eventType === 'QUARANTINE') {
    process.stderr.write(
      '[AISLE] ' + eventType + ' seq=' + _eventSeq + ' scanner=' + record.scanner +
      ' finding=' + String(record.finding) + '\n'
    );
  }

  return _eventSeq;
}

/**
 * Return session statistics.
 *
 * @returns {{ sessionBlocks: number, sessionWarns: number, sessionLogs: number, eventCount: number }}
 */
function getStats() {
  return {
    sessionBlocks: _sessionBlocks,
    sessionWarns: _sessionWarns,
    sessionLogs: _sessionLogs,
    eventCount: _eventSeq,
  };
}

/**
 * Verify the hash chain integrity of a JSONL log file.
 *
 * Checks:
 * 1. prevHash of each event matches SHA-256 of the previous raw line.
 * 2. seq is monotonically increasing without gaps (1, 2, 3, ...).
 * 3. The first event's prevHash matches the current external anchor
 *    (SHA-256(sessionId + bootTimestamp)) — only possible if init() was called.
 *
 * @param {string} logPath - Absolute path to the JSONL log file.
 * @returns {{ valid: boolean, brokenAt?: number, reason?: string }}
 */
function verifyChain(logPath) {
  let rawContent;
  try {
    rawContent = fs.readFileSync(logPath, 'utf8');
  } catch (err) {
    return { valid: false, reason: 'Cannot read log file: ' + err.message };
  }

  const lines = rawContent
    .split('\n')
    .filter(l => l.trim().length > 0);

  if (lines.length === 0) {
    // Empty file is trivially valid
    return { valid: true };
  }

  // Parse all lines first — any parse failure is a corruption indicator
  const events = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      events.push(JSON.parse(lines[i]));
    } catch (_) {
      return { valid: false, brokenAt: i + 1, reason: 'JSON parse error on line ' + (i + 1) };
    }
  }

  // Validate the first event's anchor
  if (_sessionId !== null && _bootTimestamp !== null) {
    const expectedAnchor = sha256(_sessionId + String(_bootTimestamp));
    if (events[0].prevHash !== expectedAnchor) {
      return {
        valid: false,
        brokenAt: 1,
        reason: 'Anchor mismatch on first event: expected ' + expectedAnchor +
          ' got ' + events[0].prevHash,
      };
    }
  }

  // Walk the chain: line i+1's prevHash must equal SHA-256(lines[i])
  for (let i = 1; i < lines.length; i++) {
    const expectedPrev = sha256(lines[i - 1]);
    if (events[i].prevHash !== expectedPrev) {
      return {
        valid: false,
        brokenAt: i + 1,
        reason: 'Hash chain broken at line ' + (i + 1) +
          ': expected ' + expectedPrev + ' got ' + events[i].prevHash,
      };
    }
  }

  // Validate monotonic seq (no gaps, starts at 1)
  const firstSeq = events[0].seq;
  for (let i = 0; i < events.length; i++) {
    const expectedSeq = firstSeq + i;
    if (events[i].seq !== expectedSeq) {
      return {
        valid: false,
        brokenAt: i + 1,
        reason: 'Sequence gap at line ' + (i + 1) +
          ': expected seq ' + expectedSeq + ' got ' + events[i].seq,
      };
    }
  }

  return { valid: true };
}

// -------------------------------------------------------------------------
// Module exports
// -------------------------------------------------------------------------

module.exports = {
  init,
  emit,
  getStats,
  verifyChain,
};
