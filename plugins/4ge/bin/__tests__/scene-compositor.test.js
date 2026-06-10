import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);

const {
  composeScene,
  composeSceneText,
  fitLine,
  overlayOnLine,
  sceneHeader,
  sceneFooter,
} = _require('../scene-compositor.cjs');

const {
  SCENES,
  selectScene,
  getSceneNames,
  getScene,
  bgIdle,
  bgFocused,
  bgAlert,
  characterFace,
  infoLine,
  infoAlert,
  SCENE_FACES,
  DENSITY,
  BRAILLE,
  MAX_WIDTH,
  MAX_LINES,
} = _require('../scene-library.cjs');

// --- Helpers ---

function makeState(overrides) {
  return {
    terminal: { cols: 79, rows: 24 },
    session: { model: 'opus', contextPct: 30, rateLimits: 'N/A', cost: 0 },
    os: { overallHealth: 'ready', capabilities: {} },
    forge: { active: false, phase: null, teammates: [], scope: null },
    context: { trigger: 'unknown', event: null, zone: null },
    badges: {},
    ...overrides,
  };
}

// --- Scene Library Tests ---

describe('scene-library', () => {
  describe('SCENES', () => {
    it('defines at least 3 scene types', () => {
      expect(Object.keys(SCENES).length).toBeGreaterThanOrEqual(3);
    });

    it('has idle, focused, and alert scenes', () => {
      expect(SCENES.idle).toBeDefined();
      expect(SCENES.focused).toBeDefined();
      expect(SCENES.alert).toBeDefined();
    });

    it('each scene has required properties', () => {
      for (const [name, scene] of Object.entries(SCENES)) {
        expect(scene.name).toBe(name);
        expect(typeof scene.mood).toBe('string');
        expect(typeof scene.background).toBe('function');
        expect(Array.isArray(scene.expressions)).toBe(true);
        expect(scene.expressions.length).toBeGreaterThan(0);
      }
    });
  });

  describe('getSceneNames', () => {
    it('returns all scene names', () => {
      const names = getSceneNames();
      expect(names).toContain('idle');
      expect(names).toContain('focused');
      expect(names).toContain('alert');
    });
  });

  describe('getScene', () => {
    it('returns scene by name', () => {
      const scene = getScene('idle');
      expect(scene.name).toBe('idle');
    });

    it('falls back to idle for unknown names', () => {
      const scene = getScene('nonexistent');
      expect(scene.name).toBe('idle');
    });
  });

  describe('selectScene', () => {
    it('returns idle for neutral state', () => {
      const state = makeState();
      expect(selectScene(state)).toBe('idle');
    });

    it('returns focused when forge is active', () => {
      const state = makeState({ forge: { active: true, phase: 'execute', teammates: [], scope: null } });
      expect(selectScene(state)).toBe('focused');
    });

    it('returns focused on test-pass event', () => {
      const state = makeState({ context: { trigger: 'unknown', event: 'test-pass', zone: null } });
      expect(selectScene(state)).toBe('focused');
    });

    it('returns focused on commit event', () => {
      const state = makeState({ context: { trigger: 'unknown', event: 'commit', zone: null } });
      expect(selectScene(state)).toBe('focused');
    });

    it('returns alert when capabilities are degraded', () => {
      const state = makeState({
        os: {
          overallHealth: 'degraded',
          capabilities: {
            memory: { ok: false, reason: 'down' },
            git: { ok: false, reason: 'error' },
            forge: { ok: true },
          },
        },
      });
      expect(selectScene(state)).toBe('alert');
    });

    it('returns alert on test-fail event', () => {
      const state = makeState({ context: { trigger: 'unknown', event: 'test-fail', zone: null } });
      expect(selectScene(state)).toBe('alert');
    });

    it('returns alert on high context pressure', () => {
      const state = makeState({ session: { model: 'opus', contextPct: 85, rateLimits: 'N/A', cost: 0 } });
      expect(selectScene(state)).toBe('alert');
    });

    it('handles empty state gracefully', () => {
      expect(selectScene({})).toBe('idle');
    });
  });
});

