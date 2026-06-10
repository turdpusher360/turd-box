'use strict';

/**
 * ipc.cjs
 *
 * Kernel service for inter-process communication between agents.
 *
 * Responsibilities:
 *   - Write typed messages to a per-session directory as JSON files
 *   - Read and filter messages by target PID, timestamp, and TTL
 *   - Support broadcast messages deliverable to any PID
 *   - Validate message types against the allowed set
 *   - Link RESPONSE messages to their originating REQUEST via correlationId
 *
 * Message file naming: <epoch-ms>-<id-prefix>.json
 * Session directory:   <stateDir>/ipc/<sessionId>/
 *
 * Message shape:
 *   { id, type, from, to, timestamp, correlationId, payload }
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** Exhaustive list of permitted message types. */
const VALID_TYPES = ['REQUEST', 'RESPONSE', 'BROADCAST', 'HEARTBEAT', 'HANDOFF', 'SHUTDOWN'];

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Create an IPC service scoped to a single session.
 *
 * @param {string} stateDir  - Root state directory (e.g. a tmp dir in tests).
 * @param {string} sessionId - Logical session identifier; determines the
 *                             subdirectory under `<stateDir>/ipc/`.
 * @returns {{
 *   send(opts: object): object,
 *   receive(pid: number|string, opts?: object): object[],
 *   broadcast(opts: object): object,
 * }}
 */
function createIPC(stateDir, sessionId) {
  const sessionDir = path.join(stateDir, 'ipc', sessionId);

  // ---------------------------------------------------------------------------
  // send
  // ---------------------------------------------------------------------------

  /**
   * Write a message to the session directory.
   *
   * @param {object} opts
   * @param {object}  [opts.from]          - Sender descriptor { pid, agentType }.
   * @param {object}   opts.to             - Recipient descriptor { pid, agentType }.
   *                                        Use pid: '*' for broadcasts.
   * @param {string}   opts.type           - One of VALID_TYPES.
   * @param {string}  [opts.correlationId] - ID of the message being replied to.
   * @param {object}   opts.payload        - Arbitrary message data.
   *                                        payload.ttl (number, seconds) is
   *                                        consumed by receive() for expiry.
   * @returns {object} The persisted message object.
   * @throws {Error} When `type` is not in VALID_TYPES.
   */
  function send({ from, to, type, correlationId, payload }) {
    if (!VALID_TYPES.includes(type)) {
      throw new Error(`Invalid message type: ${type}. Must be one of: ${VALID_TYPES.join(', ')}`);
    }

    const id = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    const message = {
      id,
      type,
      from: from || null,
      to,
      timestamp,
      correlationId: correlationId || null,
      payload,
    };

    // Ensure session directory exists before writing.
    fs.mkdirSync(sessionDir, { recursive: true });

    const filename = `${Date.now()}-${id.slice(0, 8)}.json`;
    fs.writeFileSync(path.join(sessionDir, filename), JSON.stringify(message, null, 2));

    return message;
  }

  // ---------------------------------------------------------------------------
  // receive
  // ---------------------------------------------------------------------------

  /**
   * Read all messages addressed to `pid` from the session directory.
   *
   * Filtering rules applied in order:
   *   1. Recipient match: msg.to.pid === pid  OR  msg.to.pid === '*'
   *   2. Since filter:    msg.timestamp >= opts.since  (when provided)
   *   3. TTL expiry:      skip if payload.ttl (seconds) has elapsed since
   *                       msg.timestamp
   *
   * @param {number|string} pid  - Target process ID (or '*' wildcard).
   * @param {object} [opts]
   * @param {string} [opts.since] - ISO timestamp lower bound (inclusive).
   * @returns {object[]} Matching messages sorted ascending by timestamp.
   */
  function receive(pid, opts = {}) {
    // Return empty array when no messages have been sent yet.
    if (!fs.existsSync(sessionDir)) {
      return [];
    }

    const files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.json'));
    const now = Date.now();
    const messages = [];

    for (const file of files) {
      let msg;
      try {
        msg = JSON.parse(fs.readFileSync(path.join(sessionDir, file), 'utf8'));
      } catch (_) {
        // Corrupt or partial write — skip silently.
        continue;
      }

      // 1. Recipient match: direct address or broadcast wildcard.
      if (msg.to.pid !== pid && msg.to.pid !== '*') {
        continue;
      }

      // 2. Timestamp lower bound.
      if (opts.since && msg.timestamp < opts.since) {
        continue;
      }

      // 3. TTL expiry — measured in seconds from the message's own timestamp.
      if (typeof msg.payload?.ttl === 'number') {
        const ageSeconds = (now - new Date(msg.timestamp).getTime()) / 1000;
        if (ageSeconds >= msg.payload.ttl) {
          continue;
        }
      }

      messages.push(msg);
    }

    // Sort ascending by ISO timestamp (lexicographic sort is correct for ISO 8601).
    messages.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));

    return messages;
  }

  // ---------------------------------------------------------------------------
  // broadcast
  // ---------------------------------------------------------------------------

  /**
   * Send a message to all recipients (pid: '*').
   *
   * @param {object} opts
   * @param {string} [opts.type='BROADCAST'] - Message type (defaults to BROADCAST).
   * @param {object}  opts.payload           - Arbitrary message data.
   * @param {object} [opts.from]             - Sender descriptor.
   * @param {string} [opts.correlationId]    - Optional correlation ID.
   * @returns {object} The persisted message object.
   */
  function broadcast({ type = 'BROADCAST', payload, from, correlationId } = {}) {
    return send({ from, to: { pid: '*' }, type, correlationId, payload });
  }

  // ---------------------------------------------------------------------------
  // cleanup
  // ---------------------------------------------------------------------------

  /**
   * Delete IPC message files older than maxAgeMs milliseconds.
   * @param {number} maxAgeMs - Maximum age in ms before deletion
   * @returns {number} Count of deleted files
   */
  function cleanup(maxAgeMs) {
    let deleted = 0;
    try {
      const files = fs.readdirSync(sessionDir);
      const cutoff = Date.now() - maxAgeMs;
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const filePath = path.join(sessionDir, file);
        try {
          const stat = fs.statSync(filePath);
          if (stat.mtimeMs < cutoff) {
            fs.unlinkSync(filePath);
            deleted++;
          }
        } catch { /* file may have been consumed */ }
      }
    } catch { /* session dir may not exist yet */ }
    return deleted;
  }

  // ---------------------------------------------------------------------------

  return { send, receive, broadcast, cleanup };
}

module.exports = { createIPC };
