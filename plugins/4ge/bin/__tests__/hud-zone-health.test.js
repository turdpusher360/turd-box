import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);
const MODULE_PATH = path.resolve(__dirname, '../hud-zone-health.cjs');
const { buildCapabilities } = _require(path.resolve(__dirname, '../hud-data-loader.cjs'));

function requireFresh() {
  for (const key of Object.keys(_require.cache)) {
    if (key.includes('hud-zone-health') || key.includes('hud-palette') || key.includes('hud-state')) {
      delete _require.cache[key];
    }
  }
  return _require(MODULE_PATH);
}

describe('computeHealthScore', () => {
  it('returns 100 when all caps are ok', () => {
    const { computeHealthScore } = requireFresh();
    const caps = { memory: { ok: true }, git: { ok: true }, aisle: { ok: true } };
    expect(computeHealthScore(caps)).toBe(100);
  });

  it('returns 0 when all caps are down', () => {
    const { computeHealthScore } = requireFresh();
    const caps = { memory: { ok: false }, git: { ok: false } };
    expect(computeHealthScore(caps)).toBe(0);
  });

  it('returns rounded percentage', () => {
    const { computeHealthScore } = requireFresh();
    const caps = { a: { ok: true }, b: { ok: true }, c: { ok: false } };
    expect(computeHealthScore(caps)).toBe(67); // 2/3
  });

  it('returns 0 for empty caps', () => {
    const { computeHealthScore } = requireFresh();
    expect(computeHealthScore({})).toBe(0);
  });
});

describe('gradeForScore', () => {
  it('returns A for >= 90', () => {
    const { gradeForScore } = requireFresh();
    expect(gradeForScore(90)).toBe('A');
    expect(gradeForScore(100)).toBe('A');
  });

  it('returns B for >= 75', () => {
    const { gradeForScore } = requireFresh();
    expect(gradeForScore(75)).toBe('B');
    expect(gradeForScore(89)).toBe('B');
  });

  it('returns C for >= 55', () => {
    const { gradeForScore } = requireFresh();
    expect(gradeForScore(55)).toBe('C');
  });

  it('returns D for >= 35', () => {
    const { gradeForScore } = requireFresh();
    expect(gradeForScore(35)).toBe('D');
  });

  it('returns F for < 35', () => {
    const { gradeForScore } = requireFresh();
    expect(gradeForScore(34)).toBe('F');
    expect(gradeForScore(0)).toBe('F');
  });
});

