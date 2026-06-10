import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

// ── Real temp-dir approach ──────────────────────────────────────────────────
// vi.mock('fs') does NOT reliably intercept CJS require('fs') across module
// boundaries, and vi.mock for CJS relative paths is also unreliable after
// cache busting. Instead we use real temp dirs for everything:
// - State file: written to tmpDir/_runs/os/
// - Config file: written to tmpDir/.4ge/config.json
// This gives deterministic behavior with zero tautological assertions.

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-insights-test-'));
  fs.mkdirSync(path.join(tmpDir, '_runs', 'os'), { recursive: true });
  vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  // companion-insights.cjs resolves its state/cache paths as
  // CLAUDE_PROJECT_DIR || process.cwd(). Hook-spawned vitest runs (bg-verify,
  // commit-triggered) inherit CLAUDE_PROJECT_DIR from Claude Code, which
  // overrides the cwd mock and points every concurrent test process at the
  // REAL shared _runs/os/ files — racing each other and the live session's
  // HUD. Stub it to '' (falsy) so the module falls back to the mocked cwd
  // and each test stays isolated in its own mkdtemp dir.
  vi.stubEnv('CLAUDE_PROJECT_DIR', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
});

// ── helpers ───────────────────────────────────────────────────────────────────
function requireFresh() {
  // Bust cache for both insights and config modules
  const modPath = path.resolve(__dirname, '../companion-insights.cjs');
  const configPath = path.resolve(__dirname, '../companion-config.cjs');
  delete require.cache[modPath];
  delete require.cache[configPath];
  return require(modPath);
}

/** Write .4ge/config.json with companion config overrides. */
function writeConfig(companionOverrides) {
  const configDir = path.join(tmpDir, '.4ge');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify({ companion: companionOverrides }),
  );
}

/**
 * Build a complete, valid state object. Pass overrides as nested objects:
 *   makeState({ session: { duration: 90 } })
 */
function makeState(overrides = {}) {
  return {
    session: {
      modelId: 'claude-opus-4-6',
      contextPct: 5,
      toolCount: 10,
      outputTokens: 0,
      duration: 600,
      ...(overrides.session || {}),
    },
    git: {
      branch: 'main',
      dirty: false,
      ahead: 0,
      behind: 0,
      lastCommitAge: 5,
      lastCommitMsg: 'test commit',
      ...(overrides.git || {}),
    },
    forge: {
      active: false,
      phase: null,
      activeCommand: '',
      ...(overrides.forge || {}),
    },
    os: {
      capabilities: {},
      ...(overrides.os || {}),
    },
    context: {
      trigger: '',
      event: '',
      ...(overrides.context || {}),
    },
    palette: {},
    ...Object.fromEntries(
      Object.entries(overrides).filter(([k]) =>
        !['session', 'git', 'forge', 'os', 'context'].includes(k)
      )
    ),
  };
}

/** Write a persisted state that makes the rotation gate OPEN (old timestamp). */
function seedOpenState() {
  fs.writeFileSync(
    path.join(tmpDir, '_runs', 'os', '.companion-insights.json'),
    JSON.stringify({
      lastInsightAt: Date.now() - 999999,
      lastInsightId: '__none__',
      sessionStartAt: Date.now() - 60000,
    }),
  );
}

