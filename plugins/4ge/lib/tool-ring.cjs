'use strict';
/**
 * tool-ring.cjs — Append-and-rotate ring buffer of recent tool events.
 *
 * Stored at `_runs/os/tool-ring.json` (project-local, gitignored).
 * Keeps last N tool events for intent detection and session analytics.
 *
 * Location decision (S303 C7): kept at `_runs/os/` rather than
 * `CLAUDE_PLUGIN_DATA` because (a) tool ring is per-project activity
 * matching `_runs/` semantic, (b) repo hooks (e.g. .claude/hooks/) do
 * not auto-receive `CLAUDE_PLUGIN_DATA` env var — same constraint that
 * drove S302 d7bb876 to move session-history.json out of PLUGIN_DATA,
 * (c) PLUGIN_DATA is reserved for cross-project state (badges, telemetry,
 * checkpoint buddy) — different category from per-session activity.
 *
 * Storage format: JSONL — one JSON object per line.
 *
 * Race-condition fix: each append is a single `appendFileSync` call,
 * which is atomic at the OS level (O_APPEND). Concurrent PostToolUse
 * hooks writing simultaneously each get their line written without
 * clobbering each other.
 *
 * Capacity enforcement: after every append, if the file has more than
 * `capacity` entries, it is rewritten to exactly the last `capacity`
 * entries via an atomic tmp/rename. This preserves the same behavioural
 * contract as the old JSON read-modify-write approach.
 *
 * Disk-bloat optimization: skip the rewrite check when the file has
 * grown beyond TRIM_THRESHOLD (capacity × TRIM_FACTOR = 150 lines) but
 * is still within TRIM_SKIP_BELOW. In practice the check fires on every
 * append that pushes past capacity (i.e. on the 31st append and every
 * few appends thereafter), keeping file size tightly bounded.
 *
 * Old JSON-array format (single-line `[{...}]`): treated as corrupt
 * and dropped on first read. The ring is ephemeral — no migration.
 *
 * All functions are fail-safe — never throw, always return sensibly
 * on I/O failure (empty array / no-op write).
 */

const fs = require('node:fs');
const path = require('node:path');
const { writeFileAtomic } = require('./atomic-write.cjs');

const DEFAULT_CAPACITY = 30;
const TRIM_FACTOR = 5;
const RING_FILENAME = 'tool-ring.json';

function ringPath(stateDir) {
  return path.join(stateDir || path.join(process.cwd(), '_runs', 'os'), RING_FILENAME);
}

/**
 * Parse raw JSONL file content into an array of objects.
 * Malformed lines (non-JSON or non-object) are silently skipped.
 * Lines that look like a JSON array (`[...`) are treated as corrupt
 * (old JSON-array storage format — migration policy: drop and move on).
 */
function parseJsonl(raw) {
  const lines = raw.split('\n');
  const entries = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('[')) continue; // old format — drop
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        entries.push(obj);
      }
    } catch {
      // Malformed line — skip
    }
  }
  return entries;
}

function readRing(stateDir, capacity) {
  try {
    const p = ringPath(stateDir);
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, 'utf8');
    const entries = parseJsonl(raw);
    const limit = capacity || DEFAULT_CAPACITY;
    return entries.length > limit ? entries.slice(-limit) : entries;
  } catch {
    return [];
  }
}

/**
 * Rewrite the file to only the last `capacity` entries.
 * Delegates to writeFileAtomic (tmp+rename with EPERM retry + fallback).
 */
function trimFile(p, entries, capacity) {
  const trimmed = entries.slice(-capacity);
  writeFileAtomic(p, trimmed.map(e => JSON.stringify(e)).join('\n') + '\n');
}

