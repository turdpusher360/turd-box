'use strict';
// @aspirational — instantiated every boot, zero producers/consumers ever (no scheduler-queue.jsonl); superseded by the harness Workflow/Agent tools. Disposition: LABEL (upstream, owner-chosen over REMOVE). Do not cite as an active subsystem.

/**
 * dag-executor.cjs
 *
 * DAG executor for ordered task dispatch — supports both synchronous and
 * async (non-blocking) execution modes.
 *
 * Takes a DAG (directed acyclic graph) of tasks with dependencies and
 * dispatches them through a priority queue in topological order. Tasks
 * with no unresolved dependencies are enqueued; as each task completes
 * (via queue.release), its dependents become eligible.
 *
 * Synchronous execution model: the executor drives a loop that dequeues
 * tasks, calls onDispatch, and processes completions. In real Forge
 * integration, onDispatch spawns an async agent — the executor provides
 * ordering, the caller handles async lifecycle.
 *
 * Async execution model: executeAsync() dispatches tasks without blocking.
 * If onDispatch returns a Promise, the executor races it against an optional
 * timeout and handles the result via onTimeout (skip/retry/fail).
 * Use awaitAll() to wait for all in-flight tasks to settle.
 *
 * T2.7 — Conditional edges (guard functions):
 *   A task may define `guards` entries:
 *     { id: 'b', deps: ['a'], guards: [{ from: 'a', fn: (result) => boolean }] }
 *   When task 'a' completes, the guard fn is called with its result.
 *   If the guard returns false, the dependent is marked unreachable and
 *   onUnreachable is called instead of dispatching the task.
 *   DAGs without guards behave identically to before (backward compat).
 *
 * @param {object} priorityQueue - A priority queue instance (from priority-queue.cjs)
 * @returns {{ execute, executeAsync, awaitAll }}
 */

/**
 * Create a DAG executor backed by the given priority queue.
 *
 * @param {object} priorityQueue - Must have enqueue, dequeue, release, active methods
 * @returns {{ execute, executeAsync, awaitAll }}
 */
