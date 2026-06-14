'use strict';
// companion-state.cjs — Expression state machine for the DIS-ARC-005 companion system.
//
// Maps session state (from statusLine stdin JSON + persisted state) to:
//   { expression, gaze, mode, frame }
//
// Called by hud-engine.cjs on every statusLine tick. Reads/writes
// _runs/os/.companion-state.json for cross-tick persistence.

const fs = require('fs');
const path = require('path');
const { loadCompanionConfig } = require('./companion-config.cjs');
const { writeFileAtomic } = require('../lib/atomic-write.cjs');

// ── Constants (configurable via .4ge/config.json → companion key) ──
// Config loaded per-call via cc() so changes apply without session restart.

function cc() { return loadCompanionConfig(); }
const STATE_PATH = process.env.COMPANION_STATE_PATH || path.resolve(__dirname, '..', '..', '..', '_runs', 'os', '.companion-state.json');

// ── Expression Priority (higher = overrides lower) ──

const PRIORITY = {
  error: 90,
  'rate-limited': 85,
  'context-warn': 80,
  'tests-fail': 70,
  'tests-pass': 60,
  commit: 55,
  'agent-dispatch': 50,
  'agent-return': 50,
  'tool-running': 40,
  idle: 10,
  'long-idle': 5,
  boot: 100,
};

// ── State Mapping ──

const STATE_MAP = {
  boot:             { expression: 'proud joy',      gaze: 'forward', mode: 'expanded' },
  idle:             { expression: 'proud joy',      gaze: 'forward', mode: 'standard' },
  'long-idle':      { expression: 'blink',          gaze: 'forward', mode: 'standard' },
  'tool-running':   { expression: 'thinking',       gaze: 'forward', mode: 'standard' }, // was 'compact' S288, reverted S290 — semantically inert post-S290
  'tests-pass':     { expression: 'happy',          gaze: 'forward', mode: 'standard' },
  'tests-fail':     { expression: 'proud joy',      gaze: 'forward', mode: 'standard' },
  error:            { expression: 'dead',           gaze: 'forward', mode: 'standard' },
  commit:           { expression: 'proud joy',      gaze: 'forward', mode: 'standard' },
  'context-warn':   { expression: 'exhausted',      gaze: 'forward', mode: 'standard' },
  'rate-limited':   { expression: 'sleepy',         gaze: 'forward', mode: 'standard' }, // was 'compact' S288, reverted S290 — semantically inert post-S290
  'agent-dispatch': { expression: 'determined',     gaze: 'forward', mode: 'standard' },
  'agent-return':   { expression: 'sad',            gaze: 'left',    mode: 'standard' },
};

function normalizeStateKey(key) {
  return STATE_MAP[key] ? key : 'idle';
}

// ── State Persistence ──

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return {
      expression: 'neutral alive',
      gaze: 'forward',
      mode: 'standard',
      stateKey: 'idle',
      changedAt: 0,              // allow immediate transition on first tick
      lastToolAt: Date.now(),
      blinkAt: Date.now(),       // don't blink on first tick
      gazePhase: 0,
    };
  }
}

