// plugins/4ge/__tests__/design-suite-data-system.test.js
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { assembleDataToolkit, assembleSystemToolkit, SCHEMA_DESIGN_RULES, MIGRATION_SAFETY_RULES, SYSTEM_PATTERNS } = require('../lib/design-suite-data-system.cjs');

describe('design-suite-data-system', () => {
  const baseConfig = {
    detected: { language: 'typescript', monorepo: '' },
    design_suite: { enabled: true },
  };

  describe('assembleDataToolkit', () => {
    it('returns toolkit with required sections', () => {
      const tk = assembleDataToolkit(baseConfig);
      expect(tk).toHaveProperty('schema_design');
      expect(tk).toHaveProperty('relationships');
      expect(tk).toHaveProperty('indexing');
      expect(tk).toHaveProperty('migration_safety');
      expect(tk).toHaveProperty('audit_trail');
      expect(tk).toHaveProperty('workflow');
    });

    it('has at least 4 schema design rules', () => {
      expect(SCHEMA_DESIGN_RULES.length).toBeGreaterThanOrEqual(4);
    });

    it('has at least 3 migration safety rules', () => {
      expect(MIGRATION_SAFETY_RULES.length).toBeGreaterThanOrEqual(3);
    });

    it('returns data workflow with 5 steps', () => {
      const tk = assembleDataToolkit(baseConfig);
      expect(tk.workflow).toHaveLength(5);
      expect(tk.workflow[0].name).toBe('Entities');
    });
  });

  describe('assembleSystemToolkit', () => {
    it('returns toolkit with required sections', () => {
      const tk = assembleSystemToolkit(baseConfig);
      expect(tk).toHaveProperty('dependency_analysis');
      expect(tk).toHaveProperty('coupling');
      expect(tk).toHaveProperty('boundaries');
      expect(tk).toHaveProperty('tradeoffs');
      expect(tk).toHaveProperty('workflow');
    });

    it('includes trade-off matrix template', () => {
      const tk = assembleSystemToolkit(baseConfig);
      expect(tk.tradeoffs).toHaveProperty('template');
      expect(tk.tradeoffs.template).toHaveProperty('dimensions');
    });

    it('includes monorepo awareness when detected', () => {
      const config = { ...baseConfig, detected: { ...baseConfig.detected, monorepo: 'turborepo' } };
      const tk = assembleSystemToolkit(config);
      expect(tk.boundaries.monorepo).toBe('turborepo');
      expect(tk.boundaries.monorepo_patterns.length).toBeGreaterThan(0);
    });

    it('omits monorepo patterns when not detected', () => {
      const tk = assembleSystemToolkit(baseConfig);
      expect(tk.boundaries.monorepo).toBe('');
      expect(tk.boundaries.monorepo_patterns).toEqual([]);
    });

    it('returns system workflow with 5 steps', () => {
      const tk = assembleSystemToolkit(baseConfig);
      expect(tk.workflow).toHaveLength(5);
      expect(tk.workflow[0].name).toBe('Dependencies');
    });

    it('includes ADR template in workflow', () => {
      const tk = assembleSystemToolkit(baseConfig);
      const adrStep = tk.workflow.find(s => s.name === 'ADR');
      expect(adrStep).toBeDefined();
    });
  });

  describe('SYSTEM_PATTERNS', () => {
    it('has bounded context patterns', () => {
      expect(SYSTEM_PATTERNS).toHaveProperty('bounded_contexts');
    });

    it('has coupling metrics', () => {
      expect(SYSTEM_PATTERNS).toHaveProperty('coupling_metrics');
    });

    it('has dependency direction rules', () => {
      expect(SYSTEM_PATTERNS).toHaveProperty('dependency_direction');
    });
  });
});
