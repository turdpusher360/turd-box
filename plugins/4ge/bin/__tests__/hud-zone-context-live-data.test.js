import { describe, it, expect } from 'vitest';
const { renderContextZone } = require('../hud-zone-context.cjs');
const { stripAnsi } = require('../hud-palette.cjs');

function fakePalette() {
  return { text: '', muted: '', ok: '', warn: '', accent: '', error: '', bg: '', reset: '' };
}

describe('hud-zone-context live-data rendering', () => {
  it('appends contextLabel suffix after ctx %', () => {
    const state = {
      session: {
        model: 'claude-opus-4-6',
        contextPct: 12,
        contextLabel: 'est.',
        rateLimits: { fiveHour: 5, sevenDay: 0 },
      },
    };
    const lines = renderContextZone(state, fakePalette());
    expect(stripAnsi(lines[0])).toContain('12% est.');
  });

  it('renders rate: -- when rateLimits is the string sentinel', () => {
    const state = {
      session: {
        model: 'claude-opus-4-6',
        contextPct: 8,
        contextLabel: 'est.',
        rateLimits: 'N/A',
      },
    };
    const lines = renderContextZone(state, fakePalette());
    const text = stripAnsi(lines[0]);
    expect(text).toContain('rate: --');
    expect(text).not.toContain('%  '); // no rate percent bar
  });

  it('renders rate bar when rateLimits is an object', () => {
    const state = {
      session: {
        model: 'claude-sonnet-4-6',
        contextPct: 8,
        contextLabel: '',
        rateLimits: { fiveHour: 33, sevenDay: 10 },
      },
    };
    const lines = renderContextZone(state, fakePalette());
    expect(stripAnsi(lines[0])).toContain('rate: 33%');
  });

  it('omits suffix when contextLabel is empty', () => {
    const state = {
      session: {
        model: 'claude-opus-4-6',
        contextPct: 5,
        contextLabel: '',
        rateLimits: 'N/A',
      },
    };
    const lines = renderContextZone(state, fakePalette());
    expect(stripAnsi(lines[0])).toContain('5%');
    expect(stripAnsi(lines[0])).not.toContain('5% est.');
  });
});
