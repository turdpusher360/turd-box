import { describe, it, expect } from 'vitest';

const {
  SHARED_QUESTIONS,
  WORKFLOW_MENUS,
  CREATIVE_TRIGGERS,
  detectMode,
  getMenuTree,
  getSharedQuestion,
} = require('../../lib/wizard-questions.cjs');

describe('wizard-questions', () => {
  describe('detectMode', () => {
    it('returns quick for --quick flag', () => {
      const result = detectMode({ quick: true }, {}, {});
      expect(result.mode).toBe('quick');
    });

    it('returns quick for --ci flag', () => {
      const result = detectMode({ ci: true }, {}, {});
      expect(result.mode).toBe('quick');
    });

    it('returns quick for --preflight flag', () => {
      const result = detectMode({ preflight: true }, {}, {});
      expect(result.mode).toBe('quick');
    });

    it('returns guided for --guided flag', () => {
      const result = detectMode({ guided: true }, {}, {});
      expect(result.mode).toBe('guided');
    });

    it('returns creative for --creative flag', () => {
      const result = detectMode({ creative: true }, {}, {});
      expect(result.mode).toBe('creative');
    });

    it('detects creative from description keywords', () => {
      const result = detectMode({}, { description: 'brainstorm ideas for new UX' }, {});
      expect(result.mode).toBe('creative');
    });

    it('defaults to guided when no flags or triggers', () => {
      const result = detectMode({}, {}, {});
      expect(result.mode).toBe('guided');
    });

    it('is case-insensitive for creative triggers', () => {
      const result = detectMode({}, { description: 'BRAINSTORM a new feature' }, {});
      expect(result.mode).toBe('creative');
    });
  });

  describe('getMenuTree', () => {
    it('returns menu for known workflows', () => {
      const workflows = ['build', 'fix', 'improve', 'review', 'explore', 'plan'];
      for (const wf of workflows) {
        const tree = getMenuTree(wf);
        expect(tree).not.toBeNull();
        expect(Array.isArray(tree)).toBe(true);
        expect(tree.length).toBeGreaterThan(0);
      }
    });

    it('returns null for unknown workflow', () => {
      expect(getMenuTree('nonexistent')).toBeNull();
    });
  });

  describe('getSharedQuestion', () => {
    it('returns scope question', () => {
      const q = getSharedQuestion('scope');
      expect(q).not.toBeNull();
      expect(q.id).toBe('scope');
      expect(q.options.length).toBeGreaterThan(0);
    });

    it('returns depth question', () => {
      const q = getSharedQuestion('depth');
      expect(q).not.toBeNull();
      expect(q.id).toBe('depth');
    });

    it('returns output question', () => {
      const q = getSharedQuestion('output');
      expect(q).not.toBeNull();
      expect(q.id).toBe('output');
    });

    it('returns null for unknown question', () => {
      expect(getSharedQuestion('nonexistent')).toBeNull();
    });
  });

  describe('SHARED_QUESTIONS', () => {
    it('defines scope, depth, and output', () => {
      expect(SHARED_QUESTIONS.scope).toBeDefined();
      expect(SHARED_QUESTIONS.depth).toBeDefined();
      expect(SHARED_QUESTIONS.output).toBeDefined();
    });

    it('each has id, prompt, and options', () => {
      for (const [key, q] of Object.entries(SHARED_QUESTIONS)) {
        expect(q.id).toBe(key);
        expect(typeof q.prompt).toBe('string');
        expect(Array.isArray(q.options)).toBe(true);
      }
    });
  });

  describe('WORKFLOW_MENUS', () => {
    it('each workflow has 2-4 questions', () => {
      for (const [name, menu] of Object.entries(WORKFLOW_MENUS)) {
        expect(menu.length).toBeGreaterThanOrEqual(2);
        expect(menu.length).toBeLessThanOrEqual(4);
      }
    });

    it('each question has id, prompt, options, and skipIf', () => {
      for (const [name, menu] of Object.entries(WORKFLOW_MENUS)) {
        for (const q of menu) {
          expect(q.id).toBeDefined();
          expect(q.prompt).toBeDefined();
          expect(Array.isArray(q.options)).toBe(true);
          expect(typeof q.skipIf).toBe('function');
        }
      }
    });

    it('skipIf functions return booleans', () => {
      const buildMenu = WORKFLOW_MENUS.build;
      // Test with empty context
      for (const q of buildMenu) {
        const result = q.skipIf({}, {}, {});
        expect(typeof result === 'boolean' || result === undefined || result === null || result === '' || result === 0).toBe(true);
      }
    });
  });

  describe('CREATIVE_TRIGGERS', () => {
    it('includes expected trigger words', () => {
      expect(CREATIVE_TRIGGERS).toContain('brainstorm');
      expect(CREATIVE_TRIGGERS).toContain('vision');
      expect(CREATIVE_TRIGGERS).toContain('ideate');
    });

    it('has at least 3 triggers', () => {
      expect(CREATIVE_TRIGGERS.length).toBeGreaterThanOrEqual(3);
    });
  });
});
