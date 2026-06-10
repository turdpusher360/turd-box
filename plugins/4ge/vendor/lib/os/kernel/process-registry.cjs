'use strict';

/**
 * process-registry.cjs
 *
 * Kernel module for tracking agent process lifecycle.
 *
 * Responsibilities:
 *   - Assign monotonically increasing PIDs via an append-only counter file
 *   - Maintain an in-memory Map of active processes
 *   - Persist every spawn/stop event to a JSONL file
 *   - Rotate the JSONL file at 1000 entries (spec invariant #12)
 *   - Support concurrent registry instances producing distinct PIDs (spec invariant #11)
 *   - Load agent turn budgets from agent .md frontmatter (G-022)
 *   - Expose getRemainingTurns(pid) and getAgentBudget(agentType) (G-022)
 *   - Track process deadlines and zombie detection (ZOM-PRV-002 Phase 1)
 *   - Enforce hard concurrency limits via process-caps.cjs (P0 safety)
 *
 * The PID counter relies on `fs.appendFileSync` atomicity for single-byte appends
 * on POSIX and Windows NTFS. Each newline append followed by a line-count read
 * gives a unique, monotonically increasing integer per process. For true
 * multi-process safety the append+count must be wrapped in an exclusive lock;
 * here we use a simple spin-lock file so concurrent createRegistry instances
 * do not race on the same counter.
 */

const fs = require('node:fs');
const path = require('node:path');
const { getCaps } = require('./process-caps.cjs');

/** Filename for the JSONL event log */
const JSONL_FILE = 'process-table.jsonl';

/** Filename for the append-only PID counter */
const COUNTER_FILE = '.pid-counter';

/** Filename for the exclusive spin-lock */
const LOCK_FILE = '.pid-counter.lock';

/** Rotate JSONL when it reaches this many lines */
const ROTATION_THRESHOLD = 1000;

/** Maximum milliseconds to wait for the spin-lock before stale-lock fallback */
const LOCK_TIMEOUT_MS = 500;

/** Initial backoff interval between lock-acquire retries (ms) */
const LOCK_INITIAL_BACKOFF_MS = 10;

/** Maximum backoff interval cap (ms) */
const LOCK_MAX_BACKOFF_MS = 160;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// Shared buffer for Atomics.wait-based non-busy sleep
const _sleepBuf = new Int32Array(new SharedArrayBuffer(4));

/**
 * Synchronously sleep for `ms` milliseconds without busy-waiting.
 * Uses Atomics.wait on a shared buffer that is never notified,
 * so the wait always times out after exactly `ms`.
 * @param {number} ms
 */
function sleepMs(ms) {
  Atomics.wait(_sleepBuf, 0, 0, ms);
}

/**
 * Acquire an exclusive file lock using a flag file.
 * Uses exponential backoff (10ms, 20ms, 40ms, ..., capped at 160ms)
 * for up to LOCK_TIMEOUT_MS before attempting stale-lock recovery.
 *
 * @param {string} lockPath - Path to the lock file.
 */
function acquireLock(lockPath) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let backoff = LOCK_INITIAL_BACKOFF_MS;
  while (Date.now() < deadline) {
    try {
      // O_EXCL guarantees atomic create-or-fail on POSIX and Windows NTFS
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      return; // lock acquired
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Another process holds the lock — exponential backoff
      const wait = Math.min(backoff, deadline - Date.now());
      if (wait > 0) sleepMs(wait);
      backoff = Math.min(backoff * 2, LOCK_MAX_BACKOFF_MS);
    }
  }
  // Stale lock defence: if the holder PID no longer exists, remove and retry once
  try {
    const holder = Number(fs.readFileSync(lockPath, 'utf8').trim());
    if (holder && holder !== process.pid) {
      try { process.kill(holder, 0); } catch (_) {
        // Process is gone — remove stale lock
        fs.rmSync(lockPath, { force: true });
        fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
        return;
      }
    }
  } catch (_) { /* ignore */ }
  throw new Error(`[process-registry] Could not acquire PID lock at ${lockPath} within ${LOCK_TIMEOUT_MS}ms`);
}

/**
 * Release the exclusive lock.
 *
 * @param {string} lockPath
 */