function saveState(state) {
  try {
    const dir = path.dirname(STATE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    writeFileAtomic(STATE_PATH, JSON.stringify(state));
  } catch { /* non-fatal */ }
}

// ── Session State Detection ──

/**
 * Determine the current session state from statusLine stdin JSON.
 * Returns a state key string.
 */
function detectState(stdin, prevState) {
  const _cc = cc();
  const now = Date.now();

  // 200K degradation — highest priority context signal
  if (stdin.exceeds_200k_tokens === true || (stdin.session && stdin.session.exceeds200k === true)) {
    return 'context-warn';
  }

  // Context pressure — graduated response (accepts harness stdin or canonical state)
  // Harness sends context_window.used_percentage directly; canonical state has session.contextPct
  const ctxPct = (stdin.context_window && typeof stdin.context_window.used_percentage === 'number')
    ? stdin.context_window.used_percentage
    : (stdin.session && stdin.session.contextPct) || 0;
  if (ctxPct >= _cc.contextWarnPct) return 'context-warn';
  if (ctxPct >= _cc.contextSleepyPct) return 'rate-limited';

  // Rate limiting — harness sends five_hour/seven_day with used_percentage; no requests_remaining
  if (stdin.rate_limits) {
    const rl = stdin.rate_limits;
    const tiers = [rl.five_hour, rl.seven_day].filter(Boolean);
    if (tiers.some(t => typeof t.used_percentage === 'number' && t.used_percentage >= 95)) return 'rate-limited';
  }

  // Session boundary detection — MUST run before idle time checks.
  // If outputTokens decreased, a new session started. Reset stale timestamps
  // so the idle checks below use fresh values instead of previous-session data.
  // Accept both canonical state (session.outputTokens) and raw harness JSON (context_window.total_output_tokens)
  const outputTokens = (stdin && stdin.session && stdin.session.outputTokens)
    || (stdin && stdin.context_window && stdin.context_window.total_output_tokens)
    || 0;
  const prevTokens = prevState.totalOutputTokens || 0;
  if (outputTokens > 0 && outputTokens < prevTokens) {
    prevState.totalOutputTokens = outputTokens;
    prevState.lastToolAt = now;
  }

  // Time since last tool activity
  const lastTool = prevState.lastToolAt || now;
  const idleS = (now - lastTool) / 1000;

  if (idleS > _cc.veryLongIdleS) return 'context-warn';
  if (idleS > _cc.longIdleS) return 'long-idle';
  if (idleS > _cc.idleThresholdS) return 'idle';

  // Model actively generating: outputTokens increases between ticks
  if (outputTokens > 0 && outputTokens > prevTokens) {
    return 'tool-running';
  }

  // High tool count fatigue — use persisted count since statusline stdin has no tool_count
  const tc = stdin.tool_count || prevState.toolCount || 0;
  if (tc > _cc.highToolCount && idleS > _cc.idleThresholdS / 2) return 'long-idle';

  // Default: idle.
  return 'idle';
}

// ── Idle Animation ──

/**
 * Apply idle animation overlays (blink, gaze drift).
 * Modifies expression/gaze in place based on timing.
 */
function applyIdleAnimation(result, state, now) {
  if (result.mode !== 'standard' && result.mode !== 'expanded') return;
  if (PRIORITY[state.stateKey] > PRIORITY.idle) return; // don't animate during events
  if (cc().animate === false) return; // escape hatch: no idle blink/gaze drift when animation is off

  // Blink: only during long-idle (5min+). Not a regular idle animation.
  if (state.stateKey === 'long-idle') {
    const blinkInterval = cc().blinkInterval;
    if (now - (state.blinkAt || 0) > blinkInterval) {
      result.expression = 'blink';
      state.blinkAt = now;
      return;
    }
  }

  // Gaze drift: cycle through forward → left → forward → right every 60s
  const gazePhase = Math.floor(((now / 1000) % 60) / 15); // 0-3
  const gazes = ['forward', 'left', 'forward', 'right'];
  result.gaze = gazes[gazePhase] || 'forward';
  state.gazePhase = gazePhase;
}

// ── Transition Logic ──

/**
 * Resolve the expression state for this tick.
 *
 * @param {object} stdin - statusLine stdin JSON
 * @param {string} [eventHint] - explicit event from a hook ("tests-pass", "commit", etc.)
 * @returns {{ expression: string, gaze: string, mode: string }}
 */
function resolveExpression(stdin, eventHint) {
  const now = Date.now();
  const state = loadState();
  state.stateKey = normalizeStateKey(state.stateKey);

  // Session-resume detection (H7 fix, S332 + 2026-04-27 Task 1):
  //
  // If lastToolAt is older than veryLongIdleS, the next detectState() tick
  // would return 'context-warn' (exhausted face) regardless of whether a
  // session is actually running. The S332 baseline guarded this with a
  // strict toolCount<=1 check, which is correct on cold-boot stdin but
  // FAILS on /compact and sentinel re-entry boots: os-boot.cjs's early-exit
  // paths skip the session-meta.json rewrite, so meta.tool_count_running
  // (and downstream stdin.session.toolCount) carries forward at hundreds.
  // The strict check then refuses to fire and the user gets exhausted-face.
  //
  // Loosened predicate (any one of these = fresh session):
  //   A. Output tokens fully zero on BOTH paths (raw + canonical)
  //   B. Session id mismatch (state.lastSessionId !== stdin.session.id)
  // Plus the original baseline as a fallback when stdin.session is missing.
  //
  // This cannot regress the genuine long-idle running case: a running
  // session has the same session.id AND non-zero output tokens, so neither
  // signal fires and the guard correctly stays out of the way.
  const _resumeIdleMs = (cc().veryLongIdleS || 900) * 1000;
  const _lastTool = state.lastToolAt || 0;
  if (!state.bootActive && (now - _lastTool) > _resumeIdleMs) {
    const stdinToolCount = (stdin && stdin.tool_count)
      || (stdin && stdin.session && stdin.session.toolCount) || 0;
    const stdinOutputTokens = (stdin && stdin.context_window && stdin.context_window.total_output_tokens)
      || (stdin && stdin.session && stdin.session.outputTokens) || 0;
    const stdinSessionId = (stdin && stdin.session && typeof stdin.session.id === 'string' && stdin.session.id)
      || (stdin && typeof stdin.session_id === 'string' && stdin.session_id)
      || null;

    const fullyZeroOutput = stdinOutputTokens <= 0;
    const sessionIdMismatch = stdinSessionId && state.lastSessionId && stdinSessionId !== state.lastSessionId;
    const baselineFreshSignature = stdinToolCount <= 1 && fullyZeroOutput;

    if (sessionIdMismatch || (fullyZeroOutput && stdinToolCount <= 1) || baselineFreshSignature) {
      // Resume detected: reset timestamps, drop stale stateKey to idle
      state.lastToolAt = now;
      state.changedAt = now;
      state.stateKey = 'idle';
      state.totalOutputTokens = 0;
    }

    // Always learn the new session id when we observe one, regardless of
    // whether the guard fired — keeps the mismatch signal accurate next tick.
    if (stdinSessionId) state.lastSessionId = stdinSessionId;
  } else if (stdin && stdin.session && typeof stdin.session.id === 'string' && stdin.session.id) {
    // Track session id even outside the resume window so the first long-idle
    // tick can detect a true mismatch.
    state.lastSessionId = stdin.session.id;
  } else if (stdin && typeof stdin.session_id === 'string' && stdin.session_id) {
    state.lastSessionId = stdin.session_id;
  }

  // Boot animation: if active, advance one frame per tick.
  // Auto-cancel if boot has been running >10s (no ticks advanced it).
  if (state.bootActive) {
    const bootAge = now - (state.bootStartedAt || 0);
    if (bootAge > 10000) {
      state.bootActive = false;
      state.stateKey = 'idle';
      state.changedAt = now;
      state.lastToolAt = now;
    } else {
      const result = advanceBoot(state);
      saveState(state);
      return result;
    }
  }

  // Heartbeat tracks statusline liveness.
  state.lastHeartbeat = now;


  // Sync lastToolAt from tool count.
  // StatusLine stdin has NO tool_count — only PostToolUse hooks do.
  // Canonical state (from hud-data-loader) has session.toolCount.
  // Also check cost.output_tokens as a proxy: harness provides this in statusline.
  const toolCount = (stdin && stdin.tool_count)
    || (stdin && stdin.session && stdin.session.toolCount)
    || 0;
  if (toolCount > 0 && toolCount > (state.toolCount || 0)) {
    state.lastToolAt = now;
  }
  if (toolCount > 0) state.toolCount = toolCount;

  // If an explicit event hint is provided (from a reactive hook), use it.
  // detectState runs BEFORE totalOutputTokens update so old vs new comparison works.
  let newKey = normalizeStateKey(eventHint || detectState(stdin, state));

  // Update totalOutputTokens AFTER detectState so old vs new comparison works
  state.totalOutputTokens = (stdin && stdin.session && stdin.session.outputTokens)
    || (stdin && stdin.context_window && stdin.context_window.total_output_tokens)
    || 0;

  // Priority check: only transition if new state has higher priority than current
  const curPriority = PRIORITY[state.stateKey] || 0;
  const newPriority = PRIORITY[newKey] || 0;

  // Dwell time: don't transition too fast
  const _cc = cc();
  const sinceChange = now - (state.changedAt || 0);
  if (sinceChange < _cc.dwellMs && !eventHint) {
    // Hold current expression
    newKey = normalizeStateKey(state.stateKey);
  } else if (newPriority < curPriority && sinceChange < _cc.decayMs) {
    // Current state is higher priority and hasn't decayed yet
    newKey = normalizeStateKey(state.stateKey);
  }

  // Resolve expression from map
  const mapped = STATE_MAP[newKey] || STATE_MAP.idle;
  const result = { ...mapped };

  // Update state tracking
  if (newKey !== state.stateKey) {
    state.changedAt = now;
  }
  state.stateKey = newKey;

  // Update last tool activity time if we're in an active state
  if (newPriority > PRIORITY.idle) {
    state.lastToolAt = now;
  }

  // Apply idle animation overlays
  applyIdleAnimation(result, state, now);

  // Persist state for next tick
  saveState(state);

  // Include stateKey and lastToolAt so downstream consumers (orb, shimmer)
  // can detect active states and suppress idle animations.
  result.stateKey = state.stateKey;
  result.lastToolAt = state.lastToolAt || 0;
  result.toolCount = state.toolCount || 0;

  return result;
}

/**
 * Signal an event from a reactive hook (PostToolUse, SubagentStop, etc.).
 * Writes the event to the state file for the next statusLine tick to pick up.
 */
function signalEvent(eventKey) {
  const state = loadState();
  const stateKey = normalizeStateKey(eventKey);
  // Cancel boot animation — real events take precedence
  if (state.bootActive) {
    state.bootActive = false;
  }
  // Expire stale message — TTL check prevents dead messages from persisting
  if (state.message && Date.now() > (state.message.at || 0) + (state.message.ttl || 15000)) {
    state.message = null;
  }
  state.stateKey = stateKey;
  state.changedAt = Date.now();
  if (PRIORITY[stateKey] > PRIORITY.idle) {
    state.lastToolAt = Date.now();
  }
  // Write the expression field so the strip renderer picks it up directly
  const mapped = STATE_MAP[stateKey] || STATE_MAP.idle;
  state.expression = mapped.expression;
  state.gaze = mapped.gaze || 'forward';
  state.mode = mapped.mode || 'compact';
  saveState(state);
}

// ── Boot Animation ──

const BOOT_SEQUENCE = [
  { expression: 'dead',          gaze: 'forward' },
  { expression: 'exhausted',     gaze: 'forward' },
  { expression: 'sleepy',        gaze: 'forward' },
  { expression: 'neutral alive', gaze: 'forward' },
  { expression: 'neutral alive', gaze: 'left'    },
  { expression: 'curious',       gaze: 'left'    },
  { expression: 'alert',         gaze: 'left'    },
  { expression: 'alert',         gaze: 'forward' },
  { expression: 'proud joy',     gaze: 'forward' },
];

/**
 * Start boot animation. Called by SessionStart hook.
 * Writes initial boot state with frame index 0 and target frame.
 * @param {number} targetFrame - index into BOOT_SEQUENCE (0-8)
 */
function startBoot(targetFrame) {
  const state = loadState();
  state.bootActive = true;
  state.bootFrame = 0;
  state.bootTarget = Math.min(targetFrame, BOOT_SEQUENCE.length - 1);
  state.bootStartedAt = Date.now();
  state.stateKey = 'boot';
  state.changedAt = Date.now();
  state.message = null;
  saveState(state);
}

/**
 * Advance boot animation by one frame. Called during resolveExpression
 * when bootActive is true. Returns the current frame's expression/gaze
 * and advances the frame index for next tick.
 */
function advanceBoot(state) {
  const frame = BOOT_SEQUENCE[state.bootFrame] || BOOT_SEQUENCE[0];
  const result = { ...frame, mode: 'expanded' };

  // Advance frame for next tick
  if (state.bootFrame < state.bootTarget) {
    state.bootFrame++;
  } else {
    // Boot complete — switch to normal state machine
    state.bootActive = false;
    state.stateKey = 'idle';
    state.changedAt = Date.now();
    state.lastToolAt = Date.now();
  }

  return result;
}

// Message priority tiers — drive TTL and replacement behavior
const TIER_TTL = {
  flash:    8000,    // trivial status chatter — disappears fast
  signal:   30000,   // meaningful observations — 30s dwell
  critical: 120000,  // important warnings (rate-limit, errors, session-end) — 2min dwell
};

/**
 * Signal a companion message to display in the Braille field.
 * Message auto-expires after tier-based TTL unless refreshed.
 *
 * @param {string} text - Message text (truncated to 60 chars)
 * @param {number|object} [opts] - Legacy number (ttlMs) OR options object:
 *   {string} [tier='flash'] - flash|signal|critical
 *   {number} [ttlMs] - explicit TTL override (ignores tier default)
 *
 * Replacement policy: higher-tier message cannot be overwritten by lower-tier
 * while still active. Same-tier or higher always wins.
 */
function signalMessage(text, opts) {
  // Backward-compat: if opts is a number, treat as ttlMs with flash tier
  let tier = 'flash';
  let ttlMs;
  if (typeof opts === 'number') {
    ttlMs = opts;
  } else if (opts && typeof opts === 'object') {
    tier = opts.tier || 'flash';
    ttlMs = opts.ttlMs;
  }
  if (!TIER_TTL[tier]) tier = 'flash';
  const effectiveTtl = ttlMs || TIER_TTL[tier] || 15000;

  const state = loadState();

  // Priority check: reject lower-tier overwrites while a higher-tier message is still fresh
  if (state.message && state.message.text) {
    const age = Date.now() - (state.message.at || 0);
    const stillFresh = age < (state.message.ttl || 15000);
    const TIER_RANK = { flash: 1, signal: 2, critical: 3 };
    const incomingRank = TIER_RANK[tier] || 1;
    const activeRank = TIER_RANK[state.message.tier] || 1;
    if (stillFresh && incomingRank < activeRank) {
      // Lower-tier incoming; keep the existing higher-tier message
      return;
    }
  }

  // Sanitize text: strip ANSI escape sequences and control characters before
  // persisting to statusline. Any upstream source that pipes user-controlled
  // text (e.g., git branch names, commit messages) cannot inject ANSI via
  // the statusline band. security-auditor SEC-P1-1.
  const sanitized = String(text)
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')  // CSI sequences
    .replace(/\x1b[()].|\x1b\].*?\x07|\x1b\].*?\x1b\\/g, '')  // charset / OSC
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')  // control chars except \t\n
    .slice(0, 60);

  state.message = {
    text: sanitized,
    at: Date.now(),
    ttl: effectiveTtl,
    tier,
  };
  saveState(state);
}