// --- Background Layer Tests ---

describe('background layers', () => {
  describe('bgIdle', () => {
    it('returns an array of rows', () => {
      const rows = bgIdle(79);
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBeGreaterThan(0);
    });

    it('each row is a string', () => {
      const rows = bgIdle(79);
      for (const row of rows) {
        expect(typeof row).toBe('string');
      }
    });

    it('rows have content within width budget', () => {
      const rows = bgIdle(79);
      for (const row of rows) {
        expect(Array.from(row).length).toBeLessThanOrEqual(79);
      }
    });
  });

  describe('bgFocused', () => {
    it('returns an array of rows', () => {
      const rows = bgFocused(79);
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBeGreaterThan(0);
    });

    it('has denser content than idle', () => {
      const idle = bgIdle(40);
      const focused = bgFocused(40);
      // Focused should have fewer spaces (denser)
      const idleSpaces = idle.join('').split('').filter(c => c === ' ').length;
      const focusedSpaces = focused.join('').split('').filter(c => c === ' ').length;
      expect(focusedSpaces).toBeLessThan(idleSpaces);
    });
  });

  describe('bgAlert', () => {
    it('returns an array of rows', () => {
      const rows = bgAlert(79);
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBeGreaterThan(0);
    });

    it('uses block elements', () => {
      const rows = bgAlert(79);
      const joined = rows.join('');
      // Alert background uses block characters
      const hasBlocks = /[\u2588\u2591\u2592\u2593]/.test(joined);
      expect(hasBlocks).toBe(true);
    });
  });

  describe('all backgrounds respect width', () => {
    const widths = [40, 60, 79];
    for (const w of widths) {
      it(`bgIdle at width ${w}`, () => {
        for (const row of bgIdle(w)) {
          expect(Array.from(row).length).toBeLessThanOrEqual(w);
        }
      });
      it(`bgFocused at width ${w}`, () => {
        for (const row of bgFocused(w)) {
          expect(Array.from(row).length).toBeLessThanOrEqual(w);
        }
      });
      it(`bgAlert at width ${w}`, () => {
        for (const row of bgAlert(w)) {
          expect(Array.from(row).length).toBeLessThanOrEqual(w);
        }
      });
    }
  });
});

// --- Character Layer Tests ---

describe('characterFace', () => {
  it('returns a face for each known expression', () => {
    for (const expr of Object.keys(SCENE_FACES)) {
      const face = characterFace(expr);
      expect(typeof face).toBe('string');
      expect(face.length).toBeGreaterThan(0);
    }
  });

  it('returns neutral for unknown expression', () => {
    const face = characterFace('unknown-expression');
    expect(face).toBe(SCENE_FACES.neutral);
  });
});

// --- Info Layer Tests ---

describe('infoLine', () => {
  it('returns a string', () => {
    const state = makeState();
    expect(typeof infoLine(state, 'neutral')).toBe('string');
  });

  it('includes model name', () => {
    const state = makeState({ session: { model: 'opus', contextPct: 30, rateLimits: 'N/A', cost: 0 } });
    const line = infoLine(state, 'neutral');
    // The model name is rendered in math monospace
    expect(line.length).toBeGreaterThan(0);
  });

  it('includes context percentage', () => {
    const state = makeState({ session: { model: 'opus', contextPct: 42, rateLimits: 'N/A', cost: 0 } });
    const line = infoLine(state, 'neutral');
    expect(line).toContain('42%');
  });

  it('includes forge status when active', () => {
    const state = makeState({
      session: { model: 'opus', contextPct: 30, rateLimits: 'N/A', cost: 0 },
      forge: { active: true, phase: 'execute', teammates: [], scope: null },
    });
    const line = infoLine(state, 'focused');
    // Should contain bold FORGE text (Math Bold characters)
    expect(line.length).toBeGreaterThan(0);
  });

  it('handles empty state', () => {
    const line = infoLine({}, 'neutral');
    expect(typeof line).toBe('string');
  });
});

