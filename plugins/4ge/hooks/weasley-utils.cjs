#!/usr/bin/env node
/**
 * Weasley Clock shared utilities.
 *
 * The Weasley Clock is a cross-session agent-location tracker. Multiple Claude
 * Code sessions (lead + teammates + parallel terminals) can edit the same repo
 * at once with no awareness of each other. Weasley records which agent is active
 * and which files it "owns" (recently edited) into a state file that lives in the
 * AISLE state dir — a location immune to CC's file cache and shared across every
 * session on the machine (the golden-copy approach). This is what makes
 * cross-session awareness possible without a memory hub or file locking.
 *
 * This module owns the pure, side-effect-light helpers shared by the heartbeat
 * (PostToolUse writer) and the conflict-check (PreToolUse reader) hooks. The
 * conflict-detection logic (detectConflict) is a PURE function so it can be unit
 * tested with no fs/stdin mocks.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// An agent entry is "stale" (the owning agent has gone quiet) after this window.
// Anything older is ignored for conflict checks and eligible for clock pruning.
const STALE_MS = 60000;
// A file is only "owned" for conflict purposes if it was touched this recently.
// Beyond this, the agent has likely moved on — warning would be noise.
const FILE_OWNERSHIP_MS = 60000;
// Keep at most this many recently-touched files per agent entry.
const MAX_FILES = 12;

/**
 * Resolve the AISLE state directory. MUST match wizard-scan-aisle.cjs exactly so
 * Weasley state lives alongside the other AISLE scanner state. This is the
 * CC-cache-immune, cross-session-shared location — NOT a _runs/ path (which is
 * per-checkout and subject to ghost reversion).
 *
 * cwd "/mnt/o/Sand_Box_Dev" -> "mnt-o-Sand-Box-Dev".
 * @param {string} [cwd] override for testing
 * @returns {string}
 */
function resolveAisleStateDir(cwd) {
  const projectId = (cwd || process.cwd())
    .replace(/[\\/:\s_]/g, '-')
    .replace(/^-+/, '');
  return path.join(os.homedir(), '.claude', 'projects', projectId, 'aisle');
}

/** Absolute path to the authoritative clock file (AISLE dir). */
function clockPath(cwd) {
  return path.join(resolveAisleStateDir(cwd), 'clock.json');
}

/**
 * Classify the caller from a hook stdin payload into a stable identity.
 * Mirrors os-accounting.cjs classifyCaller so the two compose cleanly.
 * @param {object} input parsed hook stdin
 * @returns {{type:string, id:string, name:string}}
 */
function classifyCaller(input) {
  input = input || {};
  if (!input.agent_id) {
    return { type: 'main', id: 'main', name: 'lead' };
  }
  if (input.agent_type === 'in_process_teammate') {
    return { type: 'teammate', id: input.agent_id, name: input.agent_id };
  }
  return { type: 'subagent', id: input.agent_id, name: input.agent_type || 'unknown' };
}

/**
 * Build the per-agent clock key. Keyed by BOTH session_id and caller.id because
 * two parallel sessions each classify their lead as "main" — keying on caller.id
 * alone would collide them, defeating the entire cross-session purpose.
 * @param {string} sessionId
 * @param {{id:string}} caller
 * @returns {string}
 */
function clockKey(sessionId, caller) {
  const sid = String(sessionId || 'nosession').slice(0, 12);
  return `${sid}:${caller.id}`;
}

/** Sanitize a key for safe use (defensive; keys are otherwise machine-built). */
function sanitizeKey(k) {
  return String(k || 'unknown').replace(/[^a-zA-Z0-9_:.-]/g, '_');
}

/**
 * Read the clock JSON. Never throws; returns an empty shape on any error.
 * @param {string} [cwd]
 * @returns {{agents: object}}
 */
function readClock(cwd) {
  try {
    const raw = fs.readFileSync(clockPath(cwd), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.agents) return parsed;
  } catch { /* missing or corrupt — fall through to empty */ }
  return { agents: {} };
}

/**
 * Atomically write the clock JSON (tmp + rename). The read-modify-write is
 * best-effort: two agents writing simultaneously can lose one update. Staleness
 * expiry (STALE_MS) bounds the damage — a clobbered entry simply re-registers on
 * the agent's next tool call. We do NOT claim race-freedom.
 * @param {object} clock
 * @param {string} [cwd]
 * @returns {boolean} success
 */
function writeClock(clock, cwd) {
  try {
    const dir = resolveAisleStateDir(cwd);
    fs.mkdirSync(dir, { recursive: true });
    const dest = clockPath(cwd);
    const tmp = dest + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(clock));
    fs.renameSync(tmp, dest);
    return true;
  } catch {
    return false;
  }
}

