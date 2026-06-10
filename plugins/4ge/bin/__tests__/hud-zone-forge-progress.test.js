import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);
const { renderForgeProgressZone, ZONE_META, forgeProgressVisible, formatElapsed } = _require('../hud-zone-forge-progress.cjs');
const { resolvePalette, stripAnsi } = _require('../hud-palette.cjs');

const palette = resolvePalette({ name: 'plain' });

describe('ZONE_META', () => {
  it('has priority 3', () => {
    expect(ZONE_META.priority).toBe(3);
  });

  it('has key "forgeProgress"', () => {
    expect(ZONE_META.key).toBe('forgeProgress');
  });

  it('has minRows 3 and idealRows 8', () => {
    expect(ZONE_META.minRows).toBe(3);
    expect(ZONE_META.idealRows).toBe(8);
  });
});

describe('forgeProgressVisible', () => {
  it('returns false when forgeProgress is null', () => {
    expect(forgeProgressVisible({ forgeProgress: null })).toBe(false);
  });

  it('returns false when forgeProgress is missing', () => {
    expect(forgeProgressVisible({})).toBe(false);
  });

  it('returns false when waves is empty', () => {
    expect(forgeProgressVisible({ forgeProgress: { waves: [] } })).toBe(false);
  });

  it('returns true when waves has entries', () => {
    expect(forgeProgressVisible({
      forgeProgress: {
        waves: [{ id: 'W1', label: 'Foundation', status: 'shipped' }],
      },
    })).toBe(true);
  });

  it('returns false for non-object forgeProgress', () => {
    expect(forgeProgressVisible({ forgeProgress: 'invalid' })).toBe(false);
  });
});

describe('formatElapsed', () => {
  it('returns empty string for null', () => {
    expect(formatElapsed(null)).toBe('');
  });

  it('returns empty string for invalid date', () => {
    expect(formatElapsed('not-a-date')).toBe('');
  });

  it('formats seconds', () => {
    const recent = new Date(Date.now() - 30000).toISOString();
    const result = formatElapsed(recent);
    expect(result).toMatch(/^\d+s$/);
  });

  it('formats minutes', () => {
    const fiveMinsAgo = new Date(Date.now() - 300000).toISOString();
    const result = formatElapsed(fiveMinsAgo);
    expect(result).toMatch(/^\d+m$/);
  });

  it('formats hours and minutes', () => {
    const twoHoursAgo = new Date(Date.now() - 7500000).toISOString();
    const result = formatElapsed(twoHoursAgo);
    expect(result).toMatch(/^\d+h\d+m$/);
  });
});

