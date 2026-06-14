import { describe, it, expect } from 'vitest';
const { renderContextZone, renderContextCompact } = require('../hud-zone-context.cjs');
const { stripAnsi } = require('../hud-palette.cjs');

// Palette with no ANSI codes — makes string assertions straightforward.
function plainPalette() {
  return { text: '', muted: '', ok: '', warn: '', accent: '', error: '', bg: '', reset: '' };
}

describe('hud-zone-context FIND-011: N/A sentinel display', () => {
  it('renders "--" (not "N/A") when rateLimits is the string sentinel', () => {
    const state = {
      session: {
        model: 'claude-opus-4-6',
        contextPct: 8,
        contextLabel: 'est.',
        rateLimits: 'N/A',
      },
    };
    const lines = renderContextZone(state, plainPalette());
    const text = stripAnsi(lines[0]);
    expect(text).toContain('rate: --');
    expect(text).not.toContain('rate: N/A');
  });

  it('does not render a rate bar when rateLimits is N/A sentinel', () => {
    const state = {
      session: {
        model: 'claude-opus-4-6',
        contextPct: 5,
        contextLabel: '',
        rateLimits: 'N/A',
      },
    };
    const lines = renderContextZone(state, plainPalette());
    const text = stripAnsi(lines[0]);
    // No percentage sign from a rate bar
    expect(text).not.toMatch(/rate:.*\d+%/);
  });

  it('still renders a rate bar (with %) when rateLimits is a live object', () => {
    const state = {
      session: {
        model: 'claude-sonnet-4-6',
        contextPct: 20,
        contextLabel: '',
        rateLimits: { fiveHour: 45, sevenDay: 12 },
      },
    };
    const lines = renderContextZone(state, plainPalette());
    const text = stripAnsi(lines[0]);
    expect(text).toContain('rate: 45%');
    expect(text).not.toContain('rate: --');
  });

  it('renders context % and label together', () => {
    const state = {
      session: {
        model: 'claude-opus-4-6',
        contextPct: 12,
        contextLabel: 'of 1M',
        rateLimits: { fiveHour: 30, sevenDay: 10 },
      },
    };
    const lines = renderContextZone(state, plainPalette());
    const text = stripAnsi(lines[0]);
    expect(text).toContain('12% of 1M');
  });
});

// W5 T5.4: model-specific coloring in context bar
describe('hud-zone-context model-specific color (W5 T5.4)', () => {
  const { resolveModelColor } = require('../hud-zone-context.cjs');

  it('returns accent for Opus model IDs', () => {
    expect(resolveModelColor('claude-opus-4-6')).toBe('accent');
    expect(resolveModelColor('claude-opus-4-6[1m]')).toBe('accent');
    expect(resolveModelColor('claude-opus-5-0')).toBe('accent');
  });

  it('returns text for Sonnet model IDs', () => {
    expect(resolveModelColor('claude-sonnet-4-6')).toBe('text');
    expect(resolveModelColor('claude-sonnet-5-0')).toBe('text');
  });

  it('returns muted for Haiku model IDs', () => {
    expect(resolveModelColor('claude-haiku-4-5')).toBe('muted');
    expect(resolveModelColor('claude-haiku-5-0')).toBe('muted');
  });

  it('returns text for unknown model', () => {
    expect(resolveModelColor('gpt-4')).toBe('text');
    expect(resolveModelColor('')).toBe('text');
    expect(resolveModelColor(null)).toBe('text');
  });

  it('model name appears in context zone output', () => {
    const state = {
      session: {
        model: 'claude-opus-4-6',
        modelId: 'claude-opus-4-6',
        contextPct: 10,
        rateLimits: 'N/A',
      },
    };
    const lines = renderContextZone(state, plainPalette());
    const text = stripAnsi(lines[0]);
    expect(text).toContain('claude-opus-4-6');
  });
});

describe('hud-zone-context substrate trend activation', () => {
  it('renders a braille context trend when history is present', () => {
    const state = {
      session: {
        model: 'claude-opus-4-6',
        modelId: 'claude-opus-4-6',
        contextPct: 62,
        contextPctHistory: [8, 16, 25, 37, 50, 62],
        rateLimits: 'N/A',
      },
    };

    const lines = renderContextZone(state, plainPalette());
    const text = lines.map((line) => stripAnsi(line)).join('\n');

    expect(text).toContain('ctx trend');
    expect(text).toMatch(/[\u2800-\u28ff]/);
  });

  it('exposes the context trend as an optional compact row', () => {
    const lines = renderContextCompact({
      session: {
        contextPct: 62,
        contextPctHistory: [8, 16, 25, 37, 50, 62],
      },
    }, plainPalette());
    const text = lines.map((line) => stripAnsi(line)).join('\n');

    expect(lines).toHaveLength(1);
    expect(text).toContain('ctx trend');
    expect(text).toMatch(/[\u2800-\u28ff]/);
  });

  it('omits the compact row when context history is absent', () => {
    const lines = renderContextCompact({
      session: {
        contextPct: 12,
      },
    }, plainPalette());

    expect(lines).toEqual([]);
  });
});
