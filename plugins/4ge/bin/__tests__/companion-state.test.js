import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Helpers to isolate state file per test
const TEST_STATE_DIR = path.resolve(process.cwd(), '_runs/os');
const TEST_STATE_PATH = path.resolve(TEST_STATE_DIR, '.companion-state-test-cs.json');
process.env.COMPANION_STATE_PATH = TEST_STATE_PATH;
const RETIRED_STATE_KEYS = ['push', 'interrupted', 'model-change', 'effort-change', 'user-typing'];

function clearState() {
  try { fs.unlinkSync(TEST_STATE_PATH); } catch { /* ok */ }
}

function writeState(state) {
  if (!fs.existsSync(TEST_STATE_DIR)) fs.mkdirSync(TEST_STATE_DIR, { recursive: true });
  fs.writeFileSync(TEST_STATE_PATH, JSON.stringify(state));
}

function readState() {
  return JSON.parse(fs.readFileSync(TEST_STATE_PATH, 'utf8'));
}

function requireFresh() {
  const modPath = path.resolve(__dirname, '../companion-state.cjs');
  delete require.cache[modPath];
  return require(modPath);
}

describe('companion-state', () => {
  beforeEach(() => clearState());
  afterEach(() => clearState());

  describe('resolveExpression', () => {
    it('returns proud joy (idle face) on first call with empty stdin', () => {
      const { resolveExpression } = requireFresh();
      const result = resolveExpression({});
      expect(result.expression).toBe('proud joy');
      expect(result.mode).toBe('standard');
    });

    it('returns exhausted when context > 80%', () => {
      const { resolveExpression } = requireFresh();
      const result = resolveExpression({
        context_window: { used_percentage: 85 },
      });
      expect(result.expression).toBe('exhausted');
    });

    it('returns sleepy when rate limited', () => {
      const { resolveExpression } = requireFresh();
      const result = resolveExpression({
        rate_limits: { five_hour: { used_percentage: 96 } },
      });
      expect(result.expression).toBe('sleepy');
      expect(result.mode).toBe('standard'); // was 'compact' pre-S292; changed P1-HUD-DOCS da86221
    });

    it('respects event hint over detected state', () => {
      const { resolveExpression } = requireFresh();
      const result = resolveExpression({}, 'commit');
      expect(result.expression).toBe('proud joy');
    });

    it('holds expression during dwell time', () => {
      const { resolveExpression, signalEvent } = requireFresh();
      // Signal a commit event
      signalEvent('commit');
      // Immediately resolve — should hold commit expression
      const result = resolveExpression({});
      expect(result.expression).toBe('proud joy');
    });
  });

  // 2026-04-27 Task 1: regression coverage for the S332 T9 resume guard.
  // Pre-existing fix had no test; loosened predicate (session-id mismatch +
  // zero output tokens) lets the guard fire on /compact and sentinel re-entry
  // boots where stdin.session.toolCount is stale.
  describe('resolveExpression — session-resume guard (H7 / S332 + Task 1)', () => {
    const STALE_MS = 1_000_000; // > default veryLongIdleS (900s)

    it('S332 baseline: cold-boot stdin (zero everything) resets stale lastToolAt', () => {
      writeState({
        expression: 'exhausted',
        gaze: 'forward',
        mode: 'standard',
        stateKey: 'context-warn',
        changedAt: Date.now() - STALE_MS,
        lastToolAt: Date.now() - STALE_MS,
        blinkAt: 0,
        gazePhase: 0,
      });
      const { resolveExpression } = requireFresh();
      const before = Date.now();
      const result = resolveExpression({});
      const state = readState();
      expect(state.lastToolAt).toBeGreaterThanOrEqual(before);
      expect(result.expression).not.toBe('exhausted');
    });

    it('Task 1: re-entry boot with stale stdin.session.toolCount still resets when session id mismatches', () => {
      writeState({
        expression: 'exhausted',
        stateKey: 'context-warn',
        changedAt: Date.now() - STALE_MS,
        lastToolAt: Date.now() - STALE_MS,
        lastSessionId: 'old-session',
      });
      const { resolveExpression } = requireFresh();
      const before = Date.now();
      // Stale tool count from session-meta.json — this is the H7 case.
      const result = resolveExpression({
        session: { id: 'new-session', toolCount: 47, outputTokens: 0 },
        context_window: { total_output_tokens: 0 },
      });
      const state = readState();
      expect(state.lastToolAt).toBeGreaterThanOrEqual(before);
      expect(state.lastSessionId).toBe('new-session');
      expect(result.expression).not.toBe('exhausted');
    });

    it('Task 1: does NOT reset on a genuine long-idle running session (same id + non-zero output)', () => {
      writeState({
        expression: 'exhausted',
        stateKey: 'context-warn',
        changedAt: Date.now() - STALE_MS,
        lastToolAt: Date.now() - STALE_MS,
        lastSessionId: 'same-session',
      });
      const { resolveExpression } = requireFresh();
      // Same session id, real activity in the window — the resume guard
      // must NOT fire (no session-id mismatch, output tokens > 0). The
      // expression must remain 'exhausted' because context > 80%.
      const result = resolveExpression({
        session: { id: 'same-session', toolCount: 30, outputTokens: 50000 },
        context_window: { total_output_tokens: 50000, used_percentage: 85 },
      });
      expect(result.expression).toBe('exhausted');
      // (lastToolAt does get bumped later in resolveExpression because
      //  newPriority > PRIORITY.idle for context-warn — that's correct
      //  behavior for an active session and is unrelated to the resume
      //  guard. The signal we care about is the surviving 'exhausted'.)
    });

    it('Task 1: learns new session id on first observation even outside the resume window', () => {
      writeState({
        stateKey: 'idle',
        changedAt: Date.now(),
        lastToolAt: Date.now(),
      });
      const { resolveExpression } = requireFresh();
      resolveExpression({
        session: { id: 'first-seen', toolCount: 5, outputTokens: 100 },
      });
      const state = readState();
      expect(state.lastSessionId).toBe('first-seen');
    });

    it('Task 1: handles stdin.session_id (raw harness shape) in addition to stdin.session.id', () => {
      writeState({
        stateKey: 'context-warn',
        changedAt: Date.now() - STALE_MS,
        lastToolAt: Date.now() - STALE_MS,
        lastSessionId: 'old',
      });
      const { resolveExpression } = requireFresh();
      const before = Date.now();
      // Some hooks pass raw harness shape with top-level session_id.
      resolveExpression({
        session_id: 'fresh-via-raw',
        tool_count: 0,
        context_window: { total_output_tokens: 0 },
      });
      const state = readState();
      expect(state.lastSessionId).toBe('fresh-via-raw');
      expect(state.lastToolAt).toBeGreaterThanOrEqual(before);
    });
  });

  describe('signalEvent', () => {
    it('writes event to state file', () => {
      const { signalEvent } = requireFresh();
      signalEvent('tests-pass');
      const state = readState();
      expect(state.stateKey).toBe('tests-pass');
    });

    it('updates lastToolAt for high-priority events', () => {
      const { signalEvent } = requireFresh();
      const before = Date.now();
      signalEvent('commit');
      const state = readState();
      expect(state.lastToolAt).toBeGreaterThanOrEqual(before);
    });

    it('does not update lastToolAt for idle events', () => {
      const { signalEvent } = requireFresh();
      // Set a known lastToolAt
      writeState({
        stateKey: 'idle',
        changedAt: Date.now() - 10000,
        lastToolAt: 1000,
        blinkAt: 0,
        gazePhase: 0,
      });
      signalEvent('idle');
      const state = readState();
      // idle priority (10) <= idle priority, so lastToolAt unchanged
      expect(state.lastToolAt).toBe(1000);
    });

    it('retired event keys fall back to idle instead of persisting ghost states', () => {
      const { signalEvent } = requireFresh();
      for (const key of RETIRED_STATE_KEYS) {
        clearState();
        signalEvent(key);
        const state = readState();
        expect(state.stateKey, key).toBe('idle');
        expect(state.expression, key).toBe('proud joy');
      }
    });
  });

  describe('detectState', () => {
    it('returns context-warn when context exceeds threshold', () => {
      const { detectState } = requireFresh();
      const state = { lastToolAt: Date.now(), stateKey: 'idle' };
      const result = detectState({ context_window: { used_percentage: 55 } }, state);
      expect(result).toBe('context-warn');
    });

    it('returns rate-limited when rate limit >= 95%', () => {
      const { detectState } = requireFresh();
      const state = { lastToolAt: Date.now(), stateKey: 'idle' };
      const result = detectState({ rate_limits: { five_hour: { used_percentage: 96 } } }, state);
      expect(result).toBe('rate-limited');
    });

    it('returns idle after 30s of inactivity', () => {
      const { detectState, IDLE_THRESHOLD_S } = requireFresh();
      const state = { lastToolAt: Date.now() - (IDLE_THRESHOLD_S + 1) * 1000, stateKey: 'tool-running' };
      const result = detectState({}, state);
      expect(result).toBe('idle');
    });

    it('returns long-idle after 5min of inactivity', () => {
      const { detectState, LONG_IDLE_S } = requireFresh();
      const state = { lastToolAt: Date.now() - (LONG_IDLE_S + 1) * 1000, stateKey: 'idle' };
      const result = detectState({}, state);
      expect(result).toBe('long-idle');
    });

    it('returns idle when no condition triggers — event persistence handled by resolveExpression', () => {
      const { detectState } = requireFresh();
      const state = { lastToolAt: Date.now(), stateKey: 'tests-pass' };
      const result = detectState({}, state);
      expect(result).toBe('idle');
    });

    it('detects context-warn from canonical session.contextPct', () => {
      const { detectState } = requireFresh();
      const state = { lastToolAt: Date.now(), stateKey: 'idle' };
      const result = detectState({ session: { contextPct: 60 } }, state);
      expect(result).toBe('context-warn');
    });

    it('returns tool-running when outputTokens increases (harness path)', () => {
      const { detectState } = requireFresh();
      const state = { lastToolAt: Date.now(), stateKey: 'idle', totalOutputTokens: 1000 };
      const result = detectState({ context_window: { total_output_tokens: 1500 } }, state);
      expect(result).toBe('tool-running');
    });

    it('returns tool-running when outputTokens increases (canonical path)', () => {
      const { detectState } = requireFresh();
      const state = { lastToolAt: Date.now(), stateKey: 'idle', totalOutputTokens: 1000 };
      const result = detectState({ session: { outputTokens: 1500 } }, state);
      expect(result).toBe('tool-running');
    });

    it('detects rate-limited from seven_day tier', () => {
      const { detectState } = requireFresh();
      const state = { lastToolAt: Date.now(), stateKey: 'idle' };
      const result = detectState({ rate_limits: { seven_day: { used_percentage: 98 } } }, state);
      expect(result).toBe('rate-limited');
    });

    it('does not rate-limit when below 95%', () => {
      const { detectState } = requireFresh();
      const state = { lastToolAt: Date.now(), stateKey: 'idle' };
      const result = detectState({ rate_limits: { five_hour: { used_percentage: 80 } } }, state);
      expect(result).toBe('idle');
    });

    it('returns rate-limited (sleepy expression) when contextSleepyPct threshold hit', () => {
      const { detectState } = requireFresh();
      const state = { lastToolAt: Date.now(), stateKey: 'idle' };
      // Default contextSleepyPct=35, contextWarnPct=50. 40% triggers sleepy (rate-limited key).
      const result = detectState({ context_window: { used_percentage: 40 } }, state);
      expect(result).toBe('rate-limited');
    });
  });

  describe('applyIdleAnimation', () => {
    // Hermetic config (S441): the repo's .4ge/config.json now defaults to
    // animate:false (mobile freeze). applyIdleAnimation bails early when
    // animate===false, so these ANIMATED-behavior tests must pin animate:true in
    // an isolated temp project config rather than inherit the repo default.
    let idleCfgRoot, idlePrevDir;
    beforeEach(() => {
      idleCfgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-idle-'));
      fs.mkdirSync(path.join(idleCfgRoot, '.4ge'), { recursive: true });
      fs.writeFileSync(
        path.join(idleCfgRoot, '.4ge', 'config.json'),
        JSON.stringify({ companion: { animate: true, zen: false } }),
      );
      idlePrevDir = process.env.CLAUDE_PROJECT_DIR;
      process.env.CLAUDE_PROJECT_DIR = idleCfgRoot;
      const ccPath = path.resolve(__dirname, '../companion-config.cjs');
      delete require.cache[ccPath];
      require(ccPath).clearCache();
    });
    afterEach(() => {
      if (idlePrevDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = idlePrevDir;
      const ccPath = path.resolve(__dirname, '../companion-config.cjs');
      delete require.cache[ccPath];
      try { require(ccPath).clearCache(); } catch { /* ok */ }
      try { fs.rmSync(idleCfgRoot, { recursive: true, force: true }); } catch { /* ok */ }
    });

    it('triggers blink only during long-idle', () => {
      const { applyIdleAnimation } = requireFresh();
      const result = { expression: 'neutral alive', gaze: 'forward', mode: 'standard' };
      const state = { stateKey: 'long-idle', blinkAt: 0, gazePhase: 0 };
      const now = Date.now();
      applyIdleAnimation(result, state, now);
      expect(result.expression).toBe('blink');
      expect(state.blinkAt).toBe(now);
    });

    it('does not blink during regular idle', () => {
      const { applyIdleAnimation } = requireFresh();
      const result = { expression: 'neutral alive', gaze: 'forward', mode: 'standard' };
      const state = { stateKey: 'idle', blinkAt: 0, gazePhase: 0 };
      const now = Date.now();
      applyIdleAnimation(result, state, now);
      expect(result.expression).toBe('neutral alive');
    });

    it('does not blink if recently blinked in long-idle', () => {
      const { applyIdleAnimation } = requireFresh();
      const now = Date.now();
      const result = { expression: 'neutral alive', gaze: 'forward', mode: 'standard' };
      const state = { stateKey: 'long-idle', blinkAt: now - 5000, gazePhase: 0 };
      applyIdleAnimation(result, state, now);
      expect(result.expression).toBe('neutral alive'); // no blink
    });

    it('does not animate during high-priority events', () => {
      const { applyIdleAnimation } = requireFresh();
      const result = { expression: 'anxious', gaze: 'forward', mode: 'standard' };
      const state = { stateKey: 'error', blinkAt: 0, gazePhase: 0 };
      applyIdleAnimation(result, state, Date.now());
      expect(result.expression).toBe('anxious'); // unchanged
    });

    it('does not animate in compact mode', () => {
      const { applyIdleAnimation } = requireFresh();
      const result = { expression: 'thinking', gaze: 'forward', mode: 'compact' };
      const state = { stateKey: 'idle', blinkAt: 0, gazePhase: 0 };
      applyIdleAnimation(result, state, Date.now());
      expect(result.expression).toBe('thinking'); // unchanged
    });

    it('applies gaze drift in 60s cycle', () => {
      const { applyIdleAnimation } = requireFresh();
      const result = { expression: 'neutral alive', gaze: 'forward', mode: 'standard' };
      const state = { stateKey: 'idle', blinkAt: Date.now(), gazePhase: 0 };
      // At 15s into the cycle, gazePhase should be 1 (left)
      const now = Math.floor(Date.now() / 1000) * 1000; // align to second
      const at15s = (Math.floor(now / 60000) * 60000) + 15000; // 15s into current minute
      applyIdleAnimation(result, state, at15s);
      expect(result.gaze).toBe('left');
    });
  });

  describe('Wave 1: zen forces calm in applyIdleAnimation', () => {
    let cfgRoot;
    let prevProjectDir;

    function writeCompanionConfig(companion) {
      const dir = path.join(cfgRoot, '.4ge');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ companion }));
      // The config loader keys off CLAUDE_PROJECT_DIR || cwd; point it at our temp root.
      process.env.CLAUDE_PROJECT_DIR = cfgRoot;
      // Bust the 10s loader cache so the new config is read.
      const ccPath = path.resolve(__dirname, '../companion-config.cjs');
      delete require.cache[ccPath];
      require(ccPath).clearCache();
    }

    beforeEach(() => {
      cfgRoot = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cs-zen-'));
      prevProjectDir = process.env.CLAUDE_PROJECT_DIR;
    });

    afterEach(() => {
      if (prevProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = prevProjectDir;
      const ccPath = path.resolve(__dirname, '../companion-config.cjs');
      delete require.cache[ccPath];
      try { require(ccPath).clearCache(); } catch { /* ok */ }
      fs.rmSync(cfgRoot, { recursive: true, force: true });
    });

    it('suppresses gaze drift when zen is true (calm, no drift)', () => {
      writeCompanionConfig({ zen: true });
      const { applyIdleAnimation } = requireFresh();
      const result = { expression: 'neutral alive', gaze: 'forward', mode: 'standard' };
      const state = { stateKey: 'idle', blinkAt: Date.now(), gazePhase: 0 };
      const now = Math.floor(Date.now() / 1000) * 1000;
      const at15s = (Math.floor(now / 60000) * 60000) + 15000;
      applyIdleAnimation(result, state, at15s);
      expect(result.gaze).toBe('forward'); // no drift under zen
    });

    it('suppresses long-idle blink when zen is true', () => {
      writeCompanionConfig({ zen: true });
      const { applyIdleAnimation } = requireFresh();
      const result = { expression: 'neutral alive', gaze: 'forward', mode: 'standard' };
      const state = { stateKey: 'long-idle', blinkAt: 0, gazePhase: 0 };
      applyIdleAnimation(result, state, Date.now());
      expect(result.expression).toBe('neutral alive'); // no blink under zen
    });

    it('still animates when zen is false and animate is true (control)', () => {
      writeCompanionConfig({ zen: false, animate: true });
      const { applyIdleAnimation } = requireFresh();
      const result = { expression: 'neutral alive', gaze: 'forward', mode: 'standard' };
      const state = { stateKey: 'idle', blinkAt: Date.now(), gazePhase: 0 };
      const now = Math.floor(Date.now() / 1000) * 1000;
      const at15s = (Math.floor(now / 60000) * 60000) + 15000;
      applyIdleAnimation(result, state, at15s);
      expect(result.gaze).toBe('left'); // drift fires normally
    });
  });

  describe('Wave 1: signalMessage maxLen override', () => {
    it('truncates to 60 chars by default', () => {
      const { signalMessage, activeMessage } = requireFresh();
      const long = 'x'.repeat(120);
      signalMessage(long, { tier: 'critical' });
      const am = activeMessage();
      expect([...am.text].length).toBe(60);
    });

    it('honors an elevated maxLen so the long update notice renders in full', () => {
      const { signalMessage, activeMessage } = requireFresh();
      const notice = '⚙ Face/motion settings updated — yours: calm. Change: /hud face lively · /hud zen · keep: /hud face ok';
      signalMessage(notice, { tier: 'critical', maxLen: 110 });
      const am = activeMessage();
      expect(am.text).toContain('/hud face ok'); // the tail survives (default 60-cap would cut it)
    });

    it('caps maxLen at 200 to bound statusline width', () => {
      const { signalMessage, activeMessage } = requireFresh();
      const huge = 'y'.repeat(400);
      signalMessage(huge, { tier: 'critical', maxLen: 999 });
      const am = activeMessage();
      expect([...am.text].length).toBe(200);
    });
  });

  describe('priority ordering', () => {
    it('error overrides tool-running', () => {
      const { PRIORITY } = requireFresh();
      expect(PRIORITY.error).toBeGreaterThan(PRIORITY['tool-running']);
    });

    it('boot is highest priority', () => {
      const { PRIORITY } = requireFresh();
      const max = Math.max(...Object.values(PRIORITY));
      expect(PRIORITY.boot).toBe(max);
    });

    it('long-idle is lowest priority', () => {
      const { PRIORITY } = requireFresh();
      const min = Math.min(...Object.values(PRIORITY));
      expect(PRIORITY['long-idle']).toBe(min);
    });

    it('tests-fail overrides tests-pass', () => {
      const { PRIORITY } = requireFresh();
      expect(PRIORITY['tests-fail']).toBeGreaterThan(PRIORITY['tests-pass']);
    });

    it('does not retain retired zero-producer state priorities', () => {
      const { PRIORITY } = requireFresh();
      for (const key of RETIRED_STATE_KEYS) {
        expect(PRIORITY[key], key).toBeUndefined();
      }
    });
  });

  describe('STATE_MAP coverage', () => {
    it('every priority key has a STATE_MAP entry', () => {
      const { PRIORITY, STATE_MAP } = requireFresh();
      for (const key of Object.keys(PRIORITY)) {
        expect(STATE_MAP[key]).toBeDefined();
      }
    });

    it('every STATE_MAP entry has expression, gaze, mode', () => {
      const { STATE_MAP } = requireFresh();
      for (const val of Object.values(STATE_MAP)) {
        expect(val.expression).toBeDefined();
        expect(val.gaze).toBeDefined();
        expect(val.mode).toBeDefined();
      }
    });

    it('does not retain retired zero-producer state mappings', () => {
      const { STATE_MAP } = requireFresh();
      for (const key of RETIRED_STATE_KEYS) {
        expect(STATE_MAP[key], key).toBeUndefined();
      }
    });
  });

  describe('retired event hints', () => {
    it('resolveExpression falls back to idle for retired event hints', () => {
      const { resolveExpression } = requireFresh();
      for (const key of RETIRED_STATE_KEYS) {
        clearState();
        const result = resolveExpression({}, key);
        expect(result.stateKey, key).toBe('idle');
        expect(result.expression, key).toBe('proud joy');
      }
    });
  });

  describe('boot animation', () => {
    it('startBoot sets bootActive and frame 0', () => {
      const { startBoot } = requireFresh();
      startBoot(8); // target: proud joy
      const state = readState();
      expect(state.bootActive).toBe(true);
      expect(state.bootFrame).toBe(0);
      expect(state.bootTarget).toBe(8);
    });

    it('resolveExpression advances boot frames', () => {
      const { startBoot, resolveExpression } = requireFresh();
      startBoot(3); // target: neutral alive (frame 3)

      const r0 = resolveExpression({});
      expect(r0.expression).toBe('dead');        // frame 0
      expect(r0.mode).toBe('expanded');

      const r1 = resolveExpression({});
      expect(r1.expression).toBe('exhausted');    // frame 1

      const r2 = resolveExpression({});
      expect(r2.expression).toBe('sleepy');       // frame 2

      const r3 = resolveExpression({});
      expect(r3.expression).toBe('neutral alive'); // frame 3 (target)

      // Next tick: boot should be complete, back to normal state machine
      const r4 = resolveExpression({});
      expect(r4.expression).not.toBe('dead');
      const state = readState();
      expect(state.bootActive).toBeFalsy();
    });

    it('boot clamps target to sequence length', () => {
      const { startBoot, BOOT_SEQUENCE } = requireFresh();
      startBoot(999);
      const state = readState();
      expect(state.bootTarget).toBe(BOOT_SEQUENCE.length - 1);
    });

    it('BOOT_SEQUENCE has 9 frames', () => {
      const { BOOT_SEQUENCE } = requireFresh();
      expect(BOOT_SEQUENCE).toHaveLength(9);
    });
  });

  describe('heartbeat', () => {
    it('keeps session alive when statusLine ticks', () => {
      const { resolveExpression } = requireFresh();
      // Simulate old lastToolAt (would be long-idle without heartbeat)
      writeState({
        stateKey: 'idle',
        changedAt: Date.now() - 400000,
        lastToolAt: Date.now() - 400000,
        lastHeartbeat: 0,
        blinkAt: Date.now(),
        gazePhase: 0,
      });
      const result = resolveExpression({});
      // Should NOT be long-idle because heartbeat refreshes lastToolAt
      expect(result.expression).not.toBe('sleepy');
    });
  });

  describe('message tiers (S302)', () => {
    it('signalMessage with tier=flash uses the flash dwell TTL (15s)', () => {
      const { signalMessage, TIER_TTL } = requireFresh();
      signalMessage('test flash', { tier: 'flash' });
      const state = readState();
      expect(state.message.tier).toBe('flash');
      expect(state.message.ttl).toBe(TIER_TTL.flash);
    });

    it('signalMessage with tier=signal uses 30s TTL', () => {
      const { signalMessage, TIER_TTL } = requireFresh();
      signalMessage('test signal', { tier: 'signal' });
      const state = readState();
      expect(state.message.tier).toBe('signal');
      expect(state.message.ttl).toBe(TIER_TTL.signal);
    });

    it('signalMessage with tier=critical uses 120s TTL', () => {
      const { signalMessage, TIER_TTL } = requireFresh();
      signalMessage('test critical', { tier: 'critical' });
      const state = readState();
      expect(state.message.tier).toBe('critical');
      expect(state.message.ttl).toBe(TIER_TTL.critical);
    });

    it('higher tier replaces active lower-tier message', () => {
      const { signalMessage } = requireFresh();
      signalMessage('flash msg', { tier: 'flash' });
      signalMessage('critical msg', { tier: 'critical' });
      const state = readState();
      expect(state.message.text).toBe('critical msg');
      expect(state.message.tier).toBe('critical');
    });

    it('lower tier does NOT overwrite active higher-tier message', () => {
      const { signalMessage } = requireFresh();
      signalMessage('critical msg', { tier: 'critical' });
      signalMessage('flash msg', { tier: 'flash' });
      const state = readState();
      expect(state.message.text).toBe('critical msg');
      expect(state.message.tier).toBe('critical');
    });

    it('backward-compat: signalMessage(text, ttlMs) still works', () => {
      const { signalMessage } = requireFresh();
      signalMessage('legacy', 5000);
      const state = readState();
      expect(state.message.text).toBe('legacy');
      expect(state.message.ttl).toBe(5000);
      expect(state.message.tier).toBe('flash');
    });

    it('explicit ttlMs option overrides tier default', () => {
      const { signalMessage } = requireFresh();
      signalMessage('custom', { tier: 'signal', ttlMs: 99999 });
      const state = readState();
      expect(state.message.ttl).toBe(99999);
    });

    it('refreshMessage resets timestamp on active message', () => {
      const { signalMessage, refreshMessage } = requireFresh();
      signalMessage('keep me', { tier: 'signal' });
      const beforeAt = readState().message.at;
      // Simulate passage of time by tweaking state directly
      const s = readState();
      s.message.at = beforeAt - 5000;
      writeState(s);
      refreshMessage();
      const afterAt = readState().message.at;
      expect(afterAt).toBeGreaterThan(beforeAt - 5000);
    });

    it('refreshMessage does NOT resurrect expired messages', () => {
      const { signalMessage, refreshMessage, activeMessage } = requireFresh();
      signalMessage('expired', { tier: 'flash' });
      // Manually age the message past its TTL
      const s = readState();
      s.message.at = Date.now() - 20000;
      writeState(s);
      refreshMessage();
      expect(activeMessage()).toBeNull();
    });

    it('activeMessage returns tier field', () => {
      const { signalMessage, activeMessage } = requireFresh();
      signalMessage('has tier', { tier: 'critical' });
      const am = activeMessage();
      expect(am).not.toBeNull();
      expect(am.tier).toBe('critical');
    });

    it('unknown tier falls back to flash', () => {
      const { signalMessage } = requireFresh();
      signalMessage('bogus', { tier: 'ultracritical' });
      const state = readState();
      expect(state.message.tier).toBe('flash');
    });

    // security-auditor SEC-P1-1
    it('strips ANSI escape sequences from message text', () => {
      const { signalMessage } = requireFresh();
      signalMessage('\x1b[48;5;196mRED BG\x1b[0m actual text', { tier: 'flash' });
      const state = readState();
      expect(state.message.text).not.toContain('\x1b');
      expect(state.message.text).toContain('actual text');
    });

    it('strips control characters from message text', () => {
      const { signalMessage } = requireFresh();
      signalMessage('text\x00with\x07control\x1fchars', { tier: 'flash' });
      const state = readState();
      expect(state.message.text).not.toMatch(/[\x00\x07\x1f]/);
    });

    it('preserves tab and newline (not stripped)', () => {
      const { signalMessage } = requireFresh();
      signalMessage('tab\tnewline\n', { tier: 'flash' });
      const state = readState();
      // Tab and newline are informational, not injection vectors
      expect(state.message.text).toMatch(/tab/);
    });
  });

  describe('message cooldown (rate limiter — "slow the messages down")', () => {
    it('suppresses a non-critical message within the cooldown window', () => {
      const { signalMessage } = requireFresh();
      // A flash message was just posted (default cooldown is 45s).
      writeState({ message: { text: 'first', at: Date.now(), ttl: 8000, tier: 'flash' } });
      signalMessage('second', { tier: 'flash' });
      expect(readState().message.text).toBe('first');
    });

    it('lets a critical message bypass the cooldown', () => {
      const { signalMessage } = requireFresh();
      writeState({ message: { text: 'first', at: Date.now(), ttl: 8000, tier: 'flash' } });
      signalMessage('urgent', { tier: 'critical' });
      expect(readState().message.text).toBe('urgent');
    });

    it('allows a new message once the cooldown has elapsed', () => {
      const { signalMessage } = requireFresh();
      writeState({ message: { text: 'first', at: Date.now() - 60000, ttl: 8000, tier: 'flash' } });
      signalMessage('second', { tier: 'flash' });
      expect(readState().message.text).toBe('second');
    });

    it('always posts the first message (no prior message to gate against)', () => {
      const { signalMessage } = requireFresh();
      signalMessage('hello', { tier: 'flash' });
      expect(readState().message.text).toBe('hello');
    });
  });

  describe('S440: message min-dwell replacement floor', () => {
    let cfgRoot;
    let prevProjectDir;

    function writeCompanionConfig(companion) {
      const dir = path.join(cfgRoot, '.4ge');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ companion }));
      process.env.CLAUDE_PROJECT_DIR = cfgRoot;
      const ccPath = path.resolve(__dirname, '../companion-config.cjs');
      delete require.cache[ccPath];
      require(ccPath).clearCache();
    }

    beforeEach(() => {
      cfgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-dwell-'));
      prevProjectDir = process.env.CLAUDE_PROJECT_DIR;
    });

    afterEach(() => {
      if (prevProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = prevProjectDir;
      const ccPath = path.resolve(__dirname, '../companion-config.cjs');
      delete require.cache[ccPath];
      try { require(ccPath).clearCache(); } catch { /* ok */ }
      fs.rmSync(cfgRoot, { recursive: true, force: true });
    });

    it('does not replace an active critical message before its dwell floor', () => {
      const { signalMessage } = requireFresh();
      writeState({
        message: {
          text: 'first critical',
          at: Date.now() - 10000,
          ttl: 120000,
          tier: 'critical',
        },
      });
      signalMessage('second critical', { tier: 'critical' });
      expect(readState().message.text).toBe('first critical');
    });

    it('allows same-tier replacement after the active message dwell floor has elapsed', () => {
      const { signalMessage } = requireFresh();
      writeState({
        message: {
          text: 'first critical',
          at: Date.now() - 16000,
          ttl: 120000,
          tier: 'critical',
        },
      });
      signalMessage('second critical', { tier: 'critical' });
      expect(readState().message.text).toBe('second critical');
    });

    it('does not replace active flash chatter before its dwell floor when cooldown is disabled', () => {
      writeCompanionConfig({ messageCooldownS: 0, minDwellFlashMs: 6000 });
      const { signalMessage } = requireFresh();
      writeState({
        message: {
          text: 'first flash',
          at: Date.now() - 2000,
          ttl: 15000,
          tier: 'flash',
        },
      });
      signalMessage('second flash', { tier: 'flash' });
      expect(readState().message.text).toBe('first flash');
    });

    it('allows flash replacement after its dwell floor when cooldown is disabled', () => {
      writeCompanionConfig({ messageCooldownS: 0, minDwellFlashMs: 6000 });
      const { signalMessage } = requireFresh();
      writeState({
        message: {
          text: 'first flash',
          at: Date.now() - 7000,
          ttl: 15000,
          tier: 'flash',
        },
      });
      signalMessage('second flash', { tier: 'flash' });
      expect(readState().message.text).toBe('second flash');
    });
  });
});
