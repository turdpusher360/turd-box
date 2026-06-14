import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);
const { renderRateLimitZone, renderRateLimitCompact, rateVisible, RATE_META } = _require('../hud-zone-rate-limit.cjs');
const { resolvePalette } = _require('../hud-palette.cjs');

const palette = resolvePalette({ name: 'forge' });

describe('rateVisible', () => {
  it('returns false when rateLimits is N/A', () => {
    expect(rateVisible({ session: { rateLimits: 'N/A' } })).toBe(false);
  });

  it('returns false when rateLimits is missing', () => {
    expect(rateVisible({ session: {} })).toBe(false);
  });

  it('returns false when all tiers below 80%', () => {
    expect(rateVisible({ session: { rateLimits: { fiveHour: 50, sevenDay: 60 } } })).toBe(false);
  });

  it('returns true when fiveHour exceeds 80%', () => {
    expect(rateVisible({ session: { rateLimits: { fiveHour: 85, sevenDay: 20 } } })).toBe(true);
  });

  it('returns true when sevenDay exceeds 80%', () => {
    expect(rateVisible({ session: { rateLimits: { fiveHour: 10, sevenDay: 92 } } })).toBe(true);
  });

  it('returns false for non-object rateLimits', () => {
    expect(rateVisible({ session: { rateLimits: 42 } })).toBe(false);
  });
});

describe('RATE_META', () => {
  it('has priority 10 (high — transient alert)', () => {
    expect(RATE_META.priority).toBe(10);
  });

  it('has minRows 1 and idealRows 2', () => {
    expect(RATE_META.minRows).toBe(1);
    expect(RATE_META.idealRows).toBe(2);
  });
});

describe('renderRateLimitZone', () => {
  it('returns 2-line array', () => {
    const state = { session: { rateLimits: { fiveHour: 90, sevenDay: 30 } } };
    const lines = renderRateLimitZone(state, palette);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBe(2);
  });

  it('includes percentage in output', () => {
    const state = { session: { rateLimits: { fiveHour: 85, sevenDay: 10 } } };
    const lines = renderRateLimitZone(state, palette);
    const plain = lines.join(' ').replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('85%');
  });

  it('includes tier name in output', () => {
    const state = { session: { rateLimits: { fiveHour: 95, sevenDay: 40 } } };
    const lines = renderRateLimitZone(state, palette);
    const plain = lines.join(' ').replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('5-hour');
  });

  it('shows worst tier when multiple are high', () => {
    const state = { session: { rateLimits: { fiveHour: 85, sevenDay: 97 } } };
    const lines = renderRateLimitZone(state, palette);
    const plain = lines.join(' ').replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain('97%');
    expect(plain).toContain('7-day');
  });

  it('renders a braille trend for the visible worst tier when rate history is present', () => {
    const state = {
      session: {
        rateLimits: { fiveHour: 88, sevenDay: 20 },
        rateLimitHistory: [
          { fiveHour: 40, sevenDay: 10 },
          { fiveHour: 52, sevenDay: 12 },
          { fiveHour: 70, sevenDay: 15 },
          { fiveHour: 88, sevenDay: 20 },
        ],
      },
    };

    const lines = renderRateLimitZone(state, palette);
    const plain = lines.join(' ').replace(/\x1b\[[0-9;]*m/g, '');

    expect(lines).toHaveLength(2);
    expect(plain).toContain('trend');
    expect(plain).toMatch(/[\u2800-\u28ff]/);
  });

  it('exposes the visible worst-tier trend as an optional compact row', () => {
    const state = {
      session: {
        rateLimits: { fiveHour: 88, sevenDay: 20 },
        rateLimitHistory: [
          { fiveHour: 40, sevenDay: 10 },
          { fiveHour: 52, sevenDay: 12 },
          { fiveHour: 70, sevenDay: 15 },
          { fiveHour: 88, sevenDay: 20 },
        ],
      },
    };

    const lines = renderRateLimitCompact(state, palette);
    const plain = lines.join(' ').replace(/\x1b\[[0-9;]*m/g, '');

    expect(lines).toHaveLength(1);
    expect(plain).toContain('rate trend');
    expect(plain).toContain('88%');
    expect(plain).toMatch(/[\u2800-\u28ff]/);
  });

  it('omits compact output when the rate alert zone is not visible', () => {
    const state = {
      session: {
        rateLimits: { fiveHour: 40, sevenDay: 20 },
        rateLimitHistory: [
          { fiveHour: 30, sevenDay: 10 },
          { fiveHour: 40, sevenDay: 20 },
        ],
      },
    };

    expect(renderRateLimitCompact(state, palette)).toEqual([]);
  });
});
