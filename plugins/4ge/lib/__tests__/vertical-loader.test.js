import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

const {
  loadVertical,
  listVerticals,
  validateVertical,
  getDiscoveryPaths,
  VERTICAL_DIR,
} = require('../../lib/vertical-loader.cjs');

const {
  mergeConfig,
  enforceSecurityFloors,
  deepMerge,
} = require('../../lib/wizard-config.cjs');

const {
  suggestVertical,
  VERTICAL_INDICATORS,
} = require('../../lib/dialect-detector.cjs');

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vertical-test-'));
}

function writeJSON(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
}

// ── vertical-loader ────────────────────────────────────────────────────────

describe('vertical-loader', () => {
  let tmpRoot;
  let pluginRoot;

  beforeEach(() => {
    tmpRoot = makeTmpDir();
    // Simulate plugins/4ge/ under a project root
    pluginRoot = path.join(tmpRoot, 'plugins', '4ge');
    fs.mkdirSync(pluginRoot, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe('VERTICAL_DIR', () => {
    it('exports the verticals directory name', () => {
      expect(VERTICAL_DIR).toBe('verticals');
    });
  });

  describe('getDiscoveryPaths', () => {
    it('returns 3 candidate paths in priority order', () => {
      const paths = getDiscoveryPaths('devops', pluginRoot);
      expect(paths).toHaveLength(3);
      expect(paths[0]).toContain(path.join('plugins', '4ge', 'verticals', 'devops'));
      expect(paths[1]).toContain(path.join('.4ge-verticals', 'devops'));
      expect(paths[2]).toContain(path.join('.4ge', 'verticals', 'devops'));
    });
  });

  describe('loadVertical', () => {
    it('loads from plugin-shipped directory (priority 1)', () => {
      const vertDir = path.join(pluginRoot, 'verticals', 'devops');
      writeJSON(path.join(vertDir, 'defaults.json'), {
        version: '1.0.0',
        name: 'devops',
        description: 'DevOps vertical',
        categories: { dependencies: { weight: 2.0 } },
      });

      const result = loadVertical('devops', pluginRoot);
      expect(result.found).toBe(true);
      expect(result.config.name).toBe('devops');
      expect(result.config.categories.dependencies.weight).toBe(2.0);
      expect(result.error).toBeNull();
    });

    it('loads from project-level directory (priority 2)', () => {
      const projVertDir = path.join(tmpRoot, '.4ge-verticals', 'custom');
      writeJSON(path.join(projVertDir, 'defaults.json'), {
        version: '1.0.0',
        name: 'custom',
        description: 'Custom vertical',
      });

      const result = loadVertical('custom', pluginRoot);
      expect(result.found).toBe(true);
      expect(result.config.name).toBe('custom');
    });

    it('plugin-shipped wins over project-level when both exist', () => {
      // Plugin-shipped
      const pluginVertDir = path.join(pluginRoot, 'verticals', 'devops');
      writeJSON(path.join(pluginVertDir, 'defaults.json'), {
        version: '1.0.0',
        name: 'devops',
        description: 'Plugin version',
      });

      // Project-level
      const projVertDir = path.join(tmpRoot, '.4ge-verticals', 'devops');
      writeJSON(path.join(projVertDir, 'defaults.json'), {
        version: '1.0.0',
        name: 'devops',
        description: 'Project version',
      });

      const result = loadVertical('devops', pluginRoot);
      expect(result.config.description).toBe('Plugin version');
    });

    it('returns error for unknown vertical', () => {
      const result = loadVertical('nonexistent', pluginRoot);
      expect(result.found).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('returns error for empty name', () => {
      const result = loadVertical('', pluginRoot);
      expect(result.found).toBe(false);
      expect(result.error).toBe('Vertical name is required');
    });

    it('returns error for null name', () => {
      const result = loadVertical(null, pluginRoot);
      expect(result.found).toBe(false);
      expect(result.error).toBe('Vertical name is required');
    });

    it('rejects names with path traversal characters', () => {
      const result = loadVertical('../etc', pluginRoot);
      expect(result.found).toBe(false);
      expect(result.error).toContain('Invalid vertical name');
    });

    it('rejects names with special characters', () => {
      const result = loadVertical('dev ops!', pluginRoot);
      expect(result.found).toBe(false);
      expect(result.error).toContain('Invalid vertical name');
    });

    it('allows hyphens and underscores in names', () => {
      const vertDir = path.join(pluginRoot, 'verticals', 'my-vertical_v2');
      writeJSON(path.join(vertDir, 'defaults.json'), {
        version: '1.0.0',
        name: 'my-vertical_v2',
      });

      const result = loadVertical('my-vertical_v2', pluginRoot);
      expect(result.found).toBe(true);
      expect(result.error).toBeNull();
    });

    it('returns error for malformed JSON', () => {
      const vertDir = path.join(pluginRoot, 'verticals', 'broken');
      fs.mkdirSync(vertDir, { recursive: true });
      fs.writeFileSync(path.join(vertDir, 'defaults.json'), '{ not valid json }}}');

      const result = loadVertical('broken', pluginRoot);
      expect(result.found).toBe(true);
      expect(result.config).toBeNull();
      expect(result.error).toContain('Parse error');
    });

    it('returns validation error for config missing required fields', () => {
      const vertDir = path.join(pluginRoot, 'verticals', 'incomplete');
      writeJSON(path.join(vertDir, 'defaults.json'), {
        description: 'Missing version and name',
      });

      const result = loadVertical('incomplete', pluginRoot);
      expect(result.found).toBe(true);
      expect(result.config).toBeNull();
      expect(result.error).toContain('Missing required field');
    });
  });

  describe('listVerticals', () => {
    it('returns empty array when no verticals exist', () => {
      const result = listVerticals(pluginRoot);
      expect(result).toEqual([]);
    });

    it('lists plugin-shipped verticals', () => {
      writeJSON(path.join(pluginRoot, 'verticals', 'devops', 'defaults.json'), {
        version: '1.0.0',
        name: 'devops',
        description: 'DevOps vertical',
      });

      const result = listVerticals(pluginRoot);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('devops');
      expect(result[0].source).toBe('plugin');
      expect(result[0].description).toBe('DevOps vertical');
    });

    it('lists verticals from multiple sources', () => {
      writeJSON(path.join(pluginRoot, 'verticals', 'devops', 'defaults.json'), {
        version: '1.0.0',
        name: 'devops',
        description: 'DevOps',
      });
      writeJSON(path.join(tmpRoot, '.4ge-verticals', 'legal', 'defaults.json'), {
        version: '1.0.0',
        name: 'legal',
        description: 'Legal',
      });

      const result = listVerticals(pluginRoot);
      expect(result).toHaveLength(2);
      const names = result.map(v => v.name);
      expect(names).toContain('devops');
      expect(names).toContain('legal');
    });

    it('deduplicates: plugin-shipped wins over project-level', () => {
      writeJSON(path.join(pluginRoot, 'verticals', 'devops', 'defaults.json'), {
        version: '1.0.0',
        name: 'devops',
        description: 'Plugin DevOps',
      });
      writeJSON(path.join(tmpRoot, '.4ge-verticals', 'devops', 'defaults.json'), {
        version: '1.0.0',
        name: 'devops',
        description: 'Project DevOps',
      });

      const result = listVerticals(pluginRoot);
      expect(result).toHaveLength(1);
      expect(result[0].source).toBe('plugin');
      expect(result[0].description).toBe('Plugin DevOps');
    });

    it('skips directories without defaults.json', () => {
      fs.mkdirSync(path.join(pluginRoot, 'verticals', 'empty-dir'), { recursive: true });
      const result = listVerticals(pluginRoot);
      expect(result).toEqual([]);
    });
  });

  describe('validateVertical', () => {
    it('accepts valid minimal config', () => {
      const result = validateVertical({ version: '1.0.0', name: 'test' });
      expect(result.valid).toBe(true);
      expect(result.error).toBeNull();
    });

    it('accepts config with categories', () => {
      const result = validateVertical({
        version: '1.0.0',
        name: 'devops',
        categories: { dependencies: { weight: 2.0 } },
      });
      expect(result.valid).toBe(true);
    });

    it('rejects null', () => {
      const result = validateVertical(null);
      expect(result.valid).toBe(false);
    });

    it('rejects array', () => {
      const result = validateVertical([]);
      expect(result.valid).toBe(false);
    });

    it('rejects missing version', () => {
      const result = validateVertical({ name: 'test' });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('version');
    });

    it('rejects missing name', () => {
      const result = validateVertical({ version: '1.0.0' });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('name');
    });

    it('rejects wrong type for version', () => {
      const result = validateVertical({ version: 1, name: 'test' });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('version');
    });

    it('rejects non-object category entry', () => {
      const result = validateVertical({
        version: '1.0.0',
        name: 'bad',
        categories: { branches: 'invalid' },
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('branches');
    });

    it('rejects vertical that disables security', () => {
      const result = validateVertical({
        version: '1.0.0',
        name: 'unsafe',
        categories: { security: { enabled: false } },
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('disable');
    });

    it('rejects vertical with security pass_threshold below 30', () => {
      const result = validateVertical({
        version: '1.0.0',
        name: 'unsafe',
        categories: { security: { pass_threshold: 10 } },
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('pass_threshold');
    });

    it('allows vertical with security pass_threshold at 30', () => {
      const result = validateVertical({
        version: '1.0.0',
        name: 'strict',
        categories: { security: { pass_threshold: 30 } },
      });
      expect(result.valid).toBe(true);
    });
  });
});

// ── 4-layer mergeConfig ────────────────────────────────────────────────────

describe('mergeConfig 4-layer', () => {
  const pluginDefaults = {
    categories: {
      dependencies: { weight: 1.2, enabled: true, pass_threshold: 80 },
      security: { weight: 1.5, enabled: true, pass_threshold: 80 },
      dead_code: { weight: 0.8, enabled: true },
    },
    research: { depth: 'standard', sources: ['memory', 'codebase'] },
  };

  it('applies 4-layer precedence: plugin < vertical < project < mode', () => {
    const vertical = { categories: { dependencies: { weight: 2.0 } } };
    const project = { categories: { dependencies: { weight: 1.8 } } };
    const mode = { categories: { dependencies: { weight: 3.0 } } };

    const result = mergeConfig(pluginDefaults, vertical, project, mode);
    expect(result.categories.dependencies.weight).toBe(3.0);
  });

  it('vertical overrides plugin defaults', () => {
    const vertical = { categories: { dependencies: { weight: 2.0 } } };
    const result = mergeConfig(pluginDefaults, vertical, null, null);
    expect(result.categories.dependencies.weight).toBe(2.0);
  });

  it('project overrides vertical', () => {
    const vertical = { categories: { dependencies: { weight: 2.0 } } };
    const project = { categories: { dependencies: { weight: 1.5 } } };
    const result = mergeConfig(pluginDefaults, vertical, project, null);
    expect(result.categories.dependencies.weight).toBe(1.5);
  });

  it('null vertical is transparent (3-layer compat with 4 args)', () => {
    const project = { categories: { dependencies: { weight: 1.8 } } };
    const result = mergeConfig(pluginDefaults, null, project, null);
    expect(result.categories.dependencies.weight).toBe(1.8);
    expect(result.categories.dead_code.weight).toBe(0.8); // unchanged from defaults
  });

  it('backward compat: 3-arg call still works', () => {
    const project = { categories: { dependencies: { weight: 1.8 } } };
    const mode = { research: { depth: 'quick' } };
    const result = mergeConfig(pluginDefaults, project, mode);
    expect(result.categories.dependencies.weight).toBe(1.8);
    expect(result.research.depth).toBe('quick');
  });

  it('security floors enforced after vertical merge', () => {
    const vertical = {
      categories: {
        security: { pass_threshold: 10 },
      },
    };
    const result = mergeConfig(pluginDefaults, vertical, null, null);
    // enforceSecurityFloors raises below-30 to 30
    expect(result.categories.security.pass_threshold).toBe(30);
    expect(result.categories.security.enabled).toBe(true);
  });

  it('vertical adds new research sources, project can override', () => {
    const vertical = { research: { sources: ['memory', 'codebase', 'web', 'osv'] } };
    const project = { research: { sources: ['memory', 'codebase'] } };
    const result = mergeConfig(pluginDefaults, vertical, project, null);
    // Arrays replace (per deepMerge rules), so project wins
    expect(result.research.sources).toEqual(['memory', 'codebase']);
  });

  it('vertical can add scan_exclude entries', () => {
    const vertical = { scan_exclude: ['.terraform/', 'vendor/'] };
    const result = mergeConfig(pluginDefaults, vertical, null, null);
    expect(result.scan_exclude).toEqual(['.terraform/', 'vendor/']);
  });
});

// ── suggestVertical (auto-detect) ──────────────────────────────────────────

describe('suggestVertical', () => {
  let tmpRoot;

  beforeEach(() => {
    tmpRoot = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('suggests devops when Dockerfile exists', () => {
    fs.writeFileSync(path.join(tmpRoot, 'Dockerfile'), 'FROM node:20');
    expect(suggestVertical(tmpRoot)).toBe('devops');
  });

  it('suggests devops when docker-compose.yml exists', () => {
    fs.writeFileSync(path.join(tmpRoot, 'docker-compose.yml'), 'version: "3"');
    expect(suggestVertical(tmpRoot)).toBe('devops');
  });

  it('suggests devops when terraform directory exists', () => {
    fs.mkdirSync(path.join(tmpRoot, 'terraform'));
    expect(suggestVertical(tmpRoot)).toBe('devops');
  });

  it('suggests devops when .github/workflows exists', () => {
    fs.mkdirSync(path.join(tmpRoot, '.github', 'workflows'), { recursive: true });
    expect(suggestVertical(tmpRoot)).toBe('devops');
  });

  it('suggests datascience when .ipynb file + requirements.txt exist', () => {
    fs.writeFileSync(path.join(tmpRoot, 'analysis.ipynb'), '{}');
    fs.writeFileSync(path.join(tmpRoot, 'requirements.txt'), 'pandas');
    expect(suggestVertical(tmpRoot)).toBe('datascience');
  });

  it('does not suggest datascience for single .ipynb (needs 2 signals)', () => {
    fs.writeFileSync(path.join(tmpRoot, 'notebook.ipynb'), '{}');
    expect(suggestVertical(tmpRoot)).not.toBe('datascience');
  });

  it('suggests legal when LICENSES + compliance exist', () => {
    fs.mkdirSync(path.join(tmpRoot, 'LICENSES'));
    fs.mkdirSync(path.join(tmpRoot, 'compliance'));
    expect(suggestVertical(tmpRoot)).toBe('legal');
  });

  it('returns null when no signals match', () => {
    expect(suggestVertical(tmpRoot)).toBeNull();
  });

  it('devops takes priority over datascience when both match', () => {
    // devops needs only 1 signal
    fs.writeFileSync(path.join(tmpRoot, 'Dockerfile'), 'FROM python:3');
    // datascience needs 2
    fs.writeFileSync(path.join(tmpRoot, 'model.ipynb'), '{}');
    fs.writeFileSync(path.join(tmpRoot, 'requirements.txt'), 'torch');
    expect(suggestVertical(tmpRoot)).toBe('devops');
  });

  it('VERTICAL_INDICATORS is exported for extension', () => {
    expect(VERTICAL_INDICATORS).toBeDefined();
    expect(VERTICAL_INDICATORS.devops).toBeDefined();
    expect(VERTICAL_INDICATORS.devops.signals.length).toBeGreaterThan(0);
  });
});

// ── Integration: full pipeline with vertical ───────────────────────────────

describe('integration: vertical pipeline', () => {
  let tmpRoot;
  let pluginRoot;

  beforeEach(() => {
    tmpRoot = makeTmpDir();
    pluginRoot = path.join(tmpRoot, 'plugins', '4ge');
    fs.mkdirSync(pluginRoot, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('load vertical -> merge -> security floors intact', () => {
    // Write a vertical
    writeJSON(path.join(pluginRoot, 'verticals', 'devops', 'defaults.json'), {
      version: '1.0.0',
      name: 'devops',
      categories: {
        dependencies: { weight: 2.0 },
        security: { weight: 2.0, pass_threshold: 80 },
      },
    });

    // Load it
    const loaded = loadVertical('devops', pluginRoot);
    expect(loaded.found).toBe(true);

    // Merge with plugin defaults and project config
    const pluginDefaults = {
      categories: {
        dependencies: { weight: 1.2, enabled: true },
        security: { weight: 1.5, enabled: true, pass_threshold: 80 },
      },
    };
    const projectConfig = { categories: { dependencies: { weight: 1.9 } } };

    const result = mergeConfig(pluginDefaults, loaded.config.categories ? loaded.config : null, projectConfig, null);

    // Project weight overrides vertical
    expect(result.categories.dependencies.weight).toBe(1.9);
    // Security floors enforced
    expect(result.categories.security.enabled).toBe(true);
    expect(result.categories.security.pass_threshold).toBeGreaterThanOrEqual(30);
  });

  it('detect vertical -> load -> merge end-to-end', () => {
    // Create Dockerfile so suggestVertical returns 'devops'
    fs.writeFileSync(path.join(tmpRoot, 'Dockerfile'), 'FROM node:20');

    // Ship the vertical
    writeJSON(path.join(pluginRoot, 'verticals', 'devops', 'defaults.json'), {
      version: '1.0.0',
      name: 'devops',
      categories: { dependencies: { weight: 2.0 } },
    });

    // Detect
    const suggestion = suggestVertical(tmpRoot);
    expect(suggestion).toBe('devops');

    // Load
    const loaded = loadVertical(suggestion, pluginRoot);
    expect(loaded.found).toBe(true);

    // Merge
    const pluginDefaults = {
      categories: {
        dependencies: { weight: 1.2, enabled: true },
        security: { weight: 1.5, enabled: true },
      },
    };
    const result = mergeConfig(pluginDefaults, loaded.config, {}, null);
    expect(result.categories.dependencies.weight).toBe(2.0);
  });
});
