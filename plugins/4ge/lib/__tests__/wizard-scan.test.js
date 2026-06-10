import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const { scan } = require('../wizard-scan.cjs');

// ---------------------------------------------------------------------------
// Load actual threshold-defaults so tests match production behaviour
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const thresholdDefaultsPath = path.join(
  __dirname,
  '../../skills/wizard-engine/references/threshold-defaults.json',
);
const thresholdDefaults = JSON.parse(fs.readFileSync(thresholdDefaultsPath, 'utf-8'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Timestamp that is `days` ago, ISO string */
function daysAgo(days) {
  return new Date(Date.now() - days * 86400_000).toISOString();
}

/** Write one experiments.jsonl entry (baseline, fresh) */
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
  fs.writeFileSync(path.join(dir, 'experiments.jsonl'), JSON.stringify(entry) + '\n', 'utf-8');
}

/** Write a domain config (used for signal_only label resolution) */
function writeDomainConfig(root, domain, cfg) {
  const dir = path.join(root, 'scripts', 'autoresearch', 'domains');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${domain}.json`), JSON.stringify(cfg), 'utf-8');
}

/** Write wizard inbox items */
function writeWizardInbox(root, items) {
  const lines = items.map(i => JSON.stringify(i)).join('\n') + '\n';
  fs.writeFileSync(path.join(root, '.4ge-wizard-inbox.jsonl'), lines, 'utf-8');
}

/** Write fix inbox items */
function writeFixInbox(root, items) {
  const dir = path.join(root, '_runs');
  fs.mkdirSync(dir, { recursive: true });
  const lines = items.map(i => JSON.stringify(i)).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, '.fix-inbox.jsonl'), lines, 'utf-8');
}

/** Write OS state files */
function writeOsFiles(root) {
  const dir = path.join(root, '_runs', 'os');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'boot-status.json'),
    JSON.stringify({ total_boot_ms: 120, capabilities: { memory: { status: 'ready' }, git: { status: 'ready' } } }),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(dir, 'health.json'),
    JSON.stringify({ memory: { ok: true }, git: { ok: true } }),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(dir, 'git-state.json'),
    JSON.stringify({ branch: 'main', dirty: false, uncommittedFiles: 0, ahead: 0, behind: 0 }),
    'utf-8',
  );
}

/** Minimal wizard config (no overrides) */
const baseConfig = {};

/** Scan opts that isolate AISLE from real state dir */
function scanOpts(root) {
  return { aisleStateDir: path.join(root, '_no_aisle_') };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tmpRoot;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-scan-test-'));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('wizard-scan orchestrator', () => {

  // ── 1. Full orchestration ─────────────────────────────────────────────────
  describe('full orchestration', () => {
    it('returns all top-level ScanResult fields when all readers succeed', () => {
      writeExperiment(tmpRoot, 'dep-vulnerability', 2);
      writeExperiment(tmpRoot, 'dep-staleness', 3);
      writeOsFiles(tmpRoot);

      const result = scan(tmpRoot, baseConfig, thresholdDefaults, scanOpts(tmpRoot));

      // top-level shape
      expect(result).toHaveProperty('categories');
      expect(result).toHaveProperty('overall');
      expect(result).toHaveProperty('signals');
      expect(result).toHaveProperty('stale');
      expect(result).toHaveProperty('inbox');
      expect(result).toHaveProperty('os');
      expect(result).toHaveProperty('aisle');
      expect(result).toHaveProperty('meta');

      // every category in threshold-defaults appears in results
      for (const catName of Object.keys(thresholdDefaults.categories)) {
        expect(result.categories).toHaveProperty(catName);
      }

      // overall has expected fields
      expect(typeof result.overall.weighted).toBe('number');
      expect(typeof result.overall.grade).toBe('string');
      expect(result.overall.grade).toMatch(/^[A-F]$/);

      // meta fields
      expect(result.meta.dataSourcesRead).toContain('autoresearch');
      expect(result.meta.dataSourcesRead).toContain('inbox');
      expect(result.meta.dataSourcesRead).toContain('aisle');
      expect(result.meta.dataSourcesRead).toContain('os');
      expect(typeof result.meta.scannedAt).toBe('string');
    });

    it('os data is populated from _runs/os/ files', () => {
      writeOsFiles(tmpRoot);
      const result = scan(tmpRoot, baseConfig, thresholdDefaults, scanOpts(tmpRoot));
      expect(result.os).not.toBeNull();
      expect(result.os.boot.capsReady).toBe(2);
      expect(result.os.health.allOk).toBe(true);
      expect(result.os.git.branch).toBe('main');
    });
  });

  // ── 2. Inbox deductions applied ───────────────────────────────────────────
  describe('inbox deductions', () => {
    it('open inbox items in hooks category reduce hooks score', () => {
      // Write 3 open hooks items
      writeWizardInbox(tmpRoot, [
        { description: 'hooks issue A', category: 'hooks' },
        { description: 'hooks issue B', category: 'hooks' },
        { description: 'hooks issue C', category: 'hooks' },
      ]);

      const resultWithInbox = scan(tmpRoot, baseConfig, thresholdDefaults, scanOpts(tmpRoot));

      // Baseline scan with no inbox items for comparison
      const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-scan-empty-'));
      const resultNoInbox = scan(emptyRoot, baseConfig, thresholdDefaults);

      const hooksWithInbox = resultWithInbox.categories.hooks;
      const hooksNoInbox = resultNoInbox.categories.hooks;

      // Score with inbox items must be <= score without (deductions applied)
      expect(hooksWithInbox.raw).toBeLessThanOrEqual(hooksNoInbox.raw);

      // Deductions array should include inbox_open
      const inboxDeduction = hooksWithInbox.deductions.find(d => d.id === 'inbox_open');
      expect(inboxDeduction).toBeDefined();
      expect(inboxDeduction.count).toBe(3);
    });

    it('inbox total is reflected in result.inbox.total', () => {
      writeWizardInbox(tmpRoot, [
        { description: 'item 1', category: 'security' },
        { description: 'item 2', category: 'hooks' },
      ]);
      const result = scan(tmpRoot, baseConfig, thresholdDefaults, scanOpts(tmpRoot));
      expect(result.inbox.total).toBe(2);
      expect(result.inbox.categories.security).toBe(1);
      expect(result.inbox.categories.hooks).toBe(1);
    });

    it('inbox item in fix-inbox (secondary) also deducts', () => {
      writeFixInbox(tmpRoot, [
        { description: 'fix inbox item', category: 'config' },
      ]);

      const result = scan(tmpRoot, baseConfig, thresholdDefaults, scanOpts(tmpRoot));
      expect(result.inbox.total).toBe(1);
      const configDeduction = result.categories.config.deductions.find(d => d.id === 'inbox_open');
      expect(configDeduction).toBeDefined();
    });
  });

  // ── 3. Scoring matches manual calculation ─────────────────────────────────
  describe('manual scoring verification', () => {
    it('dependencies category: high_vuln:1 -> deduction -3, raw=17', () => {
      // dep-vulnerability domain maps to dependencies/high_vuln, type:count
      // With metric=1 -> finding count=1 -> deduction = 1 * -3 = -3
      // raw = 20 - 3 = 17
      writeExperiment(tmpRoot, 'dep-vulnerability', 1);

      const result = scan(tmpRoot, baseConfig, thresholdDefaults, scanOpts(tmpRoot));
      const deps = result.categories.dependencies;

      const vulnDeduction = deps.deductions.find(d => d.id === 'high_vuln');
      expect(vulnDeduction).toBeDefined();
      expect(vulnDeduction.count).toBe(1);
      expect(vulnDeduction.deduction).toBe(-3);
      expect(deps.raw).toBe(17);
    });

    it('security category: no AISLE data, no autoresearch security findings -> raw=20', () => {
      // AISLE stateDir from cwd won't exist in tmpRoot -> pin_mismatch=0
      // No autoresearch security domain files written -> gitignore_gap=0, env_tracked=0
      // security raw = 20 - 0 = 20
      const result = scan(tmpRoot, baseConfig, thresholdDefaults, scanOpts(tmpRoot));
      expect(result.categories.security.raw).toBe(20);
      expect(result.categories.security.deductions).toEqual([]);
    });

    it('hooks category: bad_exit:2 -> deduction -6 (capped at max -6), raw=14', () => {
      // hook-exit-contract maps to hooks/bad_exit, type:count
      // metric=2 -> count=2 -> deduction = 2 * -3 = -6 (equals max -6)
      // raw = 20 - 6 = 14
      writeExperiment(tmpRoot, 'hook-exit-contract', 2);

      const result = scan(tmpRoot, baseConfig, thresholdDefaults, scanOpts(tmpRoot));
      const hooks = result.categories.hooks;

      const badExitDeduction = hooks.deductions.find(d => d.id === 'bad_exit');
      expect(badExitDeduction).toBeDefined();
      expect(badExitDeduction.count).toBe(2);
      expect(badExitDeduction.deduction).toBe(-6);
      expect(hooks.raw).toBe(14);
    });

    it('dead_code category: todo_density:10 -> per-5 = 2 steps, deduction -2, raw=18', () => {
      // todo-density maps to dead_code/todo_density, type:count, per:5, points:-1, max:-8
      // metric=10 -> count=10 -> deduction = floor(10/5) * -1 = -2
      // raw = 20 - 2 = 18
      writeExperiment(tmpRoot, 'todo-density', 10);

      const result = scan(tmpRoot, baseConfig, thresholdDefaults, scanOpts(tmpRoot));
      const dc = result.categories.dead_code;

      const todoDeduction = dc.deductions.find(d => d.id === 'todo_density');
      expect(todoDeduction).toBeDefined();
      expect(todoDeduction.deduction).toBe(-2);
      expect(dc.raw).toBe(18);
    });
  });

  // ── 4. Reader failure is graceful ─────────────────────────────────────────
  describe('reader failure graceful degradation', () => {
    it('missing _runs/autoresearch dir does not crash scan', () => {
      // No autoresearch files written at all
      // os files still work
      writeOsFiles(tmpRoot);

      let result;
      expect(() => {
        result = scan(tmpRoot, baseConfig, thresholdDefaults, scanOpts(tmpRoot));
      }).not.toThrow();

      // All categories still present
      for (const catName of Object.keys(thresholdDefaults.categories)) {
        expect(result.categories).toHaveProperty(catName);
      }

      // Autoresearch findings empty means all categories start at max
      expect(result.categories.dependencies.raw).toBe(20);
      expect(result.signals).toEqual([]);
      expect(result.stale).toEqual([]);
    });
  });

  // ── 5. Empty project ──────────────────────────────────────────────────────
  describe('empty project', () => {
    it('returns all categories at max raw score with no crash', () => {
      // tmpRoot is empty - no data files at all
      const result = scan(tmpRoot, baseConfig, thresholdDefaults, scanOpts(tmpRoot));

      // No crash
      expect(result).toBeDefined();
      expect(result.categories).toBeDefined();
      expect(result.overall).toBeDefined();

      // All categories at raw=20 (no deductions)
      for (const [name, cat] of Object.entries(result.categories)) {
        expect(cat.raw).toBe(20, `expected ${name} raw=20 for empty project`);
        expect(cat.deductions).toEqual([]);
      }

      // Overall should be grade A (100%)
      expect(result.overall.weighted).toBe(100);
      expect(result.overall.grade).toBe('A');
    });
  });

  // ── 6. Stale data flagged ─────────────────────────────────────────────────
  describe('stale data flagging', () => {
    it('data older than staleDays (7) appears in stale array', () => {
      // Write dep-vulnerability with 15-day-old data (stale but within maxStaleDays=30)
      writeExperiment(tmpRoot, 'dep-vulnerability', 3, 'baseline', 15);

      const result = scan(tmpRoot, baseConfig, thresholdDefaults, scanOpts(tmpRoot));

      expect(result.stale).toContain('dep-vulnerability');
    });

    it('data older than maxStaleDays (30) is excluded and in stale', () => {
      // 45-day-old data is excluded entirely
      writeExperiment(tmpRoot, 'dep-vulnerability', 5, 'baseline', 45);

      const result = scan(tmpRoot, baseConfig, thresholdDefaults, scanOpts(tmpRoot));

      // Excluded = not included in findings, so dependencies raw should be 20
      expect(result.categories.dependencies.raw).toBe(20);
      expect(result.stale).toContain('dep-vulnerability');
    });

    it('fresh data is not in stale array', () => {
      writeExperiment(tmpRoot, 'dep-vulnerability', 1, 'baseline', 2);
      const result = scan(tmpRoot, baseConfig, thresholdDefaults, scanOpts(tmpRoot));
      expect(result.stale).not.toContain('dep-vulnerability');
    });
  });

  // ── 7. Overall grade correct ──────────────────────────────────────────────
  describe('overall grade assignment', () => {
    it('empty project (all max scores) -> weighted=100, grade A', () => {
      const result = scan(tmpRoot, baseConfig, thresholdDefaults, scanOpts(tmpRoot));
      expect(result.overall.weighted).toBe(100);
      expect(result.overall.grade).toBe('A');
    });

    it('known exact score: deps raw=11 (all others 20, all weights 1.0) -> weighted=95, grade A', () => {
      // dep-vulnerability metric=3 -> high_vuln count=3 -> deduction=3*-3=-9 -> deps raw=11
      // baseConfig has no category weights set, so all weights default to 1.0 in scan()
      // 9 categories, 8 at raw=20, deps at raw=11
      // weightedSum = 11 + 8*20 = 11 + 160 = 171
      // maxWeightedSum = 9 * 20 = 180
      // weighted = round(171/180 * 100) = round(95.0) = 95
      writeExperiment(tmpRoot, 'dep-vulnerability', 3);

      const result = scan(tmpRoot, baseConfig, thresholdDefaults, scanOpts(tmpRoot));

      expect(result.categories.dependencies.raw).toBe(11);
      expect(result.overall.weighted).toBe(95);
      expect(result.overall.grade).toBe('A');
    });

    it('multiple degraded categories -> score < 100 and grade consistent with score', () => {
      // Degrade several categories with real autoresearch findings
      writeExperiment(tmpRoot, 'dep-vulnerability', 3);  // deps raw=11 (high_vuln -9)
      writeExperiment(tmpRoot, 'hook-exit-contract', 2); // hooks raw=14 (bad_exit -6)
      writeExperiment(tmpRoot, 'agent-staleness', 0);    // agents raw=10 (stale_verified score_invert(0)=5 -> -10)
      writeExperiment(tmpRoot, 'todo-density', 50);      // dead_code raw=12 (todo_density -8 max)

      const result = scan(tmpRoot, baseConfig, thresholdDefaults, scanOpts(tmpRoot));

      expect(result.overall.weighted).toBeLessThan(100);

      // Grade must match the weighted score
      const w = result.overall.weighted;
      if (w >= 90) expect(result.overall.grade).toBe('A');
      else if (w >= 75) expect(result.overall.grade).toBe('B');
      else if (w >= 55) expect(result.overall.grade).toBe('C');
      else if (w >= 35) expect(result.overall.grade).toBe('D');
      else expect(result.overall.grade).toBe('F');
    });
  });

  // ── 8. Config weight override respected ──────────────────────────────────
  describe('config weight override', () => {
    it('disabled category has weight=0 and is skipped in overall', () => {
      const configWithDisabled = {
        categories: {
          branches: { enabled: false, weight: 0 },
        },
      };

      const result = scan(tmpRoot, configWithDisabled, thresholdDefaults, scanOpts(tmpRoot));

      expect(result.categories.branches.skipped).toBe(true);
      expect(result.categories.branches.weight).toBe(0);
    });
  });

  // ── 9. AISLE findings merge into security category ────────────────────────
  describe('AISLE findings merged', () => {
    it('when AISLE state dir missing, security findings from AISLE are zero', () => {
      // tmpRoot has no AISLE state, but AISLE stateDir is derived from cwd,
      // so it won't exist in tmpRoot. scanAisle() returns empty findings.
      const result = scan(tmpRoot, baseConfig, thresholdDefaults, scanOpts(tmpRoot));

      // security raw should be 20 (no autoresearch security data written, no AISLE data)
      expect(result.aisle.healthy).toBe(false);
      expect(result.aisle.scanners).toEqual([]);
      expect(result.categories.security.raw).toBe(20);
    });
  });

  // ── 10. Signals passed through ───────────────────────────────────────────
  describe('signal passthrough', () => {
    it('signal_only domains appear in result.signals not in category findings', () => {
      // dep-count-budget is signal_only -> no findings, only signals
      writeExperiment(tmpRoot, 'dep-count-budget', 42);
      writeDomainConfig(tmpRoot, 'dep-count-budget', { name: 'dep-count-budget', metric: { name: 'dep_count' } });

      const result = scan(tmpRoot, baseConfig, thresholdDefaults, scanOpts(tmpRoot));

      const signal = result.signals.find(s => s.domain === 'dep-count-budget');
      expect(signal).toBeDefined();
      expect(signal.metric).toBe(42);

      // Should not appear in any category findings (dependencies raw still 20)
      expect(result.categories.dependencies.raw).toBe(20);
    });
  });

  // ── 11. Meta warnings on reader failure ──────────────────────────────────
  describe('meta warnings', () => {
    it('no warnings key when all readers succeed on empty project', () => {
      const result = scan(tmpRoot, baseConfig, thresholdDefaults, scanOpts(tmpRoot));
      // Empty project = all readers return defaults without throwing
      // (inbox returns empty, autoresearch returns empty findings, aisle returns no-data,
      // os returns defaults). No warnings should be emitted.
      expect(result.meta.warnings).toBeUndefined();
    });
  });
});