function createDAGExecutor(priorityQueue) {

  // Shared set of pending promises — populated by executeAsync, read by awaitAll
  const _pendingPromises = [];

  /**
   * Build adjacency structures from a flat task list.
   * Also extracts the parallel guards map for conditional edge evaluation.
   *
   * guards entry format (on each task):
   *   guards: [{ from: '<sourceTaskId>', fn: (result) => boolean }]
   *
   * @param {Array<{ id: string, deps?: string[], guards?: object[] }>} tasks
   * @returns {{ taskMap: Map, depCount: Map, dependents: Map, guards: Map }}
   */
  function buildGraph(tasks) {
    const taskMap = new Map();
    const depCount = new Map();
    const dependents = new Map();
    // guards: Map<targetId, Map<sourceId, guardFn>>
    const guards = new Map();

    for (const task of tasks) {
      taskMap.set(task.id, task);
      depCount.set(task.id, (task.deps || []).length);
      if (!dependents.has(task.id)) dependents.set(task.id, new Set());

      for (const dep of (task.deps || [])) {
        if (!dependents.has(dep)) dependents.set(dep, new Set());
        dependents.get(dep).add(task.id);
      }

      // Register guard functions for this task's incoming edges
      if (task.guards) {
        for (const guardEntry of task.guards) {
          if (typeof guardEntry.fn !== 'function') {
            throw new TypeError(
              `[dag-executor] guard on task '${task.id}' from '${guardEntry.from}' must be a function`
            );
          }
          if (!guards.has(task.id)) guards.set(task.id, new Map());
          guards.get(task.id).set(guardEntry.from, guardEntry.fn);
        }
      }
    }

    return { taskMap, depCount, dependents, guards };
  }

  /**
   * Unlock tasks that depended on the completed task id and enqueue any
   * that are now fully unblocked, respecting guard functions.
   *
   * If a guard exists for an edge (completedId -> depId) and returns false,
   * the dependent is treated as unreachable: onUnreachable is called and
   * the task is skipped without being enqueued.
   *
   * @param {string} completedId
   * @param {any} result - The result produced by the completed task (passed to guards)
   * @param {Map} taskMap
   * @param {Map} depCount
   * @param {Map} dependents
   * @param {Map} guards - Map<targetId, Map<sourceId, guardFn>>
   * @param {Map} results - Map<taskId, result> for tracking task outputs
   * @param {Set} unreachable - Set of task IDs that have been skipped
   * @param {Function} [onUnreachable] - Called when a task is skipped by a guard
   */
  function unlockDependents(completedId, result, taskMap, depCount, dependents, guards, results, unreachable, onUnreachable) {
    // Track the result for guard evaluation
    if (results) results.set(completedId, result);

    for (const depId of (dependents.get(completedId) || [])) {
      // Skip tasks already marked unreachable
      if (unreachable && unreachable.has(depId)) continue;

      // Evaluate guard if present
      const edgeGuards = guards ? guards.get(depId) : null;
      if (edgeGuards && edgeGuards.has(completedId)) {
        const guardFn = edgeGuards.get(completedId);
        const passed = guardFn(result);
        if (!passed) {
          // Guard failed — mark as unreachable
          if (unreachable) unreachable.add(depId);
          if (onUnreachable) onUnreachable(taskMap.get(depId));
          continue;
        }
      }

      depCount.set(depId, depCount.get(depId) - 1);
      if (depCount.get(depId) === 0) {
        // Only enqueue if not already unreachable
        if (!unreachable || !unreachable.has(depId)) {
          priorityQueue.enqueue(taskMap.get(depId));
        }
      }
    }
  }

  /**
   * Execute a DAG by dispatching tasks through the priority queue.
   *
   * Supports optional guard functions on edges (T2.7 conditional edges).
   * DAGs without guards behave identically to before.
   *
   * Bug fix: priorityQueue.release() is now called in both the normal path
   * and the backpressure-retry path after completed.add().
   *
   * @param {{ tasks: Array<{ id: string, deps: string[], priority: string, guards?: object[] }> }} dag
   * @param {{
   *   onDispatch: (task: object) => void,
   *   onComplete?: (task: object, result?: any) => void,
   *   onBackpressure?: (task: object) => void,
   *   onUnreachable?: (task: object) => void,
   * }} callbacks
   */
  function execute(dag, callbacks) {
    const { onDispatch, onComplete, onBackpressure, onUnreachable } = callbacks;
    const tasks = dag.tasks || [];

    if (tasks.length === 0) return;

    const { taskMap, depCount, dependents, guards } = buildGraph(tasks);
    const completed = new Set();
    const unreachable = new Set();
    const results = new Map();

    // Enqueue tasks that are initially ready (no deps)
    for (const task of tasks) {
      if (depCount.get(task.id) === 0) {
        priorityQueue.enqueue(task);
      }
    }

    // Dispatch loop — continues until all tasks are completed or unreachable
    let maxIterations = tasks.length * 10; // safety valve
    while ((completed.size + unreachable.size) < tasks.length && maxIterations-- > 0) {
      const task = priorityQueue.dequeue();

      if (!task) {
        // Check if remaining tasks are all unreachable — if so, stop
        const remaining = tasks.filter(t => !completed.has(t.id) && !unreachable.has(t.id));
        if (remaining.length === 0) break;

        // Backpressure — all slots full, find a blocked task to report
        for (const t of remaining) {
          if (depCount.get(t.id) === 0) {
            if (onBackpressure) onBackpressure(t);
            break;
          }
        }

        // In sync mode, we need the caller to release slots.
        // Try dequeue again — if still null, we're stuck and should break.
        const retry = priorityQueue.dequeue();
        if (!retry) break;

        if (onDispatch) onDispatch(retry);
        completed.add(retry.id);
        priorityQueue.release(retry.id);

        if (onComplete) onComplete(retry);

        unlockDependents(retry.id, undefined, taskMap, depCount, dependents, guards, results, unreachable, onUnreachable);
        continue;
      }

      // Normal dispatch
      if (onDispatch) onDispatch(task);
      completed.add(task.id);
      priorityQueue.release(task.id); // Bug fix: was missing in original

      if (onComplete) onComplete(task);

      unlockDependents(task.id, undefined, taskMap, depCount, dependents, guards, results, unreachable, onUnreachable);
    }
  }

  /**
   * Execute a DAG asynchronously without blocking.
   *
   * Supports optional guard functions on edges (T2.7 conditional edges).
   * DAGs without guards behave identically to before.
   *
   * If onDispatch returns a Promise, tasks are tracked and settled via
   * onTimeout callbacks. Use awaitAll() to wait for all tasks to finish.
   *
   * @param {Array<{ id: string, deps?: string[], priority?: string, guards?: object[] }>} tasks
   * @param {(task: object) => any} onDispatch - May return a Promise or sync value
   * @param {(task: object, value: any) => void} [onComplete]
   * @param {{
   *   taskTimeout?: number,
   *   maxRetries?: number,
   *   onTimeout?: (task: object, err: Error) => 'skip' | 'retry' | 'fail',
   *   onUnreachable?: (task: object) => void,
   * }} [opts]
   */
  function executeAsync(tasks, onDispatch, onComplete, opts) {
    const { taskTimeout, maxRetries = 1, onTimeout, onUnreachable } = opts || {};
    const pending = new Map();     // id -> Promise
    const completed = new Set();
    const retries = new Map();     // id -> retry count
    const results = new Map();     // id -> result (for guard evaluation)
    const unreachable = new Set(); // ids skipped by guards

    if (!tasks || tasks.length === 0) return;

    const { taskMap, depCount, dependents, guards } = buildGraph(tasks);

    // Enqueue initially ready tasks
    for (const task of tasks) {
      if (depCount.get(task.id) === 0) {
        priorityQueue.enqueue(task);
      }
    }

    function unlockDep(completedId, result) {
      unlockDependents(completedId, result, taskMap, depCount, dependents, guards, results, unreachable, onUnreachable);
      // Drain the queue — dispatch any newly unblocked tasks
      drainQueue();
    }

    function drainQueue() {
      let task;
      while ((task = priorityQueue.dequeue()) !== null && task !== undefined) {
        // Skip unreachable tasks that may have been enqueued before guard evaluation
        if (unreachable.has(task.id)) {
          priorityQueue.release(task.id);
          continue;
        }
        dispatch(task);
      }
    }

    function dispatch(task) {
      let result;
      try {
        result = onDispatch(task);
      } catch (err) {
        // Synchronous throw — treat same as async rejection
        handleError(task, err);
        return;
      }

      if (result && typeof result.then === 'function') {
        // Async path
        let racePromise = result;
        let timeoutTimer;

        if (taskTimeout) {
          const timeoutP = new Promise((_, reject) => {
            timeoutTimer = setTimeout(
              () => reject(new Error(`Task ${task.id} timed out after ${taskTimeout}ms`)),
              taskTimeout
            );
          });
          racePromise = Promise.race([result, timeoutP]);
        }

        const settled = racePromise.then(
          (value) => {
            if (timeoutTimer) clearTimeout(timeoutTimer); // Clear timer on success
            completed.add(task.id);
            priorityQueue.release(task.id);
            if (onComplete) onComplete(task, value);
            unlockDep(task.id, value);
          },
          (err) => {
            if (timeoutTimer) clearTimeout(timeoutTimer); // Clear timer on error
            handleError(task, err);
          }
        );

        pending.set(task.id, settled);
        _pendingPromises.push(settled);
      } else {
        // Sync path — result is a plain value
        completed.add(task.id);
        priorityQueue.release(task.id);
        if (onComplete) onComplete(task, result);
        unlockDep(task.id, result);
      }
    }

    function handleError(task, err) {
      const action = onTimeout ? onTimeout(task, err) : 'fail';

      if (action === 'skip') {
        completed.add(task.id);
        priorityQueue.release(task.id);
        unlockDep(task.id, undefined);
      } else if (action === 'retry') {
        const count = (retries.get(task.id) || 0) + 1;
        retries.set(task.id, count);
        if (count <= maxRetries) {
          // Free the slot before re-enqueueing so the task can be dequeued again
          priorityQueue.release(task.id);
          priorityQueue.enqueue(task);
          const requeued = priorityQueue.dequeue();
          if (requeued) dispatch(requeued);
        } else {
          // Exhausted retries — fail without unlocking dependents
          completed.add(task.id);
          priorityQueue.release(task.id);
        }
      } else {
        // 'fail' — complete without unlocking dependents (downstream blocked)
        completed.add(task.id);
        priorityQueue.release(task.id);
      }
    }

    // Kick off the initial batch
    drainQueue();
  }

  /**
   * Wait for all async tasks dispatched via executeAsync() to settle.
   *
   * Resolves once all tracked Promises have either resolved or rejected.
   * Safe to call even if no async tasks were dispatched (resolves immediately).
   *
   * @returns {Promise<void>}
   */
  async function awaitAll() {
    let lastLength = 0;
    while (_pendingPromises.length > lastLength) {
      lastLength = _pendingPromises.length;
      await Promise.all(_pendingPromises.map((p) => p.catch(() => {})));
    }
    _pendingPromises.length = 0; // Clear settled promises to prevent memory leak
  }

  return { execute, executeAsync, awaitAll };
}

module.exports = { createDAGExecutor };
