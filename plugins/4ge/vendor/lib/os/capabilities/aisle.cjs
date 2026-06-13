'use strict';

/**
 * aisle.cjs — AISLE OS Capability Registration
 *
 * Registers AISLE as an OS capability so it can be discovered by the
 * capability registry and invoked via os.invoke('aisle', '<action>', args).
 *
 * Design notes:
 *   - init() is synchronous — boot() is synchronous, no await needed (P0-B fix)
 *   - stateDir is resolved from config.resolveStateDir(), NOT os.capDir (P0-D fix)
 *   - manifest.actions = metadata only (for registry discovery)
 *   - module-level actions = invocable functions
 *   - depends_on: [] — memory is optional enrichment, not a hard dependency
 *   - health() in manifest returns cached health from last boot
 */

const config = require('../../aisle/core/config.cjs');
const { boot } = require('../../aisle/core/boot.cjs');
const healthMonitor = require('../../aisle/core/health-monitor.cjs');
const scannerRegistry = require('../../aisle/core/scanner-registry.cjs');

// ---------------------------------------------------------------------------
// Report formatting helper
// ---------------------------------------------------------------------------

/**
 * Format a findings report from parsed JSONL events or in-memory stats.
 *
 * @param {Array<object>} events - Parsed JSONL event records
 * @param {object|null} stats    - In-memory stats fallback ({sessionBlocks, sessionWarns, sessionLogs, eventCount})
 * @returns {string} Formatted report string (under 500 tokens)
 */
function formatReport(events, stats) {
  // If we have events from JSONL, compute counts from them
  if (events.length > 0) {
    let blocks = 0;
    let warns = 0;
    let logs = 0;

    // Per-scanner breakdown: { [scannerId]: { BLOCK: n, WARN: n, LOG: n } }
    const byScannerAndTier = {};

    for (const event of events) {
      const tier = (event.type || '').toUpperCase();
      const scannerId = event.scanner || 'unknown';

      if (tier === 'BLOCK') blocks++;
      else if (tier === 'WARN') warns++;
      else if (tier === 'LOG') logs++;
      // QUARANTINE and SYSTEM events are not counted in summary tiers

      if (tier === 'BLOCK' || tier === 'WARN' || tier === 'LOG') {
        if (!byScannerAndTier[scannerId]) {
          byScannerAndTier[scannerId] = { BLOCK: 0, WARN: 0, LOG: 0 };
        }
        byScannerAndTier[scannerId][tier]++;
      }
    }

    const total = blocks + warns + logs;
    const lines = [`AISLE Session Report — ${total} finding(s)`];
    lines.push(`Total: ${blocks} BLOCK, ${warns} WARN, ${logs} LOG`);

    const scannerIds = Object.keys(byScannerAndTier).sort();
    if (scannerIds.length > 0) {
      lines.push('');
      lines.push('Per-scanner breakdown:');
      for (const id of scannerIds) {
        const t = byScannerAndTier[id];
        const parts = [];
        if (t.BLOCK > 0) parts.push(`${t.BLOCK} BLOCK`);
        if (t.WARN > 0) parts.push(`${t.WARN} WARN`);
        if (t.LOG > 0) parts.push(`${t.LOG} LOG`);
        lines.push(`  Scanner ${id}: ${parts.join(', ') || '0'}`);
      }
    }

    return lines.join('\n');
  }

  // Fallback: use in-memory stats
  if (stats) {
    const total = stats.sessionBlocks + stats.sessionWarns + stats.sessionLogs;
    return [
      `AISLE Session Report — ${total} finding(s)`,
      `Total: ${stats.sessionBlocks} BLOCK, ${stats.sessionWarns} WARN, ${stats.sessionLogs} LOG`,
      '(in-memory stats — no JSONL events available)',
    ].join('\n');
  }

  return 'AISLE Session Report — 0 finding(s)\nTotal: 0 BLOCK, 0 WARN, 0 LOG\n(no events recorded this session)';
}

