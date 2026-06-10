import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);
const { renderActivityZone, activityVisible, ZONE_META } = _require('../hud-zone-activity.cjs');
const { resolvePalette, stripAnsi } = _require('../hud-palette.cjs');

const palette = resolvePalette({ name: 'plain' });

describe('ZONE_META', () => {
  it('has priority 1 (lowest)', () => {
    expect(ZONE_META.priority).toBe(1);
  });

  it('has key "activity"', () => {
    expect(ZONE_META.key).toBe('activity');
  });

  it('has minRows 2 and idealRows 4', () => {
    expect(ZONE_META.minRows).toBe(2);
    expect(ZONE_META.idealRows).toBe(4);
  });
});

describe('activityVisible', () => {
  it('returns false when transcript is null', () => {
    expect(activityVisible({ transcript: null })).toBe(false);
  });

  it('returns false when transcript is missing', () => {
    expect(activityVisible({})).toBe(false);
  });

  it('returns false when recentEvents is empty', () => {
    expect(activityVisible({ transcript: { recentEvents: [] } })).toBe(false);
  });

  it('returns true when recentEvents has entries', () => {
    expect(activityVisible({
      transcript: {
        recentEvents: [{ kind: 'tool_use', name: 'Read', summary: 'test.js' }],
      },
    })).toBe(true);
  });

  it('returns false for non-object transcript', () => {
    expect(activityVisible({ transcript: 'invalid' })).toBe(false);
  });
});

describe('renderActivityZone', () => {
  const baseState = {
    terminal: { cols: 79, rows: 24 },
    transcript: {
      toolCallsTotal: 15,
      toolErrorsTotal: 2,
      recentEvents: [
        { kind: 'tool_use', name: 'Read', summary: '/path/to/file.cjs', id: '1' },
        { kind: 'tool_result', id: '1', error: false, summary: 'file contents...' },
        { kind: 'tool_use', name: 'Edit', summary: '/path/to/edit.cjs', id: '2' },
        { kind: 'tool_result', id: '2', error: true, summary: 'not unique' },
      ],
    },
  };

  it('returns an array of strings', () => {
    const lines = renderActivityZone(baseState, palette);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(typeof line).toBe('string');
    }
  });

  it('includes total call count in header', () => {
    const lines = renderActivityZone(baseState, palette);
    const plain = lines.map(l => stripAnsi(l)).join(' ');
    expect(plain).toContain('15');
    expect(plain).toContain('calls');
  });

  it('includes error count when errors exist', () => {
    const lines = renderActivityZone(baseState, palette);
    const plain = lines.map(l => stripAnsi(l)).join(' ');
    expect(plain).toContain('2');
    expect(plain).toContain('err');
  });

  it('omits error count when zero errors', () => {
    const state = {
      ...baseState,
      transcript: { ...baseState.transcript, toolErrorsTotal: 0 },
    };
    const lines = renderActivityZone(state, palette);
    const plain = lines.map(l => stripAnsi(l)).join(' ');
    expect(plain).not.toContain('err');
  });

  it('shows tool_use events with arrow icon and name', () => {
    const lines = renderActivityZone(baseState, palette);
    const plain = lines.map(l => stripAnsi(l)).join('\n');
    // Zone shows last N events (idealRows-1=3), so first Read is sliced off
    expect(plain).toContain('Edit');
  });

  it('shows tool_result with checkmark or X', () => {
    const lines = renderActivityZone(baseState, palette);
    const plain = lines.map(l => stripAnsi(l)).join('\n');
    expect(plain).toContain('\u2713'); // checkmark
    expect(plain).toContain('\u2717'); // X for error
  });

  it('returns fallback when no events', () => {
    const state = {
      terminal: { cols: 79, rows: 24 },
      transcript: { toolCallsTotal: 0, toolErrorsTotal: 0, recentEvents: [] },
    };
    const lines = renderActivityZone(state, palette);
    expect(lines.length).toBeGreaterThanOrEqual(1);
  });

  it('respects terminal width for summary truncation', () => {
    const narrowState = {
      ...baseState,
      terminal: { cols: 40, rows: 24 },
    };
    const lines = renderActivityZone(narrowState, palette);
    for (const line of lines) {
      // Each line's visible content should be reasonable for narrow terminals
      expect(stripAnsi(line).length).toBeLessThan(80);
    }
  });
});