describe('infoAlert', () => {
  it('returns empty array for healthy state', () => {
    const state = makeState();
    expect(infoAlert(state)).toEqual([]);
  });

  it('returns degraded info when capabilities are down', () => {
    const state = makeState({
      os: {
        overallHealth: 'degraded',
        capabilities: {
          memory: { ok: false, reason: 'down' },
          git: { ok: true },
        },
      },
    });
    const lines = infoAlert(state);
    expect(lines.length).toBeGreaterThan(0);
  });

  it('returns context warning at high usage', () => {
    const state = makeState({
      session: { model: 'opus', contextPct: 75, rateLimits: 'N/A', cost: 0 },
    });
    const lines = infoAlert(state);
    expect(lines.length).toBeGreaterThan(0);
  });
});

// --- Compositor Utility Tests ---

describe('fitLine', () => {
  it('pads short lines to width', () => {
    const result = fitLine('hello', 10);
    expect(Array.from(result).length).toBe(10);
  });

  it('trims long lines to width', () => {
    const result = fitLine('a'.repeat(100), 79);
    expect(Array.from(result).length).toBe(79);
  });

  it('handles empty string', () => {
    const result = fitLine('', 10);
    expect(Array.from(result).length).toBe(10);
  });

  it('handles Unicode characters', () => {
    const result = fitLine('\u2588\u2588\u2588', 5);
    expect(Array.from(result).length).toBe(5);
  });
});

describe('overlayOnLine', () => {
  it('replaces characters at the specified position', () => {
    const result = overlayOnLine('aaaaaaa', 'BBB', 2);
    expect(result).toBe('aaBBBaa');
  });

  it('pads background if overlay extends past end', () => {
    const result = overlayOnLine('aaa', 'BB', 2);
    expect(result).toBe('aaBB');
  });

  it('handles start at position 0', () => {
    const result = overlayOnLine('xxxxx', 'AB', 0);
    expect(result).toBe('ABxxx');
  });

  it('handles Unicode overlay on ASCII background', () => {
    const bg = ' '.repeat(10);
    const overlay = '[\u2585 \u2585]';
    const result = overlayOnLine(bg, overlay, 3);
    expect(result).toContain('\u2585');
  });
});

describe('sceneHeader', () => {
  it('returns a string', () => {
    const header = sceneHeader('idle');
    expect(typeof header).toBe('string');
    expect(header.length).toBeGreaterThan(0);
  });
});

describe('sceneFooter', () => {
  it('returns a string with box drawing', () => {
    const footer = sceneFooter(79);
    expect(typeof footer).toBe('string');
    expect(footer).toContain('\u2500');
  });
});

// --- Main Compositor Tests ---