describe('renderForgeProgressZone', () => {
  const baseState = {
    terminal: { cols: 79, rows: 24 },
    forgeProgress: {
      session: 'S256',
      task: 'Technical Debt Terraforming',
      startedAt: new Date(Date.now() - 3600000).toISOString(),
      waves: [
        {
          id: 'W1',
          label: 'Foundation',
          status: 'shipped',
          commits: 9,
          packages: ['hud-w4', 'hud-w5', 'audit-tail'],
          agents: [],
        },
        {
          id: 'WB',
          label: 'Engine + Substrate',
          status: 'running',
          commits: 2,
          packages: ['wizard-engine', 'substrate-unlock'],
          agents: [
            { name: 'wb1-wizard', type: 'wizard-expert', status: 'running', startedAt: new Date(Date.now() - 600000).toISOString() },
            { name: 'wb2-substrate', type: 'hud-expert', status: 'running', startedAt: new Date(Date.now() - 300000).toISOString() },
          ],
        },
        {
          id: 'W2',
          label: 'Features',
          status: 'queued',
          commits: 0,
          packages: ['feature-a', 'feature-b'],
          agents: [],
        },
      ],
      totals: { packages: 7, shipped: 3, running: 2, queued: 2 },
    },
  };

  it('returns an array of strings', () => {
    const lines = renderForgeProgressZone(baseState, palette);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(typeof line).toBe('string');
    }
  });

  it('includes session ID in header', () => {
    const lines = renderForgeProgressZone(baseState, palette);
    const plain = lines.map(l => stripAnsi(l)).join(' ');
    expect(plain).toContain('S256');
  });

  it('includes FORGE label in header', () => {
    const lines = renderForgeProgressZone(baseState, palette);
    const plain = lines.map(l => stripAnsi(l)).join(' ');
    expect(plain).toContain('FORGE');
  });

  it('includes task description in header', () => {
    const lines = renderForgeProgressZone(baseState, palette);
    const plain = lines.map(l => stripAnsi(l)).join(' ');
    expect(plain).toContain('Technical Debt Terraforming');
  });

  it('includes elapsed time in header', () => {
    const lines = renderForgeProgressZone(baseState, palette);
    const plain = lines.map(l => stripAnsi(l)).join(' ');
    // Should contain time like "1h0m" or similar
    expect(plain).toMatch(/\d+[hms]/);
  });

  it('renders wave IDs', () => {
    const lines = renderForgeProgressZone(baseState, palette);
    const plain = lines.map(l => stripAnsi(l)).join('\n');
    expect(plain).toContain('W1');
    expect(plain).toContain('WB');
    expect(plain).toContain('W2');
  });

  it('renders wave labels', () => {
    const lines = renderForgeProgressZone(baseState, palette);
    const plain = lines.map(l => stripAnsi(l)).join('\n');
    expect(plain).toContain('Foundation');
    expect(plain).toContain('Engine + Substra'); // 16 char label truncation
  });

  it('shows commit counts', () => {
    const lines = renderForgeProgressZone(baseState, palette);
    const plain = lines.map(l => stripAnsi(l)).join('\n');
    expect(plain).toContain('9c');
    expect(plain).toContain('2c');
    expect(plain).toContain('0c');
  });

  it('shows active agents indented under running waves', () => {
    const lines = renderForgeProgressZone(baseState, palette);
    const plain = lines.map(l => stripAnsi(l)).join('\n');
    expect(plain).toContain('wb1-wizard');
    expect(plain).toContain('wb2-substrate');
  });

  it('does not show agents under shipped waves', () => {
    const lines = renderForgeProgressZone(baseState, palette);
    const plain = lines.map(l => stripAnsi(l)).join('\n');
    // W1 is shipped with no agents, so no agent lines should appear after it
    const w1LineIdx = lines.findIndex(l => stripAnsi(l).includes('W1'));
    if (w1LineIdx >= 0 && w1LineIdx + 1 < lines.length) {
      // Next line should be WB row, not an agent indent
      expect(stripAnsi(lines[w1LineIdx + 1])).not.toMatch(/^\s{4}/);
    }
  });

  it('shows footer with shipped/total and active counts', () => {
    const lines = renderForgeProgressZone(baseState, palette);
    const plain = lines.map(l => stripAnsi(l)).join(' ');
    expect(plain).toContain('3');
    expect(plain).toContain('/');
    expect(plain).toContain('7');
    expect(plain).toContain('shipped');
    expect(plain).toContain('2');
    expect(plain).toContain('active');
  });

  it('returns fallback when no forgeProgress data', () => {
    const state = { terminal: { cols: 79, rows: 24 }, forgeProgress: null };
    const lines = renderForgeProgressZone(state, palette);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const plain = stripAnsi(lines[0]);
    expect(plain).toContain('No forge progress');
  });

  it('handles waves with no packages gracefully', () => {
    const state = {
      terminal: { cols: 79, rows: 24 },
      forgeProgress: {
        session: 'S257',
        waves: [{ id: 'W1', label: 'Empty', status: 'queued', commits: 0, packages: [], agents: [] }],
        totals: { packages: 0, shipped: 0, running: 0, queued: 0 },
      },
    };
    const lines = renderForgeProgressZone(state, palette);
    expect(lines.length).toBeGreaterThan(0);
  });

  it('truncates long task descriptions', () => {
    const state = {
      terminal: { cols: 40, rows: 24 },
      forgeProgress: {
        session: 'S256',
        task: 'A very long task description that would exceed the column width',
        startedAt: new Date().toISOString(),
        waves: [{ id: 'W1', label: 'Test', status: 'shipped', commits: 1, packages: ['a'], agents: [] }],
        totals: { packages: 1, shipped: 1, running: 0, queued: 0 },
      },
    };
    const lines = renderForgeProgressZone(state, palette);
    // Header line should contain truncation marker
    const headerPlain = stripAnsi(lines[0]);
    expect(headerPlain).toContain('\u2026');
  });
});
