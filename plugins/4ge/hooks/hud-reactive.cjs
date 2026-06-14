'use strict';
// hud-reactive.cjs — Plugin-scoped reactive hook for companion activity signaling.
// Adapted from .claude/hooks/hud-reactive.cjs for plugin distribution.
// Wired to: PostToolUse (broad matcher: Write|Edit|Bash|Agent|Task|Read|Grep|Glob)
// Detects 14 event types, renders via buildD5Output (dual channel: terminal + model).
// Per-event throttle overrides. Always exits 0 (never blocks).

const { readStdinJson } = require('./hook-utils.cjs');
const fs = require('fs');
const path = require('path');

// Resolve plugin bin/ via CLAUDE_PLUGIN_ROOT so requires survive PLUGIN_DATA migration.
// __dirname-relative ../bin/ breaks when hooks are copied to PLUGIN_DATA/hooks/ (no bin/ sibling there).
const _hudPluginRoot = process.env.CLAUDE_PLUGIN_DATA || process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
const hudEvents = require(path.join(_hudPluginRoot, 'lib', 'hud-events.cjs'));
let loadHudData, buildD5Output;
let toolRing, intentDetector, messageComposer, companionState;
let mergeHarnessStdin = null;
try {
  const loader = require(path.join(_hudPluginRoot, 'bin', 'hud-data-loader.cjs'));
  loadHudData = loader.loadHudData;
  mergeHarnessStdin = loader.mergeHarnessStdin;
  buildD5Output = require(path.join(_hudPluginRoot, 'bin', 'hud-middleware.cjs')).buildD5Output;
} catch {
  loadHudData = null;
  buildD5Output = null;
}
// Atomic-write helper — centralises tmp+rename+EPERM-retry pattern
let writeFileAtomic = null;
try { writeFileAtomic = require(path.join(_hudPluginRoot, 'lib', 'atomic-write.cjs')).writeFileAtomic; } catch { writeFileAtomic = null; }

// Hoist smart-HUD module requires so we don't pay cold-load cost on every signaling event
let sessionArc = null, anomalyFlagger = null;
try { toolRing = require(path.join(_hudPluginRoot, 'lib', 'tool-ring.cjs')); } catch { toolRing = null; }
try { intentDetector = require(path.join(_hudPluginRoot, 'lib', 'intent-detector.cjs')); } catch { intentDetector = null; }
try { sessionArc = require(path.join(_hudPluginRoot, 'lib', 'session-arc.cjs')); } catch { sessionArc = null; }
try { anomalyFlagger = require(path.join(_hudPluginRoot, 'lib', 'anomaly-flagger.cjs')); } catch { anomalyFlagger = null; }
try { messageComposer = require(path.join(_hudPluginRoot, 'lib', 'message-composer.cjs')); } catch { messageComposer = null; }
try { companionState = require(path.join(_hudPluginRoot, 'bin', 'companion-state.cjs')); } catch { companionState = null; }

// --- Throttle State ---
const THROTTLE_FILE = path.join(process.cwd(), '_runs', 'os', 'hud-last-reactive.json');
const ANOMALY_FILE = path.join(path.dirname(THROTTLE_FILE), 'hud-last-anomaly.json');
const DEFAULT_THROTTLE_MS = 30000;
// Anomaly re-spam guard: same anomaly type cannot re-fire within this window.
// Prevents persistent conditions (rate-limit at 80% for 3h) from spamming the
// statusline every signaling event. (dumb-fuck W2 P1-1).
const ANOMALY_THROTTLE_MS = 5 * 60 * 1000;  // 5 min per anomaly type
const GIT_REFRESH_THROTTLE_MS = 10 * 1000;
const GIT_REFRESH_TOOLS = new Set(['Bash', 'Write', 'Edit', 'MultiEdit', 'Agent', 'Task']);

// Per-event throttle overrides (only events reachable via detectEvent)
const EVENT_THROTTLE = hudEvents.eventThrottleMap();
const ANOMALY_SEVERITY_RANK = { critical: 3, signal: 2, flash: 1 };

