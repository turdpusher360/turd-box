'use strict';

/**
 * operator-queue.cjs
 *
 * Postmortem P4 (_runs/2026-07-02/postmortem-ecosystem-stranded-work.md):
 * operator-only decisions (credential revokes, PR merges, ratify calls) used
 * to live scattered across handoffs and TASKING.md, invisible until an
 * agent happened to surface them. `OPERATOR-QUEUE.md` (repo root) is now the
 * first-class, dated home for that list — this module reads its "## Open"
 * table and reduces it to a one-line boot-brief count + oldest-item age, so
 * the operator's importance is visible and bounded instead of ambient.
 *
 * Format contract (OPERATOR-QUEUE.md, as authored by the lead 2026-07-02):
 *   `## Open` heading, followed by a GFM table with columns
 *   `| Added | Class | Ask | Source |`. `Added` is `YYYY-MM-DD`, optionally
 *   suffixed with an approximation marker (e.g. `2026-05-04≈`). Parsing
 *   stops at the next `## ` heading (the `## Deferred` / `## Done` sections
 *   are intentionally not counted as pending).
 *
 * Fail-open: a missing file, an empty/malformed "## Open" section, or a row
 * with an unparseable `Added` date degrades gracefully — the row still
 * counts toward the total (it's still a real pending item) but is excluded
 * from the oldest-item calculation. The module never throws.
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_FILENAME = 'OPERATOR-QUEUE.md';

/**
 * Split a markdown table row into trimmed cells. Handles the leading/
 * trailing `|` that GFM tables conventionally include.
 *
 * @param {string} line
 * @returns {string[]}
 */
function splitRow(line) {
  let cells = line.split('|');
  if (cells.length && cells[0].trim() === '') cells = cells.slice(1);
  if (cells.length && cells[cells.length - 1].trim() === '') cells = cells.slice(0, -1);
  return cells.map((c) => c.trim());
}

/** A separator row looks like `---|---|---` (each cell only dashes/colons/spaces). */
function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

/**
 * Parse the "## Open" table out of OPERATOR-QUEUE.md text.
 *
 * @param {string} text - raw file contents
 * @returns {{ added: string|null, ageDays: number|null, class: string, ask: string, source: string }[]}
 */
function parseOperatorQueue(text) {
  if (typeof text !== 'string') return [];

  const lines = text.split('\n');
  let inOpenSection = false;
  let sawHeaderRow = false;
  const items = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');

    if (/^##\s+Open\s*$/i.test(line.trim())) {
      inOpenSection = true;
      sawHeaderRow = false;
      continue;
    }
    if (inOpenSection && /^##\s+/.test(line.trim())) {
      // Next section (Deferred / Done / etc.) — stop.
      break;
    }
    if (!inOpenSection) continue;
    if (!line.trim().startsWith('|')) continue;

    const cells = splitRow(line);
    if (cells.length === 0) continue;
    if (isSeparatorRow(cells)) continue;
    if (!sawHeaderRow) {
      // First non-separator row after "## Open" is the column header.
      sawHeaderRow = true;
      continue;
    }
    if (cells.length < 3) continue; // malformed row — skip, don't crash

    const [addedRaw, classRaw, askRaw, sourceRaw] = cells;
    const dateMatch = addedRaw.match(/^(\d{4}-\d{2}-\d{2})/);
    let added = null;
    let ageDays = null;
    if (dateMatch) {
      const t = Date.parse(dateMatch[1]);
      if (Number.isFinite(t)) {
        added = dateMatch[1];
        ageDays = Math.max(0, Math.floor((Date.now() - t) / 86400000));
      }
    }

    items.push({
      added,
      ageDays,
      class: classRaw || 'unknown',
      ask: askRaw || '',
      source: sourceRaw || '',
    });
  }

  return items;
}

/**
 * Reduce parsed items to a boot-brief summary.
 *
 * @param {ReturnType<typeof parseOperatorQueue>} items
 * @returns {{ count: number, oldestDays: number|null, oldestClass: string|null, oldestAdded: string|null }}
 */
function computeQueueSummary(items) {
  const list = Array.isArray(items) ? items : [];
  let oldestDays = null;
  let oldestClass = null;
  let oldestAdded = null;

  for (const item of list) {
    if (item.ageDays === null) continue;
    if (oldestDays === null || item.ageDays > oldestDays) {
      oldestDays = item.ageDays;
      oldestClass = item.class;
      oldestAdded = item.added;
    }
  }

  return { count: list.length, oldestDays, oldestClass, oldestAdded };
}

/**
 * Read + parse OPERATOR-QUEUE.md and return the boot-brief summary.
 * Fail-open: `{ available: false }` on any read error.
 *
 * @param {{ repoRoot?: string, filePath?: string }} [opts]
 * @returns {{ available: boolean, count: number|null, oldestDays: number|null, oldestClass: string|null, oldestAdded: string|null }}
 */
function readOperatorQueue(opts) {
  const options = opts || {};
  const filePath = options.filePath || path.join(options.repoRoot || process.cwd(), DEFAULT_FILENAME);

  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const items = parseOperatorQueue(text);
    const summary = computeQueueSummary(items);
    return { available: true, ...summary };
  } catch {
    return { available: false, count: null, oldestDays: null, oldestClass: null, oldestAdded: null };
  }
}

/**
 * Format the boot-brief line. Never throws.
 *
 * @param {ReturnType<typeof readOperatorQueue>} result
 * @returns {string}
 */
function formatOperatorQueueLine(result) {
  if (!result || result.available === false) {
    return 'OPERATOR-QUEUE.md not found — queue status unknown';
  }
  if (!result.count) {
    return '0 operator items pending';
  }
  if (result.oldestDays === null) {
    return `${result.count} operator item${result.count === 1 ? '' : 's'} pending (oldest date unparseable)`;
  }
  return `${result.count} operator item${result.count === 1 ? '' : 's'} pending, oldest ${result.oldestDays}d (${result.oldestClass})`;
}

module.exports = {
  DEFAULT_FILENAME,
  parseOperatorQueue,
  computeQueueSummary,
  readOperatorQueue,
  formatOperatorQueueLine,
};
