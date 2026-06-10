import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

const PALETTE_PATH = path.resolve(__dirname, '../hud-palette.cjs');

// Load the module fresh (clears require cache + in-memory theme state)
function requireFresh() {
  delete _require.cache[_require.resolve(PALETTE_PATH)];
  return _require(PALETTE_PATH);
}

describe('PRESET_NAMES', () => {
  it('contains all 7 built-in presets', () => {
    const { PRESET_NAMES } = requireFresh();
    expect(PRESET_NAMES).toContain('dark-ansi');
    expect(PRESET_NAMES).toContain('tokyonight-dark');
    expect(PRESET_NAMES).toContain('plain');
    expect(PRESET_NAMES).toContain('catppuccin-mocha');
    expect(PRESET_NAMES).toContain('dracula');
    expect(PRESET_NAMES).toContain('nord');
    expect(PRESET_NAMES).toContain('forge');
    expect(PRESET_NAMES.length).toBe(7);
  });
});

describe('setTheme()', () => {
  afterEach(() => {
    // Remove the theme file after each test to avoid cross-test contamination
    const { THEME_FILE } = requireFresh();
    try { fs.unlinkSync(THEME_FILE); } catch {}
  });

  it('returns true for a valid theme name', () => {
    const { setTheme } = requireFresh();
    expect(setTheme('nord')).toBe(true);
  });

  it('returns false for an invalid theme name', () => {
    const { setTheme } = requireFresh();
    expect(setTheme('nonexistent-theme')).toBe(false);
  });

  it('updates getTheme() in the same module instance', () => {
    const mod = requireFresh();
    expect(mod.setTheme('dracula')).toBe(true);
    expect(mod.getTheme()).toBe('dracula');
  });

  it('writes theme.json to disk with expected shape', () => {
    const mod = requireFresh();
    mod.setTheme('nord');

    expect(fs.existsSync(mod.THEME_FILE)).toBe(true);
    const data = JSON.parse(fs.readFileSync(mod.THEME_FILE, 'utf8'));
    expect(data.theme).toBe('nord');
    expect(typeof data.setAt).toBe('string');
  });

  it('theme.json is valid ISO date string', () => {
    const mod = requireFresh();
    mod.setTheme('catppuccin-mocha');

    const data = JSON.parse(fs.readFileSync(mod.THEME_FILE, 'utf8'));
    expect(() => new Date(data.setAt).toISOString()).not.toThrow();
  });

  it('can be updated from one theme to another', () => {
    const mod = requireFresh();
    mod.setTheme('nord');
    expect(mod.getTheme()).toBe('nord');
    mod.setTheme('dracula');
    expect(mod.getTheme()).toBe('dracula');
  });
});

describe('getTheme()', () => {
  it('returns forge by default when no theme file exists', () => {
    const { THEME_FILE } = requireFresh();
    // Remove any existing theme file so default loads
    try { fs.unlinkSync(THEME_FILE); } catch {}

    const mod = requireFresh();
    expect(mod.getTheme()).toBe('forge');
  });

  it('reads persisted theme from disk on module load', () => {
    const { THEME_FILE } = requireFresh();
    // Write a theme file manually
    const dir = path.dirname(THEME_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(THEME_FILE, JSON.stringify({ theme: 'nord', setAt: new Date().toISOString() }));

    const freshMod = requireFresh();
    expect(freshMod.getTheme()).toBe('nord');

    // cleanup
    try { fs.unlinkSync(THEME_FILE); } catch {}
  });

  it('falls back to forge when theme file has invalid preset name', () => {
    const { THEME_FILE } = requireFresh();
    const dir = path.dirname(THEME_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(THEME_FILE, JSON.stringify({ theme: 'unknown-preset' }));

    const freshMod = requireFresh();
    expect(freshMod.getTheme()).toBe('forge');

    try { fs.unlinkSync(THEME_FILE); } catch {}
  });
});

describe('listThemes()', () => {
  afterEach(() => {
    const { THEME_FILE } = requireFresh();
    try { fs.unlinkSync(THEME_FILE); } catch {}
  });

  it('returns an array of objects with name and current fields', () => {
    const mod = requireFresh();
    const themes = mod.listThemes();
    expect(Array.isArray(themes)).toBe(true);
    expect(themes.length).toBe(7);
    for (const t of themes) {
      expect(typeof t.name).toBe('string');
      expect(typeof t.current).toBe('boolean');
    }
  });

  it('marks only the current theme as current', () => {
    const mod = requireFresh();
    mod.setTheme('dracula');
    const themes = mod.listThemes();
    const current = themes.filter(t => t.current);
    expect(current.length).toBe(1);
    expect(current[0].name).toBe('dracula');
  });

  it('has exactly one current=true entry', () => {
    const mod = requireFresh();
    const themes = mod.listThemes();
    const currentCount = themes.filter(t => t.current).length;
    expect(currentCount).toBe(1);
  });

  it('includes all preset names', () => {
    const mod = requireFresh();
    const names = mod.listThemes().map(t => t.name);
    expect(names).toContain('dark-ansi');
    expect(names).toContain('tokyonight-dark');
    expect(names).toContain('catppuccin-mocha');
    expect(names).toContain('dracula');
    expect(names).toContain('nord');
    expect(names).toContain('plain');
    expect(names).toContain('forge');
  });
});
