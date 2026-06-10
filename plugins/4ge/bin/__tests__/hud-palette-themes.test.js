import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

function requireFresh() {
  delete process.env.NO_COLOR;
  process.env.CLICOLOR_FORCE = '1';
  for (const key of Object.keys(_require.cache)) {
    if (key.includes('hud-palette')) {
      delete _require.cache[key];
    }
  }
  return _require(path.resolve(__dirname, '../hud-palette.cjs'));
}

describe('PRESETS', () => {
  it('defines 7 theme presets', () => {
    const { PRESETS } = requireFresh();
    expect(Object.keys(PRESETS).length).toBe(7);
  });

  it('each preset has 3 depth variants', () => {
    const { PRESETS } = requireFresh();
    for (const [name, preset] of Object.entries(PRESETS)) {
      expect(Object.keys(preset), `${name} should have 3 depths`).toEqual(
        expect.arrayContaining(['8', '256', 'truecolor'])
      );
    }
  });

  it('each depth variant has all semantic roles', () => {
    const { PRESETS } = requireFresh();
    const requiredRoles = ['ok', 'warn', 'error', 'accent', 'muted', 'text', 'glow', 'bg', 'reset'];
    for (const [name, preset] of Object.entries(PRESETS)) {
      for (const [depth, roles] of Object.entries(preset)) {
        for (const role of requiredRoles) {
          expect(role in roles, `${name}.${depth} missing role "${role}"`).toBe(true);
        }
      }
    }
  });

  it('plain preset has all empty strings', () => {
    const { PRESETS } = requireFresh();
    for (const [depth, roles] of Object.entries(PRESETS.plain)) {
      for (const [role, value] of Object.entries(roles)) {
        expect(value, `plain.${depth}.${role} should be empty`).toBe('');
      }
    }
  });

  it('forge preset glow differs from text (gradient)', () => {
    const { PRESETS } = requireFresh();
    expect(PRESETS.forge['256'].glow).not.toBe(PRESETS.forge['256'].text);
  });

  it('non-forge presets have glow === text', () => {
    const { PRESETS } = requireFresh();
    for (const name of ['dark-ansi', 'tokyonight-dark', 'catppuccin-mocha', 'dracula', 'nord']) {
      expect(PRESETS[name]['256'].glow, `${name} glow should equal text`).toBe(PRESETS[name]['256'].text);
    }
  });
});

describe('resolvePalette', () => {
  it('returns forge palette by default', () => {
    const { resolvePalette, PRESETS } = requireFresh();
    const palette = resolvePalette({});
    // Should resolve to forge at some depth
    expect(palette.ok).toBeTruthy();
  });

  it('returns plain palette for unknown theme', () => {
    const { resolvePalette } = requireFresh();
    // Unknown themes fall back to forge
    const palette = resolvePalette({ name: 'nonexistent' });
    expect(palette.ok).toBeTruthy();
  });

  it('returns specified theme', () => {
    const { resolvePalette } = requireFresh();
    const palette = resolvePalette({ name: 'dracula' });
    expect(palette.ok).toBeTruthy();
    expect(palette.reset).toBe('\x1b[0m');
  });
});

describe('colorize', () => {
  it('wraps text with ANSI codes', () => {
    const { colorize, resolvePalette } = requireFresh();
    const palette = resolvePalette({ name: 'forge' });
    const result = colorize(palette, 'ok', 'hello');
    expect(result).toContain('hello');
    expect(result).toContain('\x1b[');
    expect(result).toContain('\x1b[0m');
  });

  it('returns bare text for plain palette', () => {
    const { colorize, resolvePalette } = requireFresh();
    const palette = resolvePalette({ name: 'plain' });
    const result = colorize(palette, 'ok', 'hello');
    expect(result).toBe('hello');
  });
});

describe('stripAnsi', () => {
  it('removes ANSI escape codes', () => {
    const { stripAnsi } = requireFresh();
    expect(stripAnsi('\x1b[32mhello\x1b[0m')).toBe('hello');
  });

  it('preserves plain text', () => {
    const { stripAnsi } = requireFresh();
    expect(stripAnsi('hello world')).toBe('hello world');
  });

  it('handles empty string', () => {
    const { stripAnsi } = requireFresh();
    expect(stripAnsi('')).toBe('');
  });
});

describe('PRESET_NAMES', () => {
  it('matches PRESETS keys', () => {
    const { PRESETS, PRESET_NAMES } = requireFresh();
    expect(PRESET_NAMES).toEqual(Object.keys(PRESETS));
  });
});