function appendTool(entry, opts = {}) {
  try {
    const stateDir = opts.stateDir || path.join(process.cwd(), '_runs', 'os');
    const capacity = opts.capacity || DEFAULT_CAPACITY;
    const trimThreshold = capacity * TRIM_FACTOR;

    if (!fs.existsSync(stateDir)) {
      try { fs.mkdirSync(stateDir, { recursive: true }); } catch { /* best-effort */ }
    }

    const normalized = normalizeEntry(entry);
    if (!normalized) return;

    const p = ringPath(stateDir);

    // Atomic single-syscall append — no read-modify-write race
    fs.appendFileSync(p, JSON.stringify(normalized) + '\n', 'utf8');

    // Capacity enforcement: rewrite when file exceeds capacity entries.
    // Skip the read+rewrite when file is still small (< trimThreshold lines)
    // AND within the first `capacity` entries — fast path for the common case.
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const nonEmpty = raw.split('\n').filter(l => l.trim());
      // Trim whenever over capacity OR when bloat threshold is hit
      if (nonEmpty.length > capacity) {
        const entries = parseJsonl(raw);
        trimFile(p, entries, capacity);
      } else if (nonEmpty.length > trimThreshold) {
        // Defensive: trimThreshold > capacity, so this branch is unreachable
        // in normal operation, but keeps the file bounded if capacity is 0.
        const entries = parseJsonl(raw);
        trimFile(p, entries, capacity);
      }
    } catch {
      // Best-effort trim check
    }
  } catch {
    // Ring buffer is best-effort — no-op on failure
  }
}

// Coerce PostToolUse `tool_response` (untyped, varies by tool) to a searchable
// string for the ring's output preview. Harness field is `tool_response` (schema:
// coreSchemas.ts z.unknown()), NOT `tool_result`. Reading the wrong field blinded
// the ring's output capture and anomaly-flagger's output-pattern error detection.
// Verified S392 against harness-intel/playbook/architecture-map.md:345.
function coerceToolOutput(toolResponse) {
  if (toolResponse == null) return '';
  if (typeof toolResponse === 'string') return toolResponse;
  if (typeof toolResponse === 'object') {
    // Extract genuine output text only; metadata-only objects (e.g. Write/Edit
    // {filePath,success}) return '' rather than their JSON, so the ring's output
    // preview stays clean and anomaly-flagger's pattern checks don't match
    // stringified metadata (S392 adversarial-verify P3).
    const cand = [toolResponse.stdout, toolResponse.stderr, toolResponse.output, toolResponse.content]
      .filter(v => typeof v === 'string' && v.length > 0);
    return cand.length ? cand.join('\n') : '';
  }
  return String(toolResponse);
}

function normalizeEntry(input) {
  if (!input) return null;
  const tool = input.tool_name || input.tool || '';
  if (!tool) return null;
  const ti = input.tool_input || {};
  const out = { tool, ts: Date.now() };
  if (tool === 'Bash' && ti.command) out.command = String(ti.command).slice(0, 200);
  if (ti.file_path) out.filePath = String(ti.file_path);
  if (ti.replace_all === true) out.replaceAll = true;

  // Preserve error signal from hook input — used by anomaly-flagger's
  // rapid-error-cascade and error-regression checks. Without this, the
  // ring silently drops the isError flag and those checks are blind.
  if (input.isError === true) out.isError = true;

  // Preserve a short preview of tool output for pattern-based error detection
  // (e.g., "FAIL src/foo.test.js" in vitest output). Cap at 400 chars so the
  // ring file doesn't bloat — we only need substring matching, not full text.
  // Harness field is `tool_response` (NOT `tool_result` — see coerceToolOutput).
  const result = coerceToolOutput(input.tool_response);
  if (result.length > 0) {
    out.output = result.slice(0, 400);
  }
  return out;
}

function clearRing(stateDir) {
  try {
    const p = ringPath(stateDir);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    // Best-effort
  }
}

module.exports = {
  appendTool,
  readRing,
  clearRing,
  normalizeEntry,
  DEFAULT_CAPACITY,
  RING_FILENAME,
};