/**
 * Drop agent entries with no heartbeat within STALE_MS.
 * @param {{agents:object}} clock
 * @param {number} now epoch ms
 * @returns {{agents:object}}
 */
function pruneStale(clock, now) {
  const agents = {};
  for (const [k, v] of Object.entries((clock && clock.agents) || {})) {
    if (v && typeof v.lastActive === 'number' && now - v.lastActive <= STALE_MS) {
      agents[k] = v;
    }
  }
  return { agents };
}

/**
 * Normalize an edit-tool input into the target file path (absolute when given).
 * Returns null for non-file tools.
 * @param {string} toolName
 * @param {object} toolInput
 * @returns {string|null}
 */
function extractEditTarget(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'NotebookEdit') {
    const p = toolInput.file_path || toolInput.notebook_path || toolInput.path;
    return typeof p === 'string' && p.length > 0 ? p : null;
  }
  return null;
}

/**
 * PURE conflict detector. Given the current clock state, a candidate file the
 * caller is about to edit, and the caller's own key, return a warning string if
 * ANOTHER live agent recently touched that same file — otherwise null.
 *
 * Rules (all required to keep the signal from becoming noise):
 *   - exclude the caller's own entries (selfKey)
 *   - exclude stale agents (no heartbeat within STALE_MS)
 *   - per-file recency: the other agent must have touched THIS file within
 *     FILE_OWNERSHIP_MS, not merely be alive
 *   - WARN only, never block
 *
 * @param {{agents:object}} clock
 * @param {string} candidateFile  absolute or repo-relative path being edited
 * @param {string} selfKey        clockKey of the caller (excluded)
 * @param {number} now            epoch ms
 * @returns {string|null} human warning, or null when clear
 */
function detectConflict(clock, candidateFile, selfKey, now) {
  if (!candidateFile) return null;
  const agents = (clock && clock.agents) || {};
  const owners = [];
  for (const [k, entry] of Object.entries(agents)) {
    if (k === selfKey) continue;
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.lastActive !== 'number' || now - entry.lastActive > STALE_MS) continue;
    const files = entry.files && typeof entry.files === 'object' ? entry.files : {};
    const touchedAt = files[candidateFile];
    if (typeof touchedAt === 'number' && now - touchedAt <= FILE_OWNERSHIP_MS) {
      const who = entry.name || entry.type || k;
      const agoS = Math.max(0, Math.round((now - touchedAt) / 1000));
      owners.push(`${who} (${agoS}s ago)`);
    }
  }
  if (owners.length === 0) return null;
  const base = path.basename(candidateFile);
  return `[weasley] CONFLICT: ${base} is being edited by another live agent: ${owners.join(', ')}. ` +
    `Coordinate before overwriting — another session may have unsaved work on this file.`;
}

/**
 * Upsert the caller's entry into the clock with the current activity + optional
 * file touch. Mutates and returns the clock. Caps the per-agent file list and
 * records each file's last-touch timestamp.
 * @param {{agents:object}} clock
 * @param {string} key
 * @param {{type:string,name:string}} caller
 * @param {string} sessionId
 * @param {string|null} touchedFile
 * @param {string|null} task
 * @param {number} now
 * @returns {{agents:object}}
 */
function upsertEntry(clock, key, caller, sessionId, touchedFile, task, now) {
  if (!clock.agents) clock.agents = {};
  const prev = clock.agents[key] || {};
  const files = prev.files && typeof prev.files === 'object' ? { ...prev.files } : {};
  if (touchedFile) {
    files[touchedFile] = now;
    // Trim to MAX_FILES most-recent by timestamp.
    const entries = Object.entries(files).sort((a, b) => b[1] - a[1]).slice(0, MAX_FILES);
    for (const k of Object.keys(files)) delete files[k];
    for (const [f, ts] of entries) files[f] = ts;
  }
  clock.agents[key] = {
    type: caller.type,
    name: caller.name,
    session: String(sessionId || '').slice(0, 12),
    pid: process.pid,
    lastActive: now,
    task: task || prev.task || null,
    files,
  };
  return clock;
}

module.exports = {
  STALE_MS,
  FILE_OWNERSHIP_MS,
  MAX_FILES,
  resolveAisleStateDir,
  clockPath,
  classifyCaller,
  clockKey,
  sanitizeKey,
  readClock,
  writeClock,
  pruneStale,
  extractEditTarget,
  detectConflict,
  upsertEntry,
};
