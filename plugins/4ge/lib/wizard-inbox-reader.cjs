'use strict';

const fs = require('node:fs');
const path = require('node:path');

const WIZARD_INBOX = '.4ge-wizard-inbox.jsonl';
const FIX_INBOX = path.join('_runs', '.fix-inbox.jsonl');
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/g;

// Terminal statuses written by the fix writer (modes/fix.md:93) and the
// historical resolved/closed vocabulary. An entry in any of these is closed
// and stops deducting from its category score.
const CLOSED_STATUSES = new Set(['resolved', 'closed', 'applied', 'dismissed']);

// Default auto-purge window (config-schema.md / wizard-defaults.json inbox.max_age_days).
const DEFAULT_MAX_AGE_DAYS = 30;

/**
 * Sanitize a string by stripping ASCII control characters.
 * W6 mitigation: prevents injection via unsanitized $ARGUMENTS.
 * @param {string} str
 * @returns {string}
 */
function sanitizeString(str) {
  if (typeof str !== 'string') return str;
  return str.replace(CONTROL_CHAR_RE, '');
}

/**
 * Read and parse a JSONL file, skipping malformed lines.
 * Returns an array of parsed objects.
 * @param {string} filePath
 * @returns {Object[]}
 */
function readJsonlFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const lines = raw.split('\n');
  const results = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      results.push(JSON.parse(trimmed));
    } catch {
      // Skip malformed lines
    }
  }
  return results;
}

/**
 * Determine whether an entry is "open".
 * Entries without a status field are treated as open. An entry is closed
 * (and stops deducting) once the writer marks it resolved/closed/applied/dismissed.
 * @param {Object} entry
 * @returns {boolean}
 */
function isOpen(entry) {
  if (entry.status === undefined || entry.status === null) return true;
  const s = String(entry.status).toLowerCase();
  return !CLOSED_STATUSES.has(s);
}

/**
 * Whether an entry is older than the purge window.
 * Entries with a missing/unparseable timestamp are NOT purged (fail safe:
 * keep visible rather than silently dropping items that can't be dated).
 * @param {Object} entry
 * @param {number} maxAgeDays
 * @param {number} nowMs - current time in ms (injectable for tests)
 * @returns {boolean}
 */
function isExpired(entry, maxAgeDays, nowMs) {
  if (!maxAgeDays || maxAgeDays <= 0) return false;
  const tsMs = Date.parse(entry.ts);
  if (Number.isNaN(tsMs)) return false; // undated → not purged
  const ageDays = (nowMs - tsMs) / 86_400_000;
  return ageDays > maxAgeDays;
}

/**
 * Normalize a description for deduplication.
 * @param {string} desc
 * @returns {string}
 */
function normalizeDesc(desc) {
  return desc.trim().toLowerCase();
}

/**
 * Read fix-inbox JSONL files and count open items per wizard category.
 *
 * Reads two files:
 *   1. <projectRoot>/.4ge-wizard-inbox.jsonl  (primary)
 *   2. <projectRoot>/_runs/.fix-inbox.jsonl   (hook-health-validator output)
 *
 * Deduplication: when two entries share the same normalized description,
 * the entry from the primary wizard inbox is kept.
 *
 * @param {string} projectRoot - absolute path to project root
 * @param {Object} [opts]
 * @param {number} [opts.maxAgeDays=30] - entries older than this are purged from the open set
 * @param {number} [opts.now=Date.now()] - current time in ms (injectable for tests)
 * @returns {{ categories: Object.<string, number>, total: number, entries: Object[] }}
 */
function readInbox(projectRoot, opts = {}) {
  const maxAgeDays = opts.maxAgeDays !== undefined ? opts.maxAgeDays : DEFAULT_MAX_AGE_DAYS;
  const nowMs = opts.now !== undefined ? opts.now : Date.now();

  // An entry counts toward the score only if it is open AND within the purge window.
  const isActive = (entry) => isOpen(entry) && !isExpired(entry, maxAgeDays, nowMs);

  const primaryPath = path.join(projectRoot, WIZARD_INBOX);
  const secondaryPath = path.join(projectRoot, FIX_INBOX);

  const primaryRaw = readJsonlFile(primaryPath);
  const secondaryRaw = readJsonlFile(secondaryPath);

  // Sanitize and validate all entries from both sources.
  // Track source so primary wins dedup.
  const sanitize = (entry, source) => {
    if (!entry || typeof entry !== 'object') return null;
    if (!entry.description) return null; // skip entries without description

    return {
      ts: entry.ts || '',
      description: sanitizeString(entry.description),
      category: entry.category || 'uncategorized',
      source: entry.source || source,
      status: entry.status,
      confidence: entry.confidence !== undefined ? entry.confidence : 1,
      tier: entry.tier || 'noted',
    };
  };

  const primaryEntries = primaryRaw
    .map((e) => sanitize(e, 'wizard-inbox'))
    .filter(Boolean)
    .filter(isActive);

  const secondaryEntries = secondaryRaw
    .map((e) => sanitize(e, 'hook-health-validator'))
    .filter(Boolean)
    .filter(isActive);

  // Deduplication: build a map keyed by normalized description.
  // Primary entries are inserted first so they win over secondary.
  const seen = new Map();

  for (const entry of primaryEntries) {
    const key = normalizeDesc(entry.description);
    if (!seen.has(key)) {
      seen.set(key, entry);
    }
  }

  for (const entry of secondaryEntries) {
    const key = normalizeDesc(entry.description);
    if (!seen.has(key)) {
      seen.set(key, entry);
    }
  }

  const entries = Array.from(seen.values());

  // Count per category
  const categories = {};
  for (const entry of entries) {
    const cat = entry.category || 'uncategorized';
    categories[cat] = (categories[cat] || 0) + 1;
  }

  return {
    categories,
    total: entries.length,
    entries,
  };
}

module.exports = {
  readInbox,
  isOpen,
  isExpired,
};
