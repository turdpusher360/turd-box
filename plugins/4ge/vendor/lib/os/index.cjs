'use strict';

/**
 * lib/os/index.cjs — Unified API for the Agentic OS.
 *
 * Exposes lazy-initialized singletons across three layers:
 *
 * kernel:
 *   - contracts: parse/validate/merge agent frontmatter
 *   - getRegistry(): PID tracking, spawn/stop lifecycle, JSONL persistence
 *   - getEnforcer(): per-agent tool+scope enforcement
 *
 * services:
 *   - getObservability(): unified JSONL event logging + query
 *   - getIPC(): typed file-based inter-agent messaging
 *
 * scheduler:
 *   - getPriorityQueue(): 4-tier scheduling with backpressure
 *   - getDAGExecutor(): topological DAG dispatch via priority queue
 */

const path = require('node:path');
const fs = require('node:fs');
const contracts = require('./kernel/contracts.cjs');
const { createRegistry } = require('./kernel/process-registry.cjs');
const { createEnforcer } = require('./kernel/capability-enforcer.cjs');
const { createObservability } = require('./services/observability.cjs');
const { createIPC } = require('./services/ipc.cjs');
const { createPriorityQueue } = require('./scheduler/priority-queue.cjs');
const { createDAGExecutor } = require('./scheduler/dag-executor.cjs');
const { createCapabilityRegistry } = require('./capability-registry.cjs');

const STATE_DIR = path.join(process.cwd(), '_runs', 'os');
function loadSessionId() {
  try {
    const metaPath = path.join(STATE_DIR, 'session-meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    if (typeof meta.session_id === 'string' && meta.session_id) return meta.session_id;
  } catch { /* session-meta.json not yet written — use fallback */ }
  return `session-${Date.now()}`;
}
const SESSION_ID = loadSessionId();

let _registry = null;
let _enforcer = null;
let _observability = null;
let _ipc = null;
let _priorityQueue = null;
let _dagExecutor = null;

// Capability registry singleton (review fix #5).
// The boot hook creates and boots the registry via setCapabilityRegistry().
// Subsequent callers access the live instance via getCapabilityRegistry().
// CLI plugin commands are Claude-mediated (read state files) and don't need this singleton.
let _capRegistry = null;

module.exports = {
  kernel: {
    contracts,
    getRegistry() {
      if (!_registry) _registry = createRegistry(STATE_DIR);
      return _registry;
    },
    getEnforcer() {
      if (!_enforcer) _enforcer = createEnforcer();
      return _enforcer;
    },
  },
  services: {
    getObservability() {
      if (!_observability) _observability = createObservability(STATE_DIR);
      return _observability;
    },
    getIPC() {
      if (!_ipc) _ipc = createIPC(STATE_DIR, SESSION_ID);
      return _ipc;
    },
  },
  scheduler: {
    getPriorityQueue() {
      if (!_priorityQueue) _priorityQueue = createPriorityQueue(STATE_DIR);
      return _priorityQueue;
    },
    getDAGExecutor() {
      if (!_dagExecutor) _dagExecutor = createDAGExecutor(module.exports.scheduler.getPriorityQueue());
      return _dagExecutor;
    },
  },

  // Capability registry factory — create a new registry instance.
  // Pass the os module itself as osApi for the full lazy-getter kernel.
  createCapabilityRegistry,

  // Singleton accessors for runtime registry (set by os-boot.cjs after boot).
  getCapabilityRegistry() {
    return _capRegistry;
  },
  setCapabilityRegistry(reg) {
    _capRegistry = reg;
  },
};
