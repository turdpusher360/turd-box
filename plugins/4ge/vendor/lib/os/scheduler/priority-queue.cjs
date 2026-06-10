'use strict';
// @aspirational — instantiated every boot, zero producers/consumers ever (no scheduler-queue.jsonl); superseded by the harness Workflow/Agent tools. Disposition: LABEL (upstream, owner-chosen over REMOVE). Do not cite as an active subsystem.

const fs = require('node:fs');
const path = require('node:path');

// Priority tier order — higher index = lower priority
const TIERS = ['critical', 'high', 'normal', 'low'];

/**
 * Append a single event line to the JSONL log.
 * Failures are swallowed — persistence is best-effort.
 *
 * @param {string} filePath - Absolute path to scheduler-queue.jsonl
 * @param {object} entry - Event object to serialize
 */
function appendEvent(filePath, entry) {
  try {
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
  } catch (_err) {
    // Fire-and-forget — never throw from persistence layer
  }
}

/**
 * Create a priority queue with JSONL persistence and backpressure.
 *
 * @param {string} stateDir - Directory where scheduler-queue.jsonl is written
 * @param {{ maxConcurrent?: number }} options
 * @returns {{ enqueue, dequeue, release, active, stats, recover }}
 */
function createPriorityQueue(stateDir, options) {
  const { maxConcurrent = 4 } = options || {};

  fs.mkdirSync(stateDir, { recursive: true });

  const queuePath = path.join(stateDir, 'scheduler-queue.jsonl');

  // Internal state
  const queues = {
    critical: [],
    high: [],
    normal: [],
    low: [],
  };
  const activeSet = new Set();
  let activeCount = 0;

  /**
   * Add a task to the appropriate priority tier and log the enqueue event.
   *
   * @param {{ id: string, priority?: string, agentType?: string }} task
   */
  function enqueue(task) {
    const tier = TIERS.includes(task.priority) ? task.priority : 'normal';
    const entry = {
      id: task.id,
      priority: tier,
      agentType: task.agentType || null,
      event: 'enqueue',
      timestamp: new Date().toISOString(),
    };
    queues[tier].push(entry);
    appendEvent(queuePath, entry);
  }

  /**
   * Dispatch the highest-priority pending task.
   * Returns null when at capacity (backpressure) or when all queues are empty.
   *
   * @returns {object|null}
   */
  function dequeue() {
    if (activeCount >= maxConcurrent) {
      return null;
    }

    for (const tier of TIERS) {
      if (queues[tier].length > 0) {
        const task = queues[tier].shift();
        activeSet.add(task.id);
        activeCount++;
        return task;
      }
    }

    return null;
  }

  /**
   * Mark a previously dispatched task as complete, freeing one concurrency slot.
   *
   * @param {string} taskId
   */
  function release(taskId) {
    if (activeSet.has(taskId)) {
      activeSet.delete(taskId);
      activeCount--;
    }
    appendEvent(queuePath, {
      id: taskId,
      event: 'complete',
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Return the number of currently active (dispatched, not yet released) tasks.
   *
   * @returns {number}
   */
  function active() {
    return activeCount;
  }

  /**
   * Return queue depth per tier plus active and maxConcurrent counts.
   *
   * @returns {{ critical: number, high: number, normal: number, low: number, active: number, maxConcurrent: number }}
   */
  function stats() {
    return {
      critical: queues.critical.length,
      high: queues.high.length,
      normal: queues.normal.length,
      low: queues.low.length,
      active: activeCount,
      maxConcurrent,
    };
  }

  /**
   * Replay the JSONL event log to rebuild in-memory queue state.
   * Enqueue events that have no matching complete event are re-queued.
   * Active count and activeSet are reset (in-flight tasks at crash time
   * are treated as not yet dispatched so they can be retried).
   */
  function recover() {
    // Reset in-memory state before replay
    for (const tier of TIERS) {
      queues[tier] = [];
    }
    activeSet.clear();
    activeCount = 0;

    let raw;
    try {
      raw = fs.readFileSync(queuePath, 'utf8');
    } catch (_err) {
      // No log file yet — nothing to recover
      return;
    }

    const lines = raw.split('\n').filter(Boolean);

    // Build a map of id -> last-seen enqueue entry
    const pending = new Map(); // id -> entry

    for (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch (_err) {
        continue; // Skip malformed lines
      }

      if (entry.event === 'enqueue') {
        pending.set(entry.id, entry);
      } else if (entry.event === 'complete') {
        pending.delete(entry.id);
      }
    }

    // Re-queue surviving entries preserving original tier
    for (const entry of pending.values()) {
      const tier = TIERS.includes(entry.priority) ? entry.priority : 'normal';
      queues[tier].push(entry);
    }
  }

  return { enqueue, dequeue, release, active, stats, recover };
}

module.exports = { createPriorityQueue };
