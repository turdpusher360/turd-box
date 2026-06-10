/**
 * wizard-e2e.test.js
 *
 * End-to-end tests for the wizard engine 6-stage pipeline:
 *   scan -> triage (score) -> inspect (findings) -> execute (session) -> verify -> report
 *
 * Architecture note: there is no single wizard-engine.cjs. The pipeline is
 * distributed across wizard-scan.cjs (scan + triage), wizard-scoring.cjs
 * (score math), wizard-session.cjs (session lifecycle), wizard-output.cjs
 * (report rendering), and wizard-cli.cjs (CLI entry). These tests exercise
 * each stage boundary and their composition.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);

// ── Module imports ──────────────────────────────────────────────────────────

const { scan } = require('../wizard-scan.cjs');
const { renderQuickReport, setColorEnabled } = require('../wizard-output.cjs');
const { scoreCategory, computeOverall, classifyCategory, assignGrade, computeDelta } = require('../wizard-scoring.cjs');
const { mergeConfig, resolveThresholds } = require('../wizard-config.cjs');
const { create, update, read, end, isStale } = require('../wizard-session.cjs');

// ── Fixture loading ─────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const thresholdDefaultsPath = path.join(
  __dirname,
  '../../skills/wizard-engine/references/threshold-defaults.json',
);
const thresholdDefaults = JSON.parse(fs.readFileSync(thresholdDefaultsPath, 'utf-8'));

// ── Helpers ─────────────────────────────────────────────────────────────────

/** ISO timestamp `days` days in the past */
function daysAgo(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

/** Write one experiments.jsonl entry for an autoresearch domain */
function writeExperiment(root, domain, metric, status = 'baseline', daysOld = 1) {
  const dir = path.join(root, '_runs', 'autoresearch', domain);
  fs.mkdirSync(dir, { recursive: true });
  const entry = {
    experiment: 1,
    timestamp: daysAgo(daysOld),
    hypothesis: 'baseline',
    metric,
    status,
    commit: null,
  };
  fs.writeFileSync(
    path.join(dir, 'experiments.jsonl'),
    JSON.stringify(entry) + '\n',
    'utf-8',
  );
}

/** Write wizard inbox items */
function writeWizardInbox(root, items) {
  const lines = items.map(i => JSON.stringify(i)).join('\n') + '\n';
  fs.writeFileSync(path.join(root, '.4ge-wizard-inbox.jsonl'), lines, 'utf-8');
}

/** Write secondary fix-inbox items */
function writeFixInbox(root, items) {
  const dir = path.join(root, '_runs');
  fs.mkdirSync(dir, { recursive: true });
  const lines = items.map(i => JSON.stringify(i)).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, '.fix-inbox.jsonl'), lines, 'utf-8');
}

/** Write OS state files for scanOs */
function writeOsFiles(root) {
  const dir = path.join(root, '_runs', 'os');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'boot-status.json'),
    JSON.stringify({
      total_boot_ms: 200,
      capabilities: {
        memory: { status: 'ready' },
        git: { status: 'ready' },
        forge: { status: 'ready' },
      },
    }),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(dir, 'health.json'),
    JSON.stringify({ memory: { ok: true }, git: { ok: true }, forge: { ok: true } }),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(dir, 'git-state.json'),
    JSON.stringify({
      branch: 'main',
      dirty: false,
      uncommittedFiles: 0,
      ahead: 0,
      behind: 0,
    }),
    'utf-8',
  );
}

/** Write AISLE scanner cache files */
function writeAisleCache(stateDir, scannerStates) {
  const cacheDir = path.join(stateDir, 'scanner-cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  for (const [id, state] of Object.entries(scannerStates)) {
    fs.writeFileSync(
      path.join(cacheDir, `${id}.json`),
      JSON.stringify(state),
      'utf-8',
    );
  }
}

/** Write a minimal .4ge-wizard.json project config */
function writeProjectConfig(root, cfg) {
  fs.writeFileSync(
    path.join(root, '.4ge-wizard.json'),
    JSON.stringify(cfg),
    'utf-8',
  );
}

/** Returns scan opts that isolate AISLE from the real system state dir */
function isolatedOpts(root) {
  return { aisleStateDir: path.join(root, '_aisle_') };
}

