import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { scanAutoresearch, readAgentStaleness } = require('../wizard-scan-autoresearch.cjs');

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

// ---------------------------------------------------------------------------
// agent-staleness: read at scan time from .claude/agents/*.md with the rules of
// the check-agent-staleness register hook. The wizard never runs that hook.
// ---------------------------------------------------------------------------

const REGISTER_MAP = {
  'agent-staleness': {
    category: 'agents', thresholdId: 'stale_verified', type: 'score_invert', source: 'register:agent-staleness',
  },
};

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const REAL_HOOK = path.join(REPO_ROOT, '.claude', 'hooks', 'check-agent-staleness.cjs');
const MODULE_PATH = path.join(REPO_ROOT, 'plugins', '4ge', 'lib', 'wizard-scan-autoresearch.cjs');

const DAY_MS = 86400000;
// Noon UTC: a date-only last-verified parses to UTC midnight, so every fixture
// date sits half a day inside its whole-day bucket in any local time zone.
const NOW = Date.UTC(2026, 8, 30, 12);

/** YYYY-MM-DD for `days` days before `nowMs`. */
function isoDay(nowMs, days) {
  return new Date(nowMs - days * DAY_MS).toISOString().slice(0, 10);
}

function agentsDir(projectRoot) {
  const dir = path.join(projectRoot, '.claude', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeAgent(projectRoot, name, body) {
  fs.writeFileSync(path.join(agentsDir(projectRoot), `${name}.md`), body);
}

/** An agent file whose frontmatter carries `line` (pass '' for no last-verified). */
function agentBody(line) {
  return `---\nname: a\n${line}\n---\nbody\n`;
}

/** The hook file whose presence marks a repo that follows the last-verified convention. */
function writeHookFile(projectRoot, source = '// marker only\n') {
  const dir = path.join(projectRoot, '.claude', 'hooks');
  fs.mkdirSync(dir, { recursive: true });
  const hookPath = path.join(dir, 'check-agent-staleness.cjs');
  fs.writeFileSync(hookPath, source);
  return hookPath;
}

describe('wizard-scan-autoresearch — agent-staleness read in-process', () => {
  it('a fresh agent scores 100', () => {
    writeHookFile(tmpRoot);
    writeAgent(tmpRoot, 'fresh', agentBody(`last-verified: ${isoDay(NOW, 1)}`));
    expect(readAgentStaleness(tmpRoot, { now: NOW })).toBe(100);
  });

  it('exactly 14 days old is not stale; 15 days old is', () => {
    writeHookFile(tmpRoot);
    writeAgent(tmpRoot, 'boundary', agentBody(`last-verified: ${isoDay(NOW, 14)}`));
    expect(readAgentStaleness(tmpRoot, { now: NOW })).toBe(100);
    writeAgent(tmpRoot, 'stale', agentBody(`last-verified: ${isoDay(NOW, 15)}`));
    expect(readAgentStaleness(tmpRoot, { now: NOW })).toBe(50);
  });

  it('an agent without a last-verified line counts as missing', () => {
    writeHookFile(tmpRoot);
    writeAgent(tmpRoot, 'fresh', agentBody(`last-verified: ${isoDay(NOW, 1)}`));
    writeAgent(tmpRoot, 'none', agentBody(''));
    expect(readAgentStaleness(tmpRoot, { now: NOW })).toBe(50);
  });

  it('a date the pattern does not match counts as missing', () => {
    writeHookFile(tmpRoot);
    writeAgent(tmpRoot, 'slashes', agentBody('last-verified: 2026/09/29'));
    writeAgent(tmpRoot, 'word', agentBody('last-verified: soon'));
    writeAgent(tmpRoot, 'indented', agentBody(`  last-verified: ${isoDay(NOW, 1)}`));
    writeAgent(tmpRoot, 'fresh', agentBody(`last-verified: ${isoDay(NOW, 1)}`));
    expect(readAgentStaleness(tmpRoot, { now: NOW })).toBe(25);
  });

  it('an impossible calendar date counts as fresh, as in the hook (Invalid Date gives NaN days)', () => {
    writeHookFile(tmpRoot);
    writeAgent(tmpRoot, 'impossible', agentBody('last-verified: 2026-13-45'));
    expect(readAgentStaleness(tmpRoot, { now: NOW })).toBe(100);
  });

  it('matches last-verified anywhere in the file, not only in the frontmatter', () => {
    writeHookFile(tmpRoot);
    writeAgent(tmpRoot, 'in-body', `---\nname: a\n---\nNotes.\nlast-verified: ${isoDay(NOW, 2)}\n`);
    expect(readAgentStaleness(tmpRoot, { now: NOW })).toBe(100);
  });

  it('a directory named x.md counts as missing', () => {
    writeHookFile(tmpRoot);
    writeAgent(tmpRoot, 'fresh', agentBody(`last-verified: ${isoDay(NOW, 1)}`));
    fs.mkdirSync(path.join(agentsDir(tmpRoot), 'x.md'));
    expect(readAgentStaleness(tmpRoot, { now: NOW })).toBe(50);
  });

  it.skipIf(process.platform === 'win32')('a FIFO named y.md counts as missing and does not block', (ctx) => {
    writeHookFile(tmpRoot);
    writeAgent(tmpRoot, 'fresh', agentBody(`last-verified: ${isoDay(NOW, 1)}`));
    const made = spawnSync('mkfifo', [path.join(agentsDir(tmpRoot), 'y.md')]);
    if (made.error || made.status !== 0) ctx.skip();
    // Run in a child with a deadline: a blocking read would hang this worker, not fail it.
    const script = 'const [m, r, n] = process.argv.slice(1);' +
      'process.stdout.write(String(require(m).readAgentStaleness(r, { now: Number(n) })));';
    const run = spawnSync(process.execPath, ['-e', script, MODULE_PATH, tmpRoot, String(NOW)], {
      encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(run.error).toBeUndefined();
    expect(run.stdout).toBe('50');
  });

  it('reads only the first 64 KiB of each file', () => {
    writeHookFile(tmpRoot);
    const pad = 'x'.repeat(70 * 1024);
    writeAgent(tmpRoot, 'line-first', `last-verified: ${isoDay(NOW, 1)}\n${pad}\n`);
    writeAgent(tmpRoot, 'line-past-cap', `${pad}\nlast-verified: ${isoDay(NOW, 1)}\n`);
    expect(readAgentStaleness(tmpRoot, { now: NOW })).toBe(50);
  });

  it('is null when the hook file is absent, even with agents and experiment rows', () => {
    writeAgent(tmpRoot, 'fresh', agentBody(`last-verified: ${isoDay(NOW, 1)}`));
    writeExperiments(tmpRoot, 'agent-staleness', [{ status: 'baseline', metric: 0, timestamp: daysAgo(1) }]);
    expect(readAgentStaleness(tmpRoot, { now: NOW })).toBeNull();
    const result = scanAutoresearch(tmpRoot, REGISTER_MAP);
    expect(result.findings).toEqual({});
    expect(result.stale).toEqual([]);
  });

  it('is null when .claude/agents is absent, not a directory, or holds no .md files', () => {
    writeHookFile(tmpRoot);
    expect(readAgentStaleness(tmpRoot, { now: NOW })).toBeNull();
    fs.writeFileSync(path.join(tmpRoot, '.claude', 'agents'), 'not a directory');
    expect(readAgentStaleness(tmpRoot, { now: NOW })).toBeNull();
    fs.rmSync(path.join(tmpRoot, '.claude', 'agents'));
    fs.writeFileSync(path.join(agentsDir(tmpRoot), 'README.txt'), 'last-verified: 2026-09-29\n');
    expect(readAgentStaleness(tmpRoot, { now: NOW })).toBeNull();
    expect(scanAutoresearch(tmpRoot, REGISTER_MAP).findings).toEqual({});
  });

  it('feeds the score_invert finding through REGISTER_SOURCES (real clock, dates far from the boundary)', () => {
    writeHookFile(tmpRoot);
    const now = Date.now();
    writeAgent(tmpRoot, 'a', agentBody(`last-verified: ${isoDay(now, 1)}`));
    writeAgent(tmpRoot, 'b', agentBody(`last-verified: ${isoDay(now, 2)}`));
    writeAgent(tmpRoot, 'c', agentBody(`last-verified: ${isoDay(now, 100)}`));
    writeAgent(tmpRoot, 'd', agentBody(''));
    const { findings } = scanAutoresearch(tmpRoot, REGISTER_MAP);
    expect(findings.agents.stale_verified).toBe(3); // 2 of 4 fresh = 50 -> ceil(50/20) = 3
  });

  it('records a zero finding when every agent is fresh', () => {
    writeHookFile(tmpRoot);
    writeAgent(tmpRoot, 'a', agentBody(`last-verified: ${isoDay(Date.now(), 1)}`));
    const { findings } = scanAutoresearch(tmpRoot, REGISTER_MAP);
    expect(findings.agents.stale_verified).toBe(0);
  });

  it("never runs or loads the scanned repo's hook", () => {
    const marker = path.join(tmpRoot, 'hook-ran.txt');
    const hookPath = writeHookFile(tmpRoot,
      `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n` +
      "process.stdout.write('[agent-staleness] WARNING: 9 agent(s) not verified in 14+ days: x (99d)\\n');\n");
    writeAgent(tmpRoot, 'fresh', agentBody(`last-verified: ${isoDay(Date.now(), 1)}`));
    const { findings } = scanAutoresearch(tmpRoot, REGISTER_MAP);
    expect(findings.agents.stale_verified).toBe(0);
    expect(readAgentStaleness(tmpRoot)).toBe(100);
    expect(fs.existsSync(marker)).toBe(false);
    // The fixture is live: running it does write the marker.
    spawnSync(process.execPath, [hookPath], { timeout: 10000, stdio: 'ignore' });
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('matches the real check-agent-staleness hook on the same agents (parity)', () => {
    const hooksDir = path.join(tmpRoot, '.claude', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    const hookCopy = path.join(hooksDir, 'check-agent-staleness.cjs');
    fs.copyFileSync(REAL_HOOK, hookCopy);
    expect(fs.readFileSync(hookCopy).equals(fs.readFileSync(REAL_HOOK))).toBe(true);
    // The hook requires ../../lib/hook-utils.cjs for timing only; an empty module stands in.
    fs.mkdirSync(path.join(tmpRoot, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'lib', 'hook-utils.cjs'), '');

    // The hook reads the real clock, so every date sits days away from the 14-day line.
    // No FIFO here: the hook's readFileSync would block on one.
    const now = Date.now();
    writeAgent(tmpRoot, 'fresh-1', agentBody(`last-verified: ${isoDay(now, 1)}`));
    writeAgent(tmpRoot, 'fresh-7', agentBody(`last-verified: ${isoDay(now, 7)}`));
    writeAgent(tmpRoot, 'in-body', `---\nname: a\n---\nlast-verified: ${isoDay(now, 3)}\n`);
    writeAgent(tmpRoot, 'impossible', agentBody('last-verified: 2026-13-45'));
    writeAgent(tmpRoot, 'stale-60', agentBody(`last-verified: ${isoDay(now, 60)}`));
    writeAgent(tmpRoot, 'stale-200', agentBody(`last-verified: ${isoDay(now, 200)}`));
    writeAgent(tmpRoot, 'none', agentBody(''));
    writeAgent(tmpRoot, 'word', agentBody('last-verified: soon'));
    fs.mkdirSync(path.join(agentsDir(tmpRoot), 'x.md'));
    const total = 9;

    const run = spawnSync(process.execPath, [hookCopy], {
      cwd: tmpRoot, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(run.error).toBeUndefined();
    expect(run.status).toBe(0);
    const staleLine = run.stdout.match(/\[agent-staleness\] WARNING: (\d+) agent\(s\) not verified/);
    const missingLine = run.stdout.match(/\[agent-staleness\] (\d+) agent\(s\) missing last-verified/);
    // Both lines must parse, so parity cannot pass on a defaulted zero.
    expect(staleLine).not.toBeNull();
    expect(missingLine).not.toBeNull();
    const staleCount = Number(staleLine[1]);
    const missingCount = Number(missingLine[1]);
    expect(staleCount).toBe(2);
    expect(missingCount).toBe(3);
    const hookMetric = Math.round((100 * Math.max(0, total - (staleCount + missingCount))) / total);

    expect(readAgentStaleness(tmpRoot)).toBe(hookMetric);
  });

  it('the shipped domain map sources agent-staleness from the register check', () => {
    const shippedMap = require('../domain-threshold-map.json');
    expect(shippedMap['agent-staleness'].source).toBe('register:agent-staleness');
  });
});
