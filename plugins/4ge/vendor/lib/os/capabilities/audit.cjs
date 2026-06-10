'use strict';

const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  manifest: {
    name: 'audit',
    version: '1.0.0',
    description: 'Domain-based code quality checks (70 checks, 10 domains)',
    depends_on: [],
    actions: {
      run:     { description: 'Interactive audit (interview + engine + report)', args: [] },
      status:  { description: 'Last audit results summary', args: [] },
    },
    health() {
      return { ...(this._healthCache || { ok: false, reason: 'not initialized' }) };
    },
    resources: {},
  },

  _os: null,
  _stateDir: null,
  _enginePath: null,
  _healthCache: { ok: false, reason: 'not initialized' },

  probeCost: 'cheap',

  _REQUIRED_AGENTS: [
    'master-auditor.md',
    'opus-audit.md',
  ],

  probe() {
    try {
      const pathMod = require('node:path');
      const fsMod = require('node:fs');
      const agentsDir = pathMod.join(process.cwd(), '.claude', 'agents');
      const entries = new Set(fsMod.readdirSync(agentsDir));
      const missing = this._REQUIRED_AGENTS.filter(f => !entries.has(f));
      if (missing.length > 0) {
        const result = { ok: false, reason: `missing audit agents: ${missing.join(', ')}` };
        this._healthCache = result;
        return result;
      }
      const result = { ok: true, audit_agents: this._REQUIRED_AGENTS.length };
      this._healthCache = result;
      return result;
    } catch (e) {
      const result = { ok: false, reason: `probe threw: ${e.message}` };
      this._healthCache = result;
      return result;
    }
  },

  init(os) {
    const obs = os.observability;
    const t0 = Date.now();
    obs.log('capability', 'init-start', { capability: 'audit', severity: 'info' });

    try {
      this._os = os;
      this._stateDir = os.capDir;

      // Primary: agent definition (audit is agent-delegated since upstream plugin consolidation)
      const agentPath = path.join(process.cwd(), '.claude', 'agents', 'master-auditor.md');
      // Secondary: 4ge command
      const commandPath = path.join(process.cwd(), 'plugins', '4ge', 'commands', 'audit.md');

      this._agentPath = fs.existsSync(agentPath) ? agentPath : null;
      this._commandPath = fs.existsSync(commandPath) ? commandPath : null;

      // Legacy engine path (retired in 9c2207c)
      const legacyCandidates = [
        path.join(process.cwd(), 'plugins', 'turd-audit', 'lib', 'audit-engine.cjs'),
      ];
      this._enginePath = legacyCandidates.find(p => fs.existsSync(p)) || null;

      if (this._agentPath || this._commandPath) {
        this._healthCache = {
          ok: true,
          mode: 'agent-delegated',
          agentPath: this._agentPath,
          commandPath: this._commandPath,
        };
      } else if (this._enginePath) {
        this._healthCache = { ok: true, enginePath: this._enginePath };
      } else {
        this._healthCache = { ok: false, reason: 'audit agent and engine not found' };
      }

      obs.log('capability', 'init-complete', {
        capability: 'audit',
        severity: 'info',
        durationMs: Date.now() - t0,
        mode: this._healthCache.ok ? (this._healthCache.mode || 'legacy-engine') : 'unavailable',
      });
    } catch (e) {
      obs.log('capability', 'init-error', {
        capability: 'audit',
        severity: 'error',
        message: e.message,
        durationMs: Date.now() - t0,
      });
      throw e;
    }
  },

  shutdown() {},

  // NOTE: Since upstream plugin consolidation (9c2207c), audit is agent-delegated to @master-auditor.
  // The capability reports ready when the agent definition or /audit command exists.
  // Direct engine execution is a legacy path; actions return advisory instructions.
  actions: {
    run(_args, _os) {
      // Emit audit-start event when an audit is invoked
      const os = module.exports._os;
      if (os && os.observability) {
        os.observability.log('capability', 'audit-start', {
          capability: 'audit',
          severity: 'info',
          mode: 'agent-delegated',
          agent: 'master-auditor',
        });
      }

      return {
        advisory: true,
        instruction: 'Spawn @master-auditor agent for interactive audit.',
        agent: 'master-auditor',
      };
    },

    status(_args, _os) {
      try {
        const resultsPath = path.join(process.cwd(), '.audit-results.json');
        if (!fs.existsSync(resultsPath)) {
          return { hasResults: false };
        }
        const data = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
        return {
          hasResults: true,
          score: data.score,
          summary: data.summary,
          timestamp: data.timestamp,
        };
      } catch {
        return { hasResults: false, error: 'failed to read results' };
      }
    },

  },
};