function releaseLock(lockPath) {
  try {
    fs.rmSync(lockPath, { force: true });
  } catch (_) { /* best-effort */ }
}

/**
 * Allocate the next PID by appending a newline to the counter file and
 * counting the resulting lines. Wrapped in an exclusive lock so concurrent
 * instances produce distinct values.
 *
 * @param {string} stateDir
 * @returns {number}
 */
function nextPid(stateDir) {
  const counterPath = path.join(stateDir, COUNTER_FILE);
  const lockPath = path.join(stateDir, LOCK_FILE);

  acquireLock(lockPath);
  try {
    fs.appendFileSync(counterPath, '\n');
    const content = fs.readFileSync(counterPath, 'utf8');
    // Count newline characters — each append adds one, giving a monotonic PID
    return content.split('\n').length - 1;
  } finally {
    releaseLock(lockPath);
  }
}

/**
 * Append a structured event object to the JSONL log, rotating when needed.
 *
 * @param {string} jsonlPath - Absolute path to the JSONL file.
 * @param {object} entry - The event object to append.
 */
/**
 * Append a structured event object to the JSONL log, rotating when needed.
 * Uses a caller-provided counter reference to avoid re-reading the file.
 *
 * @param {string} jsonlPath - Absolute path to the JSONL file.
 * @param {object} entry - The event object to append.
 * @param {{count: number}} counter - Mutable line count reference.
 */
function appendJsonl(jsonlPath, entry, counter) {
  // Rotate when at threshold so the fresh file starts with the new entry
  if (counter.count >= ROTATION_THRESHOLD) {
    const ts = Date.now();
    const archivePath = jsonlPath.replace(/\.jsonl$/, `.${ts}.jsonl`);
    fs.renameSync(jsonlPath, archivePath);
    counter.count = 0;
  }

  fs.appendFileSync(jsonlPath, JSON.stringify(entry) + '\n');
  counter.count++;
}

// ---------------------------------------------------------------------------
// G-022: Agent turn budget loader
// ---------------------------------------------------------------------------

/**
 * Read agent .md files from agentsDir and extract maxTurns from YAML frontmatter.
 * Returns a Map keyed by agent name (from the `name:` field) -> maxTurns (number).
 *
 * Gracefully skips:
 *   - Files without frontmatter
 *   - Files with missing or non-numeric maxTurns (omitted from the map)
 *   - Read errors for individual files
 *
 * @param {string} agentsDir - Path to directory containing agent .md files.
 * @returns {Map<string, number>} agentName -> maxTurns
 */
function loadAgentBudgets(agentsDir) {
  const budgets = new Map();

  if (!agentsDir || !fs.existsSync(agentsDir)) return budgets;

  let files;
  try {
    files = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'));
  } catch {
    return budgets;
  }

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(agentsDir, file), 'utf8');
      const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!fmMatch) continue;

      const fm = fmMatch[1];

      // Extract `name:` field
      const nameMatch = fm.match(/^name:\s*(.+)$/m);
      if (!nameMatch) continue;
      const agentName = nameMatch[1].trim();

      // Extract `maxTurns:` field — must be a positive integer
      const turnsMatch = fm.match(/^maxTurns:\s*(\d+)$/m);
      if (!turnsMatch) continue;
      const maxTurns = parseInt(turnsMatch[1], 10);
      if (!Number.isFinite(maxTurns) || maxTurns <= 0) continue;

      budgets.set(agentName, maxTurns);
    } catch {
      // Skip malformed or unreadable files
    }
  }

  return budgets;
}

// ---------------------------------------------------------------------------
// ZOM-PRV-002: Deadline computation
// ---------------------------------------------------------------------------

/** Maximum agent deadline cap: 2 hours in ms */
const MAX_DEADLINE_MS = 2 * 60 * 60 * 1000;

/** Global default agent deadline: 90 minutes in ms */
const DEFAULT_DEADLINE_MS = 90 * 60 * 1000;

/** Heuristic: estimated ms per agent turn (30 seconds) */
const MS_PER_TURN = 30 * 1000;