describe('renderHealthZone', () => {
  it('returns single line in compact mode (rows < 12)', () => {
    const { renderHealthZone } = requireFresh();
    const palette = {
      ok: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m',
      accent: '\x1b[36m', muted: '\x1b[90m', text: '\x1b[37m',
      bg: '\x1b[40m', reset: '\x1b[0m',
    };
    const state = {
      terminal: { cols: 79, rows: 8 },
      os: { capabilities: { memory: { ok: true }, git: { ok: true }, aisle: { ok: false } } },
    };
    const lines = renderHealthZone(state, palette);
    expect(lines).toHaveLength(1);
  });

  it('returns multiple lines in rich mode (rows >= 12)', () => {
    const { renderHealthZone } = requireFresh();
    const palette = {
      ok: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m',
      accent: '\x1b[36m', muted: '\x1b[90m', text: '\x1b[37m',
      bg: '\x1b[40m', reset: '\x1b[0m',
    };
    const state = {
      terminal: { cols: 79, rows: 24 },
      os: { capabilities: { a: { ok: true, init_ms: 50 }, b: { ok: true, init_ms: 0 }, c: { ok: false, init_ms: 0 } }, bootTime: 50 },
    };
    const lines = renderHealthZone(state, palette);
    expect(lines.length).toBeGreaterThan(1);
  });

  it('contains score and grade in compact mode', () => {
    const { renderHealthZone } = requireFresh();
    const { stripAnsi } = _require(path.resolve(__dirname, '../hud-palette.cjs'));
    const palette = {
      ok: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m',
      accent: '\x1b[36m', muted: '\x1b[90m', text: '\x1b[37m',
      bg: '\x1b[40m', reset: '\x1b[0m',
    };
    const state = {
      terminal: { cols: 79, rows: 8 },
      os: { capabilities: { a: { ok: true }, b: { ok: true }, c: { ok: false } } },
    };
    const lines = renderHealthZone(state, palette);
    const text = stripAnsi(lines[0]);
    expect(text).toContain('67');
    expect(text).toContain('C');
    expect(text).toMatch(/[=-]/);
  });

  it('contains marker chars and braille in rich mode', () => {
    const { renderHealthZone } = requireFresh();
    const { stripAnsi } = _require(path.resolve(__dirname, '../hud-palette.cjs'));
    const palette = {
      ok: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m',
      accent: '\x1b[36m', muted: '\x1b[90m', text: '\x1b[37m',
      bg: '\x1b[40m', reset: '\x1b[0m',
    };
    const state = {
      terminal: { cols: 79, rows: 24 },
      os: { capabilities: { a: { ok: true, init_ms: 0 } }, bootTime: 0 },
    };
    const lines = renderHealthZone(state, palette);
    const all = lines.map(l => stripAnsi(l)).join('\\n');
    expect(all).toContain('\u25CF');
    const hasBraille = [...all].some(ch => { const cp = ch.codePointAt(0); return cp >= 0x2800 && cp <= 0x28FF; });
    expect(hasBraille).toBe(true);
  });

  // An empty capability map (no health.json or boot-status.json; the loader
  // calls it 'unknown') still scores 0, but that is not a failed grade. The zone
  // must say "health unknown", never a red "Health: 0 F".
  function expectHealthUnknown(terminal) {
    const { renderHealthZone } = requireFresh();
    const { stripAnsi } = _require(path.resolve(__dirname, '../hud-palette.cjs'));
    const palette = {
      ok: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m',
      accent: '\x1b[36m', muted: '\x1b[90m', text: '\x1b[37m',
      bg: '\x1b[40m', reset: '\x1b[0m',
    };
    const state = { terminal, os: { overallHealth: 'unknown', bootTime: 0, capabilities: {} } };
    for (const lines of [renderHealthZone(state, palette), renderHealthZone(state, palette, { detailed: true })]) {
      const raw = lines.join('\n');
      const text = stripAnsi(raw);
      expect(text).toContain('health unknown');
      expect(raw).toContain(`${palette.warn}health unknown`);
      expect(text).not.toContain('Health:');
      expect(text).not.toMatch(/\b0\s+F\b/);
      expect(raw).not.toContain(palette.error);
    }
  }

  it('renders an empty capability map as health unknown at a wide width', () => {
    expectHealthUnknown({ cols: 120, rows: 40 });
  });

  it('renders an empty capability map as health unknown at a narrow width', () => {
    expectHealthUnknown({ cols: 48, rows: 8 });
  });

  function expectHealthFailed(terminal) {
    const { renderHealthZone } = requireFresh();
    const { stripAnsi } = _require(path.resolve(__dirname, '../hud-palette.cjs'));
    const palette = {
      ok: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m',
      accent: '\x1b[36m', muted: '\x1b[90m', text: '\x1b[37m',
      bg: '\x1b[40m', reset: '\x1b[0m',
    };
    const state = { terminal, os: { overallHealth: 'failed', bootTime: 0, capabilities: {} } };
    for (const lines of [renderHealthZone(state, palette), renderHealthZone(state, palette, { detailed: true })]) {
      const raw = lines.join('\n');
      const text = stripAnsi(raw);
      expect(text).toContain('health failed');
      expect(raw).toContain(`${palette.error}health failed`);
      expect(text).not.toContain('health unknown');
      expect(text).not.toContain('Health:');
      expect(text).not.toMatch(/\b0\s+F\b/);
    }
  }

  it('renders an empty failed boot as health failed at a wide width', () => {
    expectHealthFailed({ cols: 120, rows: 40 });
  });

  it('renders an empty failed boot as health failed at a narrow width', () => {
    expectHealthFailed({ cols: 48, rows: 8 });
  });

  it('renders a capability without boolean ok as health unknown', () => {
    const { renderHealthZone } = requireFresh();
    const { stripAnsi } = _require(path.resolve(__dirname, '../hud-palette.cjs'));
    const palette = {
      ok: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m',
      accent: '\x1b[36m', muted: '\x1b[90m', text: '\x1b[37m',
      bg: '\x1b[40m', reset: '\x1b[0m',
    };
    const raw = renderHealthZone({
      terminal: { cols: 120, rows: 40 },
      os: { overallHealth: 'degraded', capabilities: { memory: { status: 'degraded' } } },
    }, palette).join('\n');
    const text = stripAnsi(raw);
    expect(text).toContain('health unknown');
    expect(raw).toContain(`${palette.warn}health unknown`);
    expect(text).not.toContain('Health:');
    expect(text).not.toMatch(/\b0\s+F\b/);
  });

  it.each([
    ['wide', { cols: 120, rows: 40 }],
    ['narrow', { cols: 48, rows: 8 }],
  ])('renders a null capability as warning-role health unknown at a %s width', (_label, terminal) => {
    const { renderHealthZone } = requireFresh();
    const { stripAnsi } = _require(path.resolve(__dirname, '../hud-palette.cjs'));
    const palette = {
      ok: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m',
      accent: '\x1b[36m', muted: '\x1b[90m', text: '\x1b[37m',
      bg: '\x1b[40m', reset: '\x1b[0m',
    };
    let raw;

    expect(() => {
      raw = renderHealthZone({
        terminal,
        os: { overallHealth: 'unknown', bootTime: 0, capabilities: { probe: null } },
      }, palette).join('\n');
    }).not.toThrow();

    const text = stripAnsi(raw);
    expect(text).toContain('health unknown');
    expect(raw).toContain(`${palette.warn}health unknown`);
    expect(text).not.toContain('Health:');
  });

  it.each([
    ['wide', { cols: 120, rows: 40 }],
    ['narrow', { cols: 48, rows: 8 }],
  ])('never renders a non-boolean live ok value healthy at a %s width', (_label, terminal) => {
    const { renderHealthZone } = requireFresh();
    const { stripAnsi } = _require(path.resolve(__dirname, '../hud-palette.cjs'));
    const palette = {
      ok: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m',
      accent: '\x1b[36m', muted: '\x1b[90m', text: '\x1b[37m',
      bg: '\x1b[40m', reset: '\x1b[0m',
    };
    const capabilities = buildCapabilities({}, { probe: { ok: 'false' } });
    let raw;

    expect(() => {
      raw = renderHealthZone({
        terminal,
        os: { overallHealth: 'degraded', bootTime: 0, capabilities },
      }, palette).join('\n');
    }).not.toThrow();

    const text = stripAnsi(raw);
    expect(text).toMatch(/Health:\s+0\s+F\b/);
    expect(text).not.toMatch(/Health:\s+100\s+A\b/);
    expect(raw).toContain(palette.error);
  });

  it('renders mixed ready and unknown observations as a warning count', () => {
    const { renderHealthZone } = requireFresh();
    const { stripAnsi } = _require(path.resolve(__dirname, '../hud-palette.cjs'));
    const palette = {
      ok: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m',
      accent: '\x1b[36m', muted: '\x1b[90m', text: '\x1b[37m',
      bg: '\x1b[40m', reset: '\x1b[0m',
    };
    const raw = renderHealthZone({
      terminal: { cols: 120, rows: 40 },
      os: {
        overallHealth: 'degraded',
        capabilities: { git: { ok: true }, memory: { status: 'degraded' } },
      },
    }, palette).join('\n');
    const text = stripAnsi(raw);
    expect(text).toContain('1 ready · 1 unknown');
    expect(raw).toContain(`${palette.warn}1 ready · 1 unknown`);
    expect(text).not.toContain('Health:');
    expect(text).not.toMatch(/\b50\s+[A-F]\b/);
  });
});

describe('ZONE_META', () => {
  it('exports zone metadata', () => {
    const { ZONE_META } = requireFresh();
    expect(ZONE_META.key).toBe('health');
    expect(ZONE_META.priority).toBe(8);
    expect(ZONE_META.minRows).toBe(1);
    expect(ZONE_META.idealRows).toBe(8);
  });
});
