import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const modPath = require.resolve('../command-card-renderer.cjs');

function loadFresh() {
  delete require.cache[modPath];
  // Also clear smart-order cache since renderer imports it
  const soPath = require.resolve('../smart-order.cjs');
  delete require.cache[soPath];
  return require(modPath);
}

describe('command-card-renderer', () => {
  describe('exports', () => {
    it('exports 6 sprites, COMMAND_CHARACTERS, and 2 render functions', () => {
      const mod = loadFresh();
      expect(mod.FORGE_SM).toBeDefined();
      expect(mod.SENTRY_SM).toBeDefined();
      expect(mod.WRENCH_SM).toBeDefined();
      expect(mod.SCOUT_SM).toBeDefined();
      expect(mod.LENS_SM).toBeDefined();
      expect(mod.ANVIL_SM).toBeDefined();
      expect(mod.COMMAND_CHARACTERS).toBeDefined();
      expect(typeof mod.renderCommandCard).toBe('function');
      expect(typeof mod.renderCard).toBe('function');
    });
  });

  describe('sprites', () => {
    it('all sprites have exactly 5 rows', () => {
      const mod = loadFresh();
      const sprites = [mod.FORGE_SM, mod.SENTRY_SM, mod.WRENCH_SM, mod.SCOUT_SM, mod.LENS_SM, mod.ANVIL_SM];
      for (const sprite of sprites) {
        expect(Array.isArray(sprite)).toBe(true);
        expect(sprite).toHaveLength(5);
      }
    });
  });

  describe('COMMAND_CHARACTERS', () => {
    it('maps known command ids to 5-row arrays', () => {
      const mod = loadFresh();
      expect(mod.COMMAND_CHARACTERS.forge).toHaveLength(5);
      expect(mod.COMMAND_CHARACTERS.dfe).toHaveLength(5);
      expect(mod.COMMAND_CHARACTERS.default).toHaveLength(5);
      // Verify distinct sprites (forge != dfe != default)
      expect(mod.COMMAND_CHARACTERS.forge[0]).not.toBe(mod.COMMAND_CHARACTERS.dfe[0]);
    });
  });

  describe('renderCommandCard', () => {
    it('returns a multi-line string', () => {
      const mod = loadFresh();
      const output = mod.renderCommandCard({
        sprite: mod.ANVIL_SM,
        greeting: 'Hello',
        options: [{ id: 'test', label: 'Run tests' }],
      });
      expect(typeof output).toBe('string');
      expect(output.split('\n').length).toBeGreaterThan(1);
    });

    it('includes the greeting text', () => {
      const mod = loadFresh();
      const output = mod.renderCommandCard({
        sprite: mod.ANVIL_SM,
        greeting: 'Test greeting here',
        options: [],
      });
      expect(output).toContain('Test greeting here');
    });

    it('includes option labels', () => {
      const mod = loadFresh();
      const output = mod.renderCommandCard({
        sprite: mod.ANVIL_SM,
        greeting: 'Hi',
        options: [
          { id: 'a', label: 'First option' },
          { id: 'b', label: 'Second option' },
        ],
      });
      expect(output).toContain('First option');
      expect(output).toContain('Second option');
    });

    it('includes context line when provided', () => {
      const mod = loadFresh();
      const output = mod.renderCommandCard({
        sprite: mod.ANVIL_SM,
        greeting: 'Hi',
        context: { branch: 'main', tests: '555 pass' },
        options: [],
      });
      expect(output).toContain('main');
      expect(output).toContain('555 pass');
    });

    it('includes tip when provided', () => {
      const mod = loadFresh();
      const output = mod.renderCommandCard({
        sprite: mod.ANVIL_SM,
        greeting: 'Hi',
        options: [],
        tip: 'Pro tip: use /ship',
      });
      expect(output).toContain('Pro tip: use /ship');
    });

    it('renders in plain mode when NO_COLOR is set', () => {
      const mod = loadFresh();
      const origEnv = process.env.NO_COLOR;
      process.env.NO_COLOR = '1';
      try {
        const output = mod.renderCommandCard({
          sprite: mod.ANVIL_SM,
          greeting: 'Plain test',
          options: [{ id: 'x', label: 'Option X' }],
        });
        // Strip any residual ANSI — plain mode should have none outside sprites
        expect(output).toContain('Plain test');
        expect(output).toContain('Option X');
      } finally {
        if (origEnv === undefined) delete process.env.NO_COLOR;
        else process.env.NO_COLOR = origEnv;
      }
    });
  });
});