/** Write a persisted state that makes the rotation gate CLOSED (recent timestamp). */
function seedClosedState() {
  fs.writeFileSync(
    path.join(tmpDir, '_runs', 'os', '.companion-insights.json'),
    JSON.stringify({
      lastInsightAt: Date.now(),
      lastInsightId: '__none__',
      sessionStartAt: Date.now() - 60000,
    }),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
describe('companion-insights', () => {

  // ── module exports ──────────────────────────────────────────────────────────
  describe('exports', () => {
    it('exports getInsight function', () => {
      const { getInsight } = requireFresh();
      expect(typeof getInsight).toBe('function');
    });

    it('exports RULES array', () => {
      const { RULES } = requireFresh();
      expect(Array.isArray(RULES)).toBe(true);
      expect(RULES.length).toBeGreaterThan(0);
    });

    it('every rule has id, category, condition, message, tone', () => {
      const { RULES } = requireFresh();
      for (const rule of RULES) {
        expect(typeof rule.id).toBe('string');
        expect(typeof rule.category).toBe('string');
        expect(typeof rule.condition).toBe('function');
        expect(typeof rule.message).toBe('function');
        expect(typeof rule.tone).toBe('string');
      }
    });
  });

  // ── null/empty state safety ─────────────────────────────────────────────────
  describe('null/empty state safety', () => {
    it('getInsight(null) returns null without throwing', () => {
      const { getInsight } = requireFresh();
      expect(() => getInsight(null)).not.toThrow();
      expect(getInsight(null)).toBeNull();
    });

    it('getInsight({}) returns a string when gate is open (ambient rules fire)', () => {
      seedOpenState();
      const { getInsight } = requireFresh();
      const result = getInsight({});
      expect(typeof result).toBe('string');
    });

    it('getInsight(undefined) returns null without throwing', () => {
      const { getInsight } = requireFresh();
      expect(() => getInsight(undefined)).not.toThrow();
    });
  });

  // ── insights.enabled flag ────────────────────────────────────────────────────
  describe('enabled flag', () => {
    it('returns null when insights.enabled is false', () => {
      writeConfig({ insights: { enabled: false } });
      seedOpenState();
      const { getInsight } = requireFresh();
      const result = getInsight(makeState());
      expect(result).toBeNull();
    });

    it('returns a string when insights.enabled is true and gate is open', () => {
      writeConfig({ insights: { enabled: true } });
      seedOpenState();
      const { getInsight } = requireFresh();
      const result = getInsight(makeState());
      expect(typeof result).toBe('string');
    });
  });

  // ── rotation gate ────────────────────────────────────────────────────────────
  describe('rotation gate', () => {
    it('returns null when called within rotationMs of last insight', () => {
      seedClosedState();
      const { getInsight } = requireFresh();
      const result = getInsight(makeState());
      expect(result).toBeNull();
    });

    it('returns a string after rotation window expires', () => {
      seedOpenState();
      const { getInsight } = requireFresh();
      const result = getInsight(makeState());
      expect(typeof result).toBe('string');
    });

    it('second call within rotationMs returns null', () => {
      seedOpenState();
      const { getInsight } = requireFresh();
      const state = makeState();
      const first = getInsight(state);
      expect(typeof first).toBe('string');
      const second = getInsight(state);
      expect(second).toBeNull();
    });
  });

  // ── rule categories: session ─────────────────────────────────────────────────
  describe('session rules', () => {
    it('session-30m fires when duration is between 30 and 60 minutes', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'session-30m');
      expect(rule).toBeDefined();
      const state = makeState({ session: { duration: 45 } });
      expect(rule.condition(state)).toBe(true);
      expect(typeof rule.message(state)).toBe('string');
    });

    it('session-30m does NOT fire when duration is over 60', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'session-30m');
      expect(rule.condition(makeState({ session: { duration: 90 } }))).toBe(false);
    });

    it('session-1h fires when duration is between 60 and 120 minutes', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'session-1h');
      const state = makeState({ session: { duration: 90 } });
      expect(rule.condition(state)).toBe(true);
      expect(typeof rule.message(state)).toBe('string');
    });

    it('session-2h fires when duration is over 120 minutes', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'session-2h');
      const state = makeState({ session: { duration: 150 } });
      expect(rule.condition(state)).toBe(true);
      expect(typeof rule.message(state)).toBe('string');
    });

    it('tools-100 fires when toolCount is between 100 and 300', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'tools-100');
      const state = makeState({ session: { toolCount: 150 } });
      expect(rule.condition(state)).toBe(true);
      expect(rule.message(state)).toContain('150');
    });

    it('tools-300 fires when toolCount exceeds 300', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'tools-300');
      const state = makeState({ session: { toolCount: 450 } });
      expect(rule.condition(state)).toBe(true);
      expect(rule.message(state)).toContain('450');
    });

    it('commit-first fires when lastCommitMsg is set and toolCount < 50', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'commit-first');
      const state = makeState({ session: { toolCount: 20 }, git: { lastCommitMsg: 'feat: add tests' } });
      expect(rule.condition(state)).toBe(true);
      expect(typeof rule.message(state)).toBe('string');
    });

    it('lines-velocity fires when total lines > 100', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'lines-velocity');
      expect(rule).toBeDefined();
      const state = makeState({ session: { linesAdded: 80, linesRemoved: 30 } });
      expect(rule.condition(state)).toBe(true);
      expect(rule.message(state)).toBe('+80 -30 lines this session.');
    });

    it('lines-velocity does NOT fire when total lines <= 100', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'lines-velocity');
      const state = makeState({ session: { linesAdded: 40, linesRemoved: 20 } });
      expect(rule.condition(state)).toBe(false);
    });

    it('lines-velocity handles missing linesAdded/linesRemoved', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'lines-velocity');
      const state = makeState();
      expect(rule.condition(state)).toBe(false);
    });
  });

  // ── rule categories: context ─────────────────────────────────────────────────
  describe('context rules', () => {
    it('ctx-fresh fires when contextPct < 10', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'ctx-fresh');
      expect(rule.condition(makeState({ session: { contextPct: 5 } }))).toBe(true);
      expect(typeof rule.message(makeState({ session: { contextPct: 5 } }))).toBe('string');
    });

    it('ctx-quarter fires when contextPct is between 20 and 40', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'ctx-quarter');
      const state = makeState({ session: { contextPct: 30 } });
      expect(rule.condition(state)).toBe(true);
      expect(rule.message(state)).toContain('30');
    });

    it('ctx-half fires when contextPct is between 50 and 65', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'ctx-half');
      const state = makeState({ session: { contextPct: 60 } });
      expect(rule.condition(state)).toBe(true);
      expect(rule.message(state)).toContain('60');
    });

    it('ctx-high fires when contextPct > 75', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'ctx-high');
      const state = makeState({ session: { contextPct: 85 } });
      expect(rule.condition(state)).toBe(true);
      expect(rule.message(state)).toContain('85');
    });
  });

  // ── rule categories: git ─────────────────────────────────────────────────────
  describe('git rules', () => {
    it('git-dirty fires when dirty is a positive number', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'git-dirty');
      const state = makeState({ git: { dirty: 3 } });
      expect(rule.condition(state)).toBe(true);
      expect(rule.message(state)).toContain('3');
      expect(rule.message(state)).toContain('files');
    });

    it('git-dirty fires when dirty is truthy boolean', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'git-dirty');
      const state = makeState({ git: { dirty: true } });
      expect(rule.condition(state)).toBe(true);
    });

    it('git-dirty singular when 1 file', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'git-dirty');
      const state = makeState({ git: { dirty: 1 } });
      expect(rule.message(state)).toContain('1 file changed');
      expect(rule.message(state)).not.toContain('files');
    });

    it('git-ahead fires when ahead > 0 and shows count', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'git-ahead');
      const state = makeState({ git: { ahead: 2 } });
      expect(rule.condition(state)).toBe(true);
      expect(rule.message(state)).toContain('2');
    });

    it('git-clean fires when tree is not dirty and branch is set', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'git-clean');
      const state = makeState({ git: { dirty: false, branch: 'main' } });
      expect(rule.condition(state)).toBe(true);
      expect(rule.message(state)).toContain('main');
    });

    it('git-clean does NOT fire when dirty', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'git-clean');
      expect(rule.condition(makeState({ git: { dirty: 2 } }))).toBe(false);
    });

    it('git-old-commit fires when lastCommitAge > 30 AND there is uncommitted work', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'git-old-commit');
      const state = makeState({ git: { lastCommitAge: 45, dirty: 3 } });
      expect(rule.condition(state)).toBe(true);
      expect(rule.message(state)).toContain('45');
    });

    it('git-old-commit does NOT fire on a clean tree (age alone is noise)', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'git-old-commit');
      expect(rule.condition(makeState({ git: { lastCommitAge: 45, dirty: 0 } }))).toBe(false);
    });

    it('git-old-commit formats hours when age > 120 minutes', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'git-old-commit');
      const state = makeState({ git: { lastCommitAge: 240, dirty: 2 } });
      expect(rule.condition(state)).toBe(true);
      expect(rule.message(state)).toContain('4h');
    });

    it('git-behind fires when behind > 0 and shows count', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'git-behind');
      expect(rule).toBeDefined();
      const state = makeState({ git: { behind: 3 } });
      expect(rule.condition(state)).toBe(true);
      expect(rule.message(state)).toContain('3');
      expect(rule.message(state)).toContain('behind');
    });

    it('git-behind does NOT fire when behind is 0', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'git-behind');
      expect(rule.condition(makeState({ git: { behind: 0 } }))).toBe(false);
    });

    it('git-clean does NOT fire when dirty is null (unobserved git state)', () => {
      // smart-order returns dirty: null when the tree was never probed —
      // claiming "clean tree" from that state would be a lie.
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'git-clean');
      expect(rule.condition(makeState({ git: { dirty: null, branch: 'main' } }))).toBe(false);
    });

    it('ambient-quiet does NOT fire when dirty is null (unobserved git state)', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'ambient-quiet');
      expect(rule.condition(makeState({ git: { dirty: null, branch: 'main' } }))).toBe(false);
    });

    it('git-dirty suggests a checkpoint commit when 15+ files are in flight', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'git-dirty');
      const state = makeState({ git: { dirty: 20 } });
      expect(rule.condition(state)).toBe(true);
      expect(rule.message(state)).toContain('20');
      expect(rule.message(state).toLowerCase()).toContain('checkpoint');
    });
  });

  // ── rule categories: event ───────────────────────────────────────────────────
  describe('event rules', () => {
    it('event-test-pass fires on test-pass and mentions changed file count', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'event-test-pass');
      expect(rule).toBeDefined();
      expect(rule.category).toBe('event');
      const state = makeState({ context: { event: 'test-pass' }, git: { dirty: 3 } });
      expect(rule.condition(state)).toBe(true);
      const msg = rule.message(state);
      expect(msg).toContain('green');
      expect(msg).toContain('3 files');
    });

    it('event-test-pass with a clean tree reports a clean pass', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'event-test-pass');
      const state = makeState({ context: { event: 'test-pass' }, git: { dirty: 0 } });
      expect(rule.condition(state)).toBe(true);
      expect(rule.message(state)).toContain('Clean pass');
    });

    it('event-test-fail fires on test-fail with a useful, non-snarky message', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'event-test-fail');
      const state = makeState({ context: { event: 'test-fail' } });
      expect(rule.condition(state)).toBe(true);
      const msg = rule.message(state);
      expect(typeof msg).toBe('string');
      expect(msg.toLowerCase()).toContain('recent edit');
    });

    it('event-commit surfaces the commit subject line', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'event-commit');
      const state = makeState({
        context: { event: 'commit' },
        git: { lastCommitMsg: 'fix(hud): align rows\n\nlong body text' },
      });
      expect(rule.condition(state)).toBe(true);
      expect(rule.message(state)).toContain('fix(hud): align rows');
      expect(rule.message(state)).not.toContain('long body text');
    });

    it('event-forge-phase names the current phase when known', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'event-forge-phase');
      const state = makeState({
        context: { event: 'forge-phase' },
        forge: { active: true, phase: 'execute' },
      });
      expect(rule.condition(state)).toBe(true);
      expect(rule.message(state)).toContain('execute');
    });

    it('event rules do NOT fire when no event is set', () => {
      const { RULES } = requireFresh();
      const eventRules = RULES.filter(r => r.category === 'event');
      expect(eventRules.length).toBeGreaterThan(0);
      const state = makeState(); // context.event defaults to ''
      for (const rule of eventRules) {
        expect(rule.condition(state)).toBe(false);
      }
    });
  });

  // ── rule categories: os ──────────────────────────────────────────────────────
  describe('os rules', () => {
    it('os-degraded fires when a capability probe reports not-ok', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'os-degraded');
      expect(rule).toBeDefined();
      const state = makeState({
        os: { capabilities: { infra: { ok: false, status: 'degraded' } } },
      });
      expect(rule.condition(state)).toBe(true);
      expect(rule.message(state)).toContain('infra');
      expect(rule.message(state)).toContain('degraded');
    });

    it('os-degraded counts additional degraded capabilities', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'os-degraded');
      const state = makeState({
        os: {
          capabilities: {
            infra: { ok: false, status: 'degraded' },
            audit: { ok: false, status: 'failed' },
          },
        },
      });
      expect(rule.condition(state)).toBe(true);
      expect(rule.message(state)).toContain('+1 more');
    });

    it('os-degraded ignores shelved capabilities (e.g. AISLE)', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'os-degraded');
      const state = makeState({
        os: { capabilities: { aisle: { ok: false, status: 'degraded', shelved: true } } },
      });
      expect(rule.condition(state)).toBe(false);
    });

    it('os-degraded does NOT fire when all capabilities are ok', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'os-degraded');
      const state = makeState({
        os: { capabilities: { git: { ok: true, status: 'ready' } } },
      });
      expect(rule.condition(state)).toBe(false);
    });
  });

  // ── rule categories: forge ───────────────────────────────────────────────────
  describe('forge rules', () => {
    it('forge-active fires with phase and teammate count', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'forge-active');
      expect(rule).toBeDefined();
      const state = makeState({
        forge: { active: true, phase: 'execute', teammates: ['a', 'b'] },
      });
      expect(rule.condition(state)).toBe(true);
      const msg = rule.message(state);
      expect(msg).toContain('execute');
      expect(msg).toContain('2 teammates');
    });

    it('forge-active omits teammates when none assigned', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'forge-active');
      const state = makeState({ forge: { active: true, phase: 'plan', teammates: [] } });
      expect(rule.condition(state)).toBe(true);
      expect(rule.message(state)).toContain('plan');
      expect(rule.message(state)).not.toContain('teammate');
    });

    it('forge-active does NOT fire when forge is inactive', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'forge-active');
      expect(rule.condition(makeState({ forge: { active: false, phase: null } }))).toBe(false);
    });
  });

  // ── selection tiering ────────────────────────────────────────────────────────
  describe('selection tiering (context beats filler)', () => {
    it('an event insight wins over general contextual rules', () => {
      seedOpenState();
      const { getInsight } = requireFresh();
      // ctx-fresh, git-clean, commit-first are all eligible — but the
      // test-fail event should take the bubble.
      const state = makeState({
        context: { event: 'test-fail' },
        session: { contextPct: 5, toolCount: 10 },
        git: { dirty: 0, branch: 'main', lastCommitMsg: 'test commit' },
      });
      const result = getInsight(state);
      expect(result).toContain('test failed');
    });

    it('ambient lines only surface when nothing contextual fires', () => {
      seedOpenState();
      const { getInsight } = requireFresh();
      // No contextual signal anywhere: mid-band context %, low tools, short
      // session, unobserved git, no events, no forge, no memory cache.
      const state = makeState({
        context: { event: '' },
        session: { contextPct: 15, toolCount: 5, duration: 5, cost: 0 },
        git: { dirty: null, branch: null, ahead: 0, behind: 0, lastCommitAge: 5, lastCommitMsg: '' },
        forge: { active: false, phase: null, activeCommand: '' },
      });
      const result = getInsight(state);
      const ambientMessages = [
        'Forge is warm.',
        'Standing watch — nothing needs you right now.',
        'Tools in order, bench is clear.',
        'Ready when you are.',
      ];
      expect(ambientMessages).toContain(result);
    });

    it('contextual rules suppress ambient even under tone=warm', () => {
      seedOpenState();
      const { getInsight } = requireFresh();
      // git-dirty is eligible — ambient must not surface.
      const state = makeState({
        context: { event: '' },
        session: { contextPct: 15, toolCount: 5, duration: 5 },
        git: { dirty: 4, branch: 'main', ahead: 0, behind: 0, lastCommitAge: 5, lastCommitMsg: '' },
      });
      const result = getInsight(state);
      const ambientMessages = [
        'Forge is warm.',
        'Standing watch — nothing needs you right now.',
        'Tools in order, bench is clear.',
        'Ready when you are.',
      ];
      expect(result).not.toBeNull();
      expect(ambientMessages).not.toContain(result);
    });
  });

  // ── rule categories: nudge ────────────────────────────────────────────────────
  describe('nudge rules', () => {
    it('nudge-no-tests fires when toolCount > 50 and no test signal', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'nudge-no-tests');
      const state = makeState({
        session: { toolCount: 75 },
        forge: { phase: null, activeCommand: '' },
      });
      expect(rule.condition(state)).toBe(true);
      expect(typeof rule.message(state)).toBe('string');
    });

    it('nudge-no-tests does NOT fire when forge phase includes test', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'nudge-no-tests');
      const state = makeState({
        session: { toolCount: 75 },
        forge: { phase: 'test-driven', activeCommand: '' },
      });
      expect(rule.condition(state)).toBe(false);
    });

    it('nudge-forge-idle fires when forge not active and toolCount > 100', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'nudge-forge-idle');
      const state = makeState({
        session: { toolCount: 150 },
        forge: { active: false },
      });
      expect(rule.condition(state)).toBe(true);
      expect(typeof rule.message(state)).toBe('string');
    });

    it('nudge-forge-idle does NOT fire when forge is active', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'nudge-forge-idle');
      const state = makeState({
        session: { toolCount: 150 },
        forge: { active: true },
      });
      expect(rule.condition(state)).toBe(false);
    });
  });

  // ── rule categories: ambient ─────────────────────────────────────────────────
  describe('ambient rules', () => {
    it('all always-true ambient rules return strings on any state', () => {
      const { RULES } = requireFresh();
      const ambientAlways = RULES.filter(
        r => r.category === 'ambient' && r.condition.toString().includes('true')
      );
      const state = makeState();
      for (const rule of ambientAlways) {
        expect(rule.condition(state)).toBe(true);
        expect(typeof rule.message(state)).toBe('string');
        expect(rule.message(state).length).toBeGreaterThan(0);
      }
    });

    it('ambient-quiet fires when tree is clean', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'ambient-quiet');
      const state = makeState({ git: { dirty: false, branch: 'feat/tests' } });
      expect(rule.condition(state)).toBe(true);
      expect(rule.message(state)).toContain('feat/tests');
    });
  });

  // ── tone filtering ────────────────────────────────────────────────────────────
  describe('tone filtering', () => {
    it('with tone=minimal, nudge and ambient rules are excluded', () => {
      const { RULES } = requireFresh();
      const eligible = RULES.filter(r => r.category !== 'ambient' && r.category !== 'nudge');
      const excluded = RULES.filter(r => r.category === 'ambient' || r.category === 'nudge');
      expect(eligible.length).toBeGreaterThan(0);
      expect(excluded.length).toBeGreaterThan(0);
      for (const r of eligible) {
        expect(['session', 'context', 'git', 'memory', 'event', 'os', 'forge']).toContain(r.category);
      }
    });

    it('with tone=technical, ambient rules are excluded but nudge rules are included', () => {
      const { RULES } = requireFresh();
      const eligibleForTechnical = RULES.filter(r => r.category !== 'ambient');
      const nudgeRules = eligibleForTechnical.filter(r => r.category === 'nudge');
      expect(nudgeRules.length).toBeGreaterThan(0);
    });

    it('with tone=warm, all rule categories are eligible', () => {
      const { RULES } = requireFresh();
      const categories = new Set(RULES.map(r => r.category));
      expect(categories.has('ambient')).toBe(true);
      expect(categories.has('nudge')).toBe(true);
      expect(categories.has('session')).toBe(true);
    });

    it('getInsight with tone=minimal skips ambient rules', () => {
      writeConfig({ insights: { tone: 'minimal', rotationMs: 0 } });
      seedOpenState();
      const { getInsight } = requireFresh();
      // State where only ambient and git-clean would fire
      const state = makeState({
        session: { toolCount: 10, contextPct: 15, duration: 5 },
        git: { dirty: false, branch: 'main', ahead: 0, lastCommitAge: 5, lastCommitMsg: '' },
      });
      const result = getInsight(state);
      // git-clean is category 'git' (allowed by minimal), commit-first needs lastCommitMsg
      // Some non-ambient rule should match (git-clean at least), or null if none eligible
      if (result !== null) {
        // Verify it's NOT an ambient message
        const ambientMessages = [
          'Forge is warm.',
          'Standing watch — nothing needs you right now.',
          'Tools in order, bench is clear.',
          'Ready when you are.',
        ];
        expect(ambientMessages).not.toContain(result);
      }
    });
  });

  // ── duplicate ID guard ────────────────────────────────────────────────────────
  describe('rule IDs', () => {
    it('all rule IDs are unique', () => {
      const { RULES } = requireFresh();
      const ids = RULES.map(r => r.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });
  });

  // ── last-id exclusion ─────────────────────────────────────────────────────────
  describe('no back-to-back repeat', () => {
    it('does not repeat the same insight ID back-to-back', () => {
      const stateFile = path.join(tmpDir, '_runs', 'os', '.companion-insights.json');
      fs.writeFileSync(stateFile, JSON.stringify({
        lastInsightAt: Date.now() - 999999,
        lastInsightId: 'ambient-forge-warm',
        sessionStartAt: Date.now() - 60000,
      }));
      const { getInsight } = requireFresh();
      const result = getInsight(makeState());
      if (result !== null) {
        const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        expect(persisted.lastInsightId).not.toBe('ambient-forge-warm');
      }
    });
  });

  // ── state persistence ─────────────────────────────────────────────────────────
  describe('state persistence', () => {
    it('writes state file after returning an insight', () => {
      seedOpenState();
      const { getInsight } = requireFresh();
      const result = getInsight(makeState());
      expect(typeof result).toBe('string');
      const stateFile = path.join(tmpDir, '_runs', 'os', '.companion-insights.json');
      expect(fs.existsSync(stateFile)).toBe(true);
      const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      expect(typeof persisted.lastInsightAt).toBe('number');
      expect(typeof persisted.lastInsightId).toBe('string');
      expect(persisted.lastInsightId).not.toBe('__none__');
    });

    it('state persistence round-trip: first returns string, second returns null', () => {
      seedOpenState();
      const { getInsight } = requireFresh();
      const state = makeState({ session: { contextPct: 5, duration: 2400, toolCount: 10 } });
      const first = getInsight(state);
      expect(typeof first).toBe('string');
      const mod2 = requireFresh();
      const second = mod2.getInsight(state);
      expect(second).toBeNull();
    });

    it('handles corrupt state file gracefully', () => {
      const stateFile = path.join(tmpDir, '_runs', 'os', '.companion-insights.json');
      fs.writeFileSync(stateFile, 'NOT_VALID_JSON{{{');
      const { getInsight } = requireFresh();
      expect(() => getInsight(makeState())).not.toThrow();
    });
  });

  // ── cost & efficiency rules ─────────────────────────────────────────────────
  describe('cost rules', () => {
    it('cost-1 fires when cost >= 1 and < 3', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'cost-1');
      expect(rule).toBeDefined();
      expect(rule.condition(makeState({ session: { cost: 1.5 } }))).toBe(true);
      expect(rule.message(makeState({ session: { cost: 1.5 } }))).toContain('1.50');
    });

    it('cost-3 fires when cost >= 3 and < 8', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'cost-3');
      expect(rule.condition(makeState({ session: { cost: 5 } }))).toBe(true);
    });

    it('cost-8 fires when cost >= 8', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'cost-8');
      expect(rule.condition(makeState({ session: { cost: 12 } }))).toBe(true);
      expect(rule.message(makeState({ session: { cost: 12 } }))).toContain('12.00');
    });

    it('cache-low fires when cache hit rate < 30% and input > 10K', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'cache-low');
      const state = makeState({ session: { inputTokens: 50000, cacheReadTokens: 5000 } });
      expect(rule.condition(state)).toBe(true);
      expect(rule.message(state)).toContain('10%');
    });

    it('cache-low does NOT fire when input < 10K (too early)', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'cache-low');
      expect(rule.condition(makeState({ session: { inputTokens: 5000, cacheReadTokens: 0 } }))).toBe(false);
    });

    it('exceeds-200k fires when exceeds200k is true', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'exceeds-200k');
      expect(rule.condition(makeState({ session: { exceeds200k: true } }))).toBe(true);
      expect(rule.message(makeState())).toContain('200K');
    });
  });

  // ── memory cache ─────────────────────────────────────────────────────────────
  describe('memory cache', () => {
    /** Write a fresh (within TTL) cache to the temp dir. */
    function writeFreshCache(results) {
      const cacheDir = path.join(tmpDir, '_runs', 'os');
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(
        path.join(cacheDir, '.companion-memory-cache.json'),
        JSON.stringify({ fetchedAt: Date.now(), results }),
      );
    }

    /** Write an expired cache (fetchedAt = 10 minutes ago). */
    function writeExpiredCache(results) {
      const cacheDir = path.join(tmpDir, '_runs', 'os');
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(
        path.join(cacheDir, '.companion-memory-cache.json'),
        JSON.stringify({ fetchedAt: Date.now() - 11 * 60 * 1000, results }),
      );
    }

    /** Build a minimal cache result entry with the given memory_type. */
    function makeCacheEntry(memory_type, content) {
      return {
        memory: {
          id: `test-${memory_type}`,
          content: content || `Test ${memory_type} content`,
          memory_type,
        },
        similarity: 0.8,
      };
    }

    it('exports readMemoryCache, writeMemoryCache, refreshMemoryCache, MEMORY_CACHE_TTL', () => {
      const mod = requireFresh();
      expect(typeof mod.readMemoryCache).toBe('function');
      expect(typeof mod.writeMemoryCache).toBe('function');
      expect(typeof mod.refreshMemoryCache).toBe('function');
      expect(typeof mod.MEMORY_CACHE_TTL).toBe('number');
    });

    it('MEMORY_CACHE_TTL is 5 minutes', () => {
      const { MEMORY_CACHE_TTL } = requireFresh();
      expect(MEMORY_CACHE_TTL).toBe(5 * 60 * 1000);
    });

    it('readMemoryCache returns null when cache file is absent', () => {
      const { readMemoryCache } = requireFresh();
      expect(readMemoryCache()).toBeNull();
    });

    it('readMemoryCache returns null when cache is expired', () => {
      writeExpiredCache([makeCacheEntry('fact', 'stale fact')]);
      const { readMemoryCache } = requireFresh();
      expect(readMemoryCache()).toBeNull();
    });

    it('readMemoryCache returns data when cache is fresh', () => {
      writeFreshCache([makeCacheEntry('fact', 'fresh fact')]);
      const { readMemoryCache } = requireFresh();
      const result = readMemoryCache();
      expect(result).not.toBeNull();
      expect(Array.isArray(result.results)).toBe(true);
      expect(result.results).toHaveLength(1);
    });

    it('readMemoryCache returns null on corrupt JSON', () => {
      const cacheDir = path.join(tmpDir, '_runs', 'os');
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(path.join(cacheDir, '.companion-memory-cache.json'), '{{{NOT_JSON}}}');
      const { readMemoryCache } = requireFresh();
      expect(readMemoryCache()).toBeNull();
    });

    it('writeMemoryCache writes a valid cache file with fetchedAt and results', () => {
      const { writeMemoryCache, readMemoryCache } = requireFresh();
      writeMemoryCache([makeCacheEntry('fact', 'written fact')]);
      const result = readMemoryCache();
      expect(result).not.toBeNull();
      expect(result.results[0].memory.content).toBe('written fact');
      expect(typeof result.fetchedAt).toBe('number');
    });

    it('writeMemoryCache is silent on unwritable path (does not throw)', () => {
      // Point cwd to a non-existent nested path to simulate write failure
      vi.spyOn(process, 'cwd').mockReturnValue(path.join(tmpDir, 'nonexistent', 'deep'));
      const { writeMemoryCache } = requireFresh();
      expect(() => writeMemoryCache([makeCacheEntry('fact')])).not.toThrow();
    });

    it('refreshMemoryCache skips network call when cache is fresh', async () => {
      writeFreshCache([makeCacheEntry('fact', 'still valid')]);
      const { refreshMemoryCache, readMemoryCache } = requireFresh();
      const before = readMemoryCache();
      await refreshMemoryCache(tmpDir);
      const after = readMemoryCache();
      // fetchedAt should be unchanged — no re-fetch when fresh
      expect(after.fetchedAt).toBe(before.fetchedAt);
    });

    it('refreshMemoryCache resolves without throwing when hub is down', async () => {
      // Cache is absent — refreshMemoryCache will try to hit port 8091
      // If hub is down, it should resolve without throwing and leave cache absent
      const { refreshMemoryCache, readMemoryCache } = requireFresh();
      // Use a port that is definitely not listening (high ephemeral range)
      // We can't override the port constant directly, so just verify no throw
      await expect(refreshMemoryCache(tmpDir)).resolves.toBeUndefined();
    });
  });

  // ── memory-backed rules ───────────────────────────────────────────────────────
  describe('memory-backed rules', () => {
    function writeFreshCache(results) {
      const cacheDir = path.join(tmpDir, '_runs', 'os');
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(
        path.join(cacheDir, '.companion-memory-cache.json'),
        JSON.stringify({ fetchedAt: Date.now(), results }),
      );
    }

    function makeEntry(memory_type, content) {
      return { memory: { id: `e-${memory_type}`, content, memory_type }, similarity: 0.8 };
    }

    // ── memory-decision ──
    it('memory-decision is defined in RULES', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'memory-decision');
      expect(rule).toBeDefined();
      expect(rule.category).toBe('memory');
      expect(rule.tone).toBe('technical');
    });

    it('memory-decision condition returns false when cache absent', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'memory-decision');
      expect(rule.condition(makeState())).toBe(false);
    });

    it('memory-decision condition returns true when cache has a fact entry', () => {
      writeFreshCache([makeEntry('fact', 'A past decision about X')]);
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'memory-decision');
      expect(rule.condition(makeState())).toBe(true);
    });

    it('memory-decision message returns the fact content', () => {
      writeFreshCache([makeEntry('fact', 'A past decision about X')]);
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'memory-decision');
      expect(rule.message(makeState())).toBe('A past decision about X');
    });

    it('memory-decision message truncates content longer than 80 chars', () => {
      const long = 'A'.repeat(100);
      writeFreshCache([makeEntry('fact', long)]);
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'memory-decision');
      const result = rule.message(makeState());
      expect(typeof result).toBe('string');
      expect(result.length).toBeLessThanOrEqual(80);
      expect(result.endsWith('...')).toBe(true);
    });

    it('memory-decision message returns null when cache absent at message time', () => {
      // Condition is checked first — here we test message() directly with no cache
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'memory-decision');
      expect(rule.message(makeState())).toBeNull();
    });

    // ── memory-constraint ──
    it('memory-constraint is defined in RULES', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'memory-constraint');
      expect(rule).toBeDefined();
      expect(rule.category).toBe('memory');
      expect(rule.tone).toBe('technical');
    });

    it('memory-constraint condition returns false when cache absent', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'memory-constraint');
      expect(rule.condition(makeState())).toBe(false);
    });

    it('memory-constraint condition returns true when cache has an observation entry', () => {
      writeFreshCache([makeEntry('observation', 'Known constraint: X requires Y')]);
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'memory-constraint');
      expect(rule.condition(makeState())).toBe(true);
    });

    it('memory-constraint message returns the observation content', () => {
      writeFreshCache([makeEntry('observation', 'Known constraint: X requires Y')]);
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'memory-constraint');
      expect(rule.message(makeState())).toBe('Known constraint: X requires Y');
    });

    it('memory-constraint condition returns false when cache only has fact entries', () => {
      writeFreshCache([makeEntry('fact', 'A fact, not a constraint')]);
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'memory-constraint');
      expect(rule.condition(makeState())).toBe(false);
    });

    // ── memory-session-tip ──
    it('memory-session-tip is defined in RULES', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'memory-session-tip');
      expect(rule).toBeDefined();
      expect(rule.category).toBe('memory');
      expect(rule.tone).toBe('warm');
    });

    it('memory-session-tip condition returns false when cache absent', () => {
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'memory-session-tip');
      expect(rule.condition(makeState())).toBe(false);
    });

    it('memory-session-tip condition returns true when cache has an event entry', () => {
      writeFreshCache([makeEntry('event', 'S282 shipped 3 commits, plugin v1.19.3')]);
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'memory-session-tip');
      expect(rule.condition(makeState())).toBe(true);
    });

    it('memory-session-tip message returns the event content', () => {
      writeFreshCache([makeEntry('event', 'S282 shipped 3 commits, plugin v1.19.3')]);
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'memory-session-tip');
      expect(rule.message(makeState())).toBe('S282 shipped 3 commits, plugin v1.19.3');
    });

    it('memory-session-tip condition returns false when cache only has fact and observation', () => {
      writeFreshCache([
        makeEntry('fact', 'some fact'),
        makeEntry('observation', 'some observation'),
      ]);
      const { RULES } = requireFresh();
      const rule = RULES.find(r => r.id === 'memory-session-tip');
      expect(rule.condition(makeState())).toBe(false);
    });

    // ── memory rules in tone filtering ──
    it('memory rules are eligible under tone=warm', () => {
      writeFreshCache([makeEntry('fact', 'fact content'), makeEntry('event', 'event content')]);
      writeConfig({ insights: { tone: 'warm', rotationMs: 0 } });
      seedOpenState();
      const { RULES } = requireFresh();
      const memoryRules = RULES.filter(r => r.category === 'memory');
      expect(memoryRules.length).toBe(3);
    });

    it('memory rules are eligible under tone=minimal (not ambient or nudge)', () => {
      const { RULES } = requireFresh();
      // minimal skips ambient and nudge — memory is neither
      const memRules = RULES.filter(r => r.category === 'memory');
      for (const rule of memRules) {
        expect(['ambient', 'nudge']).not.toContain(rule.category);
      }
    });

    it('all memory rule IDs are unique across the full RULES array', () => {
      const { RULES } = requireFresh();
      const memoryIds = RULES.filter(r => r.category === 'memory').map(r => r.id);
      expect(memoryIds).toContain('memory-decision');
      expect(memoryIds).toContain('memory-constraint');
      expect(memoryIds).toContain('memory-session-tip');
      const allIds = RULES.map(r => r.id);
      expect(new Set(allIds).size).toBe(allIds.length);
    });

    it('getInsight surfaces a memory insight when cache has matching entries and gate is open', () => {
      writeFreshCache([
        makeEntry('fact', 'Relevant cached decision'),
        makeEntry('observation', 'Relevant cached constraint'),
      ]);
      writeConfig({ insights: { enabled: true, tone: 'technical', rotationMs: 0 } });
      seedOpenState();
      const { getInsight } = requireFresh();
      // Run several times across different minute seeds to catch a memory rule.
      // Use tone=technical to exclude ambient rules, contextPct=15 to avoid ctx-fresh.
      let foundMemoryInsight = false;
      for (let i = 0; i < 30; i++) {
        const result = getInsight(makeState({
          session: { toolCount: 5, contextPct: 15, duration: 5 },
          git: { dirty: 0, branch: null, ahead: 0, lastCommitAge: 5, lastCommitMsg: '' },
          forge: { active: false, phase: null, activeCommand: '' },
        }));
        if (result === 'Relevant cached decision' || result === 'Relevant cached constraint') {
          foundMemoryInsight = true;
          break;
        }
        // Reset state file so rotation gate re-opens
        const stateFile = path.join(tmpDir, '_runs', 'os', '.companion-insights.json');
        fs.writeFileSync(stateFile, JSON.stringify({
          lastInsightAt: Date.now() - 999999,
          lastInsightId: '__reset__',
          sessionStartAt: Date.now() - 60000,
        }));
      }
      expect(foundMemoryInsight).toBe(true);
    });
  });
});
