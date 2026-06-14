import { describe, it, expect, vi } from 'vitest';
const { renderOrb, renderColoredOrb, WIREFRAME, getBreathPeriod, easeInOutSine } = require('../hud-braille-orb.cjs');

describe('hud-braille-orb', () => {
  describe('renderOrb', () => {
    it('returns 2 rows of 3 braille chars each', () => {
      const lines = renderOrb(100, { angle: 0 });
      expect(lines).toHaveLength(2);
      expect([...lines[0]]).toHaveLength(3);
      expect([...lines[1]]).toHaveLength(3);
    });

    it('all characters are braille (U+2800-U+28FF)', () => {
      const lines = renderOrb(100, { angle: 0 });
      for (const row of lines) {
        for (const ch of row) {
          const cp = ch.codePointAt(0);
          expect(cp).toBeGreaterThanOrEqual(0x2800);
          expect(cp).toBeLessThanOrEqual(0x28FF);
        }
      }
    });

    it('produces multiple distinct frames at different angles', () => {
      // 7-meridian orb in a 6x8 braille grid: symmetric angles can collide at
      // this resolution. Freeze the clock so breathScale is deterministic — at
      // live Date.now() the breath phase shifts each run, and a contracted scale
      // (breathScaleMin=0.65) can drop distinctness below 5 (S427: amplitude
      // restore from 0.85/0.85 made this flaky; freeze clock at mid-inhale
      // where breathScale ~0.82 to guarantee >= 6 distinct frames).
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_001_200);
      try {
        const frames = new Set();
        for (let i = 0; i < 8; i++) {
          frames.add(renderOrb(100, { angle: (i / 8) * 2 * Math.PI }).join(''));
        }
        expect(frames.size).toBeGreaterThanOrEqual(6);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('health 0% produces visible dormant silhouette (outline only)', () => {
      const joined = renderOrb(0, { angle: 0 }).join('');
      const litDots = [...joined].filter(ch => ch.codePointAt(0) > 0x2800).length;
      expect(litDots).toBeGreaterThan(0);
    });

    it('health 100% has more lit dots than 20%', () => {
      const popcount = n => { let c = 0; while (n) { c += n & 1; n >>= 1; } return c; };
      const bits = s => [...s].reduce((n, ch) => n + popcount(ch.codePointAt(0) - 0x2800), 0);
      expect(bits(renderOrb(100, { angle: 0 }).join(''))).toBeGreaterThan(
        bits(renderOrb(20, { angle: 0 }).join(''))
      );
    });

    it('works without opts', () => {
      expect(renderOrb(100)).toHaveLength(2);
    });
  });

  describe('renderColoredOrb', () => {
    it('uses per-char gradient when healthy', () => {
      const lines = renderColoredOrb(100, { angle: 0 });
      expect(lines[0]).toContain('\x1b[38;5;63m');
      expect(lines[1]).toContain('\x1b[38;5;39m');
    });

    it('uses amber for degraded', () => {
      expect(renderColoredOrb(50, { angle: 0 })[0]).toContain('\x1b[38;5;172m');
    });

    it('uses red for critical', () => {
      expect(renderColoredOrb(20, { angle: 0 })[0]).toContain('\x1b[38;5;167m');
    });
  });

  describe('getBreathPeriod', () => {
    it('fast for tool-running (2000ms)', () => expect(getBreathPeriod({ stateKey: 'tool-running' })).toBe(2000));
    it('fast for thinking (2000ms)', () => expect(getBreathPeriod({ stateKey: 'thinking' })).toBe(2000));
    it('slow for idle (4000ms)', () => expect(getBreathPeriod({ stateKey: 'idle' })).toBe(4000));
    it('very slow for long-idle (6000ms)', () => expect(getBreathPeriod({ stateKey: 'long-idle' })).toBe(6000));
    it('stutter for error (1000ms)', () => expect(getBreathPeriod({ stateKey: 'error' })).toBe(1000));
    it('defaults for null (4000ms)', () => expect(getBreathPeriod(null)).toBe(4000));
    it('defaults for unknown state (4000ms)', () => expect(getBreathPeriod({ stateKey: 'unknown' })).toBe(4000));
  });

  describe('easeInOutSine', () => {
    it('maps 0→0, 0.5→0.5, 1→1', () => {
      expect(easeInOutSine(0)).toBeCloseTo(0);
      expect(easeInOutSine(0.5)).toBeCloseTo(0.5);
      expect(easeInOutSine(1)).toBeCloseTo(1);
    });
  });

  describe('WIREFRAME', () => {
    it('points and tags match length', () => {
      expect(WIREFRAME.points.length).toBe(WIREFRAME.tags.length);
    });

    it('has all tag types', () => {
      const tags = new Set(WIREFRAME.tags);
      expect(tags.has('meridian') && tags.has('parallel') && tags.has('outline')).toBe(true);
    });

    it('all points on unit sphere', () => {
      for (const [x, y, z] of WIREFRAME.points) {
        expect(Math.sqrt(x * x + y * y + z * z)).toBeCloseTo(1, 1);
      }
    });
  });
});