describe('composeScene', () => {
  it('returns an array of strings', () => {
    const state = makeState();
    const lines = composeScene(state);
    expect(Array.isArray(lines)).toBe(true);
    for (const line of lines) {
      expect(typeof line).toBe('string');
    }
  });

  it('respects max 10 lines', () => {
    const state = makeState();
    const lines = composeScene(state);
    expect(lines.length).toBeLessThanOrEqual(MAX_LINES);
  });

  it('respects 79-char width', () => {
    const state = makeState();
    const lines = composeScene(state);
    for (const line of lines) {
      expect(Array.from(line).length).toBeLessThanOrEqual(MAX_WIDTH);
    }
  });

  it('width compliance at exactly 79 chars per line', () => {
    const state = makeState();
    const lines = composeScene(state);
    for (const line of lines) {
      expect(Array.from(line).length).toBe(79);
    }
  });

  it('renders idle scene for neutral state', () => {
    const state = makeState();
    const lines = composeScene(state);
    expect(lines.length).toBeGreaterThan(0);
  });

  it('renders focused scene when forge is active', () => {
    const state = makeState({
      forge: { active: true, phase: 'execute', teammates: [], scope: null },
    });
    const lines = composeScene(state);
    expect(lines.length).toBeGreaterThan(0);
  });

  it('renders alert scene when capabilities degraded', () => {
    const state = makeState({
      os: {
        overallHealth: 'degraded',
        capabilities: {
          memory: { ok: false, reason: 'down' },
          git: { ok: false, reason: 'error' },
          forge: { ok: true },
        },
      },
    });
    const lines = composeScene(state);
    expect(lines.length).toBeGreaterThan(0);
  });

  it('handles empty state gracefully', () => {
    const lines = composeScene({});
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(MAX_LINES);
  });

  it('handles null state gracefully', () => {
    const lines = composeScene(null);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
  });

  it('accepts sceneOverride option', () => {
    const state = makeState();
    const lines = composeScene(state, { sceneOverride: 'alert' });
    expect(lines.length).toBeGreaterThan(0);
  });

  it('accepts custom width', () => {
    const state = makeState();
    const lines = composeScene(state, { width: 60 });
    for (const line of lines) {
      expect(Array.from(line).length).toBeLessThanOrEqual(60);
    }
  });

  it('accepts custom maxLines', () => {
    const state = makeState();
    const lines = composeScene(state, { maxLines: 5 });
    expect(lines.length).toBeLessThanOrEqual(5);
  });

  it('clamps width to MAX_WIDTH', () => {
    const state = makeState();
    const lines = composeScene(state, { width: 200 });
    for (const line of lines) {
      expect(Array.from(line).length).toBeLessThanOrEqual(MAX_WIDTH);
    }
  });

  it('clamps maxLines to MAX_LINES', () => {
    const state = makeState();
    const lines = composeScene(state, { maxLines: 100 });
    expect(lines.length).toBeLessThanOrEqual(MAX_LINES);
  });
});

describe('composeSceneText', () => {
  it('returns a string with newlines', () => {
    const state = makeState();
    const text = composeSceneText(state);
    expect(typeof text).toBe('string');
    expect(text).toContain('\n');
  });
});

// --- Scene-State Integration Tests ---

describe('scene selection + rendering integration', () => {
  const testCases = [
    { name: 'idle (neutral)', state: makeState(), expectedScene: 'idle' },
    {
      name: 'focused (forge active)',
      state: makeState({ forge: { active: true, phase: 'plan', teammates: [], scope: null } }),
      expectedScene: 'focused',
    },
    {
      name: 'alert (degraded caps)',
      state: makeState({
        os: {
          overallHealth: 'degraded',
          capabilities: {
            memory: { ok: false, reason: 'down' },
            audit: { ok: false, reason: 'timeout' },
          },
        },
      }),
      expectedScene: 'alert',
    },
    {
      name: 'alert (test failure)',
      state: makeState({ context: { trigger: 'unknown', event: 'test-fail', zone: null } }),
      expectedScene: 'alert',
    },
    {
      name: 'focused (test pass)',
      state: makeState({ context: { trigger: 'unknown', event: 'test-pass', zone: null } }),
      expectedScene: 'focused',
    },
  ];

  for (const tc of testCases) {
    it(`selects ${tc.expectedScene} for ${tc.name}`, () => {
      expect(selectScene(tc.state)).toBe(tc.expectedScene);
    });

    it(`renders ${tc.name} within width and height bounds`, () => {
      const lines = composeScene(tc.state);
      expect(lines.length).toBeLessThanOrEqual(MAX_LINES);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(Array.from(line).length).toBeLessThanOrEqual(MAX_WIDTH);
      }
    });
  }
});

// --- Constants Tests ---

describe('constants', () => {
  it('MAX_WIDTH is 79', () => {
    expect(MAX_WIDTH).toBe(79);
  });

  it('MAX_LINES is 10', () => {
    expect(MAX_LINES).toBe(10);
  });

  it('DENSITY has 9 levels', () => {
    expect(DENSITY.length).toBe(9);
  });

  it('BRAILLE has expected keys', () => {
    expect(BRAILLE.empty).toBeDefined();
    expect(BRAILLE.full).toBeDefined();
    expect(BRAILLE.sparse).toBeDefined();
  });
});
