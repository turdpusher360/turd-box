'use strict';

/**
 * process-caps.cjs
 *
 * P0 safety infrastructure: hard limits on concurrent agent spawns,
 * child processes, and backpressure queue depth.
 *
 * Configuration is merged from DEFAULTS with optional overrides supplied
 * at `configure()` time or loaded from .4ge/config.json `processCaps` block.
 *
 * Tracking is purely in-memory. Across process restarts the counters reset
 * to zero — this is intentional. The registry's JSONL log is the durable
 * record; caps protect the live session only.
 *
 * API
 * ---
 *   canSpawn(type)         — check whether a new spawn is allowed
 *   acquire(type, id)      — register a new process / agent, returns release()
 *   release(id)            — mark process as complete (idempotent)
 *   getStats()             — live counters
 *   configure(overrides)   — merge runtime overrides into active config
 */

const path = require('node:path');
const fs = require('node:fs');

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS = {
  maxConcurrentAgents: 8,
  maxChildProcesses: 16,
  maxQueueDepth: 32,
  queueTimeoutMs: 300_000, // 5 minutes
};

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

/**
 * Attempt to load processCaps overrides from .4ge/config.json.
 * Returns an empty object on any error (config file is optional).
 *
 * @param {string} [configPath] - Absolute path to .4ge/config.json.
 *   Defaults to <cwd>/.4ge/config.json.
 * @returns {Partial<typeof DEFAULTS>}
 */
