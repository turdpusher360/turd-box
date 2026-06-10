import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

// Plain palette: all escape codes are empty strings so assertions work on raw text.
const PLAIN = {
  ok: '', warn: '', error: '', accent: '', muted: '', text: '', bg: '', reset: '',
};

// Helper: strip ANSI from a string without requiring hud-palette to be loaded.
function stripAnsi(str) {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

// Cache-busting require for a single module path and its common deps.
function requireFresh(modulePath, ...extraCachePrefixes) {
  const busted = [modulePath, ...extraCachePrefixes, 'hud-palette'];
  for (const key of Object.keys(_require.cache)) {
    if (busted.some(p => key.includes(p))) delete _require.cache[key];
  }
  return _require(modulePath);
}

// ============================================================
// hud-zone-context.cjs
// ============================================================

describe('hud-zone-context — ZONE_META', () => {
  const mod = () => requireFresh(path.resolve(__dirname, '../hud-zone-context.cjs'), 'hud-zone-context');

  it('exports priority, minRows, idealRows', () => {
    const { ZONE_META } = mod();
    expect(typeof ZONE_META.priority).toBe('number');
    expect(typeof ZONE_META.minRows).toBe('number');
    expect(typeof ZONE_META.idealRows).toBe('number');
  });

  it('priority is 9', () => {
    expect(mod().ZONE_META.priority).toBe(9);
  });

  it('minRows is 1', () => {
    expect(mod().ZONE_META.minRows).toBe(1);
  });

  it('idealRows is 3', () => {
    expect(mod().ZONE_META.idealRows).toBe(3);
  });
});

describe('hud-zone-context — renderBar', () => {
  const mod = () => requireFresh(path.resolve(__dirname, '../hud-zone-context.cjs'), 'hud-zone-context');

  it('returns a non-empty string', () => {
    const { renderBar } = mod();
    const result = renderBar(50, 10, PLAIN, 40);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('uses filled blocks for pct portion', () => {
    const { renderBar } = mod();
    const result = stripAnsi(renderBar(100, 8, PLAIN, 40));
    // All characters should be filled (█ = U+2588)
    expect(result).toContain('\u2588');
  });

  it('uses empty blocks for unfilled portion', () => {
    const { renderBar } = mod();
    const result = stripAnsi(renderBar(0, 8, PLAIN, 40));
    // All characters should be light shade (░ = U+2591)
    expect(result).toContain('\u2591');
  });

  it('total character count equals width', () => {
    const { renderBar } = mod();
    const width = 12;
    const result = stripAnsi(renderBar(50, width, PLAIN, 40));
    expect(result.length).toBe(width);
  });
});

describe('hud-zone-context — renderContextZone', () => {
  const mod = () => requireFresh(path.resolve(__dirname, '../hud-zone-context.cjs'), 'hud-zone-context');

  const baseState = {
    session: { model: 'claude-opus-4-6', contextPct: 25, rateLimits: { fiveHour: 10 } },
  };

  it('returns an array', () => {
    const { renderContextZone } = mod();
    expect(Array.isArray(renderContextZone(baseState, PLAIN))).toBe(true);
  });

  it('returns exactly 1 line', () => {
    const { renderContextZone } = mod();
    expect(renderContextZone(baseState, PLAIN)).toHaveLength(1);
  });

  it('contains the model name', () => {
    const { renderContextZone } = mod();
    const text = stripAnsi(renderContextZone(baseState, PLAIN)[0]);
    expect(text).toContain('claude-opus-4-6');
  });

  it('contains context percentage', () => {
    const { renderContextZone } = mod();
    const state = { session: { model: 'sonnet', contextPct: 42, rateLimits: { fiveHour: 5 } } };
    const text = stripAnsi(renderContextZone(state, PLAIN)[0]);
    expect(text).toContain('42%');
  });

  it('contains rate limit percentage', () => {
    const { renderContextZone } = mod();
    const state = { session: { model: 'sonnet', contextPct: 10, rateLimits: { fiveHour: 77 } } };
    const text = stripAnsi(renderContextZone(state, PLAIN)[0]);
    expect(text).toContain('77%');
  });

  it('handles missing session gracefully (no throw)', () => {
    const { renderContextZone } = mod();
    expect(() => renderContextZone({ session: {} }, PLAIN)).not.toThrow();
  });

  it('defaults to 0% when contextPct is absent', () => {
    const { renderContextZone } = mod();
    const text = stripAnsi(renderContextZone({ session: { model: 'x' } }, PLAIN)[0]);
    expect(text).toContain('0%');
  });

  it('defaults model to "unknown" when absent', () => {
    const { renderContextZone } = mod();
    const text = stripAnsi(renderContextZone({ session: {} }, PLAIN)[0]);
    expect(text).toContain('unknown');
  });
});

// ============================================================
// hud-zone-forge.cjs
// ============================================================

describe('hud-zone-forge — ZONE_META', () => {
  const mod = () => requireFresh(path.resolve(__dirname, '../hud-zone-forge.cjs'), 'hud-zone-forge');

  it('priority is 5', () => {
    expect(mod().ZONE_META.priority).toBe(5);
  });

  it('minRows is 1', () => {
    expect(mod().ZONE_META.minRows).toBe(1);
  });

  it('idealRows is 6', () => {
    expect(mod().ZONE_META.idealRows).toBe(6);
  });
});

describe('hud-zone-forge — renderForgeZone', () => {
  const mod = () => requireFresh(path.resolve(__dirname, '../hud-zone-forge.cjs'), 'hud-zone-forge');

  it('returns an array', () => {
    const { renderForgeZone } = mod();
    expect(Array.isArray(renderForgeZone({ forge: { active: false } }, PLAIN))).toBe(true);
  });

  it('shows "FORGE" label when inactive', () => {
    const { renderForgeZone } = mod();
    const lines = renderForgeZone({ forge: { active: false } }, PLAIN);
    const text = lines.map(l => stripAnsi(l)).join(' ');
    expect(text).toContain('FORGE');
  });

  it('shows inactive message when forge.active is false', () => {
    const { renderForgeZone } = mod();
    const lines = renderForgeZone({ forge: { active: false } }, PLAIN);
    const text = lines.map(l => stripAnsi(l)).join(' ');
    expect(text).toMatch(/no active session/i);
  });

  it('shows scope and phase when forge is active', () => {
    const { renderForgeZone } = mod();
    const state = {
      forge: { active: true, scope: 'S228', phase: 'P5:execute', teammates: [] },
    };
    const text = stripAnsi(renderForgeZone(state, PLAIN).join(' '));
    expect(text).toContain('S228');
    expect(text).toContain('P5:execute');
  });

  it('lists teammates when forge is active', () => {
    const { renderForgeZone } = mod();
    const state = {
      forge: {
        active: true,
        scope: 'S228',
        phase: 'P5',
        teammates: [
          { name: 'tester', phase: 'testing', scope: 'lib/os', status: 'PASS [3/3]' },
          { name: 'implementer', phase: 'coding', scope: 'plugins/', status: '--' },
        ],
      },
    };
    const text = stripAnsi(renderForgeZone(state, PLAIN).join(' '));
    expect(text).toContain('tester');
    expect(text).toContain('implementer');
  });

  it('shows no-teammates message when teammate list is empty', () => {
    const { renderForgeZone } = mod();
    const state = { forge: { active: true, scope: 'S228', phase: 'P3', teammates: [] } };
    const text = stripAnsi(renderForgeZone(state, PLAIN).join(' '));
    expect(text).toMatch(/no active teammates/i);
  });

  it('handles missing forge object gracefully', () => {
    const { renderForgeZone } = mod();
    // forge.active is undefined/falsy — should not throw
    expect(() => renderForgeZone({ forge: {} }, PLAIN)).not.toThrow();
  });
});

// ============================================================
// hud-zone-caps.cjs
// ============================================================

describe('hud-zone-caps — ZONE_META', () => {
  const mod = () => requireFresh(path.resolve(__dirname, '../hud-zone-caps.cjs'), 'hud-zone-caps');

  it('priority is 6', () => {
    expect(mod().ZONE_META.priority).toBe(6);
  });

  it('minRows is 1', () => {
    expect(mod().ZONE_META.minRows).toBe(1);
  });

  it('idealRows is 2', () => {
    expect(mod().ZONE_META.idealRows).toBe(2);
  });
});

describe('hud-zone-caps — CAP_ORDER and CAP_SHORT', () => {
  const mod = () => requireFresh(path.resolve(__dirname, '../hud-zone-caps.cjs'), 'hud-zone-caps');

  it('CAP_ORDER is an array of real capabilities (matches lib/os/capabilities/)', () => {
    const { CAP_ORDER } = mod();
    expect(Array.isArray(CAP_ORDER)).toBe(true);
    // Real capabilities as of S240 — mirrored from lib/os/capabilities/*.cjs
    expect(CAP_ORDER).toContain('forge-session');
    expect(CAP_ORDER).toContain('git');
    expect(CAP_ORDER).toContain('file-integrity');
    expect(CAP_ORDER).toContain('process-health');
    expect(CAP_ORDER).toContain('infra');
    expect(CAP_ORDER).toContain('audit');
    expect(CAP_ORDER).toContain('forge');
    expect(CAP_ORDER).toContain('autoresearch');
    expect(CAP_ORDER).toContain('aisle');
    // Deleted caps from S221b should NOT be present
    expect(CAP_ORDER).not.toContain('memory');
    expect(CAP_ORDER).not.toContain('workflow-engine');
  });

  it('CAP_SHORT maps autoresearch to abbreviated form', () => {
    const { CAP_SHORT } = mod();
    expect(CAP_SHORT['autoresearch']).toBe('autores');
  });

  it('CAP_SHORT maps forge-session to compact form', () => {
    const { CAP_SHORT } = mod();
    expect(CAP_SHORT['forge-session']).toBe('forge-s');
  });
});

describe('hud-zone-caps — renderCapsZone', () => {
  const mod = () => requireFresh(path.resolve(__dirname, '../hud-zone-caps.cjs'), 'hud-zone-caps');

  it('returns an array', () => {
    const { renderCapsZone } = mod();
    expect(Array.isArray(renderCapsZone({ os: { capabilities: {} } }, PLAIN))).toBe(true);
  });

  it('shows compact "all ready" line when every cap is ok', () => {
    const { renderCapsZone, CAP_ORDER } = mod();
    // Provide ALL caps as ok to trigger compact mode
    const caps = {};
    for (const name of CAP_ORDER) caps[name] = { ok: true };
    const lines = renderCapsZone({ os: { capabilities: caps } }, PLAIN);
    const text = lines.map(l => stripAnsi(l)).join(' ');
    expect(text).toMatch(/all \d+ ready/);
  });

  it('compact "all ready" line is exactly 1 line', () => {
    const { renderCapsZone, CAP_ORDER } = mod();
    const caps = {};
    for (const name of CAP_ORDER) caps[name] = { ok: true };
    const lines = renderCapsZone({ os: { capabilities: caps } }, PLAIN);
    expect(lines).toHaveLength(1);
  });

  it('shows per-cap names when some are degraded', () => {
    const { renderCapsZone } = mod();
    const caps = {
      memory: { ok: true },
      git: { ok: false },
      aisle: { ok: true },
    };
    const text = stripAnsi(renderCapsZone({ os: { capabilities: caps } }, PLAIN).join(' '));
    expect(text).toContain('memory');
    expect(text).toContain('git');
  });

  it('renders extra caps not in CAP_ORDER', () => {
    const { renderCapsZone } = mod();
    const caps = {
      memory: { ok: false },
      'custom-cap': { ok: true },
    };
    const text = stripAnsi(renderCapsZone({ os: { capabilities: caps } }, PLAIN).join(' '));
    // custom-cap should appear (sliced to 8 chars)
    expect(text).toContain('custom-c');
  });

  it('handles missing os object gracefully', () => {
    const { renderCapsZone } = mod();
    expect(() => renderCapsZone({}, PLAIN)).not.toThrow();
  });

  it('handles empty capabilities object without throwing', () => {
    const { renderCapsZone } = mod();
    expect(() => renderCapsZone({ os: { capabilities: {} } }, PLAIN)).not.toThrow();
  });
});

// ============================================================
// hud-zone-badges.cjs
// ============================================================

describe('hud-zone-badges — ZONE_META', () => {
  const mod = () => requireFresh(path.resolve(__dirname, '../hud-zone-badges.cjs'), 'hud-zone-badges');

  it('priority is 2', () => {
    expect(mod().ZONE_META.priority).toBe(2);
  });

  it('minRows is 1', () => {
    expect(mod().ZONE_META.minRows).toBe(1);
  });

  it('idealRows is 2', () => {
    expect(mod().ZONE_META.idealRows).toBe(2);
  });
});

describe('hud-zone-badges — BADGE_DEFS', () => {
  const mod = () => requireFresh(path.resolve(__dirname, '../hud-zone-badges.cjs'), 'hud-zone-badges');

  it('exports an array of badge definitions', () => {
    const { BADGE_DEFS } = mod();
    expect(Array.isArray(BADGE_DEFS)).toBe(true);
    expect(BADGE_DEFS.length).toBeGreaterThan(0);
  });

  it('each definition has id, name, desc', () => {
    const { BADGE_DEFS } = mod();
    for (const badge of BADGE_DEFS) {
      expect(typeof badge.id).toBe('string');
      expect(typeof badge.name).toBe('string');
      expect(typeof badge.desc).toBe('string');
    }
  });

  it('contains forge-master badge', () => {
    const { BADGE_DEFS } = mod();
    expect(BADGE_DEFS.some(b => b.id === 'forge-master')).toBe(true);
  });

  it('contains test-green badge', () => {
    const { BADGE_DEFS } = mod();
    expect(BADGE_DEFS.some(b => b.id === 'test-green')).toBe(true);
  });
});

describe('hud-zone-badges — loadBadges / saveBadges / earnBadge', () => {
  const mod = () => requireFresh(path.resolve(__dirname, '../hud-zone-badges.cjs'), 'hud-zone-badges');

  it('loadBadges returns default state for non-existent file', () => {
    const { loadBadges } = mod();
    const result = loadBadges('/nonexistent/path/badges.json');
    expect(result).toEqual({ earned: {}, newThisSession: [] });
  });

  it('loadBadges returns default state for malformed JSON', () => {
    const tmpFile = path.join(os.tmpdir(), `badges-test-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, 'not-valid-json');
    const { loadBadges } = mod();
    const result = loadBadges(tmpFile);
    expect(result).toEqual({ earned: {}, newThisSession: [] });
    fs.unlinkSync(tmpFile);
  });

  it('loadBadges reads earned badges from valid file', () => {
    const tmpFile = path.join(os.tmpdir(), `badges-test-${Date.now()}.json`);
    const data = { earned: { 'forge-master': '2026-04-07T00:00:00Z' }, newThisSession: [] };
    fs.writeFileSync(tmpFile, JSON.stringify(data));
    const { loadBadges } = mod();
    const result = loadBadges(tmpFile);
    expect(result.earned['forge-master']).toBe('2026-04-07T00:00:00Z');
    fs.unlinkSync(tmpFile);
  });

  it('saveBadges writes state to disk', () => {
    const tmpFile = path.join(os.tmpdir(), `badges-save-${Date.now()}.json`);
    const { saveBadges, loadBadges } = mod();
    const state = { earned: { 'test-green': '2026-04-07T00:00:00Z' }, newThisSession: ['test-green'] };
    saveBadges(tmpFile, state);
    const loaded = loadBadges(tmpFile);
    expect(loaded.earned['test-green']).toBeDefined();
    fs.unlinkSync(tmpFile);
  });

  it('earnBadge returns true and stamps timestamp', () => {
    const { earnBadge } = mod();
    const state = { earned: {}, newThisSession: [] };
    const result = earnBadge(state, 'forge-master');
    expect(result).toBe(true);
    expect(typeof state.earned['forge-master']).toBe('string');
    expect(state.newThisSession).toContain('forge-master');
  });

  it('earnBadge returns false if badge already earned', () => {
    const { earnBadge } = mod();
    const state = { earned: { 'audit-clean': '2026-04-01T00:00:00Z' }, newThisSession: [] };
    const result = earnBadge(state, 'audit-clean');
    expect(result).toBe(false);
  });

  it('earnBadge does not duplicate newThisSession entries', () => {
    const { earnBadge } = mod();
    const state = { earned: {}, newThisSession: [] };
    earnBadge(state, 'test-green');
    // Calling again should return false (already earned), not push again
    earnBadge(state, 'test-green');
    expect(state.newThisSession.filter(id => id === 'test-green')).toHaveLength(1);
  });
});

describe('hud-zone-badges — renderBadgesZone', () => {
  const mod = () => requireFresh(path.resolve(__dirname, '../hud-zone-badges.cjs'), 'hud-zone-badges');

  it('returns an array', () => {
    const { renderBadgesZone } = mod();
    expect(Array.isArray(renderBadgesZone({}, PLAIN))).toBe(true);
  });

  it('returns at least 1 line', () => {
    const { renderBadgesZone } = mod();
    expect(renderBadgesZone({}, PLAIN).length).toBeGreaterThan(0);
  });

  it('shows badge names in output', () => {
    const { renderBadgesZone } = mod();
    const text = stripAnsi(renderBadgesZone({}, PLAIN).join(' '));
    expect(text).toContain('forge-master');
  });

  it('shows NEW callout when a badge was earned this session', () => {
    const { renderBadgesZone } = mod();
    const state = {
      badges: {
        earned: { 'test-green': '2026-04-07T00:00:00Z' },
        newThisSession: ['test-green'],
      },
    };
    const text = stripAnsi(renderBadgesZone(state, PLAIN).join(' '));
    expect(text).toContain('NEW:');
    expect(text).toContain('test-green');
  });

  it('does not show NEW callout when newThisSession is empty', () => {
    const { renderBadgesZone } = mod();
    const state = {
      badges: {
        earned: { 'test-green': '2026-04-07T00:00:00Z' },
        newThisSession: [],
      },
    };
    const text = stripAnsi(renderBadgesZone(state, PLAIN).join(' '));
    expect(text).not.toContain('NEW:');
  });

  it('handles missing badges key gracefully', () => {
    const { renderBadgesZone } = mod();
    expect(() => renderBadgesZone({ badges: null }, PLAIN)).not.toThrow();
  });
});

// ============================================================
// hud-zone-session.cjs
// ============================================================

describe('hud-zone-session — ZONE_META', () => {
  const mod = () => requireFresh(path.resolve(__dirname, '../hud-zone-session.cjs'), 'hud-zone-session');

  it('priority is 1', () => {
    expect(mod().ZONE_META.priority).toBe(1);
  });

  it('minRows is 1', () => {
    expect(mod().ZONE_META.minRows).toBe(1);
  });

  it('idealRows is 4', () => {
    expect(mod().ZONE_META.idealRows).toBe(4);
  });
});

describe('hud-zone-session — renderSessionZone', () => {
  const mod = () => requireFresh(path.resolve(__dirname, '../hud-zone-session.cjs'), 'hud-zone-session');

  it('returns an array', () => {
    const { renderSessionZone } = mod();
    expect(Array.isArray(renderSessionZone({}, PLAIN))).toBe(true);
  });

  it('returns fallback line when no memory data is present', () => {
    const { renderSessionZone } = mod();
    const lines = renderSessionZone({ session: {}, memory: {} }, PLAIN);
    const text = lines.map(l => stripAnsi(l)).join(' ');
    expect(text).toMatch(/no session history/i);
  });

  it('shows lastSession when present', () => {
    const { renderSessionZone } = mod();
    const state = { session: {}, memory: { lastSession: 'S226 HUD Phase 1' } };
    const text = stripAnsi(renderSessionZone(state, PLAIN).join(' '));
    expect(text).toContain('S226 HUD Phase 1');
  });

  it('shows parked work when present', () => {
    const { renderSessionZone } = mod();
    const state = { session: {}, memory: { parked: 'S228 Wave 2 pending' } };
    const text = stripAnsi(renderSessionZone(state, PLAIN).join(' '));
    expect(text).toContain('S228 Wave 2 pending');
  });

  it('shows next action when present', () => {
    const { renderSessionZone } = mod();
    const state = { session: {}, memory: { next: 'wire expressions to context' } };
    const text = stripAnsi(renderSessionZone(state, PLAIN).join(' '));
    expect(text).toContain('wire expressions to context');
  });

  it('shows formatted uptime in minutes', () => {
    const { renderSessionZone } = mod();
    const state = { session: { uptime: 12 * 60 * 1000 }, memory: {} }; // 12 minutes
    const text = stripAnsi(renderSessionZone(state, PLAIN).join(' '));
    expect(text).toContain('12m');
  });

  it('shows formatted uptime in hours and minutes', () => {
    const { renderSessionZone } = mod();
    const state = { session: { uptime: (1 * 60 + 30) * 60 * 1000 }, memory: {} }; // 1h 30m
    const text = stripAnsi(renderSessionZone(state, PLAIN).join(' '));
    expect(text).toContain('1h 30m');
  });

  it('does not show uptime line when uptime is 0', () => {
    const { renderSessionZone } = mod();
    const state = { session: { uptime: 0 }, memory: { lastSession: 'x' } };
    const text = stripAnsi(renderSessionZone(state, PLAIN).join(' '));
    expect(text).not.toContain('Uptime:');
  });

  it('handles fully empty state without throwing', () => {
    const { renderSessionZone } = mod();
    expect(() => renderSessionZone({}, PLAIN)).not.toThrow();
  });
});

// ============================================================
// hud-expressions.cjs
// ============================================================

describe('hud-expressions — EXPRESSIONS catalog', () => {
  const mod = () => requireFresh(path.resolve(__dirname, '../hud-expressions.cjs'), 'hud-expressions');

  const EXPECTED_NAMES = [
    'neutral', 'happy', 'focused', 'curious', 'sleepy', 'surprised',
    'thinking', 'determined', 'winking', 'excited', 'suspicious',
    'sad', 'angry', 'blinking', 'lookLeft', 'lookRight',
  ];

  it('exports exactly 16 named expressions', () => {
    const { EXPRESSIONS } = mod();
    expect(Object.keys(EXPRESSIONS)).toHaveLength(16);
  });

  for (const name of EXPECTED_NAMES) {
    it(`"${name}" expression exists`, () => {
      const { EXPRESSIONS } = mod();
      expect(EXPRESSIONS[name]).toBeDefined();
    });
  }

  it('every expression has left and right arrays', () => {
    const { EXPRESSIONS } = mod();
    for (const [name, expr] of Object.entries(EXPRESSIONS)) {
      expect(Array.isArray(expr.left), `${name}.left should be array`).toBe(true);
      expect(Array.isArray(expr.right), `${name}.right should be array`).toBe(true);
    }
  });
});

describe('hud-expressions — eye builder functions', () => {
  const mod = () => requireFresh(path.resolve(__dirname, '../hud-expressions.cjs'), 'hud-expressions');

  it('eyeFull returns 4 strings', () => {
    const { eyeFull } = mod();
    const result = eyeFull();
    expect(result).toHaveLength(4);
    result.forEach(row => expect(typeof row).toBe('string'));
  });

  it('eyeHighlight returns 4 strings', () => {
    const { eyeHighlight } = mod();
    expect(eyeHighlight()).toHaveLength(4);
  });

  it('eyeHalfLid returns 4 strings', () => {
    const { eyeHalfLid } = mod();
    expect(eyeHalfLid()).toHaveLength(4);
  });

  it('eyeSquint returns 4 strings', () => {
    const { eyeSquint } = mod();
    expect(eyeSquint()).toHaveLength(4);
  });

  it('eyeWide returns 5 strings', () => {
    const { eyeWide } = mod();
    expect(eyeWide()).toHaveLength(5);
  });

  it('eyeHappy returns 4 strings', () => {
    const { eyeHappy } = mod();
    expect(eyeHappy()).toHaveLength(4);
  });

  it('eyeSad returns 4 strings', () => {
    const { eyeSad } = mod();
    expect(eyeSad()).toHaveLength(4);
  });

  it('eyeClosed returns 4 strings', () => {
    const { eyeClosed } = mod();
    expect(eyeClosed()).toHaveLength(4);
  });

  it('eyeExcited returns 5 strings', () => {
    const { eyeExcited } = mod();
    expect(eyeExcited()).toHaveLength(5);
  });

  it('eye builders accept a tint argument without throwing', () => {
    const { eyeFull, eyeSquint, eyeHalfLid, eyeHappy, eyeSad, eyeHighlight } = mod();
    const tint = '\x1b[38;5;196m';
    expect(() => eyeFull(tint)).not.toThrow();
    expect(() => eyeSquint(tint)).not.toThrow();
    expect(() => eyeHalfLid(tint)).not.toThrow();
    expect(() => eyeHappy(tint)).not.toThrow();
    expect(() => eyeSad(tint)).not.toThrow();
    expect(() => eyeHighlight(tint)).not.toThrow();
  });
});

// Helper: build a minimal state object for selectExpression.
function makeState(overrides = {}) {
  return {
    context: { event: null },
    forge: { active: false, phase: null },
    session: { contextPct: 0 },
    os: { capabilities: {} },
    ...overrides,
  };
}

describe('hud-expressions — selectExpression', () => {
  const mod = () => requireFresh(path.resolve(__dirname, '../hud-expressions.cjs'), 'hud-expressions');

  it('returns an object with left and right arrays', () => {
    const { selectExpression } = mod();
    const result = selectExpression(makeState());
    expect(Array.isArray(result.left)).toBe(true);
    expect(Array.isArray(result.right)).toBe(true);
  });

  it('returns neutral for empty/default state', () => {
    const { selectExpression, EXPRESSIONS } = mod();
    const result = selectExpression(makeState());
    expect(result).toBe(EXPRESSIONS.neutral);
  });

  it('returns focused when forge is active with a phase', () => {
    const { selectExpression, EXPRESSIONS } = mod();
    const state = makeState({ forge: { active: true, phase: 'P5:execute' } });
    expect(selectExpression(state)).toBe(EXPRESSIONS.focused);
  });

  it('returns determined on forge-start event', () => {
    const { selectExpression, EXPRESSIONS } = mod();
    const state = makeState({ context: { event: 'forge-start' } });
    expect(selectExpression(state)).toBe(EXPRESSIONS.determined);
  });

  it('returns excited on forge-complete event', () => {
    const { selectExpression, EXPRESSIONS } = mod();
    const state = makeState({ context: { event: 'forge-complete' } });
    expect(selectExpression(state)).toBe(EXPRESSIONS.excited);
  });

  it('returns happy on test-pass event', () => {
    const { selectExpression, EXPRESSIONS } = mod();
    const state = makeState({ context: { event: 'test-pass' } });
    expect(selectExpression(state)).toBe(EXPRESSIONS.happy);
  });

  it('returns sad on test-fail event', () => {
    const { selectExpression, EXPRESSIONS } = mod();
    const state = makeState({ context: { event: 'test-fail' } });
    expect(selectExpression(state)).toBe(EXPRESSIONS.sad);
  });

  it('returns sleepy when contextPct >= 80', () => {
    const { selectExpression, EXPRESSIONS } = mod();
    const state = makeState({ session: { contextPct: 80 } });
    expect(selectExpression(state)).toBe(EXPRESSIONS.sleepy);
  });

  it('returns sleepy when contextPct is 95', () => {
    const { selectExpression, EXPRESSIONS } = mod();
    const state = makeState({ session: { contextPct: 95 } });
    expect(selectExpression(state)).toBe(EXPRESSIONS.sleepy);
  });

  it('returns thinking when contextPct is 60', () => {
    const { selectExpression, EXPRESSIONS } = mod();
    const state = makeState({ session: { contextPct: 60 } });
    expect(selectExpression(state)).toBe(EXPRESSIONS.thinking);
  });

  it('returns thinking when contextPct is 70', () => {
    const { selectExpression, EXPRESSIONS } = mod();
    const state = makeState({ session: { contextPct: 70 } });
    expect(selectExpression(state)).toBe(EXPRESSIONS.thinking);
  });

  it('returns winking on export event', () => {
    const { selectExpression, EXPRESSIONS } = mod();
    const state = makeState({ context: { event: 'export' } });
    expect(selectExpression(state)).toBe(EXPRESSIONS.winking);
  });

  it('returns excited on badge-earned event', () => {
    const { selectExpression, EXPRESSIONS } = mod();
    const state = makeState({ context: { event: 'badge-earned' } });
    expect(selectExpression(state)).toBe(EXPRESSIONS.excited);
  });

  it('returns surprised on boot event', () => {
    const { selectExpression, EXPRESSIONS } = mod();
    const state = makeState({ context: { event: 'boot' } });
    expect(selectExpression(state)).toBe(EXPRESSIONS.surprised);
  });

  it('returns sleepy on session-end event', () => {
    const { selectExpression, EXPRESSIONS } = mod();
    const state = makeState({ context: { event: 'session-end' } });
    expect(selectExpression(state)).toBe(EXPRESSIONS.sleepy);
  });

  it('returns blinking on blink event', () => {
    const { selectExpression, EXPRESSIONS } = mod();
    const state = makeState({ context: { event: 'blink' } });
    expect(selectExpression(state)).toBe(EXPRESSIONS.blinking);
  });

  it('returns angry when 4 or more caps degraded', () => {
    const { selectExpression, EXPRESSIONS } = mod();
    const caps = {
      a: { ok: false }, b: { ok: false }, c: { ok: false }, d: { ok: false },
    };
    const state = makeState({ os: { capabilities: caps } });
    expect(selectExpression(state)).toBe(EXPRESSIONS.angry);
  });

  it('returns suspicious when 2 caps degraded', () => {
    const { selectExpression, EXPRESSIONS } = mod();
    const caps = { a: { ok: false }, b: { ok: false } };
    const state = makeState({ os: { capabilities: caps } });
    expect(selectExpression(state)).toBe(EXPRESSIONS.suspicious);
  });

  it('returns curious when exactly 1 cap degraded', () => {
    const { selectExpression, EXPRESSIONS } = mod();
    const caps = { a: { ok: false } };
    const state = makeState({ os: { capabilities: caps } });
    expect(selectExpression(state)).toBe(EXPRESSIONS.curious);
  });

  it('forge-start takes priority over degraded caps', () => {
    const { selectExpression, EXPRESSIONS } = mod();
    const state = makeState({
      context: { event: 'forge-start' },
      os: { capabilities: { a: { ok: false }, b: { ok: false }, c: { ok: false }, d: { ok: false } } },
    });
    // forge-start is listed before cap-degradation rules
    expect(selectExpression(state)).toBe(EXPRESSIONS.determined);
  });

  it('does not throw on malformed state', () => {
    const { selectExpression } = mod();
    // Missing required nested keys — rules should catch via try/catch
    expect(() => selectExpression({})).not.toThrow();
  });
});

describe('hud-expressions — getExpressionName', () => {
  const mod = () => requireFresh(path.resolve(__dirname, '../hud-expressions.cjs'), 'hud-expressions');

  it('returns a string', () => {
    const { getExpressionName } = mod();
    expect(typeof getExpressionName(makeState())).toBe('string');
  });

  it('returns "neutral" for default state', () => {
    const { getExpressionName } = mod();
    expect(getExpressionName(makeState())).toBe('neutral');
  });

  it('returns "focused" when forge active with phase', () => {
    const { getExpressionName } = mod();
    const state = makeState({ forge: { active: true, phase: 'P3' } });
    expect(getExpressionName(state)).toBe('focused');
  });

  it('returns "happy" on test-pass event', () => {
    const { getExpressionName } = mod();
    expect(getExpressionName(makeState({ context: { event: 'test-pass' } }))).toBe('happy');
  });

  it('returns "sad" on test-fail event', () => {
    const { getExpressionName } = mod();
    expect(getExpressionName(makeState({ context: { event: 'test-fail' } }))).toBe('sad');
  });

  it('returns "sleepy" when contextPct >= 80', () => {
    const { getExpressionName } = mod();
    expect(getExpressionName(makeState({ session: { contextPct: 80 } }))).toBe('sleepy');
  });

  it('name matches the expression object returned by selectExpression', () => {
    const { selectExpression, getExpressionName, EXPRESSIONS } = mod();
    const state = makeState({ context: { event: 'test-pass' } });
    const name = getExpressionName(state);
    const expr = selectExpression(state);
    expect(EXPRESSIONS[name]).toBe(expr);
  });

  it('returns "neutral" on malformed state without throwing', () => {
    const { getExpressionName } = mod();
    expect(() => getExpressionName({})).not.toThrow();
    expect(getExpressionName({})).toBe('neutral');
  });
});