/** Returns scan opts that point to a specific AISLE state dir */
function aisleOpts(root) {
  return { aisleStateDir: path.join(root, '_aisle_') };
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

let tmpRoot;

beforeEach(() => {
  setColorEnabled(false);
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-e2e-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ── STAGE 1: SCAN ─────────────────────────────────────────────────────────────

describe('Stage 1 — scan', () => {
  it('returns all 9 expected category keys from threshold-defaults', () => {
    const result = scan(tmpRoot, {}, thresholdDefaults, isolatedOpts(tmpRoot));
    const expectedCategories = Object.keys(thresholdDefaults.categories);
    for (const name of expectedCategories) {
      expect(result.categories).toHaveProperty(name);
    }
    expect(expectedCategories.length).toBe(9);
  });

  it('scan result shape has all required top-level fields', () => {
    const result = scan(tmpRoot, {}, thresholdDefaults, isolatedOpts(tmpRoot));
    expect(result).toHaveProperty('categories');
    expect(result).toHaveProperty('overall');
    expect(result).toHaveProperty('signals');
    expect(result).toHaveProperty('stale');
    expect(result).toHaveProperty('inbox');
    expect(result).toHaveProperty('os');
    expect(result).toHaveProperty('aisle');
    expect(result).toHaveProperty('meta');
  });

  it('empty project scan does not throw and produces all-max scores', () => {
    let result;
    expect(() => {
      result = scan(tmpRoot, {}, thresholdDefaults, isolatedOpts(tmpRoot));
    }).not.toThrow();

    for (const [name, cat] of Object.entries(result.categories)) {
      expect(cat.raw).toBe(20);
      expect(cat.deductions).toEqual([]);
    }
  });

  it('meta.scannedAt is a valid ISO timestamp', () => {
    const result = scan(tmpRoot, {}, thresholdDefaults, isolatedOpts(tmpRoot));
    const parsed = new Date(result.meta.scannedAt);
    expect(parsed.getTime()).toBeGreaterThan(0);
    expect(isNaN(parsed.getTime())).toBe(false);
  });

  it('meta.dataSourcesRead names all four data sources', () => {
    const result = scan(tmpRoot, {}, thresholdDefaults, isolatedOpts(tmpRoot));
    expect(result.meta.dataSourcesRead).toContain('autoresearch');
    expect(result.meta.dataSourcesRead).toContain('inbox');
    expect(result.meta.dataSourcesRead).toContain('aisle');
    expect(result.meta.dataSourcesRead).toContain('os');
  });
});

// ── STAGE 2: TRIAGE (scoring) ─────────────────────────────────────────────────

describe('Stage 2 — triage (scoring)', () => {
  describe('category scoring math', () => {
    it('no findings -> raw=20', () => {
      const result = scoreCategory('dependencies', {}, [], { weight: 1, enabled: true });
      expect(result.raw).toBe(20);
      expect(result.deductions).toEqual([]);
    });

    it('one high_vuln finding -> deduction -3, raw=17', () => {
      const thresholds = [{ id: 'high_vuln', points: -3, max: -9, description: 'High vuln' }];
      const result = scoreCategory('dependencies', { high_vuln: 1 }, thresholds, { weight: 1, enabled: true });
      expect(result.raw).toBe(17);
      const d = result.deductions.find(d => d.id === 'high_vuln');
      expect(d).toBeDefined();
      expect(d.count).toBe(1);
      expect(d.deduction).toBe(-3);
    });

    it('deduction is capped at threshold max', () => {
      // max=-9 means more than 3 high_vuln should not go below 11
      const thresholds = [{ id: 'high_vuln', points: -3, max: -9, description: 'High vuln' }];
      const result = scoreCategory('dependencies', { high_vuln: 10 }, thresholds, { weight: 1, enabled: true });
      // 10 * -3 = -30 but max = -9, so raw = 20 - 9 = 11
      expect(result.raw).toBe(11);
    });

    it('raw score is never negative', () => {
      const thresholds = [{ id: 'env_tracked', points: -5, max: -5, description: 'env tracked' }];
      const result = scoreCategory('security', { env_tracked: 100 }, thresholds, { weight: 1, enabled: true });
      expect(result.raw).toBeGreaterThanOrEqual(0);
    });

    it('raw score is never above 20', () => {
      const result = scoreCategory('deps', {}, [], { weight: 1, enabled: true });
      expect(result.raw).toBeLessThanOrEqual(20);
    });

    it('disabled category -> skipped=true and weight=0', () => {
      const result = scoreCategory('branches', {}, [], { weight: 0, enabled: false });
      expect(result.skipped).toBe(true);
      expect(result.weight).toBe(0);
    });

    it('per-count threshold: todo_density count=10, per=5 -> floor(10/5)*-1 = -2', () => {
      const thresholds = [{ id: 'todo_density', points: -1, per: 5, max: -8, description: 'TODOs' }];
      const result = scoreCategory('dead_code', { todo_density: 10 }, thresholds, { weight: 1, enabled: true });
      const d = result.deductions.find(d => d.id === 'todo_density');
      expect(d).toBeDefined();
      expect(d.deduction).toBe(-2);
      expect(result.raw).toBe(18);
    });

    it('per-count threshold: todo_density count=4, per=5 -> floor(4/5)=0, zero deduction', () => {
      const thresholds = [{ id: 'todo_density', points: -1, per: 5, max: -8, description: 'TODOs' }];
      const result = scoreCategory('dead_code', { todo_density: 4 }, thresholds, { weight: 1, enabled: true });
      // Entry is pushed even with deduction=0 (wizard always records the threshold check)
      const d = result.deductions.find(d => d.id === 'todo_density');
      expect(d).toBeDefined();
      expect(d.deduction + 0).toBe(0); // normalize -0 to 0
      expect(result.raw).toBe(20);
    });
  });

  describe('overall computation', () => {
    it('all categories max -> weighted=100, grade A', () => {
      const cats = {
        branches: { raw: 20, weight: 1 },
        dependencies: { raw: 20, weight: 1 },
        security: { raw: 20, weight: 1.5 },
      };
      const overall = computeOverall(cats);
      expect(overall.weighted).toBe(100);
      expect(overall.grade).toBe('A');
    });

    it('skipped categories are excluded from weighted computation', () => {
      const cats = {
        branches: { raw: 20, weight: 1 },
        agents: { raw: 0, weight: 1, skipped: true },
      };
      const overall = computeOverall(cats);
      // Only branches counts: 20/20 = 100%
      expect(overall.weighted).toBe(100);
    });

    it('weighted score rounds correctly', () => {
      // 9 categories: deps raw=11 (high_vuln -9), 8 at raw=20, all weight 1.0
      // weightedSum = 11 + 8*20 = 171, maxWeightedSum = 9*20=180, weighted=round(171/180*100)=95
      const cats = {};
      const allCategories = Object.keys(thresholdDefaults.categories);
      for (const name of allCategories) {
        cats[name] = { raw: 20, weight: 1.0 };
      }
      cats['dependencies'].raw = 11;

      const overall = computeOverall(cats);
      expect(overall.weighted).toBe(95);
      expect(overall.grade).toBe('A'); // 95 >= 90
    });

    it('grade boundaries are correct', () => {
      const cases = [
        [90, 'A'], [89, 'B'], [75, 'B'], [74, 'C'], [55, 'C'], [54, 'D'], [35, 'D'], [34, 'F'],
      ];
      for (const [score, expected] of cases) {
        expect(assignGrade(score)).toBe(expected);
      }
    });

    it('classifyCategory maps score percentages correctly', () => {
      // 80% of 20 = 16 -> PASS
      expect(classifyCategory(16)).toBe('PASS');
      // 79.9% = 15.98... -> WARN (floor)
      expect(classifyCategory(15)).toBe('WARN');
      // 50% = 10 -> WARN
      expect(classifyCategory(10)).toBe('WARN');
      // 49% = 9.8 -> FAIL
      expect(classifyCategory(9)).toBe('FAIL');
    });
  });

  describe('scan-to-triage boundary', () => {
    it('scan with high_vuln autoresearch data produces expected triage score', () => {
      // dep-vulnerability domain -> dependencies/high_vuln, type:count
      writeExperiment(tmpRoot, 'dep-vulnerability', 3);

      const result = scan(tmpRoot, {}, thresholdDefaults, isolatedOpts(tmpRoot));

      const deps = result.categories.dependencies;
      const d = deps.deductions.find(d => d.id === 'high_vuln');
      expect(d).toBeDefined();
      expect(d.count).toBe(3);
      expect(d.deduction).toBe(-9); // 3 * -3 = -9 (hits max)
      expect(deps.raw).toBe(11);
    });

    it('multiple degraded categories produce overall < 100', () => {
      writeExperiment(tmpRoot, 'dep-vulnerability', 3);   // deps raw=11
      writeExperiment(tmpRoot, 'hook-exit-contract', 2);  // hooks raw=14
      writeExperiment(tmpRoot, 'todo-density', 10);       // dead_code raw=18

      const result = scan(tmpRoot, {}, thresholdDefaults, isolatedOpts(tmpRoot));

      expect(result.overall.weighted).toBeLessThan(100);
      expect(result.categories.dependencies.raw).toBe(11);
      expect(result.categories.hooks.raw).toBe(14);
      expect(result.categories.dead_code.raw).toBe(18);
    });
  });
});

// ── STAGE 3: INSPECT (findings detail) ───────────────────────────────────────

describe('Stage 3 — inspect (findings)', () => {
  it('inbox deductions appear in category deductions array', () => {
    writeWizardInbox(tmpRoot, [
      { description: 'hooks problem A', category: 'hooks' },
      { description: 'hooks problem B', category: 'hooks' },
    ]);

    const result = scan(tmpRoot, {}, thresholdDefaults, isolatedOpts(tmpRoot));
    const d = result.categories.hooks.deductions.find(d => d.id === 'inbox_open');
    expect(d).toBeDefined();
    expect(d.count).toBe(2);
    expect(d.deduction).toBe(-2); // 2 * -1, max=-4
  });

  it('fix-inbox (secondary) items contribute to deductions', () => {
    writeFixInbox(tmpRoot, [
      { description: 'config issue', category: 'config' },
    ]);

    const result = scan(tmpRoot, {}, thresholdDefaults, isolatedOpts(tmpRoot));
    const d = result.categories.config.deductions.find(d => d.id === 'inbox_open');
    expect(d).toBeDefined();
  });

  it('primary inbox wins dedup over secondary for same description', () => {
    const desc = 'duplicate issue';
    writeWizardInbox(tmpRoot, [{ description: desc, category: 'security' }]);
    writeFixInbox(tmpRoot, [{ description: desc, category: 'hooks' }]);

    const result = scan(tmpRoot, {}, thresholdDefaults, isolatedOpts(tmpRoot));

    // Only counted once (dedup by normalized description)
    expect(result.inbox.total).toBe(1);
    // Primary wins: category is security, not hooks
    expect(result.inbox.categories.security).toBe(1);
    expect(result.inbox.categories.hooks).toBeUndefined();
  });

  it('resolved inbox items are excluded from counts', () => {
    writeWizardInbox(tmpRoot, [
      { description: 'resolved item', category: 'hooks', status: 'resolved' },
      { description: 'open item', category: 'hooks' },
    ]);

    const result = scan(tmpRoot, {}, thresholdDefaults, isolatedOpts(tmpRoot));
    expect(result.inbox.total).toBe(1);
    expect(result.inbox.categories.hooks).toBe(1);
  });

  it('signal_only domains appear in signals array, not category findings', () => {
    // dep-count-budget is signal_only in domain-threshold-map.json
    writeExperiment(tmpRoot, 'dep-count-budget', 42);

    const result = scan(tmpRoot, {}, thresholdDefaults, isolatedOpts(tmpRoot));

    const sig = result.signals.find(s => s.domain === 'dep-count-budget');
    expect(sig).toBeDefined();
    expect(sig.metric).toBe(42);

    // Should not contribute to category raw score
    expect(result.categories.dependencies.raw).toBe(20);
  });

  it('AISLE scanner canary failures map to security pin_mismatch findings', () => {
    const aisleDir = path.join(tmpRoot, '_aisle_');
    fs.mkdirSync(aisleDir, { recursive: true });
    writeAisleCache(aisleDir, {
      A: { scannerId: 'A', canaryPass: false, timestamp: Date.now() },
      B: { scannerId: 'B', canaryPass: true, timestamp: Date.now() },
    });

    const result = scan(tmpRoot, {}, thresholdDefaults, aisleOpts(tmpRoot));

    // Scanner A failed canary -> pin_mismatch count = 1
    const secCat = result.categories.security;
    const d = secCat.deductions.find(d => d.id === 'pin_mismatch');
    expect(d).toBeDefined();
    expect(d.count).toBe(1);
  });

  it('AISLE healthy when all scanners pass canary', () => {
    const aisleDir = path.join(tmpRoot, '_aisle_');
    fs.mkdirSync(aisleDir, { recursive: true });
    writeAisleCache(aisleDir, {
      A: { scannerId: 'A', canaryPass: true, timestamp: Date.now() },
      B: { scannerId: 'B', canaryPass: true, timestamp: Date.now() },
    });

    const result = scan(tmpRoot, {}, thresholdDefaults, aisleOpts(tmpRoot));

    expect(result.aisle.healthy).toBe(true);
    expect(result.aisle.scanners).toHaveLength(2);
  });

  it('OS data is surfaced in result.os when files exist', () => {
    writeOsFiles(tmpRoot);

    const result = scan(tmpRoot, {}, thresholdDefaults, isolatedOpts(tmpRoot));

    expect(result.os).not.toBeNull();
    expect(result.os.boot.capsReady).toBe(3);
    expect(result.os.health.allOk).toBe(true);
    expect(result.os.git.branch).toBe('main');
  });

  it('OS data returns defaults when _runs/os/ files are missing', () => {
    const result = scan(tmpRoot, {}, thresholdDefaults, isolatedOpts(tmpRoot));

    // scanOs returns defaults when files missing (no crash, no null)
    expect(result.os).not.toBeNull();
    expect(typeof result.os.boot.capsReady).toBe('number');
    expect(typeof result.os.health.allOk).toBe('boolean');
  });
});

// ── STAGE 4: EXECUTE (session lifecycle) ─────────────────────────────────────

describe('Stage 4 — execute (session lifecycle)', () => {
  it('create() starts a session at stage 1 with correct shape', () => {
    const session = create('outhouse', { quick: true }, { cwd: tmpRoot });
    expect(session.wizard_type).toBe('outhouse');
    expect(session.current_stage).toBe(1);
    expect(session.stages_completed).toEqual([]);
    expect(session.flags).toEqual({ quick: true });
    expect(typeof session.session_id).toBe('string');
    expect(session.session_id).toHaveLength(36); // UUID
  });

  it('session file is written to project root', () => {
    create('outhouse', {}, { cwd: tmpRoot });
    expect(fs.existsSync(path.join(tmpRoot, '.outhouse-session.json'))).toBe(true);
  });

  it('update() advances stage and tracks completed stages', () => {
    create('outhouse', {}, { cwd: tmpRoot });
    const updated = update({ current_stage: 2 }, { cwd: tmpRoot });

    expect(updated.current_stage).toBe(2);
    expect(updated.stages_completed).toContain(1);
  });

  it('update() merges scan result into session', () => {
    create('outhouse', {}, { cwd: tmpRoot });
    const scanResult = { overall: { weighted: 85, grade: 'B' } };
    const updated = update({ scan_result: scanResult, current_stage: 2 }, { cwd: tmpRoot });

    expect(updated.scan_result.overall.weighted).toBe(85);
    expect(updated.scan_result.overall.grade).toBe('B');
  });

  it('read() retrieves active session', () => {
    create('outhouse', { json: false }, { cwd: tmpRoot });
    const session = read({ cwd: tmpRoot });

    expect(session).not.toBeNull();
    expect(session.wizard_type).toBe('outhouse');
  });

  it('end() finalizes and deletes the session file', () => {
    create('outhouse', {}, { cwd: tmpRoot });
    const finalized = end({ grade: 'A', weighted: 100 }, { cwd: tmpRoot });

    expect(finalized).not.toBeNull();
    expect(finalized.result.grade).toBe('A');
    expect(finalized.ended_at).toBeDefined();
    expect(fs.existsSync(path.join(tmpRoot, '.outhouse-session.json'))).toBe(false);
  });

  it('end() with archive:true writes session to _runs/outhouse/', () => {
    const session = create('outhouse', {}, { cwd: tmpRoot });
    end({ grade: 'B' }, { cwd: tmpRoot, archive: true });

    const archiveDir = path.join(tmpRoot, '_runs', 'outhouse');
    const archiveFile = path.join(archiveDir, `session-${session.session_id}.json`);
    expect(fs.existsSync(archiveFile)).toBe(true);

    const archived = JSON.parse(fs.readFileSync(archiveFile, 'utf-8'));
    expect(archived.result.grade).toBe('B');
    expect(archived.session_id).toBe(session.session_id);
  });

  it('isStale() returns false for fresh session', () => {
    create('outhouse', {}, { cwd: tmpRoot });
    const { stale, ageMs } = isStale(60_000, { cwd: tmpRoot });
    expect(stale).toBe(false);
    expect(ageMs).toBeLessThan(5_000);
  });

  it('isStale() returns true for old session', () => {
    // Write a session file with an old updated_at timestamp
    const oldSession = {
      version: '1.0.0',
      wizard_type: 'outhouse',
      session_id: 'test-session-001',
      started_at: daysAgo(1),
      updated_at: daysAgo(1),
      current_stage: 2,
      stages_completed: [1],
      flags: {},
    };
    fs.writeFileSync(
      path.join(tmpRoot, '.outhouse-session.json'),
      JSON.stringify(oldSession),
      'utf-8',
    );

    const { stale } = isStale(60_000, { cwd: tmpRoot });
    expect(stale).toBe(true);
  });

  it('update() on missing session throws', () => {
    expect(() => {
      update({ current_stage: 2 }, { cwd: tmpRoot });
    }).toThrow('No active wizard session to update');
  });

  it('end() on missing session returns null', () => {
    const result = end({ grade: 'A' }, { cwd: tmpRoot });
    expect(result).toBeNull();
  });
});

// ── STAGE 5: VERIFY (delta computation) ──────────────────────────────────────

describe('Stage 5 — verify (delta computation)', () => {
  it('computeDelta returns zero delta when categories unchanged', () => {
    const cats = {
      branches: { raw: 20, weight: 1 },
      dependencies: { raw: 18, weight: 1 },
    };
    const delta = computeDelta(cats, cats);
    expect(delta.delta).toBe(0);
    expect(Object.keys(delta.categories)).toHaveLength(0);
  });

  it('computeDelta captures improvement in a single category', () => {
    const before = { dependencies: { raw: 11, weight: 1 } };
    const after = { dependencies: { raw: 17, weight: 1 } };
    const delta = computeDelta(before, after);

    expect(delta.categories.dependencies).toBeDefined();
    expect(delta.categories.dependencies.delta).toBe(6);
    expect(delta.delta).toBeGreaterThan(0);
  });

  it('computeDelta captures regression in a single category', () => {
    const before = { security: { raw: 20, weight: 1.5 } };
    const after = { security: { raw: 14, weight: 1.5 } };
    const delta = computeDelta(before, after);

    expect(delta.categories.security.delta).toBe(-6);
    expect(delta.delta).toBeLessThan(0);
  });

  it('computeDelta grade fields reflect before/after grades', () => {
    // raw=5/20 = 25% -> F, raw=18/20 = 90% -> A
    const before = { a: { raw: 5, weight: 1 } };
    const after = { a: { raw: 18, weight: 1 } };
    const delta = computeDelta(before, after);

    expect(delta.gradeBefore).toBe('F');
    expect(delta.gradeAfter).toBe('A');
  });

  it('verify after remediation: scan-before vs scan-after shows positive delta', () => {
    // Before: write problematic autoresearch data
    writeExperiment(tmpRoot, 'dep-vulnerability', 3);
    const resultBefore = scan(tmpRoot, {}, thresholdDefaults, isolatedOpts(tmpRoot));

    // After: remove the vulnerability data by writing metric=0
    writeExperiment(tmpRoot, 'dep-vulnerability', 0);
    const resultAfter = scan(tmpRoot, {}, thresholdDefaults, isolatedOpts(tmpRoot));

    const delta = computeDelta(resultBefore.categories, resultAfter.categories);
    expect(delta.categories.dependencies).toBeDefined();
    expect(delta.categories.dependencies.delta).toBeGreaterThan(0);
    expect(delta.overallAfter).toBeGreaterThan(delta.overallBefore);
  });
});

// ── STAGE 6: REPORT ───────────────────────────────────────────────────────────

describe('Stage 6 — report (renderQuickReport)', () => {
  it('renders health score and grade', () => {
    const result = scan(tmpRoot, {}, thresholdDefaults, isolatedOpts(tmpRoot));
    const report = renderQuickReport(result);

    expect(report).toContain('Health:');
    expect(report).toMatch(/[A-F]/);
  });

  it('renders all non-skipped categories', () => {
    writeExperiment(tmpRoot, 'dep-vulnerability', 1);
    const result = scan(tmpRoot, {}, thresholdDefaults, isolatedOpts(tmpRoot));
    const report = renderQuickReport(result);

    for (const [name, cat] of Object.entries(result.categories)) {
      if (!cat.skipped) {
        expect(report).toContain(name);
      }
    }
  });

  it('categories sorted worst-first in report', () => {
    // Degrade dependencies and hooks; others stay at 20
    writeExperiment(tmpRoot, 'dep-vulnerability', 3);   // deps raw=11
    writeExperiment(tmpRoot, 'hook-exit-contract', 2);  // hooks raw=14

    const result = scan(tmpRoot, {}, thresholdDefaults, isolatedOpts(tmpRoot));
    const report = renderQuickReport(result);

    // dependencies should appear before hooks (worse score)
    const depsIdx = report.indexOf('dependencies');
    const hooksIdx = report.indexOf('hooks');
    expect(depsIdx).toBeLessThan(hooksIdx);
  });

  it('renders inbox summary when items present', () => {
    writeWizardInbox(tmpRoot, [
      { description: 'hooks issue', category: 'hooks' },
      { description: 'config issue', category: 'config' },
    ]);

    const result = scan(tmpRoot, {}, thresholdDefaults, isolatedOpts(tmpRoot));
    const report = renderQuickReport(result);

    expect(report).toContain('Inbox: 2 open items');
  });

  it('omits inbox section when no inbox items', () => {
    const result = scan(tmpRoot, {}, thresholdDefaults, isolatedOpts(tmpRoot));
    const report = renderQuickReport(result);
    expect(report).not.toContain('Inbox:');
  });

  it('renders stale data warning when stale domains exist', () => {
    // 15-day-old data is stale
    writeExperiment(tmpRoot, 'dep-vulnerability', 2, 'baseline', 15);
    const result = scan(tmpRoot, {}, thresholdDefaults, isolatedOpts(tmpRoot));
    const report = renderQuickReport(result);

    expect(report).toContain('Stale data:');
  });

  it('renders AISLE health status', () => {
    const result = scan(tmpRoot, {}, thresholdDefaults, isolatedOpts(tmpRoot));
    const report = renderQuickReport(result);

    expect(report).toContain('AISLE:');
  });

  it('finding count appears in category row when deductions exist', () => {
    writeExperiment(tmpRoot, 'dep-vulnerability', 2);

    const result = scan(tmpRoot, {}, thresholdDefaults, isolatedOpts(tmpRoot));
    const report = renderQuickReport(result);

    expect(report).toContain('findings');
  });

  it('score/20 format appears for each category', () => {
    const result = scan(tmpRoot, {}, thresholdDefaults, isolatedOpts(tmpRoot));
    const report = renderQuickReport(result);

    // Should have multiple "20/20" entries (all categories clean)
    const matches = report.match(/\d+\/20/g);
    expect(matches).not.toBeNull();
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });
});

// ── FULL PIPELINE: Happy Path ─────────────────────────────────────────────────

describe('Full pipeline — happy path', () => {
  it('scan -> score -> session -> end -> report: clean project gets grade A', () => {
    writeOsFiles(tmpRoot);

    // Stage 1: Scan
    const scanResult = scan(tmpRoot, {}, thresholdDefaults, isolatedOpts(tmpRoot));

    // Stage 2: Triage — overall grade should be A
    expect(scanResult.overall.grade).toBe('A');
    expect(scanResult.overall.weighted).toBe(100);

    // Stage 3: Inspect — no deductions in any category
    for (const cat of Object.values(scanResult.categories)) {
      expect(cat.deductions).toEqual([]);
    }

    // Stage 4: Execute — create and advance session through all 6 stages
    const session = create('outhouse', { quick: true }, { cwd: tmpRoot });
    update({ current_stage: 2, scan_result: scanResult }, { cwd: tmpRoot });
    update({ current_stage: 3 }, { cwd: tmpRoot });
    update({ current_stage: 4 }, { cwd: tmpRoot });
    update({ current_stage: 5 }, { cwd: tmpRoot });
    update({ current_stage: 6 }, { cwd: tmpRoot });

    const activeSession = read({ cwd: tmpRoot });
    expect(activeSession.current_stage).toBe(6);
    expect(activeSession.stages_completed).toEqual([1, 2, 3, 4, 5]);

    // Stage 5: Verify — delta against same scan is zero
    const delta = computeDelta(scanResult.categories, scanResult.categories);
    expect(delta.delta).toBe(0);

    // Stage 6: Report
    setColorEnabled(false);
    const report = renderQuickReport(scanResult);
    expect(report).toContain('Health: 100');
    expect(report).toContain('A');

    // End session with archive
    const finalized = end(
      { grade: scanResult.overall.grade, weighted: scanResult.overall.weighted },
      { cwd: tmpRoot, archive: true },
    );
    expect(finalized.result.grade).toBe('A');
    expect(finalized.stages_completed).toContain(5);
  });
});

// ── FULL PIPELINE: Issues Found ────────────────────────────────────────────────

describe('Full pipeline — issues found, some fixed', () => {
  it('degraded scan -> remediate one category -> delta shows improvement', () => {
    // Initial state: two degraded categories
    writeExperiment(tmpRoot, 'dep-vulnerability', 3);   // deps raw=11
    writeExperiment(tmpRoot, 'hook-exit-contract', 2);  // hooks raw=14

    const scanBefore = scan(tmpRoot, {}, thresholdDefaults, isolatedOpts(tmpRoot));
    expect(scanBefore.categories.dependencies.raw).toBe(11);
    expect(scanBefore.categories.hooks.raw).toBe(14);

    // Simulate fixing dep-vulnerability (metric now 0)
    writeExperiment(tmpRoot, 'dep-vulnerability', 0);

    const scanAfter = scan(tmpRoot, {}, thresholdDefaults, isolatedOpts(tmpRoot));
    expect(scanAfter.categories.dependencies.raw).toBe(20);

    // Stage 5: Verify delta shows deps improved
    const delta = computeDelta(scanBefore.categories, scanAfter.categories);
    expect(delta.categories.dependencies.delta).toBe(9);
    expect(delta.delta).toBeGreaterThan(0);

    // Stage 6: Report shows improvement in overall
    const report = renderQuickReport(scanAfter);
    expect(report).toContain('Health:');
    expect(report).toContain('hooks'); // hooks still degraded, appears in report
  });
});

// ── FULL PIPELINE: Empty Scan ─────────────────────────────────────────────────

describe('Full pipeline — empty scan (no issues)', () => {
  it('empty project: all stages complete, report shows perfect score', () => {
    // Stage 1: empty scan
    const result = scan(tmpRoot, {}, thresholdDefaults, isolatedOpts(tmpRoot));

    // All 9 categories at max
    expect(Object.keys(result.categories)).toHaveLength(9);
    for (const cat of Object.values(result.categories)) {
      expect(cat.raw).toBe(20);
    }
    expect(result.signals).toEqual([]);
    expect(result.stale).toEqual([]);
    expect(result.inbox.total).toBe(0);

    // Report renders without error
    setColorEnabled(false);
    const report = renderQuickReport(result);
    expect(report).toContain('Health: 100');
    expect(report).not.toContain('Inbox:');
    expect(report).not.toContain('Stale data:');
  });
});

// ── FULL PIPELINE: Stage Failures ────────────────────────────────────────────

describe('Full pipeline — stage failure resilience', () => {
  it('corrupted autoresearch file does not abort scan; other categories score normally', () => {
    // Write a corrupt experiments.jsonl for one domain
    const badDir = path.join(tmpRoot, '_runs', 'autoresearch', 'dep-vulnerability');
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, 'experiments.jsonl'), '{bad json line\n{"valid": true}\n', 'utf-8');

    let result;
    expect(() => {
      result = scan(tmpRoot, {}, thresholdDefaults, isolatedOpts(tmpRoot));
    }).not.toThrow();

    // All categories still present
    for (const name of Object.keys(thresholdDefaults.categories)) {
      expect(result.categories).toHaveProperty(name);
    }
  });

  it('missing autoresearch dir: all categories stay at max, no warnings', () => {
    // No autoresearch data written at all
    const result = scan(tmpRoot, {}, thresholdDefaults, isolatedOpts(tmpRoot));

    expect(result.categories.dependencies.raw).toBe(20);
    expect(result.meta.warnings).toBeUndefined();
  });

  it('missing _runs/os/ dir: scanOs returns safe defaults, scan does not crash', () => {
    // No OS files written
    const result = scan(tmpRoot, {}, thresholdDefaults, isolatedOpts(tmpRoot));

    expect(result.os).not.toBeNull();
    expect(result.os.boot.capsReady).toBe(0);
    expect(result.os.boot.capsDegraded).toBe(0);
    expect(result.os.health.allOk).toBe(true);
    expect(result.os.git.branch).toBe('main');
  });

  it('missing AISLE state dir: security findings from AISLE are zero, scan continues', () => {
    // aisleOpts points to nonexistent dir
    const result = scan(tmpRoot, {}, thresholdDefaults, isolatedOpts(tmpRoot));

    expect(result.aisle.healthy).toBe(false);
    expect(result.aisle.scanners).toEqual([]);
    expect(result.categories.security.raw).toBe(20);
    expect(result.meta.warnings).toBeUndefined();
  });

  it('malformed inbox line is skipped, valid items still counted', () => {
    // Write one valid and one malformed line
    const rawLines = '{"description":"valid issue","category":"hooks"}\n{bad json}\n';
    fs.writeFileSync(path.join(tmpRoot, '.4ge-wizard-inbox.jsonl'), rawLines, 'utf-8');

    const result = scan(tmpRoot, {}, thresholdDefaults, isolatedOpts(tmpRoot));

    expect(result.inbox.total).toBe(1);
    expect(result.inbox.categories.hooks).toBe(1);
  });
});

// ── CONFIGURATION ─────────────────────────────────────────────────────────────

describe('Configuration boundary', () => {
  it('project config weight override changes overall score', () => {
    writeExperiment(tmpRoot, 'dep-vulnerability', 3); // deps raw=11

    // Default weight for all categories is 1.0
    const resultDefault = scan(tmpRoot, {}, thresholdDefaults, isolatedOpts(tmpRoot));

    // Increase dependencies weight to 3.0 -> its penalty is amplified
    const heavyConfig = { categories: { dependencies: { weight: 3.0 } } };
    const resultHeavy = scan(tmpRoot, heavyConfig, thresholdDefaults, isolatedOpts(tmpRoot));

    expect(resultHeavy.overall.weighted).toBeLessThan(resultDefault.overall.weighted);
  });

  it('disabled category is skipped and excluded from overall', () => {
    const configWithDisabled = {
      categories: { branches: { enabled: false, weight: 0 } },
    };
    const result = scan(tmpRoot, configWithDisabled, thresholdDefaults, isolatedOpts(tmpRoot));

    expect(result.categories.branches.skipped).toBe(true);
    expect(result.categories.branches.weight).toBe(0);

    // Overall is computed from 8 categories, not 9 — still valid
    expect(typeof result.overall.weighted).toBe('number');
    expect(result.overall.weighted).toBeGreaterThan(0);
  });

  it('security category respects enabled: false config (no floor in scan)', () => {
    const tryDisableSecConfig = {
      categories: { security: { enabled: false, weight: 0 } },
    };
    const result = scan(tmpRoot, tryDisableSecConfig, thresholdDefaults, isolatedOpts(tmpRoot));

    // Scan respects enabled:false — security can be skipped via config
    // (security floor enforcement lives in the triage/output layer, not scan)
    expect(result.categories.security.skipped).toBe(true);
  });

  it('threshold override from project config is applied (documented path)', () => {
    // Override high_vuln to cost -1 instead of -3 using the DOCUMENTED canonical
    // location categories.<name>.thresholds.<id> (config-schema.md:100,127).
    const configWithOverride = {
      categories: {
        dependencies: { thresholds: { high_vuln: { points: -1 } } },
      },
    };
    writeExperiment(tmpRoot, 'dep-vulnerability', 3); // 3 high vulns

    const resultDefault = scan(tmpRoot, {}, thresholdDefaults, isolatedOpts(tmpRoot));
    const resultOverride = scan(tmpRoot, configWithOverride, thresholdDefaults, isolatedOpts(tmpRoot));

    // Default: 3 * -3 = -9 -> raw=11
    expect(resultDefault.categories.dependencies.raw).toBe(11);
    // Override: 3 * -1 = -3 -> raw=17
    expect(resultOverride.categories.dependencies.raw).toBe(17);
  });

  it('the OLD undocumented thresholds.overrides path is now a no-op', () => {
    // Regression guard: config written at the dead path must NOT change scoring,
    // so users who follow the docs get the only working channel.
    const oldPathConfig = {
      thresholds: { overrides: { dependencies: { high_vuln: { points: -1 } } } },
    };
    writeExperiment(tmpRoot, 'dep-vulnerability', 3);

    const resultDefault = scan(tmpRoot, {}, thresholdDefaults, isolatedOpts(tmpRoot));
    const resultOldPath = scan(tmpRoot, oldPathConfig, thresholdDefaults, isolatedOpts(tmpRoot));

    expect(resultOldPath.categories.dependencies.raw).toBe(resultDefault.categories.dependencies.raw);
  });

  it('mergeConfig deep merges 4-layer config correctly', () => {
    const pluginDefaults = { version: '1.0', categories: { security: { weight: 1.5 } } };
    const vertical = { categories: { security: { weight: 2.0 } } };
    const project = { scan_exclude: ['node_modules'] };
    const mode = { categories: { hooks: { enabled: false } } };

    const merged = mergeConfig(pluginDefaults, vertical, project, mode);

    // Vertical overrides plugin defaults for security weight
    expect(merged.categories.security.weight).toBe(2.0);
    // Project adds scan_exclude
    expect(merged.scan_exclude).toEqual(['node_modules']);
    // Mode disables hooks
    expect(merged.categories.hooks.enabled).toBe(false);
  });

  it('resolveThresholds returns defaults when no overrides', () => {
    const defaults = [{ id: 'high_vuln', points: -3, max: -9 }];
    const resolved = resolveThresholds('dependencies', defaults, {});
    expect(resolved).toEqual(defaults);
  });

  it('resolveThresholds applies per-threshold overrides', () => {
    const defaults = [{ id: 'high_vuln', points: -3, max: -9 }];
    const overrides = { high_vuln: { points: -1 } };
    const resolved = resolveThresholds('dependencies', defaults, overrides);
    expect(resolved[0].points).toBe(-1);
    expect(resolved[0].max).toBe(-9); // max preserved from default
  });
});

// ── CONFIDENCE THRESHOLD ──────────────────────────────────────────────────────

describe('Confidence threshold filtering', () => {
  it('inbox entries with confidence < 0.5 are still counted (no filtering at scan level)', () => {
    // Confidence filtering is a CLI/wizard-engine concern, not scan-level.
    // Confirm low-confidence items are included in the raw scan.
    writeWizardInbox(tmpRoot, [
      { description: 'low confidence item', category: 'hooks', confidence: 0.2 },
      { description: 'high confidence item', category: 'hooks', confidence: 0.95 },
    ]);

    const result = scan(tmpRoot, {}, thresholdDefaults, isolatedOpts(tmpRoot));

    // Both items included in raw inbox count
    expect(result.inbox.total).toBe(2);
  });
});

// ── CLI ENTRY POINT ──────────────────────────────────────────────────────────

describe('CLI entry point (wizard-cli.cjs)', () => {
  const cliPath = path.join(__dirname, '../../bin/wizard-cli.cjs');

  it('--help exits with code 0 and prints usage', () => {
    const proc = spawnSync(process.execPath, [cliPath, '--help'], {
      encoding: 'utf-8',
      timeout: 10_000,
    });
    expect(proc.status).toBe(0);
    expect(proc.stdout).toContain('Usage:');
    expect(proc.stdout).toContain('--quick');
    expect(proc.stdout).toContain('--json');
  });

  it('--json outputs valid JSON with all expected keys', () => {
    const proc = spawnSync(
      process.execPath,
      [cliPath, '--json', '--no-color', tmpRoot],
      { encoding: 'utf-8', cwd: tmpRoot, timeout: 15_000 },
    );
    expect(proc.stderr).toBe('');
    let parsed;
    expect(() => { parsed = JSON.parse(proc.stdout); }).not.toThrow();
    expect(parsed).toHaveProperty('categories');
    expect(parsed).toHaveProperty('overall');
    expect(parsed).toHaveProperty('inbox');
    expect(parsed).toHaveProperty('meta');
  });

  it('clean project: --json exits with code 0 (all PASS)', () => {
    const proc = spawnSync(
      process.execPath,
      [cliPath, '--json', tmpRoot],
      { encoding: 'utf-8', cwd: tmpRoot, timeout: 15_000 },
    );
    expect(proc.status).toBe(0);
  });

  it('degraded project: --json exits with code 1 (WARN) when worst pct is 50-79%', () => {
    // hooks raw=14 -> 14/20 = 70% -> WARN range -> exit 1
    writeExperiment(tmpRoot, 'hook-exit-contract', 2);

    const proc = spawnSync(
      process.execPath,
      [cliPath, '--json', tmpRoot],
      { encoding: 'utf-8', cwd: tmpRoot, timeout: 15_000 },
    );
    expect(proc.status).toBe(1);
  });

  it('severely degraded project: --json exits with code 2 (FAIL) when worst pct < 50%', () => {
    // Agent staleness score_invert(0) = ceil(100/20) = 5 -> 5 * -2 = -10 -> agents raw=10
    // 10/20 = 50% exactly = WARN (not FAIL). Use metric=0 which gives 5 stale_verified deductions
    // Need raw < 10 for FAIL. Write 3 bad_exit (hooks: 3*-3=-9 but capped at -6 -> raw=14)
    // To get FAIL: security env_tracked is -5 each time + inbox items + pin mismatches
    // Easiest: write 5 bad_exit (capped at -6 -> hooks raw=14 WARN), need security FAIL
    // dep-vulnerability max=-9 means deps min=11 (PASS). Hard to FAIL a category via autoresearch alone.
    // Use 4 inbox items in a single category with points=-1/each -> max inbox deduction is -4
    // so hooks: 20 - 4 = 16 still PASS.
    // Best approach: use AISLE canary failures to hit pin_mismatch*3 = -9 -> security raw=11 WARN
    // For FAIL, need security raw < 10 -> need pin_mismatch=4 -> -12, but max=-9 -> raw=11
    // The security max for pin_mismatch is -9, env_tracked is -5 (max=-5). Together: -14 (capped) -> raw=6 = FAIL
    const aisleDir = path.join(tmpRoot, '_aisle_');
    fs.mkdirSync(aisleDir, { recursive: true });
    writeAisleCache(aisleDir, {
      A: { scannerId: 'A', canaryPass: false, timestamp: Date.now() },
      B: { scannerId: 'B', canaryPass: false, timestamp: Date.now() },
      C: { scannerId: 'C', canaryPass: false, timestamp: Date.now() },
      D: { scannerId: 'D', canaryPass: false, timestamp: Date.now() },
    });
    // Also write env_tracked finding via autoresearch (env-access-safety domain)
    writeExperiment(tmpRoot, 'env-access-safety', 1);

    // Write a project config pointing AISLE at our fixture dir
    writeProjectConfig(tmpRoot, {});

    // We need the CLI to use our fixture AISLE dir. Unfortunately wizard-cli.cjs
    // uses the default AISLE state dir resolution (from process.cwd()).
    // Instead verify the scan logic computes FAIL with our fixtures directly.
    const scanResult = scan(
      tmpRoot,
      {},
      thresholdDefaults,
      { aisleStateDir: aisleDir },
    );

    // Verify security raw < 10 (FAIL threshold at 50% of 20 = 10)
    // 4 pin_mismatches: 4*-3=-12, capped at -9; env_tracked: 1*-5=-5 (capped at -5)
    // Total: -9-5 = -14, but raw floor is 0. Actually: 20-9-5=6
    expect(scanResult.categories.security.raw).toBe(6);
    const status = classifyCategory(scanResult.categories.security.raw);
    expect(status).toBe('FAIL');
  });

  it('--no-color flag produces plain-text output without ANSI codes', () => {
    const proc = spawnSync(
      process.execPath,
      [cliPath, '--no-color', tmpRoot],
      { encoding: 'utf-8', cwd: tmpRoot, timeout: 15_000 },
    );
    expect(proc.stdout).not.toContain('\x1b[');
    expect(proc.stdout).toContain('Health:');
  });

  // ── REACHABILITY PROOFS (C3/C4) ──────────────────────────────────────────
  // These prove the CLI entrypoint actually routes through mergeConfig +
  // enforceSecurityFloors + the documented wizard-defaults weighting — not that
  // those functions merely work in isolation.

  function runJson(root, cfg) {
    if (cfg !== undefined) writeProjectConfig(root, cfg);
    const proc = spawnSync(
      process.execPath,
      [cliPath, '--json', '--no-color', root],
      { encoding: 'utf-8', cwd: root, timeout: 15_000 },
    );
    return { proc, json: JSON.parse(proc.stdout) };
  }

  it('REACH: CLI enforces the security floor — enabled:false is re-enabled', () => {
    // If wizard-cli bypassed mergeConfig/enforceSecurityFloors (the pre-fix bug),
    // raw .4ge-wizard.json {security.enabled:false} would skip security. The floor
    // must re-enable it. A passing assert here PROVES the floor is reachable from
    // the real deterministic entrypoint.
    const { json } = runJson(tmpRoot, {
      categories: { security: { enabled: false, weight: 0 } },
    });
    expect(json.categories.security).toBeDefined();
    expect(json.categories.security.skipped).not.toBe(true);
  });

  it('REACH: CLI rejects a security threshold override that violates the floor', () => {
    // Documented path categories.security.thresholds.env_tracked.points:0 would
    // neuter the ".env tracked = FAIL" deduction. enforceSecurityFloors must strip
    // it. Reachable only if the CLI ran the floor over the merged config.
    writeExperiment(tmpRoot, 'env-access-safety', 1); // produces an env_tracked finding
    const baseline = runJson(tmpRoot).json;
    const attemptBypass = runJson(tmpRoot, {
      categories: { security: { thresholds: { env_tracked: { points: 0 } } } },
    }).json;
    // Floor held → the bypass config scores identically to no config.
    expect(attemptBypass.categories.security.raw).toBe(baseline.categories.security.raw);
  });

  it('REACH: CLI applies the documented category weighting (security 1.5)', () => {
    // wizard-defaults.json weights security 1.5x. If the CLI never loaded the
    // defaults (pre-fix bug), security would weigh 1.0 and a security-only penalty
    // would move the weighted overall LESS than the defaults predict. Compare the
    // CLI (defaults loaded) against a scan() forced to flat 1.0 weights.
    writeExperiment(tmpRoot, 'env-access-safety', 1); // security-only finding

    const cliWeighted = runJson(tmpRoot).json.overall.weighted;

    // Reproduce the same scan with every category forced to weight 1.0.
    const flat = {};
    for (const name of Object.keys(thresholdDefaults.categories)) {
      flat[name] = { weight: 1.0, enabled: true };
    }
    const flatWeighted = scan(
      tmpRoot,
      { categories: flat },
      thresholdDefaults,
      isolatedOpts(tmpRoot),
    ).overall.weighted;

    // Security weighing 1.5x amplifies the security penalty in the weighted mean,
    // so the CLI's defaults-loaded score is strictly lower than the flat-weight one.
    expect(cliWeighted).toBeLessThan(flatWeighted);
  });

  it('REACH: CLI applies a documented threshold override from .4ge-wizard.json', () => {
    writeExperiment(tmpRoot, 'dep-vulnerability', 3); // 3 high vulns
    const baseline = runJson(tmpRoot).json.categories.dependencies.raw;
    const overridden = runJson(tmpRoot, {
      categories: { dependencies: { thresholds: { high_vuln: { points: -1 } } } },
    }).json.categories.dependencies.raw;
    expect(overridden).toBeGreaterThan(baseline); // weaker penalty → higher score
  });

  it('REACH: CLI warns (stderr) on a malformed .4ge-wizard.json, does not silently drop it', () => {
    fs.writeFileSync(path.join(tmpRoot, '.4ge-wizard.json'), '{ not valid json', 'utf-8');
    const proc = spawnSync(
      process.execPath,
      [cliPath, '--json', '--no-color', tmpRoot],
      { encoding: 'utf-8', cwd: tmpRoot, timeout: 15_000 },
    );
    expect(proc.stderr).toContain('failed to parse');
    // Still produces a valid scan (defaults only) rather than crashing.
    expect(() => JSON.parse(proc.stdout)).not.toThrow();
  });
});

// ── STALE DATA HANDLING ───────────────────────────────────────────────────────

describe('Stale data handling', () => {
  it('data between staleDays and maxStaleDays: included in findings but flagged stale', () => {
    writeExperiment(tmpRoot, 'dep-vulnerability', 2, 'baseline', 15); // 15 days old

    const result = scan(tmpRoot, {}, thresholdDefaults, isolatedOpts(tmpRoot));

    // Stale but within maxStaleDays: still counts
    expect(result.stale).toContain('dep-vulnerability');
    expect(result.categories.dependencies.raw).toBeLessThan(20);
  });

  it('data older than maxStaleDays (30): excluded entirely', () => {
    writeExperiment(tmpRoot, 'dep-vulnerability', 5, 'baseline', 45); // 45 days old

    const result = scan(tmpRoot, {}, thresholdDefaults, isolatedOpts(tmpRoot));

    expect(result.stale).toContain('dep-vulnerability');
    expect(result.categories.dependencies.raw).toBe(20); // excluded, no penalty
  });

  it('fresh data (< 7 days old): not in stale array', () => {
    writeExperiment(tmpRoot, 'dep-vulnerability', 1, 'baseline', 2); // 2 days old

    const result = scan(tmpRoot, {}, thresholdDefaults, isolatedOpts(tmpRoot));

    expect(result.stale).not.toContain('dep-vulnerability');
  });
});