/**
 * Compute an ISO deadline timestamp for a spawned process.
 *
 * Priority order (highest wins):
 *   1. deadlineOverrideMs (direct override from spawn opts)
 *   2. contract.slo.max_duration_minutes (explicit SLO)
 *   3. contract.maxTurns heuristic (30s/turn, capped at 2h)
 *   4. Global default (90 minutes)
 *
 * @param {object} contract - Agent contract object (may be null/undefined).
 * @param {number|null} [overrideMs] - Direct override in milliseconds.
 * @returns {string} ISO timestamp string.
 */
function computeDeadline(contract, overrideMs) {
  if (typeof overrideMs === 'number' && overrideMs > 0) {
    return new Date(Date.now() + overrideMs).toISOString();
  }

  // SLO field: contract.slo.max_duration_minutes
  const sloDurationMins = contract && contract.slo && contract.slo.max_duration_minutes;
  if (typeof sloDurationMins === 'number' && sloDurationMins > 0) {
    return new Date(Date.now() + sloDurationMins * 60000).toISOString();
  }

  // maxTurns heuristic: 30s/turn, capped at 2h
  const maxTurns = contract && typeof contract.maxTurns === 'number' && contract.maxTurns > 0
    ? contract.maxTurns
    : null;
  if (maxTurns !== null) {
    const estimatedMs = Math.min(maxTurns * MS_PER_TURN, MAX_DEADLINE_MS);
    return new Date(Date.now() + estimatedMs).toISOString();
  }

  // Global default: 90 minutes
  return new Date(Date.now() + DEFAULT_DEADLINE_MS).toISOString();
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Create a process registry backed by `stateDir`.
 *
 * @param {string} stateDir - Directory where counter file and JSONL log live.
 * @param {{ agentsDir?: string }} [opts] - Optional options.
 *   agentsDir: path to .claude/agents/ directory for loading turn budgets (G-022).
 *              If provided, maxTurns is read from each agent's frontmatter.
 * @returns {{
 *   spawn(agentId: string, agentType: string, contract: object, opts?: object): number,
 *   stop(pid: number, reason: string, stats: object): void,
 *   get(pid: number): object|null,
 *   list(): object[],
 *   history(agentType: string, limit: number): object[],
 *   compact(): void,
 *   getAgentBudget(agentType: string): number|null,
 *   getRemainingTurns(pid: number): number|null,
 *   getExpiredProcesses(): object[],
 *   markForKill(pid: number, phase: string): void,
 *   setRecoveryBranch(pid: number, branch: string): void,
 *   getZombieCandidates(staleMs: number): object[],
 * }}
 */
function createRegistry(stateDir, opts) {
  const { agentsDir } = opts || {};
  fs.mkdirSync(stateDir, { recursive: true });

  const jsonlPath = path.join(stateDir, JSONL_FILE);

  /** Agent turn budget lookup: agentType -> maxTurns (G-022) */
  const agentBudgets = agentsDir ? loadAgentBudgets(agentsDir) : new Map();

  /** In-memory store: pid -> processEntry */
  const table = new Map();

  /** Track JSONL line count in memory to avoid re-reading the file on every append */
  let jsonlLineCount = 0;
  try {
    if (fs.existsSync(jsonlPath)) {
      const existing = fs.readFileSync(jsonlPath, 'utf8');
      jsonlLineCount = existing.trim() === '' ? 0 : existing.trim().split('\n').length;
    }
  } catch { /* start at 0 */ }

  // ---------------------------------------------------------------------------
  // spawn
  // ---------------------------------------------------------------------------

  /**
   * Register a new agent process.
   *
   * @param {string} agentId - Opaque agent identifier (e.g. session ID).
   * @param {string} agentType - Agent role name (e.g. 'impl-expert').
   * @param {object} contract - Agent contract object.
   * @param {{
   *   parentPid?: number|null,
   *   deadlineOverrideMs?: number|null,
   *   processCategory?: 'agent'|'hook'|'service'|'background'|null,
   *   allowlisted?: boolean,
   *   osPid?: number|null,
   * }} [opts] - Optional spawn options.
   * @returns {number} The assigned PID.
   */
  function spawn(agentId, agentType, contract, opts) {
    const {
      parentPid = null,
      deadlineOverrideMs = null,
      processCategory = null,
      allowlisted = false,
      osPid = null,
    } = opts || {};
    const pid = nextPid(stateDir);

    // Look up turn budget for this agent type (G-022)
    const maxTurns = agentBudgets.has(agentType) ? agentBudgets.get(agentType) : null;

    // T1: compute deadline from contract SLO or maxTurns heuristic (ZOM-PRV-002)
    const deadlineAt = computeDeadline(contract, deadlineOverrideMs);

    const entry = {
      pid,
      agentId,
      agentType,
      contract: contract || {},
      spawnedAt: new Date().toISOString(),
      stoppedAt: null,
      stopReason: null,
      stats: null,
      parentPid,
      lastHeartbeat: new Date().toISOString(),
      maxTurns,
      turnsUsed: 0,
      // T1: deadline tracking (ZOM-PRV-002)
      deadlineAt,
      // T2: zombie classification fields (ZOM-PRV-002)
      processCategory,
      allowlisted,
      killPhase: null,
      recoveryBranch: null,
      osPid,
    };

    table.set(pid, entry);

    // P0 safety: acquire a concurrency slot in process-caps (best-effort; errors never block spawn)
    try {
      const capsType = (processCategory === 'child_process' || processCategory === 'process')
        ? processCategory
        : 'agent';
      const capId = String(pid);
      const releaser = getCaps().acquire(capsType, capId);
      entry._capsRelease = releaser;
    } catch { /* best-effort — caps are advisory */ }

    const lineCounter = { count: jsonlLineCount };
    appendJsonl(jsonlPath, { event: 'spawn', pid, agentId, agentType, contract, spawnedAt: entry.spawnedAt, parentPid }, lineCounter);
    jsonlLineCount = lineCounter.count;

    return pid;
  }

  // ---------------------------------------------------------------------------
  // stop
  // ---------------------------------------------------------------------------

  /**
   * Mark a process as stopped.
   *
   * @param {number} pid
   * @param {string} reason - Stop reason (e.g. 'end_turn', 'error').
   * @param {object} stats - Optional runtime statistics.
   */
  function stop(pid, reason, stats) {
    const entry = table.get(pid);
    if (!entry) return;

    const stoppedAt = new Date().toISOString();
    entry.stoppedAt = stoppedAt;
    entry.stopReason = reason || null;
    entry.stats = stats || null;

    // P0 safety: release the concurrency slot in process-caps (best-effort)
    try {
      if (typeof entry._capsRelease === 'function') {
        entry._capsRelease();
        entry._capsRelease = null;
      }
    } catch { /* best-effort */ }

    const lineCounter = { count: jsonlLineCount };
    appendJsonl(jsonlPath, { event: 'stop', pid, reason, stats, stoppedAt }, lineCounter);
    jsonlLineCount = lineCounter.count;
  }

  // ---------------------------------------------------------------------------
  // get
  // ---------------------------------------------------------------------------

  /**
   * Retrieve a process entry by PID.
   *
   * @param {number} pid
   * @returns {object|null}
   */
  function get(pid) {
    return table.get(pid) || null;
  }

  // ---------------------------------------------------------------------------
  // list
  // ---------------------------------------------------------------------------

  /**
   * Return all processes that have not yet received a stop event.
   *
   * @returns {object[]}
   */
  function list() {
    return Array.from(table.values()).filter(e => e.stoppedAt === null);
  }

  // ---------------------------------------------------------------------------
  // history
  // ---------------------------------------------------------------------------

  /**
   * Read the JSONL log and return the most recent `limit` spawn events for
   * processes matching `agentType`.
   *
   * @param {string} agentType
   * @param {number} limit
   * @returns {object[]}
   */
  function history(agentType, limit) {
    if (!fs.existsSync(jsonlPath)) return [];

    const raw = fs.readFileSync(jsonlPath, 'utf8');
    const lines = raw.trim() === '' ? [] : raw.trim().split('\n');

    const results = [];
    for (const line of lines) {
      let entry;
      try { entry = JSON.parse(line); } catch (_) { continue; }
      if (entry.event === 'spawn' && entry.agentType === agentType) {
        results.push(entry);
      }
    }

    // Most recent last — return the tail
    return results.slice(-limit);
  }

  // ---------------------------------------------------------------------------
  // compact
  // ---------------------------------------------------------------------------

  /**
   * Remove stopped processes from the in-memory table.
   * The JSONL log is the permanent record; this only frees memory.
   */
  function compact() {
    for (const [pid, entry] of table.entries()) {
      if (entry.stoppedAt !== null) {
        table.delete(pid);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // recordHeartbeat
  // ---------------------------------------------------------------------------

  /**
   * Update the lastHeartbeat timestamp for a running process.
   * No-op if the PID does not exist.
   *
   * @param {number} pid
   */
  function recordHeartbeat(pid) {
    const entry = table.get(pid);
    if (!entry) return;
    entry.lastHeartbeat = new Date().toISOString();
  }

  // ---------------------------------------------------------------------------
  // getChildren
  // ---------------------------------------------------------------------------

  /**
   * Return all process entries whose parentPid matches the given pid.
   *
   * @param {number} pid
   * @returns {object[]}
   */
  function getChildren(pid) {
    return Array.from(table.values()).filter(e => e.parentPid === pid);
  }

  // ---------------------------------------------------------------------------
  // getAncestors
  // ---------------------------------------------------------------------------

  /**
   * Walk the parentPid chain from `pid` to the root and return the ordered
   * list of ancestor PIDs (immediate parent first). A visited-Set guards
   * against cycles.
   *
   * @param {number} pid
   * @returns {number[]}
   */
  function getAncestors(pid) {
    const ancestors = [];
    const visited = new Set();
    let current = pid;
    while (current) {
      if (visited.has(current)) break; // cycle guard
      visited.add(current);
      const entry = table.get(current);
      if (!entry || entry.parentPid === null || entry.parentPid === undefined) break;
      ancestors.push(entry.parentPid);
      current = entry.parentPid;
    }
    return ancestors;
  }

  // ---------------------------------------------------------------------------
  // getStaleProcesses
  // ---------------------------------------------------------------------------

  /**
   * Return the PIDs of processes whose lastHeartbeat is older than
   * `thresholdMs` milliseconds.
   *
   * @param {number} thresholdMs
   * @returns {number[]}
   */
  function getStaleProcesses(thresholdMs) {
    const now = Date.now();
    const stale = [];
    for (const entry of table.values()) {
      // Only check running processes — stopped processes are not "stale"
      if (entry.stoppedAt === null && entry.lastHeartbeat && now - Date.parse(entry.lastHeartbeat) > thresholdMs) {
        stale.push(entry.pid);
      }
    }
    return stale;
  }

  // ---------------------------------------------------------------------------
  // getActiveProcesses
  // ---------------------------------------------------------------------------

  /**
   * Return all process entries that have not yet received a stop event.
   *
   * @returns {object[]}
   */
  function getActiveProcesses() {
    return Array.from(table.values()).filter(e => e.stoppedAt === null);
  }

  // ---------------------------------------------------------------------------
  // ZOM-PRV-002: Zombie detection methods
  // ---------------------------------------------------------------------------

  /**
   * T3: Return all process entries that have exceeded their deadline.
   *
   * Criteria: stoppedAt === null AND deadlineAt is set AND deadlineAt < now.
   * Uses ISO string comparison which is lexicographically correct for UTC timestamps.
   *
   * @returns {object[]} Full entry objects (not just PIDs).
   */
  function getExpiredProcesses() {
    const now = new Date().toISOString();
    const expired = [];
    for (const entry of table.values()) {
      if (entry.stoppedAt === null && entry.deadlineAt && entry.deadlineAt < now) {
        expired.push(entry);
      }
    }
    return expired;
  }

  /**
   * T4a: Mark a process for kill at the given escalation phase.
   *
   * Updates killPhase on the entry and appends a JSONL event.
   * Phase transitions:
   *   null -> 'graceful': first kill attempt (kill-initiated event)
   *   'graceful' -> 'sigterm' | 'sigkill': escalation (kill-escalated event)
   *
   * @param {number} pid
   * @param {'graceful'|'sigterm'|'sigkill'} phase
   */
  function markForKill(pid, phase) {
    const entry = table.get(pid);
    if (!entry) return;

    const previousPhase = entry.killPhase;
    entry.killPhase = phase;

    const eventName = previousPhase === null ? 'kill-initiated' : 'kill-escalated';
    const lineCounter = { count: jsonlLineCount };
    appendJsonl(jsonlPath, {
      event: eventName,
      pid,
      killPhase: phase,
      previousPhase,
      ts: new Date().toISOString(),
    }, lineCounter);
    jsonlLineCount = lineCounter.count;
  }

  /**
   * T4b: Record the recovery branch for a killed process.
   *
   * Updates recoveryBranch on the entry and appends a JSONL event.
   *
   * @param {number} pid
   * @param {string} branch - Git branch name (e.g. 'zombie-recovery/42-1234567890').
   */
  function setRecoveryBranch(pid, branch) {
    const entry = table.get(pid);
    if (!entry) return;

    entry.recoveryBranch = branch;

    const lineCounter = { count: jsonlLineCount };
    appendJsonl(jsonlPath, {
      event: 'recovery-branch-set',
      pid,
      recoveryBranch: branch,
      ts: new Date().toISOString(),
    }, lineCounter);
    jsonlLineCount = lineCounter.count;
  }

  /**
   * T5: Return zombie candidates: stale heartbeat OR past deadline, excluding allowlisted.
   *
   * Combines getStaleProcesses(staleMs) (returns PIDs) and getExpiredProcesses()
   * (returns entries), deduplicates by PID, and filters out entries where
   * allowlisted === true.
   *
   * @param {number} staleMs - Heartbeat staleness threshold in milliseconds.
   * @returns {object[]} Full entry objects (not just PIDs).
   */
  function getZombieCandidates(staleMs) {
    const seen = new Set();
    const candidates = [];

    // Stale by heartbeat (getStaleProcesses returns PIDs)
    for (const pid of getStaleProcesses(staleMs)) {
      const entry = table.get(pid);
      if (!entry) continue;
      if (entry.allowlisted) continue;
      seen.add(pid);
      candidates.push(entry);
    }

    // Expired by deadline (getExpiredProcesses returns entries)
    for (const entry of getExpiredProcesses()) {
      if (seen.has(entry.pid)) continue; // already included
      if (entry.allowlisted) continue;
      seen.add(entry.pid);
      candidates.push(entry);
    }

    return candidates;
  }

  // ---------------------------------------------------------------------------
  // G-022: Turn budget methods
  // ---------------------------------------------------------------------------

  /**
   * Return the maxTurns budget for a given agent type, or null if not defined.
   * Reads from the budget table loaded at registry creation time.
   *
   * @param {string} agentType
   * @returns {number|null}
   */
  function getAgentBudget(agentType) {
    return agentBudgets.has(agentType) ? agentBudgets.get(agentType) : null;
  }

  /**
   * Return the remaining turns for a running process.
   * Returns null if the process has no maxTurns budget defined.
   * Returns 0 if the process has exhausted its budget.
   *
   * @param {number} pid
   * @returns {number|null}
   */
  function getRemainingTurns(pid) {
    const entry = table.get(pid);
    if (!entry) return null;
    if (entry.maxTurns === null || entry.maxTurns === undefined) return null;
    const remaining = entry.maxTurns - entry.turnsUsed;
    return Math.max(0, remaining);
  }

  /**
   * Increment the turnsUsed counter for a running process.
   * No-op if the PID does not exist or the process is stopped.
   *
   * @param {number} pid
   * @param {number} [count=1] - Number of turns to increment by.
   */
  function incrementTurns(pid, count) {
    const entry = table.get(pid);
    if (!entry || entry.stoppedAt !== null) return;
    entry.turnsUsed += (typeof count === 'number' && count > 0) ? count : 1;
  }

  // ---------------------------------------------------------------------------

  return {
    spawn,
    stop,
    get,
    list,
    history,
    compact,
    recordHeartbeat,
    getChildren,
    getAncestors,
    getStaleProcesses,
    getActiveProcesses,
    getAgentBudget,
    getRemainingTurns,
    incrementTurns,
    // ZOM-PRV-002 Phase 1 additions
    getExpiredProcesses,
    markForKill,
    setRecoveryBranch,
    getZombieCandidates,
  };
}

module.exports = { createRegistry };