module.exports = {
  manifest: {
    name: 'aisle',
    version: '1.0.0',
    description: 'AI Security Learning Environment — advisory threat detection and security posture (fail-closed enforcement gate shelved per ADR-SEC-001)',
    depends_on: [],
    actions: {
      scan:       { description: 'Full security scan (all or specific class)', args: ['target'] },
      report:     { description: 'Session findings report', args: [] },
      health:     { description: 'Component health + staleness + canary status', args: [] },
      quarantine: { description: 'List or release quarantined items', args: ['subcommand', 'id'] },
      evaluate:   { description: 'Fast-path tool call evaluation (internal)', args: ['toolInput'] },
      learn:      { description: 'Process operator feedback (FP/TP) on a finding', args: ['findingId', 'feedback', 'agentId'] },
    },
    health() {
      return module.exports._healthCache || { ok: false, reason: 'not initialized' };
    },
    resources: { typical_duration: '5s' },
  },

  _os: null,
  _stateDir: null,
  _healthCache: { ok: false, reason: 'not initialized' },

  probeCost: 'cheap',
  probe() {
    try {
      const path = require('node:path');
      const fs = require('node:fs');
      const os = require('node:os');
      const projectId = config.deriveProjectId();
      const aisleDir = path.join(os.homedir(), '.claude', 'projects', projectId, 'aisle');
      const exists = fs.existsSync(aisleDir);
      if (!exists) {
        const result = { ok: false, reason: 'aisle state dir missing' };
        this._healthCache = result;
        return result;
      }

      // upstream: cross-check against hook-server liveness so stale boot-state
      // (e.g. boot-time 'fail-closed' snapshot) corrects itself once the
      // persistent server comes up. If server is live we report operational
      // even if the init()-time boot state was degraded.
      const portFile = path.join(process.cwd(), '_runs', 'os', 'aisle-server.port');
      const pidFile = path.join(process.cwd(), '_runs', 'os', 'aisle-server.pid');
      let serverLive = false;
      try {
        if (fs.existsSync(portFile) && fs.existsSync(pidFile)) {
          const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
          if (Number.isFinite(pid) && pid > 0) {
            // signal 0 = existence check; throws if pid is gone
            process.kill(pid, 0);
            serverLive = true;
          }
        }
      } catch {
        serverLive = false;
      }

      let result;
      if (serverLive) {
        result = { ok: true, state: 'operational', server: 'live' };
      } else if (this._healthCache && this._healthCache.state === 'operational') {
        // Boot said operational but server is not running — stale cache
        result = { ok: false, reason: 'server not running', state: 'server-down' };
      } else {
        // Honor whatever init() cached (may be 'fail-closed', 'degraded', etc.)
        result = exists
          ? { ok: true, state: 'operational' }
          : { ok: false, reason: 'aisle state dir missing' };
      }

      this._healthCache = result;

      // Rewrite the aisle entry in boot-status.json so downstream consumers
      // (HUD, OsWatcher, boot-status readers) see fresh state. The original
      // boot-status.json is written once at boot moment and never refreshed —
      // upstream audit P1 fix.
      try {
        const bootStatusPath = path.join(process.cwd(), '_runs', 'os', 'boot-status.json');
        if (fs.existsSync(bootStatusPath)) {
          const bootStatus = JSON.parse(fs.readFileSync(bootStatusPath, 'utf8'));
          if (bootStatus && bootStatus.capabilities && bootStatus.capabilities.aisle) {
            const aisleEntry = bootStatus.capabilities.aisle;
            const newStatus = result.ok ? 'ready' : 'degraded';
            const newReason = result.ok ? undefined : result.reason;
            // Propagate shelved flag from _healthCache (init-time) so HUD
            // can recognize fail-closed as intentional posture.
            const cachedShelved = this._healthCache && this._healthCache.shelved === true;
            const newShelved = cachedShelved && !result.ok;
            if (aisleEntry.status !== newStatus || aisleEntry.reason !== newReason || aisleEntry.shelved !== newShelved) {
              aisleEntry.status = newStatus;
              if (newReason) {
                aisleEntry.reason = newReason;
              } else {
                delete aisleEntry.reason;
              }
              if (newShelved) {
                aisleEntry.shelved = true;
              } else {
                delete aisleEntry.shelved;
              }
              aisleEntry.refreshed_at = new Date().toISOString();
              // Atomic write (match capability-registry._writeJson pattern)
              const tmp = `${bootStatusPath}.${process.pid}.tmp`;
              fs.writeFileSync(tmp, JSON.stringify(bootStatus, null, 2), 'utf8');
              fs.renameSync(tmp, bootStatusPath);
            }
          }
        }
      } catch {
        // Non-fatal — probe must never throw; boot-status rewrite is best-effort
      }

      return result;
    } catch (e) {
      const result = { ok: false, reason: `probe threw: ${e.message}` };
      this._healthCache = result;
      return result;
    }
  },

  /**
   * Initialize the AISLE capability.
   * Resolves stateDir from config (P0-D: out-of-repo, protected by deny rules).
   * Delegates boot() synchronously (P0-B: no await).
   *
   * @param {object} os - OS context
   * @param {object} [args] - Optional args (sessionId)
   * @returns {{ health: object, state: string, bootTimeMs: number }}
   */
  init(os, args) {
    const obs = os.observability;
    const t0 = Date.now();
    obs.log('capability', 'init-start', { capability: 'aisle', severity: 'info' });

    try {
      this._os = os;

      // Resolve stateDir from config (P0-D: out-of-repo, protected by deny rules)
      const projectId = config.deriveProjectId();
      const configResult = config.loadConfig(projectId);
      this._stateDir = config.resolveStateDir(configResult ? configResult.config : null);

      // Expose stateDir to scanners via env — Scanner D health() reads this to
      // locate baselines. Without it, health() returns 'degraded', posture goes
      // 'critical', and boot flips to fail-closed even when all 8 steps pass.
      process.env.AISLE_STATE_DIR = this._stateDir;

      // Load scanners into registry before boot — boot steps 4-8 query registered
      // scanners by ID (B, C, E) and run canaries. Without pre-registration, all
      // scanner steps are skipped and boot degrades to passthrough.
      const fs = require('fs');
      const path = require('path');
      const scannerDir = path.join(__dirname, '..', '..', 'aisle', 'scanners');
      try {
        const scannerFiles = fs.readdirSync(scannerDir)
          .filter(f => f.endsWith('.cjs') && f !== 'event-bus.cjs');
        for (const file of scannerFiles) {
          scannerRegistry.load(path.join(scannerDir, file));
        }
      } catch (_err) {
        // Non-fatal: boot will degrade gracefully with 0 scanners
      }

      // Boot is synchronous — no await needed (P0-B fix).
      // Hard wall-clock guard: if boot somehow exceeds 6s, log a warning.
      // boot.cjs has its own 30s BOOT_TIMEOUT_MS budget but that is too wide
      // for the SessionStart hook's enforceTimeout(9000) context.
      const sessionId = (args && args.sessionId) || null;
      const bootStart = Date.now();
      const result = boot(os, this._stateDir, sessionId);
      const bootElapsed = Date.now() - bootStart;
      if (bootElapsed > 6000) {
        obs.log('capability', 'init-warn', {
          capability: 'aisle',
          severity: 'warn',
          message: `AISLE boot exceeded 6s budget (${bootElapsed}ms) — SessionStart hook may be slow`,
          durationMs: bootElapsed,
        });
      }
      // Translate AISLE boot state to capability-registry health contract
      // Registry checks health.ok (boolean); boot returns health.state (string)
      // Flattened to match peer convention (no spread, no nested boot diagnostics)
      const state = (result.health && result.health.state) || 'unknown';
      // fail-closed is the documented shelved posture per ADR-SEC-001.
      // Mark with shelved:true so HUD countDegraded() can suppress noise —
      // it's the intentional posture, not a regression to escalate on.
      this._healthCache = state === 'operational'
        ? { ok: true, state, bootTimeMs: result.bootTimeMs }
        : {
            ok: false,
            reason: `boot state: ${state}`,
            state,
            shelved: state === 'fail-closed',
            bootTimeMs: result.bootTimeMs,
          };

      obs.log('capability', 'init-complete', {
        capability: 'aisle',
        severity: 'info',
        durationMs: Date.now() - t0,
        state,
      });

      return result;
    } catch (e) {
      obs.log('capability', 'init-error', {
        capability: 'aisle',
        severity: 'error',
        message: e.message,
        durationMs: Date.now() - t0,
      });
      throw e;
    }
  },

  /**
   * Persist final posture report to stateDir on shutdown.
   */
  shutdown() {
    if (this._stateDir && this._healthCache) {
      try {
        const fs = require('fs');
        const path = require('path');
        fs.writeFileSync(
          path.join(this._stateDir, 'last-posture.json'),
          JSON.stringify({ ...this._healthCache, shutdownAt: Date.now() }, null, 2)
        );
      } catch (_err) {
        // non-fatal
      }
    }
  },

  actions: {
    /**
     * Run a security scan against all or a specific scanner class.
     *
     * @param {{ target?: string }} args
     * @returns {object} keyed by scanner ID
     */
    scan(args, _os) {
      const target = (args && args.target) || 'all';
      const scanners = target === 'all'
        ? scannerRegistry.getAll()
        : [scannerRegistry.get(target)].filter(Boolean);
      const results = {};
      for (const scanner of scanners) {
        try {
          results[scanner.id] = scanner.scan({ cadence: 'on-demand', target });
        } catch (err) {
          results[scanner.id] = { error: err.message };
        }
      }
      return results;
    },

    /**
     * Return current health posture from health-monitor.
     *
     * @returns {PostureReport}
     */
    health(_args, _os) {
      const configMod = require('../../aisle/core/config.cjs');
      const projectId = configMod.deriveProjectId();
      const configResult = configMod.loadConfig(projectId);
      return healthMonitor.getPosture(scannerRegistry, configResult ? configResult.config : null);
    },

    /**
     * Return a formatted session findings report.
     *
     * Reads JSONL events from the stateDir events directory.
     * If sessionId is provided, reads only that session's file(s).
     * Otherwise reads all .jsonl files in the events directory.
     *
     * Report format:
     *   Total: X BLOCK, Y WARN, Z LOG
     *   Per-scanner breakdown (scanner -> tier -> count)
     *
     * Returns a formatted string under 500 tokens (~2000 chars).
     * Handles missing events directory gracefully (returns empty report).
     *
     * @param {{ sessionId?: string }} args
     * @returns {string}
     */
    report(args, _os) {
      const fs = require('fs');
      const path = require('path');

      const stateDir = module.exports._stateDir;
      const sessionId = (args && args.sessionId) || null;

      // Fallback: if stateDir not initialized, return stats from in-memory event bus
      if (!stateDir) {
        const eventBus = require('../../aisle/scanners/event-bus.cjs');
        const stats = eventBus.getStats();
        return formatReport([], stats);
      }

      const eventsDir = path.join(stateDir, 'events');

      // Collect .jsonl files to read
      let jsonlFiles = [];
      try {
        const allFiles = fs.readdirSync(eventsDir);
        if (sessionId) {
          jsonlFiles = allFiles
            .filter(f => f.endsWith('.jsonl') && f.includes(sessionId))
            .map(f => path.join(eventsDir, f));
        } else {
          jsonlFiles = allFiles
            .filter(f => f.endsWith('.jsonl'))
            .map(f => path.join(eventsDir, f));
        }
      } catch (_err) {
        // Events directory missing or unreadable — return empty report
        return formatReport([], null);
      }

      // Parse all events from collected files
      const events = [];
      for (const filePath of jsonlFiles) {
        let raw;
        try {
          raw = fs.readFileSync(filePath, 'utf8');
        } catch (_err) {
          continue;
        }
        const lines = raw.split('\n').filter(l => l.trim().length > 0);
        for (const line of lines) {
          try {
            events.push(JSON.parse(line));
          } catch (_err) {
            // Skip corrupt lines
          }
        }
      }

      return formatReport(events, null);
    },

    /**
     * List or release quarantined items.
     * Stub — Phase 1 quarantine manager not yet implemented.
     *
     * @param {{ subcommand?: string, id?: string }} args
     * @returns {object}
     */
    quarantine(args, _os) {
      return {
        subcommand: (args && args.subcommand) || 'list',
        items: [],
        message: 'Quarantine manager not yet implemented (Phase 1)',
      };
    },

    /**
     * Fast-path tool call evaluation (internal use).
     * Emits a 'scan-block' event when the gate evaluator denies a tool call.
     *
     * @param {{ toolInput?: object }} args
     * @returns {object}
     */
    evaluate(args, os) {
      const gateEvaluator = require('../../aisle/core/gate-evaluator.cjs');
      const stateDir = module.exports._stateDir;
      const result = gateEvaluator.evaluate(args && args.toolInput, stateDir);

      // Emit scan-block event when AISLE blocks a tool call
      if (result && result.decision === 'block' && os && os.observability) {
        os.observability.log('capability', 'scan-block', {
          capability: 'aisle',
          severity: 'warn',
          scanner: result.scanner || 'unknown',
          tool: (args && args.toolInput && args.toolInput.tool_name) || 'unknown',
          reason: result.reason || 'blocked by AISLE gate',
        });
      }

      return result;
    },

    /**
     * Process operator feedback on a finding (FP/TP).
     * Adjusts scanner confidence thresholds within ATK-5 safeguards.
     *
     * @param {{ findingId: string, feedback: { type: 'FP'|'TP', tier?: string, severity?: string }, agentId?: string }} args
     * @returns {{ ok: boolean, reason?: string, applied?: boolean }}
     */
    learn(args, _os) {
      const learning = require('../../aisle/core/learning.cjs');
      const { findingId, feedback, agentId } = args || {};

      // Fix 5 (P4 DFE): Require feedback.type explicitly — downstream validation is strict
      if (!findingId || !feedback || !feedback.type) {
        return { ok: false, reason: 'Required: findingId, feedback.type (FP or TP)' };
      }

      const result = learning.processFeedback(findingId, feedback, agentId || 'operator');

      // Persist after any accepted feedback — observation counts mutate on every ok path
      if (result.ok && module.exports._stateDir) {
        learning.saveState(module.exports._stateDir);
      }

      return result;
    },
  },

  // Exposed for testing
  _formatReport: formatReport,
};
