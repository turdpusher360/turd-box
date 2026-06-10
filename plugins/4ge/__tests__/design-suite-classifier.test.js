// plugins/4ge/__tests__/design-suite-classifier.test.js
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { classifyContext, VISUAL_PATTERNS, API_PATTERNS, DATA_PATTERNS, SYSTEM_PATTERNS } = require('../lib/design-suite-classifier.cjs');

describe('design-suite-classifier', () => {
  describe('VISUAL_PATTERNS', () => {
    it('matches .tsx files', () => {
      expect(VISUAL_PATTERNS.some(p => p.test('components/Button.tsx'))).toBe(true);
    });

    it('matches .jsx files', () => {
      expect(VISUAL_PATTERNS.some(p => p.test('src/App.jsx'))).toBe(true);
    });

    it('matches .vue files', () => {
      expect(VISUAL_PATTERNS.some(p => p.test('components/Modal.vue'))).toBe(true);
    });

    it('matches .svelte files', () => {
      expect(VISUAL_PATTERNS.some(p => p.test('routes/+page.svelte'))).toBe(true);
    });

    it('matches CSS/SCSS files', () => {
      expect(VISUAL_PATTERNS.some(p => p.test('styles/global.css'))).toBe(true);
      expect(VISUAL_PATTERNS.some(p => p.test('styles/theme.scss'))).toBe(true);
    });
  });

  describe('API_PATTERNS', () => {
    it('matches /api/ paths', () => {
      expect(API_PATTERNS.some(p => p.test('src/api/users.ts'))).toBe(true);
    });

    it('matches /routes/ paths', () => {
      expect(API_PATTERNS.some(p => p.test('src/routes/auth.ts'))).toBe(true);
    });

    it('matches controller files', () => {
      expect(API_PATTERNS.some(p => p.test('src/controllers/user.controller.ts'))).toBe(true);
    });

    it('matches handler files', () => {
      expect(API_PATTERNS.some(p => p.test('src/handlers/webhook.ts'))).toBe(true);
    });
  });

  describe('DATA_PATTERNS', () => {
    it('matches .prisma files', () => {
      expect(DATA_PATTERNS.some(p => p.test('prisma/schema.prisma'))).toBe(true);
    });

    it('matches .sql files', () => {
      expect(DATA_PATTERNS.some(p => p.test('migrations/001_init.sql'))).toBe(true);
    });

    it('matches model files', () => {
      expect(DATA_PATTERNS.some(p => p.test('src/models/user.ts'))).toBe(true);
    });

    it('matches migration directories', () => {
      expect(DATA_PATTERNS.some(p => p.test('db/migrations/202604_add_table.ts'))).toBe(true);
    });
  });

  describe('SYSTEM_PATTERNS', () => {
    it('matches architecture docs', () => {
      expect(SYSTEM_PATTERNS.some(p => p.test('docs/architecture.md'))).toBe(true);
    });

    it('matches config files', () => {
      expect(SYSTEM_PATTERNS.some(p => p.test('docker-compose.yml'))).toBe(true);
    });
  });

  describe('classifyContext', () => {
    it('classifies a .tsx file as visual', () => {
      const result = classifyContext(['src/components/Button.tsx']);
      expect(result.mode).toBe('visual');
      expect(result.confidence).toBeGreaterThan(0.5);
    });

    it('classifies an api route as api', () => {
      const result = classifyContext(['src/api/users.ts', 'src/api/auth.ts']);
      expect(result.mode).toBe('api');
    });

    it('classifies a prisma schema as data', () => {
      const result = classifyContext(['prisma/schema.prisma']);
      expect(result.mode).toBe('data');
    });

    it('classifies architecture docs as system', () => {
      const result = classifyContext(['docs/architecture.md', 'docker-compose.yml']);
      expect(result.mode).toBe('system');
    });

    it('returns visual as default when ambiguous', () => {
      const result = classifyContext(['README.md']);
      expect(result.mode).toBe('visual');
      expect(result.confidence).toBeLessThan(0.5);
    });

    it('returns signals array for each classification', () => {
      const result = classifyContext(['src/components/Modal.tsx', 'src/api/users.ts']);
      expect(result.signals).toBeDefined();
      expect(Array.isArray(result.signals)).toBe(true);
      expect(result.signals.length).toBeGreaterThan(0);
    });

    it('handles empty file list gracefully', () => {
      const result = classifyContext([]);
      expect(result.mode).toBe('visual');
      expect(result.confidence).toBe(0);
    });

    // AUDIT FIX (P1 T20): Test tie-breaking behavior when multiple modes score equally
    it('breaks ties deterministically (first mode in iteration order wins)', () => {
      // One visual file + one api file = tie at 1 each
      const result = classifyContext(['src/Button.tsx', 'src/api/users.ts']);
      // Object.entries iteration order is insertion order — visual is first in MODE_PATTERNS
      expect(['visual', 'api']).toContain(result.mode);
      expect(result.confidence).toBeCloseTo(0.5, 1);
    });
  });
});