function shouldThrottle(event, thresholdMs) {
  try {
    if (!fs.existsSync(THROTTLE_FILE)) return false;
    const data = JSON.parse(fs.readFileSync(THROTTLE_FILE, 'utf8'));
    // Per-event timestamps: check this event's last fire time, not global
    const timestamps = data.events || {};
    const lastFired = timestamps[event] || 0;
    const elapsed = Date.now() - lastFired;
    return elapsed < (thresholdMs != null ? thresholdMs : DEFAULT_THROTTLE_MS);
  } catch {
    return false;
  }
}

function recordRender(eventOrEvents) {
  // Accepts a single event key OR an array of keys (batch mode).
  // Batch mode avoids Windows EPERM race when the anomaly path wants to
  // record its own throttle key in the same tool call (final-dfe H1).
  const keys = Array.isArray(eventOrEvents) ? eventOrEvents : [eventOrEvents];
  try {
    const dir = path.dirname(THROTTLE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let data = {};
    try { data = JSON.parse(fs.readFileSync(THROTTLE_FILE, 'utf8')); } catch { /* fresh */ }
    const events = data.events || {};
    const now = Date.now();
    for (const k of keys) { if (k) events[k] = now; }
    const content = JSON.stringify({ lastRender: now, events });
    if (writeFileAtomic) {
      writeFileAtomic(THROTTLE_FILE, content);
    } else {
      // Fallback: inline tmp+rename when atomic-write module failed to load
      const tmp = `${THROTTLE_FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, content);
      fs.renameSync(tmp, THROTTLE_FILE);
    }
  } catch {
    // Non-critical
  }
}

function isUnknownGitState(state) {
  return !state
    || (state.branch == null && state.dirty == null && state.uncommittedFiles == null);
}

function refreshGitState(input, now = Date.now(), smartOrderOverride = null) {
  const tool = (input && input.tool_name) || '';
  if (!GIT_REFRESH_TOOLS.has(tool)) return null;
  try {
    const smartOrder = smartOrderOverride || require(path.join(_hudPluginRoot, 'lib', 'smart-order.cjs'));
    if (!smartOrder || typeof smartOrder.readGitState !== 'function') return null;
    const cached = smartOrder.readGitState({ refresh: false });
    if (!isUnknownGitState(cached)) {
      const ts = cached && typeof cached.timestamp === 'string' ? Date.parse(cached.timestamp) : NaN;
      if (Number.isFinite(ts) && now - ts < GIT_REFRESH_THROTTLE_MS) return null;
    }
    return smartOrder.readGitState({ refresh: true }) || null;
  } catch {
    return null;
  }
}

function _loadCompanionConfig() {
  try {
    return require(path.join(_hudPluginRoot, 'bin', 'companion-config.cjs')).loadCompanionConfig();
  } catch {
    return {};
  }
}

function anomalyRowEnabled() {
  const cfg = _loadCompanionConfig();
  return cfg.anomalyRow === true;
}

function selectTopAnomaly(anomalyResult) {
  const anomalies = anomalyResult && Array.isArray(anomalyResult.anomalies)
    ? anomalyResult.anomalies
    : [];
  const valid = anomalies.filter((a) => (
    a && typeof a.type === 'string' && a.type &&
    typeof a.reason === 'string' && a.reason
  ));
  if (valid.length === 0) return null;
  return [...valid].sort((a, b) => (
    (ANOMALY_SEVERITY_RANK[b.severity] || 0) - (ANOMALY_SEVERITY_RANK[a.severity] || 0)
  ))[0];
}

function writeAtomicJson(filePath, payload) {
  const content = JSON.stringify(payload);
  if (writeFileAtomic) {
    writeFileAtomic(filePath, content);
    return;
  }
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

function recordAnomalyResult(anomalyResult, now = Date.now()) {
  if (!anomalyRowEnabled()) return null;
  try {
    const anomaly = selectTopAnomaly(anomalyResult);
    if (!anomaly) {
      try { fs.rmSync(ANOMALY_FILE, { force: true }); } catch { /* best-effort clear */ }
      return null;
    }
    const dir = path.dirname(ANOMALY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const payload = {
      updatedAt: new Date(now).toISOString(),
      type: anomaly.type,
      severity: ANOMALY_SEVERITY_RANK[anomaly.severity] ? anomaly.severity : 'signal',
      reason: anomaly.reason,
      metrics: (anomaly.metrics && typeof anomaly.metrics === 'object') ? anomaly.metrics : {},
    };
    writeAtomicJson(ANOMALY_FILE, payload);
    return payload;
  } catch {
    return null;
  }
}

// --- PostToolUse output coercion ---
// The harness delivers tool output under `tool_response` (schema: coreSchemas.ts
// `tool_response: z.unknown()`, S309-verified) — NOT `tool_result`, which is the
// transcript content-block field name (correctly used by hud-transcript-source.cjs,
// but never present on PostToolUse hook stdin). Reading the wrong field left every
// output-content event (test-pass/fail, output-pattern errors, Agent/Task forge-
// phase) silently dead in production. Shape is untyped and varies by tool — Bash
// {stdout,stderr}, Write/Edit {filePath,success}, Agent/Task string|{output} — so
// coerce to a searchable string. Verified S392 against hooks-vocabulary.md:343 +
// harness-intel/playbook/{architecture-map.md:345, agent-orchestration.md:51}.
function coerceToolOutput(toolResponse) {
  if (toolResponse == null) return '';
  if (typeof toolResponse === 'string') return toolResponse;
  if (typeof toolResponse === 'object') {
    // Extract genuine output text only. Metadata-only objects (e.g. Write/Edit
    // {filePath,success}) have no text field → return '' so they are NOT run
    // through the error-pattern regexes below — a stringified {filePath} could
    // otherwise false-positive error-state on a path containing 'Error:' or
    // 'tool_use_error' (S392 adversarial-verify P3).
    const cand = [toolResponse.stdout, toolResponse.stderr, toolResponse.output, toolResponse.content]
      .filter(v => typeof v === 'string' && v.length > 0);
    return cand.length ? cand.join('\n') : '';
  }
  return String(toolResponse);
}

// --- Event Detection ---
function detectEvent(input) {
  const tool = input.tool_name || '';
  const toolInput = input.tool_input || {};
  const outputStr = coerceToolOutput(input.tool_response);

  if (tool === 'Bash') {
    const cmd = toolInput.command || '';
    if (cmd.includes('git commit')) {
      if (outputStr.includes('nothing to commit')) {
        // Commit had no effect — check if it's a session-end/handoff commit
        if (/handoff|session.?end/i.test(cmd)) return 'session-end';
      } else {
        // Successful commit — session-end trumps generic commit
        if (/handoff|session.?end/i.test(cmd)) return 'session-end';
        return 'commit';
      }
    }
    if (cmd.includes('vitest') || cmd.includes('jest')) {
      // Check failures FIRST — "3 failed | 97 passed" contains both "failed" and "passed"
      if (outputStr.includes('failed') && !outputStr.includes('0 failed')) {
        return 'test-fail';
      }
      if (outputStr.includes('0 failed') || (outputStr.includes('Tests  ') && outputStr.includes('passed'))) {
        return 'test-pass';
      }
    }
  }

  if (tool === 'TaskUpdate' || tool === 'TaskCreate') {
    const subject = toolInput.subject || '';
    if (subject.toLowerCase().includes('forge') || subject.toLowerCase().includes('p5:')) {
      return 'forge-phase';
    }
  }

  if (tool === 'Write' || tool === 'Edit') {
    const filePath = toolInput.file_path || '';
    if (filePath.includes('badges.json')) return 'badge-earned';
    if (filePath.endsWith('-brief.md')) return 'export';
    if (filePath.includes('hud-zone-') || filePath.includes('hud-expressions')) return 'zone-change';
  }

  if (tool === 'Bash') {
    const cmd = toolInput.command || '';
    if (cmd.includes('export-pipeline')) return 'export';
  }

  if (tool === 'Agent' || tool === 'Task') {
    if (/forge-session|phase|P[1-7]:/i.test(outputStr)) return 'forge-phase';
    if (outputStr.length > 10) return 'zone-change';
  }

  // Note: hook_event_name checks removed — plugin hook is wired to PostToolUse only.
  // PreCompact/SubagentStart/etc are separate event types that never reach this hook.

  if (input.rate_limits) {
    const rl = input.rate_limits;
    const tiers = [rl.five_hour, rl.seven_day].filter(Boolean);
    if (tiers.some(t => t.used_percentage > 95)) return 'rate-limit-warn';
  }

  // Error-state detection: trust input.isError / input.success=false as the primary signal.
  // Secondary: strict error-context patterns in tool output (not bare word "error" — far too
  // permissive, was firing on every Read of any file containing the word. bull-auditor P0).
  if (input.isError === true || input.success === false) {
    return 'error-state';
  }
  if (outputStr && tool !== 'Bash' && tool !== 'Read' && tool !== 'Grep') {
    // Only match actual error indicators, not any prose containing "error"
    if (/^(Error:|TypeError:|ReferenceError:|SyntaxError:|AssertionError:)/m.test(outputStr)
        || /^\s*at\s+\S+\s+\(.+:\d+:\d+\)/m.test(outputStr)  // stack trace line
        || /tool_use_error/i.test(outputStr)) {
      return 'error-state';
    }
  }

  if (input.context_window && input.context_window.used_percentage > 75) {
    return 'context-high';
  }

  return null;
}

// --- Render via D5 dual channel ---
// state may be pre-loaded by the caller to avoid double I/O; falls back to loading.
function renderReactive(event, state) {
  if (!buildD5Output) return;
  if (!state) {
    if (!loadHudData) return;
    try {
      state = loadHudData({ cwd: process.cwd(), runExpensiveProbes: false });
    } catch { return; }
  }

  state.context = Object.assign({}, state.context, { trigger: 'reactive', event });

  let out;
  try {
    // Explicit eventName per hooks.json wiring (PostToolUse). Buildd5Output
    // defaults to 'PostToolUse' but explicit passing documents the coupling
    // and makes the library caller-event-aware for future reuse.
    out = buildD5Output('compact', state, 'PostToolUse');
  } catch { return; }

  if (!out) return;
  if (out.stdout) process.stdout.write(out.stdout + '\n');
  if (out.json) process.stdout.write(out.json + '\n');
}

// --- Companion Event Signaling ---
const COMPANION_EVENT_MAP = hudEvents.companionEventMap();
const TOOL_ACTIVITY_SET = new Set(['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'Agent', 'Task']);

// Wave 1 messages filter. MAJOR events are the consequential ones a user always
// wants surfaced in the companion bubble. The companion.messages knob gates the
// TEXT bubble only (signalMessage) — NOT the face/expression (signalEvent), so the
// error/rate-limited FACE still fires under 'off'; only the text is silenced.
//   'off'   → suppress ALL companion messages
//   'major' → emit messages only for MAJOR events (zen forces this too)
//   'all'   → unchanged (default)
const MAJOR_EVENTS = hudEvents.majorEventSet();

// Resolve the effective messages level, collapsing zen → 'major'. Fail-soft to 'all'.
function _messagesLevel() {
  const cc = _loadCompanionConfig();
  if (cc.zen === true) return 'major';
  const lvl = cc.messages;
  return (lvl === 'off' || lvl === 'major' || lvl === 'all') ? lvl : 'all';
}

// True when a companion TEXT message for `event` should be posted under the current level.
function _messageAllowed(event) {
  const lvl = _messagesLevel();
  if (lvl === 'off') return false;
  if (lvl === 'major') return MAJOR_EVENTS.has(event);
  return true; // 'all'
}

// Anomaly messages are not named events. Under 'off' suppress all; under 'major'
// allow only when the anomaly rides a MAJOR named event (eventName); bare-tool-
// activity anomalies (eventName === null) are non-MAJOR and surface only under 'all'.
function _anomalyMessageAllowed(eventName) {
  const lvl = _messagesLevel();
  if (lvl === 'off') return false;
  if (lvl === 'major') return eventName != null && MAJOR_EVENTS.has(eventName);
  return true; // 'all'
}

// Map events to message priority tiers. Critical = survives palette, signal = 30s dwell, flash = short.
const EVENT_TIER = hudEvents.eventTierMap();

// Build composer context from hook input — per-event extras the composer templates use
function buildComposerContext(input, event, state) {
  const ctx = {};
  if (!input) return ctx;
  const toolInput = input.tool_input || {};
  const fp = toolInput.file_path || '';
  if (event === 'error-state') ctx.toolName = input.tool_name || '';
  if (event === 'export' && fp.endsWith('-brief.md')) ctx.fileType = 'brief';

  // Attach workflow intent, session arc, and anomalies to context.
  // All three are optional; composer falls back gracefully if any is missing.
  if (toolRing) {
    try {
      const recentTools = toolRing.readRing();
      if (intentDetector) {
        try { ctx.intent = intentDetector.detectIntent({ recentTools, state }); } catch { /* skip */ }
      }
      if (sessionArc) {
        try { ctx.arc = sessionArc.detectArc({ recentTools, state }); } catch { /* skip */ }
      }
      if (anomalyFlagger) {
        try { ctx.anomalies = anomalyFlagger.detectAnomalies({ recentTools, state }); } catch { /* skip */ }
      }
    } catch { /* ring read failed — all context enrichment skipped */ }
  }

  return ctx;
}

// signalCompanion receives an `extraThrottleKeys` array and pushes any
// additional keys (e.g. 'anomaly:<type>') that need to be recorded alongside
// the event key — caller does one atomic recordRender([...]) at end.
function signalCompanion(event, input, state, extraThrottleKeys) {
  if (!companionState) return;
  if (!Array.isArray(extraThrottleKeys)) extraThrottleKeys = [];
  try {
    if (event && COMPANION_EVENT_MAP[event]) {
      companionState.signalEvent(COMPANION_EVENT_MAP[event]);
      // Compose a state-aware, tier-tagged message
      if (messageComposer) {
        try {
          const ctx = buildComposerContext(input, event, state);
          const msg = messageComposer.composeMessage(event, state, ctx);
          if (msg && _messageAllowed(event)) {
            const tier = EVENT_TIER[event] || 'flash';
            companionState.signalMessage(msg, { tier });
          }
          // Anomaly escalation: surface anomalies at or above the event's tier.
          // A critical anomaly ALWAYS overrides (tier guard lets critical replace
          // anything). A signal anomaly overrides only flash-tier events (otherwise
          // it would silently lose to the active same-tier event message).
          // This catches stale-dirty-work, error-regression, ctx-burn-rate-high
          // (all signal-severity) which would otherwise be swallowed by
          // flash-tier commit/test-pass messages. (integration-auditor INT-P1-3).
          _emitAnomalyIfWorthy(ctx.anomalies, event, companionState, extraThrottleKeys);
        } catch { /* composer unavailable — skip message */ }
      }
      return;
    }
    const tool = (input && input.tool_name) || '';
    if (TOOL_ACTIVITY_SET.has(tool)) {
      companionState.signalEvent('tool-running');
    }
    // Anomaly escalation runs independently of event detection so critical anomalies
    // (e.g. rate-limit-approaching at 70-80%, below the 80% event-fire threshold)
    // surface on every tool call — not only when a named companion event fired.
    // Without this, the 70-80% band computes a critical anomaly that is permanently
    // gated out because the rate-limit-warn event never fires. (S303 B.5 decouple)
    if (anomalyFlagger && toolRing) {
      try {
        const recentTools = toolRing.readRing();
        const anomalyResult = anomalyFlagger.detectAnomalies({ recentTools, state: state || {} });
        _emitAnomalyIfWorthy(anomalyResult, null, companionState, extraThrottleKeys);
      } catch { /* non-fatal */ }
    }
  } catch { /* non-fatal */ }
}

/**
 * _emitAnomalyIfWorthy — emit the highest-priority anomaly message when it
 * deserves to surface given the current event tier.
 *
 * Decoupled from event detection so it can be called both:
 *   (a) after a named event fires (eventName is the companion event key)
 *   (b) on bare tool-activity with no named event (eventName is null)
 *
 * Selection logic:
 *   - critical anomaly: always emits (trumps everything)
 *   - signal anomaly: emits when eventTier is flash, signal, OR null (no event)
 *   - flash anomaly: never escalates (too noisy without an event anchor)
 *
 * Per-anomaly-type throttle (ANOMALY_THROTTLE_MS) prevents re-spam on persistent
 * conditions. extraThrottleKeys receives any keys emitted for batched recordRender.
 */
function _emitAnomalyIfWorthy(anomalyResult, eventName, cs, extraThrottleKeys) {
  if (anomalyRowEnabled()) {
    recordAnomalyResult(anomalyResult);
    return;
  }
  if (!anomalyResult || !Array.isArray(anomalyResult.anomalies) || !anomalyResult.anomalies.length) return;
  const eventTier = eventName ? (EVENT_TIER[eventName] || 'flash') : null;
  const crit = anomalyResult.anomalies.find(a => a.severity === 'critical');
  let anomaly = null;
  if (crit) {
    anomaly = crit;
  } else if (eventTier === 'flash' || eventTier === 'signal' || eventTier === null) {
    // Signal-severity anomalies escalate on flash/signal events AND on bare tool
    // activity (null event). Null-event path is the new case: covers anomalies
    // that would never surface because their companion event threshold (e.g. 80%)
    // is above the anomaly threshold (e.g. 70%).
    anomaly = anomalyResult.anomalies.find(a => a.severity === 'signal');
  }
  if (anomaly && anomaly.reason && anomaly.type &&
      _anomalyMessageAllowed(eventName) &&
      !shouldThrottle('anomaly:' + anomaly.type, ANOMALY_THROTTLE_MS)) {
    const anomalyTier = anomaly.severity === 'critical' ? 'critical' : 'signal';
    cs.signalMessage(anomaly.reason, { tier: anomalyTier });
    extraThrottleKeys.push('anomaly:' + anomaly.type);
  }
}

// --- Main ---
async function main() {
  const input = await readStdinJson();
  if (!input) process.exit(0);

  // Skip in subagents — reactive HUD is main context only
  if (input.agent_id && input.agent_id !== 'main') process.exit(0);

  // Refresh session-active flag: every tool call keeps the HUD's time-based
  // animations (breath, shimmer, color wave) alive. When tools stop firing,
  // the TTL expires (or Stop hook clears) and output goes byte-stable so
  // mobile Termius stops scroll-bouncing.
  try {
    const cwd = input.cwd || process.cwd();
    const flag = require(path.join(_hudPluginRoot, 'lib', 'hud-active-flag.cjs'));
    flag.setActive(cwd);
  } catch { /* best-effort */ }

  // Append to tool ring buffer on every PostToolUse (before event gating,
  // so ring captures the full activity trail regardless of throttle).
  if (toolRing) {
    try { toolRing.appendTool(input); } catch { /* best-effort */ }
  }

  refreshGitState(input);

  const event = detectEvent(input);
  if (!event) {
    signalCompanion(null, input, null);
    process.exit(0);
  }

  const throttleMs = EVENT_THROTTLE[event] !== undefined ? EVENT_THROTTLE[event] : DEFAULT_THROTTLE_MS;
  if (throttleMs > 0 && shouldThrottle(event, throttleMs)) process.exit(0);

  // Load HUD state once, share between renderReactive and signalCompanion.
  // Merge harness stdin so rateLimits/cost/model come from live data.
  let state = null;
  if (loadHudData) {
    try {
      state = loadHudData({ cwd: process.cwd(), runExpensiveProbes: false });
      if (mergeHarnessStdin) mergeHarnessStdin(state, input);
    } catch { /* best-effort */ }
  }

  renderReactive(event, state);
  // Collect any extra throttle keys (e.g. 'anomaly:<type>') that signalCompanion
  // records. All throttle keys batched into one atomic recordRender to avoid
  // Windows EPERM race on rapid tmp+rename writes (final-dfe H1).
  const extraThrottleKeys = [];
  signalCompanion(event, input, state, extraThrottleKeys);
  recordRender([event, ...extraThrottleKeys]);
  process.exit(0);
}

// Only run as a hook entry point (not when require()'d from tests)
if (require.main === module) {
  main().catch(() => process.exit(0));
}

// Exported for testing — does not affect hook execution
module.exports = {
  detectEvent,
  shouldThrottle,
  recordRender,
  signalCompanion,
  _emitAnomalyIfWorthy,
  recordAnomalyResult,
  selectTopAnomaly,
  anomalyRowEnabled,
  COMPANION_EVENT_MAP,
  EVENT_THROTTLE,
  GIT_REFRESH_THROTTLE_MS,
  GIT_REFRESH_TOOLS,
  refreshGitState,
  MAJOR_EVENTS,
  _messagesLevel,
  _messageAllowed,
  _anomalyMessageAllowed,
};
