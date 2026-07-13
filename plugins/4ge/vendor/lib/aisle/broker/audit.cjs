'use strict';

/**
 * audit.cjs — append-only audit log for the AISLE authorization broker.
 *
 * One JSON object per line at <brokerDir>/audit.jsonl. Records the lifecycle of
 * every token: minted, displayed, consumed, denied, expired, revoked. The audit
 * trail is deliberately content-free about secrets: it carries the token_id (a
 * public handle), the bindings-digest (prefix is sufficient), the action class,
 * targets, an outcome, and a reason — never the raw nonce, never a paste-token,
 * never file contents, never secret values.
 *
 * Importable WITHOUT OS boot. Zero imports from gate-era modules or lib/os/.
 */

const fs = require('fs');
const path = require('path');

const AUDIT_EVENTS = new Set([
  'requested',
  'minted',
  'displayed',
  'consumed',
  'denied',
  'expired',
  'revoked',
]);

// Fields allowed to leave this module onto disk. Anything not on this list is
// dropped rather than logged — a structural guard against a caller accidentally
// threading a nonce or secret through the audit path.
const ALLOWED_FIELDS = [
  'ts',
  'event',
  'token_id',
  'action_class',
  'bindings_digest',
  'targets',
  'outcome',
  'reason',
  'requestor',
];

function brokerDir(stateDir) {
  return path.join(stateDir, 'broker');
}

/**
 * Sanitize an event record down to the allowed field set and normalize the
 * bindings_digest to its prefix (never store the full digest in audit — the
 * prefix is what the operator carries and all that is needed for correlation).
 *
 * @param {object} event
 * @returns {object} sanitized record
 */
function sanitize(event) {
  const src = event || {};
  const out = {};
  for (const key of ALLOWED_FIELDS) {
    if (src[key] === undefined) continue;
    if (key === 'bindings_digest') {
      out[key] = String(src[key]).slice(0, 16);
    } else if (key === 'targets') {
      out[key] = Array.isArray(src[key]) ? src[key].map(String) : [];
    } else {
      out[key] = src[key];
    }
  }
  if (!out.ts) out.ts = new Date().toISOString();
  return out;
}

/**
 * Append one audit event. Creates the broker dir if needed. Best-effort: an
 * audit-write failure must never convert an allow into a deny or vice versa —
 * callers treat this as fire-and-forget. Returns the record actually written
 * (for tests) or null on failure.
 *
 * @param {string} stateDir - AISLE state dir; broker lives at <stateDir>/broker
 * @param {object} event - {event, token_id, action_class, bindings_digest, targets, outcome, reason, requestor}
 * @returns {object|null}
 */
function appendAudit(stateDir, event) {
  try {
    if (event && event.event && !AUDIT_EVENTS.has(event.event)) {
      // Unknown event type — record it but tag it so an unexpected event never
      // silently masquerades as a known one.
      event = { ...event, event: `unknown:${event.event}` };
    }
    const record = sanitize(event);
    const dir = brokerDir(stateDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'audit.jsonl'), JSON.stringify(record) + '\n', 'utf8');
    return record;
  } catch {
    return null;
  }
}

/**
 * Read the tail of the audit log (most recent last).
 * @param {string} stateDir
 * @param {number} [limit] - max records (default 50)
 * @returns {object[]}
 */
function tailAudit(stateDir, limit = 50) {
  try {
    const file = path.join(brokerDir(stateDir), 'audit.jsonl');
    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const records = [];
    for (const line of lines.slice(-Math.max(0, limit))) {
      try {
        records.push(JSON.parse(line));
      } catch {
        // skip a corrupt line rather than fail the whole tail
      }
    }
    return records;
  } catch {
    return [];
  }
}

module.exports = {
  AUDIT_EVENTS,
  ALLOWED_FIELDS,
  brokerDir,
  sanitize,
  appendAudit,
  tailAudit,
};
