'use strict';

const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  manifest: {
    name: 'autoresearch',
    version: '1.0.0',
    description: 'Self-improving measurement loops (edit/run/measure/keep)',
    depends_on: [],
    actions: {
      run:    { description: 'Run single domain iteration', args: ['domain'] },
      sweep:  { description: 'Run all domains', args: [] },
      status: { description: 'Show domain statuses', args: [] },
      heal:   { description: 'Fix a failing domain', args: ['domain'] },
    },
    health() {
      return { ...(this._healthCache || { ok: false, reason: 'not initialized' }) };
    },
    resources: { typical_duration: '5m' },
  },

  _os: null,
  _stateDir: null,
  _harnessPath: null,
  _domainsDir: null,
  _healthCache: { ok: false, reason: 'not initialized' },

  probeCost: 'cheap',
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
      // Dry-load harness to catch syntax/require errors
      try {
        delete require.cache[require.resolve(harnessPath)];
        require(harnessPath);
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
    run(args, _os) {
      const { domain } = args || {};
      if (!domain) return { error: 'domain name required' };

      // Emit research-queue event when a domain task is enqueued
      const os = module.exports._os;
      if (os && os.observability) {
        os.observability.log('capability', 'research-queue', {
          capability: 'autoresearch',
          severity: 'info',
          domain,
          message: `Autoresearch task queued for domain: ${domain}`,
        });
      }

      return {
        advisory: true,
        instruction: `Invoke the autoresearch skill with domain "${domain}".`,
        domain,
        skill: 'autoresearch',
      };
    },

    sweep(_args, _os) {
      return {
        advisory: true,
        instruction: 'Invoke the autoresearch skill with "sweep" argument.',
        skill: 'autoresearch',
        args: 'sweep',
      };
    },

    status(_args, _os) {
      const harness = this._loadHarness();
      if (!harness) return { error: 'autoresearch harness not found' };

      const domains = this._listDomains();
      const results = [];

      for (const domain of domains) {
        try {
          const config = harness.loadConfig(domain);
          const experiments = harness.loadExperiments(domain);
          const baseline = harness.getBaseline(experiments);
          const threshold = config.threshold;

          results.push({
            domain,
            metric: baseline ? baseline.metric : null,
            threshold,
            atThreshold: baseline ? baseline.metric >= threshold : false,
            experiments: experiments.length,
          });
        } catch (err) {
          results.push({ domain, error: err.message });
        }
      }

      const atThreshold = results.filter(r => r.atThreshold).length;
      const errored = results.filter(r => r.error).length;
      return {
        total: domains.length,
        atThreshold,
        belowThreshold: domains.length - atThreshold - errored,
        errored,
        domains: results,
      };
    },

    heal(args, _os) {
      const { domain } = args || {};
      if (!domain) return { error: 'domain name required' };

      return {
        advisory: true,
        instruction: `Invoke the autoresearch skill with "heal ${domain}" argument.`,
        domain,
        skill: 'autoresearch',
        args: `heal ${domain}`,
      };
    },
  },
};
