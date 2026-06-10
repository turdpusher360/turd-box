import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const { scanAutoresearch } = require('../wizard-scan-autoresearch.cjs');

// ---------------------------------------------------------------------------
// Helpers — write fixture data into a temp project layout
// ---------------------------------------------------------------------------

/**
 * Build a minimal domain map entry.
 */
function makeMap(domain, type, thresholdId = 'test_threshold', category = 'test_cat') {
  return { [domain]: { category, thresholdId, type } };
}

/**
 * Write one or more JSONL experiment entries for a domain.
 * @param {string} projectRoot
 * @param {string} domain
 * @param {Object[]} entries
 */
function writeExperiments(projectRoot, domain, entries) {
  const dir = path.join(projectRoot, '_runs', 'autoresearch', domain);
  fs.mkdirSync(dir, { recursive: true });
  const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'experiments.jsonl'), lines, 'utf8');
}

/**
 * Write a domain config file at scripts/autoresearch/domains/<domain>.json.
 */
function writeDomainConfig(projectRoot, domain, config) {
  const dir = path.join(projectRoot, 'scripts', 'autoresearch', 'domains');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${domain}.json`), JSON.stringify(config), 'utf8');
}

/**
 * Build a timestamp string that is `days` days ago.
 */
function daysAgo(days) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

// ---------------------------------------------------------------------------
// Setup / teardown — temp project root per test suite
// ---------------------------------------------------------------------------

let tmpRoot;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wiz-scan-ar-test-'));
});

// No afterEach cleanup — vitest cleans temp dirs on process exit; keeping them
// avoids races on Windows. Tests are isolated by unique tmpRoot per suite run.

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

describe('wizard-scan-autoresearch', () => {

  // 1. count type
  it('count type — metric 3 becomes finding count 3', () => {
    writeExperiments(tmpRoot, 'dep-vulnerability', [
      { experiment: 1, timestamp: daysAgo(1), hypothesis: 'baseline', metric: 3, status: 'baseline', commit: null },
    ]);
    const domainMap = makeMap('dep-vulnerability', 'count', 'high_vuln', 'dependencies');
    const { findings } = scanAutoresearch(tmpRoot, domainMap);
    expect(findings.dependencies).toBeDefined();
    expect(findings.dependencies.high_vuln).toBe(3);
  });

  // 2. score_invert type
  it('score_invert — metric 80 becomes 1 finding', () => {
    writeExperiments(tmpRoot, 'agent-staleness', [
      { experiment: 1, timestamp: daysAgo(1), hypothesis: 'baseline', metric: 80, status: 'baseline', commit: null },
    ]);
    const domainMap = makeMap('agent-staleness', 'score_invert', 'stale_verified', 'agents');
    const { findings } = scanAutoresearch(tmpRoot, domainMap);
    expect(findings.agents.stale_verified).toBe(1); // ceil((100-80)/20) = 1
  });

  it('score_invert — metric 100 becomes 0 findings', () => {
    writeExperiments(tmpRoot, 'agent-staleness', [
      { experiment: 1, timestamp: daysAgo(1), hypothesis: 'baseline', metric: 100, status: 'baseline', commit: null },
    ]);
    const domainMap = makeMap('agent-staleness', 'score_invert', 'stale_verified', 'agents');
    const { findings } = scanAutoresearch(tmpRoot, domainMap);
    // score 100 = ceil(0/20) = 0; no finding recorded (count 0 still merges as 0)
    expect((findings.agents || {}).stale_verified || 0).toBe(0);
  });

  it('score_invert — metric 0 becomes 5 findings', () => {
    writeExperiments(tmpRoot, 'agent-staleness', [
      { experiment: 1, timestamp: daysAgo(1), hypothesis: 'baseline', metric: 0, status: 'baseline', commit: null },
    ]);
    const domainMap = makeMap('agent-staleness', 'score_invert', 'stale_verified', 'agents');
    const { findings } = scanAutoresearch(tmpRoot, domainMap);
    expect(findings.agents.stale_verified).toBe(5); // ceil(100/20) = 5
  });

  // 3. boolean type
  it('boolean type — metric 0 becomes 0 findings', () => {
    writeExperiments(tmpRoot, 'env-access-safety', [
      { experiment: 1, timestamp: daysAgo(1), hypothesis: 'baseline', metric: 0, status: 'baseline', commit: null },
    ]);
    const domainMap = makeMap('env-access-safety', 'boolean', 'env_tracked', 'security');
    const { findings } = scanAutoresearch(tmpRoot, domainMap);
    expect((findings.security || {}).env_tracked || 0).toBe(0);
  });

  it('boolean type — metric 5 becomes 1 finding', () => {
    writeExperiments(tmpRoot, 'env-access-safety', [
      { experiment: 1, timestamp: daysAgo(1), hypothesis: 'baseline', metric: 5, status: 'baseline', commit: null },
    ]);
    const domainMap = makeMap('env-access-safety', 'boolean', 'env_tracked', 'security');
    const { findings } = scanAutoresearch(tmpRoot, domainMap);
    expect(findings.security.env_tracked).toBe(1);
  });

  // 4. signal_only type
  it('signal_only — no findings produced, domain appears in signals', () => {
    writeExperiments(tmpRoot, 'hook-perf', [
      { experiment: 1, timestamp: daysAgo(1), hypothesis: 'baseline', metric: 142, status: 'baseline', commit: null },
    ]);
    writeDomainConfig(tmpRoot, 'hook-perf', { name: 'hook-perf', metric: { name: 'max_hook_ms' } });
    const domainMap = makeMap('hook-perf', 'signal_only', null, 'hooks');
    const { findings, signals } = scanAutoresearch(tmpRoot, domainMap);
    expect(Object.keys(findings)).toHaveLength(0);
    expect(signals).toHaveLength(1);
    expect(signals[0].domain).toBe('hook-perf');
    expect(signals[0].metric).toBe(142);
    expect(signals[0].label).toBe('max_hook_ms');
  });

  // 5. staleness: fresh data
  it('staleness: 2-day-old data is included and marked fresh', () => {
    writeExperiments(tmpRoot, 'dep-vulnerability', [
      { experiment: 1, timestamp: daysAgo(2), hypothesis: 'baseline', metric: 1, status: 'baseline', commit: null },
    ]);
    const domainMap = makeMap('dep-vulnerability', 'count', 'high_vuln', 'dependencies');
    const { findings, stale } = scanAutoresearch(tmpRoot, domainMap, { staleDays: 7 });
    expect(findings.dependencies.high_vuln).toBe(1);
    expect(stale).not.toContain('dep-vulnerability');
  });

  // 6. staleness: stale data still included but in stale array
  it('staleness: 15-day-old data is included but in stale array', () => {
    writeExperiments(tmpRoot, 'dep-vulnerability', [
      { experiment: 1, timestamp: daysAgo(15), hypothesis: 'baseline', metric: 2, status: 'baseline', commit: null },
    ]);
    const domainMap = makeMap('dep-vulnerability', 'count', 'high_vuln', 'dependencies');
    const { findings, stale } = scanAutoresearch(tmpRoot, domainMap, { staleDays: 7, maxStaleDays: 30 });
    expect(findings.dependencies.high_vuln).toBe(2);
    expect(stale).toContain('dep-vulnerability');
  });

  // 7. staleness: 45-day-old data excluded entirely
  it('staleness: 45-day-old data is excluded and in stale array', () => {
    writeExperiments(tmpRoot, 'dep-vulnerability', [
      { experiment: 1, timestamp: daysAgo(45), hypothesis: 'baseline', metric: 7, status: 'baseline', commit: null },
    ]);
    const domainMap = makeMap('dep-vulnerability', 'count', 'high_vuln', 'dependencies');
    const { findings, stale } = scanAutoresearch(tmpRoot, domainMap, { staleDays: 7, maxStaleDays: 30 });
    expect((findings.dependencies || {}).high_vuln).toBeUndefined();
    expect(stale).toContain('dep-vulnerability');
  });

  // 8. missing experiments file
  it('missing experiments file — domain skipped without error', () => {
    const domainMap = makeMap('dep-vulnerability', 'count', 'high_vuln', 'dependencies');
    // no file written
    const { findings, signals, stale } = scanAutoresearch(tmpRoot, domainMap);
    expect(Object.keys(findings)).toHaveLength(0);
    expect(signals).toHaveLength(0);
    expect(stale).toHaveLength(0);
  });

  // 9. empty experiments file
  it('empty experiments file — domain skipped without error', () => {
    const dir = path.join(tmpRoot, '_runs', 'autoresearch', 'dep-vulnerability');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'experiments.jsonl'), '', 'utf8');
    const domainMap = makeMap('dep-vulnerability', 'count', 'high_vuln', 'dependencies');
    const { findings } = scanAutoresearch(tmpRoot, domainMap);
    expect(Object.keys(findings)).toHaveLength(0);
  });

  // 10. multiple domains same category — findings sum correctly
  it('multiple domains same category — findings accumulate correctly', () => {
    writeExperiments(tmpRoot, 'dep-vulnerability', [
      { experiment: 1, timestamp: daysAgo(1), hypothesis: 'baseline', metric: 3, status: 'baseline', commit: null },
    ]);
    writeExperiments(tmpRoot, 'dep-staleness', [
      { experiment: 1, timestamp: daysAgo(1), hypothesis: 'baseline', metric: 5, status: 'baseline', commit: null },
    ]);
    const domainMap = {
      'dep-vulnerability': { category: 'dependencies', thresholdId: 'high_vuln', type: 'count' },
      'dep-staleness': { category: 'dependencies', thresholdId: 'major_outdated', type: 'count' },
    };
    const { findings } = scanAutoresearch(tmpRoot, domainMap);
    expect(findings.dependencies.high_vuln).toBe(3);
    expect(findings.dependencies.major_outdated).toBe(5);
  });

  it('multiple domains same threshold — counts are summed', () => {
    writeExperiments(tmpRoot, 'domain-a', [
      { experiment: 1, timestamp: daysAgo(1), hypothesis: 'baseline', metric: 2, status: 'baseline', commit: null },
    ]);
    writeExperiments(tmpRoot, 'domain-b', [
      { experiment: 1, timestamp: daysAgo(1), hypothesis: 'baseline', metric: 4, status: 'baseline', commit: null },
    ]);
    const domainMap = {
      'domain-a': { category: 'security', thresholdId: 'shared_threshold', type: 'count' },
      'domain-b': { category: 'security', thresholdId: 'shared_threshold', type: 'count' },
    };
    const { findings } = scanAutoresearch(tmpRoot, domainMap);
    expect(findings.security.shared_threshold).toBe(6); // 2 + 4
  });

  // 11. baseline entry used when no kept
  it('baseline status used when no kept entry exists', () => {
    writeExperiments(tmpRoot, 'dep-vulnerability', [
      { experiment: 1, timestamp: daysAgo(1), hypothesis: 'baseline', metric: 7, status: 'baseline', commit: null },
      { experiment: 2, timestamp: daysAgo(1), hypothesis: 'try x', metric_before: 7, metric_after: 5, delta: -2, status: 'discarded', commit: null },
    ]);
    const domainMap = makeMap('dep-vulnerability', 'count', 'high_vuln', 'dependencies');
    const { findings } = scanAutoresearch(tmpRoot, domainMap);
    expect(findings.dependencies.high_vuln).toBe(7);
  });

  // 12. last kept entry wins when multiple exist
  it('last kept entry wins over earlier kept entries', () => {
    writeExperiments(tmpRoot, 'hook-exit-contract', [
      { experiment: 1, timestamp: daysAgo(3), hypothesis: 'baseline', metric: 10, status: 'baseline', commit: null },
      { experiment: 2, timestamp: daysAgo(2), hypothesis: 'fix some', metric_before: 10, metric_after: 5, delta: -5, status: 'kept', commit: 'abc' },
      { experiment: 3, timestamp: daysAgo(1), hypothesis: 'fix more', metric_before: 5, metric_after: 2, delta: -3, status: 'kept', commit: 'def' },
    ]);
    const domainMap = makeMap('hook-exit-contract', 'count', 'bad_exit', 'hooks');
    const { findings } = scanAutoresearch(tmpRoot, domainMap);
    expect(findings.hooks.bad_exit).toBe(2); // last kept: metric_after = 2
  });

  // signal_only: fresh flag reflects staleness correctly
  it('signal_only fresh flag is false for stale-but-included data', () => {
    writeExperiments(tmpRoot, 'hook-perf', [
      { experiment: 1, timestamp: daysAgo(15), hypothesis: 'baseline', metric: 88, status: 'baseline', commit: null },
    ]);
    writeDomainConfig(tmpRoot, 'hook-perf', { name: 'hook-perf', metric: { name: 'max_hook_ms' } });
    const domainMap = makeMap('hook-perf', 'signal_only', null, 'hooks');
    const { signals, stale } = scanAutoresearch(tmpRoot, domainMap, { staleDays: 7, maxStaleDays: 30 });
    expect(signals).toHaveLength(1);
    expect(signals[0].fresh).toBe(false);
    expect(stale).toContain('hook-perf');
  });

  // signal_only: domain config missing — falls back to domain name as label
  it('signal_only uses domain name as label when config file missing', () => {
    writeExperiments(tmpRoot, 'hook-perf', [
      { experiment: 1, timestamp: daysAgo(1), hypothesis: 'baseline', metric: 55, status: 'baseline', commit: null },
    ]);
    // no domain config written
    const domainMap = makeMap('hook-perf', 'signal_only', null, 'hooks');
    const { signals } = scanAutoresearch(tmpRoot, domainMap);
    expect(signals[0].label).toBe('hook-perf');
  });

  // default opts
  it('uses default staleDays=7 and maxStaleDays=30 when opts not provided', () => {
    writeExperiments(tmpRoot, 'dep-vulnerability', [
      { experiment: 1, timestamp: daysAgo(1), hypothesis: 'baseline', metric: 1, status: 'baseline', commit: null },
    ]);
    const domainMap = makeMap('dep-vulnerability', 'count', 'high_vuln', 'dependencies');
    // no error = defaults accepted
    const { findings } = scanAutoresearch(tmpRoot, domainMap);
    expect(findings.dependencies.high_vuln).toBe(1);
  });

  // S286 defense-in-depth: AR sentinel metrics (-1) must not poison findings
  // even if they reach this layer. Harness throws on metric<0, so these only
  // arrive via malformed historical entries or future bypass paths.
  it('defensive: negative sentinel metric (-1) produces no finding', () => {
    writeExperiments(tmpRoot, 'config-drift', [
      { experiment: 1, timestamp: daysAgo(1), hypothesis: 'baseline', metric: -1, status: 'baseline', commit: null },
    ]);
    const domainMap = makeMap('config-drift', 'score_invert', 'drift_count', 'config');
    const { findings } = scanAutoresearch(tmpRoot, domainMap);
    expect(Object.keys(findings)).toHaveLength(0);
  });

  it('defensive: NaN metric produces no finding', () => {
    writeExperiments(tmpRoot, 'dep-vulnerability', [
      { experiment: 1, timestamp: daysAgo(1), hypothesis: 'baseline', metric: NaN, status: 'baseline', commit: null },
    ]);
    const domainMap = makeMap('dep-vulnerability', 'count', 'high_vuln', 'dependencies');
    const { findings } = scanAutoresearch(tmpRoot, domainMap);
    expect(Object.keys(findings)).toHaveLength(0);
  });

  it('defensive: Infinity metric produces no finding', () => {
    writeExperiments(tmpRoot, 'dep-vulnerability', [
      { experiment: 1, timestamp: daysAgo(1), hypothesis: 'baseline', metric: Infinity, status: 'baseline', commit: null },
    ]);
    const domainMap = makeMap('dep-vulnerability', 'count', 'high_vuln', 'dependencies');
    const { findings } = scanAutoresearch(tmpRoot, domainMap);
    expect(Object.keys(findings)).toHaveLength(0);
  });
});