/**
 * Refresh the active message's timestamp — effectively pauses TTL decay.
 * Called on UserPromptSubmit so messages don't expire while the user is
 * typing or has the slash-command palette open.
 *
 * No-op if no active message.
 */
function refreshMessage() {
  const state = loadState();
  if (!state.message || !state.message.text) return;
  // Only refresh if still within TTL (don't resurrect expired messages)
  const age = Date.now() - (state.message.at || 0);
  if (age > (state.message.ttl || 15000)) return;
  state.message.at = Date.now();
  saveState(state);
}

/**
 * Read the active companion message (if any, and not expired).
 * @returns {{ text: string, age: number, tier: string } | null}
 */
function activeMessage() {
  const state = loadState();
  if (!state.message || !state.message.text) return null;
  const age = Date.now() - (state.message.at || 0);
  if (age > (state.message.ttl || 15000)) return null;
  return {
    text: state.message.text,
    age,
    tier: state.message.tier || 'flash',
  };
}

// ── Exports ──

module.exports = {
  resolveExpression,
  signalEvent,
  signalMessage,
  refreshMessage,
  activeMessage,
  TIER_TTL,
  detectState,
  applyIdleAnimation,
  loadState,
  saveState,
  startBoot,
  advanceBoot,
  BOOT_SEQUENCE,
  STATE_MAP,
  PRIORITY,
  get DWELL_MS() { return cc().dwellMs; },
  get DECAY_MS() { return cc().decayMs; },
  get IDLE_THRESHOLD_S() { return cc().idleThresholdS; },
  get LONG_IDLE_S() { return cc().longIdleS; },
  get VERY_LONG_IDLE_S() { return cc().veryLongIdleS; },
  get CONTEXT_WARN_PCT() { return cc().contextWarnPct; },
  get CONTEXT_SLEEPY_PCT() { return cc().contextSleepyPct; },
  get HIGH_TOOL_COUNT() { return cc().highToolCount; },
  STATE_PATH,
};