function loadConfigOverrides(configPath) {
  const target = configPath || path.join(process.cwd(), '.4ge', 'config.json');
  try {
    const raw = fs.readFileSync(target, 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed.processCaps === 'object' && parsed.processCaps !== null)
      ? parsed.processCaps
      : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a process-caps instance.
 *
 * @param {{ configPath?: string }} [opts]
 *   configPath: override path to .4ge/config.json (used in tests).
 * @returns {{
 *   canSpawn(type: string): { allowed: boolean, reason?: string, queuePosition?: number },
 *   acquire(type: string, id: string): () => void,
 *   release(id: string): void,
 *   getStats(): { agents: { active: number, queued: number, total: number }, processes: { active: number, total: number } },
 *   configure(overrides: object): void,
 * }}
 */
function createCaps(opts) {
  const { configPath } = opts || {};

  // Merge defaults <- file config <- runtime overrides applied via configure()
  const config = Object.assign({}, DEFAULTS, loadConfigOverrides(configPath));

  // ---------------------------------------------------------------------------
  // Internal counters
  // ---------------------------------------------------------------------------

  /** Tracks live agent slots: id -> { type, acquiredAt } */
  const agents = new Map();

  /** Tracks live child-process slots: id -> { type, acquiredAt } */
  const childProcesses = new Map();

  /** Queue of pending items waiting for a slot: { id, type, queuedAt } */
  const queue = [];

  /** Lifetime totals for stats */
  let totalAgentsEver = 0;
  let totalProcessesEver = 0;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * True if `type` represents an agent spawn (vs. a child process).
   * Anything that is not explicitly 'child_process' or 'process' is treated
   * as an agent — this matches the two spawn categories in the task spec.
   *
   * @param {string} type
   * @returns {boolean}
   */
  function isAgent(type) {
    return type !== 'child_process' && type !== 'process';
  }

  // ---------------------------------------------------------------------------
  // canSpawn
  // ---------------------------------------------------------------------------

  /**
   * Check whether a new spawn of `type` is currently allowed.
   *
   * Returns:
   *   { allowed: true }                              — slot is free
   *   { allowed: false, reason, queuePosition }      — at limit; position in queue
   *
   * @param {string} type
   * @returns {{ allowed: boolean, reason?: string, queuePosition?: number }}
   */
  function canSpawn(type) {
    if (!type || typeof type !== 'string') {
      return { allowed: false, reason: 'type must be a non-empty string' };
    }

    if (isAgent(type)) {
      if (agents.size < config.maxConcurrentAgents) {
        return { allowed: true };
      }
      if (queue.length >= config.maxQueueDepth) {
        return {
          allowed: false,
          reason: `agent limit reached (${config.maxConcurrentAgents}) and queue full (${config.maxQueueDepth})`,
          queuePosition: -1,
        };
      }
      return {
        allowed: false,
        reason: `agent limit reached (${config.maxConcurrentAgents}); queued at position ${queue.length + 1}`,
        queuePosition: queue.length + 1,
      };
    }

    // child_process / process type
    if (childProcesses.size < config.maxChildProcesses) {
      return { allowed: true };
    }
    if (queue.length >= config.maxQueueDepth) {
      return {
        allowed: false,
        reason: `child process limit reached (${config.maxChildProcesses}) and queue full (${config.maxQueueDepth})`,
        queuePosition: -1,
      };
    }
    return {
      allowed: false,
      reason: `child process limit reached (${config.maxChildProcesses}); queued at position ${queue.length + 1}`,
      queuePosition: queue.length + 1,
    };
  }

  // ---------------------------------------------------------------------------
  // acquire
  // ---------------------------------------------------------------------------

  /**
   * Register a new process/agent slot. Returns a `release` function that
   * marks the slot as complete when called (idempotent).
   *
   * If no slot is available, the request is pushed onto the backpressure queue.
   * The queue entry expires after `queueTimeoutMs` but does not automatically
   * promote — callers must re-call `acquire` after a slot frees. The queue
   * exists as a depth gauge, not an async dispatcher.
   *
   * @param {string} type
   * @param {string} id  — unique opaque identifier (agent ID, pid, etc.)
   * @returns {() => void} release function
   */
  function acquire(type, id) {
    if (!id || typeof id !== 'string') {
      throw new Error('process-caps: acquire() requires a non-empty string id');
    }

    const now = Date.now();
    const entry = { type, acquiredAt: now };
    let released = false;

    if (isAgent(type)) {
      if (agents.size < config.maxConcurrentAgents) {
        agents.set(id, entry);
        totalAgentsEver++;

        return function release() {
          if (released) return;
          released = true;
          agents.delete(id);
          // Evict stale queue entries while we have a free slot
          _pruneQueue();
        };
      }

      // No slot — add to queue if not full
      if (queue.length < config.maxQueueDepth) {
        queue.push({ id, type, queuedAt: now });
      }
      // Return a no-op release (slot was never acquired)
      return function release() {};
    }

    // child_process / process
    if (childProcesses.size < config.maxChildProcesses) {
      childProcesses.set(id, entry);
      totalProcessesEver++;

      return function release() {
        if (released) return;
        released = true;
        childProcesses.delete(id);
        _pruneQueue();
      };
    }

    if (queue.length < config.maxQueueDepth) {
      queue.push({ id, type, queuedAt: now });
    }
    return function release() {};
  }

  // ---------------------------------------------------------------------------
  // release (direct, by id)
  // ---------------------------------------------------------------------------

  /**
   * Release a registered slot by id. Idempotent — no-op if id not found.
   *
   * @param {string} id
   */
  function release(id) {
    if (agents.delete(id) || childProcesses.delete(id)) {
      _pruneQueue();
    }
    // Remove from queue if it was queued (never acquired)
    const idx = queue.findIndex(e => e.id === id);
    if (idx !== -1) queue.splice(idx, 1);
  }

  // ---------------------------------------------------------------------------
  // _pruneQueue
  // ---------------------------------------------------------------------------

  /**
   * Remove expired queue entries (exceeded queueTimeoutMs).
   * Called whenever a slot is released.
   */
  function _pruneQueue() {
    const cutoff = Date.now() - config.queueTimeoutMs;
    let i = 0;
    while (i < queue.length) {
      if (queue[i].queuedAt < cutoff) {
        queue.splice(i, 1);
      } else {
        i++;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // getStats
  // ---------------------------------------------------------------------------

  /**
   * Return live counters and lifetime totals.
   *
   * @returns {{
   *   agents: { active: number, queued: number, total: number },
   *   processes: { active: number, total: number },
   *   queue: { depth: number, maxDepth: number },
   *   limits: { maxConcurrentAgents: number, maxChildProcesses: number, maxQueueDepth: number },
   * }}
   */
  function getStats() {
    // Queued entries that are agent-type
    const queuedAgents = queue.filter(e => isAgent(e.type)).length;

    return {
      agents: {
        active: agents.size,
        queued: queuedAgents,
        total: totalAgentsEver,
      },
      processes: {
        active: childProcesses.size,
        total: totalProcessesEver,
      },
      queue: {
        depth: queue.length,
        maxDepth: config.maxQueueDepth,
      },
      limits: {
        maxConcurrentAgents: config.maxConcurrentAgents,
        maxChildProcesses: config.maxChildProcesses,
        maxQueueDepth: config.maxQueueDepth,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // configure
  // ---------------------------------------------------------------------------

  /**
   * Merge runtime overrides into the active config. Values not supplied in
   * `overrides` remain unchanged. Only known keys are applied.
   *
   * @param {Partial<typeof DEFAULTS>} overrides
   */
  function configure(overrides) {
    if (!overrides || typeof overrides !== 'object') return;

    const allowed = ['maxConcurrentAgents', 'maxChildProcesses', 'maxQueueDepth', 'queueTimeoutMs'];
    for (const key of allowed) {
      if (typeof overrides[key] === 'number' && overrides[key] > 0) {
        config[key] = overrides[key];
      }
    }
  }

  // ---------------------------------------------------------------------------

  return { canSpawn, acquire, release, getStats, configure };
}

// ---------------------------------------------------------------------------
// Module singleton (lazy-initialized on first require)
// ---------------------------------------------------------------------------

let _singleton = null;

/**
 * Return the module-level singleton caps instance.
 * Callers that need an isolated instance (e.g. tests) should call createCaps().
 *
 * @returns {ReturnType<typeof createCaps>}
 */
function getCaps() {
  if (!_singleton) _singleton = createCaps();
  return _singleton;
}

module.exports = { createCaps, getCaps, DEFAULTS };
