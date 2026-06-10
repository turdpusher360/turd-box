/**
 * T5.6 — Expression palette verification across all themes.
 *
 * Parametric test: for each theme preset, render every expression via
 * buildExpression() and verify:
 * 1. Non-plain themes produce ANSI escape codes
 * 2. Plain theme produces zero ANSI escapes
 * 3. No expression uses hardcoded c256(38) (the pre-fix bright cyan)
 * 4. Every expression returns { left: string[], right: string[] }
 */

import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const savedColorEnv = {
  NO_COLOR: process.env.NO_COLOR,
  CLICOLOR_FORCE: process.env.CLICOLOR_FORCE,
};
delete process.env.NO_COLOR;
process.env.CLICOLOR_FORCE = '1';

const { buildExpression, EXPRESSIONS } = require('../hud-expressions.cjs');
const { resolvePalette } = require('../hud-palette.cjs');

afterAll(() => {
  if (savedColorEnv.NO_COLOR === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = savedColorEnv.NO_COLOR;
  if (savedColorEnv.CLICOLOR_FORCE === undefined) delete process.env.CLICOLOR_FORCE;
  else process.env.CLICOLOR_FORCE = savedColorEnv.CLICOLOR_FORCE;
});

// All expression names from the EXPRESSIONS constant
const EXPRESSION_NAMES = Object.keys(EXPRESSIONS);

// All theme presets
const THEMES = ['forge', 'dark-ansi', 'plain', 'tokyonight-dark', 'catppuccin-mocha', 'dracula', 'nord'];

// Hardcoded bright cyan that was the pre-fix bug (c256(38))
const HARDCODED_BRIGHT_CYAN = '\x1b[38;5;38m';

// ANSI escape pattern
const ANSI_RE = /\x1b\[/;

// Helper: build a minimal state that resolves to a given expression name
function stateForExpression(name) {
  // Map expression names to context events that trigger them
  const EVENT_MAP = {
    neutral: null,
    happy: 'test-pass',
    focused: null,       // forge active triggers this
    curious: null,       // 1 degraded cap
    sleepy: 'session-end',
    surprised: 'boot',
    thinking: null,      // 60% context
    determined: 'forge-start',
    winking: 'export',
    excited: 'badge-earned',
    suspicious: null,    // 2 degraded caps
    sad: 'test-fail',
    angry: null,         // 4+ degraded caps
    blinking: 'blink',
    lookLeft: null,
    lookRight: null,
  };

  const base = {
    session: { contextPct: 0, model: 'test' },
    os: { capabilities: {}, overallHealth: 'ready' },
    forge: { active: false },
    context: { event: null },
  };

  const event = EVENT_MAP[name];
  if (event) {
    base.context.event = event;
    return base;
  }

  // State-driven expressions
  switch (name) {
  case 'focused':
    base.forge.active = true;
    base.forge.phase = 'execute';
    return base;
  case 'thinking':
    base.session.contextPct = 65;
    return base;
  case 'curious':
    base.os.capabilities = { a: { ok: false } };
    return base;
  case 'suspicious':
    base.os.capabilities = { a: { ok: false }, b: { ok: false } };
    return base;
  case 'angry':
    base.os.capabilities = { a: { ok: false }, b: { ok: false }, c: { ok: false }, d: { ok: false } };
    return base;
  default:
    // neutral / lookLeft / lookRight — default state
    return base;
  }
}

describe('expression palette theme coverage', () => {
  for (const theme of THEMES) {
    describe(`theme: ${theme}`, () => {
      const palette = resolvePalette({ name: theme });

      for (const exprName of EXPRESSION_NAMES) {
        it(`${exprName} returns valid { left, right } arrays`, () => {
          const state = stateForExpression(exprName);
          const result = buildExpression(state, palette);
          expect(result).toBeDefined();
          expect(Array.isArray(result.left)).toBe(true);
          expect(Array.isArray(result.right)).toBe(true);
          expect(result.left.length).toBeGreaterThan(0);
          expect(result.right.length).toBeGreaterThan(0);
        });

        if (theme !== 'plain') {
          it(`${exprName} produces ANSI escapes on ${theme}`, () => {
            const state = stateForExpression(exprName);
            const result = buildExpression(state, palette);
            const allText = [...result.left, ...result.right].join('');
            expect(ANSI_RE.test(allText)).toBe(true);
          });
        }

        if (theme === 'plain') {
          it(`${exprName} produces NO ANSI escapes on plain`, () => {
            const state = stateForExpression(exprName);
            const result = buildExpression(state, palette);
            const allText = [...result.left, ...result.right].join('');
            expect(ANSI_RE.test(allText)).toBe(false);
          });
        }

        it(`${exprName} does not use hardcoded bright cyan (c256(38))`, () => {
          const state = stateForExpression(exprName);
          const result = buildExpression(state, palette);
          const allText = [...result.left, ...result.right].join('');
          expect(allText).not.toContain(HARDCODED_BRIGHT_CYAN);
        });
      }
    });
  }
});
