// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  manifest: {
    name: 'autoresearch',
    version: '2.0.0',
    description: 'Measurement-plane status: each domain\'s latest metric graded by the harness (read-only)',
    depends_on: [],
    actions: {
      status: { description: 'Grade each domain\'s latest metric against its threshold', args: [] },
    },
    /** @returns {import('../kernel/contracts.cjs').HealthResult} */
    health() {
      // Read the cache off module.exports, not `this` — a bare `manifest.health()`
      // call binds `this` to the manifest object (which has no _healthCache),
      // so `this._healthCache` would always miss (case-36 FP-bench this-binding).
      return { ...(module.exports._healthCache || { ok: false, reason: 'not initialized' }) };
    },
    resources: { typical_duration: '5m' },
  },

  _os: null,
  _stateDir: null,
  _harnessPath: null,
  _domainsDir: null,
  /** @type {import('../kernel/contracts.cjs').HealthResult} */
  _healthCache: { ok: false, reason: 'not initialized' },

  probeCost: 'cheap',
  /** @returns {import('../kernel/contracts.cjs').HealthResult} */
  probe() {
    try {
      const pathMod = require('node:path');
      const fsMod = require('node:fs');
      const harnessPath = pathMod.join(
        process.cwd(), 'scripts', 'autoresearch', 'harness.cjs'
      );
      if (!fsMod.existsSync(harnessPath)) {
        const result = { ok: false, reason: 'harness not found' };
        this._healthCache = result;
        return result;
      }
      // Compile-only syntax check, CJS-wrapped; the harness never runs here.
      // The 4ge plugin vendors this capability and runs cheap probes in any
      // repo it opens, so require()-ing a project's harness from a probe would
      // execute that repo's code (BL-404). Require-time errors surface only
      // when an explicit action loads the harness (_loadHarness).
      try {
        require('node:vm').compileFunction(
          fsMod.readFileSync(harnessPath, 'utf8'),
          ['exports', 'require', 'module', '__filename', '__dirname'],
          { filename: harnessPath }
        );
      } catch (loadErr) {
        const result = { ok: false, reason: `harness load failed: ${loadErr.message}` };
        this._healthCache = result;
        return result;
      }
      // Count domain definitions
      const domainsDir = pathMod.join(process.cwd(), 'scripts', 'autoresearch', 'domains');
      let domainCount = 0;
      try {
        domainCount = fsMod.readdirSync(domainsDir).filter(f => f.endsWith('.json')).length;
      } catch { /* domains dir optional */ }
      const result = { ok: true, harness: 'present', domains: domainCount };
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
    obs.log('capability', 'init-start', { capability: 'autoresearch', severity: 'info' });

    try {
      this._os = os;
      this._stateDir = os.capDir;

      const harnessCandidate = path.join(process.cwd(), 'scripts', 'autoresearch', 'harness.cjs');
      this._harnessPath = fs.existsSync(harnessCandidate) ? harnessCandidate : null;
      this._domainsDir = path.join(process.cwd(), 'scripts', 'autoresearch', 'domains');

      this._healthCache = this._harnessPath
        ? { ok: true, harnessPath: this._harnessPath, domainsDir: this._domainsDir }
        : { ok: false, reason: 'autoresearch harness not found' };

      obs.log('capability', 'init-complete', {
        capability: 'autoresearch',
        severity: 'info',
        durationMs: Date.now() - t0,
        harnessFound: !!this._harnessPath,
      });
    } catch (e) {
      obs.log('capability', 'init-error', {
        capability: 'autoresearch',
        severity: 'error',
        message: e.message,
        durationMs: Date.now() - t0,
      });
      throw e;
    }
  },

  shutdown() {},

  _listDomains() {
    try {
      if (!fs.existsSync(this._domainsDir)) return [];
      return fs.readdirSync(this._domainsDir)
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace('.json', ''));
    } catch { return []; }
  },

  _loadHarness() {
    if (!this._harnessPath) return null;
    try {
      delete require.cache[require.resolve(this._harnessPath)];
      return require(this._harnessPath);
    } catch { return null; }
  },

  actions: {
    status(_args, _os) {
      const harness = this._loadHarness();
      if (!harness) return { error: 'autoresearch harness not found' };
      if (typeof harness.resolveStatus !== 'function' || typeof harness.getBaselineV2 !== 'function') {
        return { error: 'autoresearch harness does not export resolveStatus and getBaselineV2' };
      }

      const domains = this._listDomains();
      const results = [];

      for (const domain of domains) {
        try {
          const config = harness.loadConfig(domain);
          const experiments = harness.loadExperiments(domain);
          // The harness grades with config.metric.threshold and config.metric.direction,
          // the same rule its --status and sweep use.
          const status = harness.resolveStatus(config, experiments);
          const baseline = harness.getBaselineV2(experiments, 'proxy');
          const metric = config.metric || {};
          // When the status was observed: the latest measurement row, failed or
          // skipped ones included. Null for an older harness without the helper.
          const latest = typeof harness.latestObservation === 'function'
            ? harness.latestObservation(experiments, 'proxy')
            : null;

          results.push({
            domain,
            status,
            metric: baseline ? (baseline.metric ?? baseline.metric_after ?? null) : null,
            threshold: metric.threshold ?? null,
            direction: metric.direction ?? null,
            experiments: experiments.length,
            observedAt: (latest && latest.timestamp) || null,
          });
        } catch (err) {
          results.push({ domain, error: err.message });
        }
      }

      /** @type {Record<string, number>} */
      const byStatus = {};
      for (const r of results) {
        if (r.status) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
      }
      return {
        total: domains.length,
        atThreshold: byStatus.AT_THRESHOLD || 0,
        errored: results.filter(r => r.error).length,
        byStatus,
        domains: results,
      };
    },
  },
};
