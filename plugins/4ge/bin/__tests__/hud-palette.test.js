import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);
const MODULE_PATH = path.resolve(__dirname, '../hud-palette.cjs');

// Returns { mod, cleanup } — caller must run cleanup() AFTER assertions
function requireFresh(envOverrides = { NO_COLOR: undefined, CLICOLOR_FORCE: '1' }) {
  const resolved = _require.resolve(MODULE_PATH);
  delete _require.cache[resolved];
  // Save and override env
  const saved = {};
  for (const [k, v] of Object.entries(envOverrides)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const mod = _require(resolved);
  // Return cleanup so env stays overridden during assertions
  const cleanup = () => {
    for (const [k] of Object.entries(envOverrides)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
  return { ...mod, _cleanup: cleanup };
}

describe('detectColorDepth', () => {
  it('returns truecolor when COLORTERM=truecolor', () => {
    const { detectColorDepth, _cleanup } = requireFresh({ COLORTERM: 'truecolor' });
    try { expect(detectColorDepth()).toBe('truecolor'); } finally { _cleanup(); }
  });

  it('returns 256 when COLORTERM=256color', () => {
    const { detectColorDepth, _cleanup } = requireFresh({ COLORTERM: '256color' });
    try { expect(detectColorDepth()).toBe('256'); } finally { _cleanup(); }
  });

  it('returns 256 when TERM includes 256color', () => {
    const { detectColorDepth, _cleanup } = requireFresh({ COLORTERM: undefined, TERM: 'xterm-256color' });
    try { expect(detectColorDepth()).toBe('256'); } finally { _cleanup(); }
  });

  it('returns 8 when no color hints', () => {
    const { detectColorDepth, _cleanup } = requireFresh({ COLORTERM: undefined, TERM: 'xterm' });
    try { expect(detectColorDepth()).toBe('8'); } finally { _cleanup(); }
  });
});

describe('resolvePalette', () => {
  it('returns semantic roles for dark-ansi theme', () => {
    const { resolvePalette } = requireFresh();
    const p = resolvePalette({ name: 'dark-ansi' });
    expect(p).toHaveProperty('ok');
    expect(p).toHaveProperty('warn');
    expect(p).toHaveProperty('error');
    expect(p).toHaveProperty('accent');
    expect(p).toHaveProperty('muted');
    expect(p).toHaveProperty('text');
    expect(p).toHaveProperty('bg');
    expect(p).toHaveProperty('reset');
  });

  it('returns plain palette with no escape codes when theme is plain', () => {
    const { resolvePalette } = requireFresh();
    const p = resolvePalette({ name: 'plain' });
    expect(p.ok).toBe('');
    expect(p.warn).toBe('');
    expect(p.error).toBe('');
    expect(p.accent).toBe('');
    expect(p.muted).toBe('');
    expect(p.text).toBe('');
    expect(p.bg).toBe('');
    expect(p.reset).toBe('');
  });

  it('returns plain palette when NO_COLOR is set', () => {
    const { resolvePalette, isNoColor, _cleanup } = requireFresh({ NO_COLOR: '1', CLICOLOR_FORCE: undefined });
    try {
      expect(isNoColor()).toBe(true);
      const p = resolvePalette({ name: 'dark-ansi' });
      expect(p.ok).toBe('');
    } finally { _cleanup(); }
  });

  it('returns tokyonight-dark palette', () => {
    const { resolvePalette } = requireFresh();
    const p = resolvePalette({ name: 'tokyonight-dark' });
    expect(p.ok).toContain('\x1b[');
    expect(p.accent).toContain('\x1b[');
  });

  it('returns forge palette', () => {
    const { resolvePalette } = requireFresh();
    const p = resolvePalette({ name: 'forge' });
    expect(p.ok).toContain('\x1b[');
    expect(p.accent).toContain('\x1b[');
  });

  it('falls back to forge for unknown theme', () => {
    const { resolvePalette } = requireFresh();
    const p = resolvePalette({ name: 'nonexistent-theme' });
    const d = resolvePalette({ name: 'forge' });
    expect(p.ok).toBe(d.ok);
  });
});

describe('colorize', () => {
  it('wraps text with palette role + reset', () => {
    const { resolvePalette, colorize } = requireFresh();
    const p = resolvePalette({ name: 'dark-ansi' });
    const result = colorize(p, 'ok', 'hello');
    expect(result).toContain('hello');
    expect(result).toContain(p.ok);
    expect(result).toContain(p.reset);
  });

  it('returns bare text for plain palette', () => {
    const { resolvePalette, colorize } = requireFresh();
    const p = resolvePalette({ name: 'plain' });
    const result = colorize(p, 'ok', 'hello');
    expect(result).toBe('hello');
  });
});

describe('stripAnsi', () => {
  it('removes ANSI escape codes', () => {
    const { stripAnsi } = requireFresh();
    expect(stripAnsi('\x1b[32mhello\x1b[0m')).toBe('hello');
  });
});

// --- Forge Theme Vertical Gradient Ladder ---
// Contract: docs/superpowers/specs/2026-04-08-hud-color-vertical-gradient.md
// These assertions pin the 256-color indices of the forge theme so that
// darkest colors sit at the TOP of the HUD panel and lightest at the BOTTOM.
// Any drift here is a regression against the spec — see the spec change log
// before updating these values.
describe('forge theme vertical gradient ladder', () => {
  // Extract the last numeric sequence from an ANSI escape — that is the
  // 256-color index (`\x1b[38;5;N m` or `\x1b[48;5;N m`).
  function extractIndex(code) {
    const matches = code.match(/\d+/g);
    return matches ? matches[matches.length - 1] : null;
  }

  it('forge.bg is c256Bg(234) — dark iron panel background', () => {
    const { PRESETS } = requireFresh();
    expect(extractIndex(PRESETS.forge['256'].bg)).toBe('234');
  });

  it('forge.accent is c256(39) — deep sky blue (TOP anchor, face)', () => {
    const { PRESETS } = requireFresh();
    expect(extractIndex(PRESETS.forge['256'].accent)).toBe('39');
  });

  it('forge.muted is c256(241) — slate chrome', () => {
    const { PRESETS } = requireFresh();
    expect(extractIndex(PRESETS.forge['256'].muted)).toBe('241');
  });

  it('forge.ok is c256(65) — cool sage', () => {
    const { PRESETS } = requireFresh();
    expect(extractIndex(PRESETS.forge['256'].ok)).toBe('65');
  });

  it('forge.warn is c256(172) — warm ember', () => {
    const { PRESETS } = requireFresh();
    expect(extractIndex(PRESETS.forge['256'].warn)).toBe('172');
  });

  it('forge.error is c256(167) — coral rust', () => {
    const { PRESETS } = requireFresh();
    expect(extractIndex(PRESETS.forge['256'].error)).toBe('167');
  });

  it('forge.text is c256(223) — wheat body text', () => {
    const { PRESETS } = requireFresh();
    expect(extractIndex(PRESETS.forge['256'].text)).toBe('223');
  });

  it('forge.glow is c256(230) — hot cream (BOTTOM anchor, session)', () => {
    const { PRESETS } = requireFresh();
    expect(extractIndex(PRESETS.forge['256'].glow)).toBe('230');
  });

  it('resolvePalette(forge) exposes glow as a palette role', () => {
    const { resolvePalette, _cleanup } = requireFresh({ COLORTERM: '256color' });
    try {
      const p = resolvePalette({ name: 'forge' });
      expect(p).toHaveProperty('glow');
      expect(p.glow).toContain('\x1b[');
    } finally { _cleanup(); }
  });

  it('all non-forge 256-color themes also define glow (falls back to text)', () => {
    const { PRESETS } = requireFresh();
    const themesRequiringGlow = ['dark-ansi', 'tokyonight-dark', 'catppuccin-mocha', 'dracula', 'nord'];
    for (const name of themesRequiringGlow) {
      expect(PRESETS[name]['256']).toHaveProperty('glow');
    }
  });

  it('plain theme exposes glow as empty string (NO_COLOR safe)', () => {
    const { PRESETS } = requireFresh();
    expect(PRESETS.plain['256'].glow).toBe('');
    expect(PRESETS.plain['8'].glow).toBe('');
    expect(PRESETS.plain['truecolor'].glow).toBe('');
  });

  it('accent index is DIMMER than glow index — the core anti-inversion check', () => {
    const { PRESETS } = requireFresh();
    const accent = parseInt(extractIndex(PRESETS.forge['256'].accent), 10);
    const glow = parseInt(extractIndex(PRESETS.forge['256'].glow), 10);
    // Numeric index is not a perfect brightness proxy across the 6x6x6 cube,
    // but for these specific picks (24 is a dim blue, 230 is a cream),
    // 24 < 230 IS a valid brightness check.
    expect(accent).toBeLessThan(glow);
  });
});

// C2.2 A2: one display-width measure for statusline row fitting. Exports are
// read inside each test, so a module without them fails per test.
function widthApi() {
  const mod = requireFresh();
  mod._cleanup();
  return mod;
}

// Every ESC in the text must open a complete CSI or OSC sequence.
function hasPartialEscape(text) {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .includes('\x1b');
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('displayWidth (C2.2 A2)', () => {
  it('counts terminal cells, not UTF-16 code units', () => {
    const { displayWidth } = widthApi();
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('\u26A1')).toBe(2);        // ⚡: 1 code unit, 2 cells
    expect(displayWidth('\u4E2D\u6587')).toBe(4);  // 中文
    expect(displayWidth('\u{1F680}')).toBe(2);     // 🚀: surrogate pair, 2 cells
    expect('\u{1D401}'.length).toBe(2);
    expect(displayWidth('\u{1D401}')).toBe(1);     // 𝐁 math bold: surrogate pair, 1 cell
    // Braille blank, ◈, ·, ↻, box drawing: narrow (ambiguous counts 1).
    expect(displayWidth('\u2800\u25C8\u00B7\u21BB\u2500')).toBe(5);
  });

  it('gives CSI and OSC escape sequences zero width', () => {
    const { displayWidth } = widthApi();
    expect(displayWidth('\x1b[1m\x1b[38;5;75mab\x1b[0m')).toBe(2);
    expect(displayWidth('\x1b]8;;https://example.test/caps\x1b\\caps\x1b]8;;\x1b\\')).toBe(4);
    expect(displayWidth('\x1b]8;;https://example.test/caps\x07caps\x1b]8;;\x07')).toBe(4);
    expect(displayWidth('\x1b(Bab')).toBe(2);
  });

  it('gives combining marks, joiners and variation selectors zero width, except VS16 on a narrow glyph', () => {
    const { displayWidth } = widthApi();
    expect(displayWidth('e\u0301')).toBe(1);
    expect(displayWidth('a\u200Db')).toBe(2);
    expect(displayWidth('\u2764\uFE0E')).toBe(1);
    expect(displayWidth('\u26A0')).toBe(1);
    expect(displayWidth('\u26A0\uFE0F')).toBe(2);  // ⚠ emoji presentation
  });
});

describe('fitAnsi (C2.2 A2)', () => {
  it('returns a row that fits unchanged, including an exact fit', () => {
    const { fitAnsi } = widthApi();
    const row = '\x1b[38;5;39mabcde\x1b[0m';
    expect(fitAnsi(row, 5)).toBe(row);
    expect(fitAnsi(row, 9)).toBe(row);
    expect(fitAnsi('\u4E2D\u6587', 4)).toBe('\u4E2D\u6587');
  });

  it('cuts one cell past the boundary to exactly cols, ending in an ellipsis', () => {
    const { fitAnsi, displayWidth } = widthApi();
    const out = fitAnsi('abcdef', 5);
    expect(out).toBe('abcd\u2026');  // plain text: no reset appended
    expect(displayWidth(out)).toBe(5);
  });

  it('keeps escape sequences whole and resets colour after the ellipsis', () => {
    const { fitAnsi, displayWidth } = widthApi();
    const out = fitAnsi('\x1b[1m\x1b[38;5;75mhello world\x1b[0m', 6);
    expect(out).toBe('\x1b[1m\x1b[38;5;75mhello\u2026\x1b[0m');
    expect(displayWidth(out)).toBe(6);
    const between = fitAnsi('ab\x1b[31mcdef\x1b[0m', 3);
    expect(between).toBe('ab\x1b[31m\u2026\x1b[0m');
    expect(hasPartialEscape(between)).toBe(false);
    expect(between.endsWith('\x1b[0m')).toBe(true);
  });

  it('never splits a wide glyph or a surrogate pair at the edge', () => {
    const { fitAnsi, displayWidth } = widthApi();
    expect(fitAnsi('ab\u4E2D\u6587', 4)).toBe('ab\u2026');     // 中 would straddle the edge
    expect(fitAnsi('ab\u26A1cd', 4)).toBe('ab\u2026');         // ⚡ is 1 code unit but 2 cells
    const rockets = fitAnsi('\u{1F680}\u{1F680}\u{1F680}', 5);
    expect(rockets).toBe('\u{1F680}\u{1F680}\u2026');
    expect(displayWidth(rockets)).toBe(5);
    expect(LONE_SURROGATE.test(rockets)).toBe(false);
    const bold = fitAnsi('\u{1D401}'.repeat(6), 4);
    expect(bold).toBe('\u{1D401}'.repeat(3) + '\u2026');
    expect(LONE_SURROGATE.test(bold)).toBe(false);
  });

  it('keeps a combining mark with its base', () => {
    const { fitAnsi, displayWidth } = widthApi();
    const out = fitAnsi('e\u0301'.repeat(4), 3);
    expect(out).toBe('e\u0301e\u0301\u2026');
    expect(displayWidth(out)).toBe(3);
  });

  it('closes an OSC-8 link that is open at the cut', () => {
    const { fitAnsi, displayWidth } = widthApi();
    const out = fitAnsi('\x1b]8;;https://example.test/caps\x1b\\caps-zone-link\x1b]8;;\x1b\\', 6);
    expect(out).toBe('\x1b]8;;https://example.test/caps\x1b\\caps-\u2026\x1b[0m\x1b]8;;\x1b\\');
    expect(displayWidth(out)).toBe(6);
    expect(hasPartialEscape(out)).toBe(false);
  });

  it('returns an empty string for a width below 1', () => {
    const { fitAnsi } = widthApi();
    expect(fitAnsi('abc', 0)).toBe('');
    expect(fitAnsi('abc', -3)).toBe('');
    expect(fitAnsi('abc', Number.NaN)).toBe('');
  });
});
