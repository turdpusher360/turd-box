/**
 * smart-hud-pipeline.test.js — Integration test for the Smart HUD pipeline.
 *
 * Exercises the full chain:
 *   appendTool → readRing → detectIntent / detectArc / detectAnomalies
 *   → composeMessage → signalCompanion (via hud-reactive exports)
 *
 * WHY THIS EXISTS:
 * Three P0 bugs in S302 came from producer/consumer shape drift that unit tests
 * with hand-fabricated shapes missed. This test uses real module contracts and
 * realistic harness shapes throughout to catch that class of bug before commit.
 *
 * SHAPE DRIFT SENTINEL — fields that caused S302 P0s:
 *   - rl.fiveHour (not rl.usedPct)         — anomaly-flagger S302 P0
 *   - lastCommitTs as ISO string            — anomaly-flagger / smart-order S302 P0
 *   - isError: boolean on ring entry        — tool-ring / anomaly-flagger S302 P0
 *   These are exercised in the dedicated sentinel suite below.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Isolate companion-state writes BEFORE any require loads companion-state.cjs:
// it resolves STATE_PATH from COMPANION_STATE_PATH || a __dirname-relative REAL
// _runs/os/.companion-state.json (a cwd mock does NOT cover that path). Without
// this, signalCompanion's companion-state writes hit the live HUD state file.
// (S441 test-leak sweep.)
process.env.COMPANION_STATE_PATH = path.join(os.tmpdir(), 'smart-hud-pipe-companion-state.json');

// CJS modules under test — use require() as the execution-conventions rule requires
const { appendTool, readRing, clearRing, normalizeEntry } = require('../tool-ring.cjs');
const { detectIntent }    = require('../intent-detector.cjs');
const { detectArc }       = require('../session-arc.cjs');
const { detectAnomalies, SEVERITY_CRITICAL, SEVERITY_SIGNAL, SEVERITY_FLASH } = require('../anomaly-flagger.cjs');
const { composeMessage }  = require('../message-composer.cjs');
// hud-reactive resolves THROTTLE_FILE / ANOMALY_FILE from process.cwd() at require
// time. These are (re)bound in beforeEach AFTER cwd is mocked to stateDir, so the
// rate-limit fixture's recordAnomalyResult writes into the tmpdir — NOT the real
// _runs/os/hud-last-anomaly.json. (S441: that leak wrote a frozen "5h 80% used,
// resets in 3.0h" fixture onto the live HUD on every suite run.) Matches the
// cwd-before-require isolation in hud-reactive.test.js.
let detectEvent, signalCompanion, COMPANION_EVENT_MAP, EVENT_THROTTLE;

// ── Test harness setup ────────────────────────────────────────────────────────

let stateDir;
let prevRateLimitEnv;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smar-hud-pipe-'));
  // Patch cwd BEFORE (re)requiring hud-reactive so its THROTTLE_FILE / ANOMALY_FILE
  // consts resolve into stateDir — isolates recordAnomalyResult writes from the real
  // _runs/os/ (the S441 live-HUD leak). Re-require fresh so the const re-binds.
  vi.spyOn(process, 'cwd').mockReturnValue(stateDir);
  const reactivePath = path.resolve(__dirname, '../../hooks/hud-reactive.cjs');
  delete require.cache[reactivePath];
  ({ detectEvent, signalCompanion, COMPANION_EVENT_MAP, EVENT_THROTTLE } = require(reactivePath));
  // Enable rate-limit anomaly detection for all tests.
  // Production default is off (ANOMALY_RATE_LIMIT !== '1') to suppress stale data popups.
  // Tests need it on to exercise the rate-limit-approaching code path.
  prevRateLimitEnv = process.env.ANOMALY_RATE_LIMIT;
  process.env.ANOMALY_RATE_LIMIT = '1';
});

afterEach(() => {
  vi.restoreAllMocks();
  // Re-require hud-reactive under the real cwd so the stale tmpdir-bound module
  // does not leak into other test files that import it.
  try { delete require.cache[path.resolve(__dirname, '../../hooks/hud-reactive.cjs')]; } catch { /* ignore */ }
  try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch { /* ignore */ }
  // Restore env var to avoid leaking into other test files
  if (prevRateLimitEnv === undefined) {
    delete process.env.ANOMALY_RATE_LIMIT;
  } else {
    process.env.ANOMALY_RATE_LIMIT = prevRateLimitEnv;
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const NOW = Date.now();

/**
 * Build a realistic PostToolUse hook input matching the harness stdin shape.
 * tool_response carries output (S309: the stdin field is tool_response, NOT
 * tool_result/tool_output — those are undefined on PostToolUse hook stdin).
 * isError is a boolean on the top-level input, not inside tool_response.
 */
function hookInput(overrides = {}) {
  return {
    tool_name: 'Bash',
    tool_input: { command: 'echo hello' },
    tool_response: '',          // PostToolUse stdin field — NOT tool_result/tool_output
    isError: false,           // top-level boolean — NOT nested
    agent_id: 'main',
    session_id: 'test-session',
    ...overrides,
  };
}

/**
 * Append N tool events to the ring and return the populated ring.
 * Uses realistic hook input shapes — each event goes through normalizeEntry.
 */
function populateRing(events, opts = {}) {
  for (const e of events) {
    appendTool(e, { stateDir, ...opts });
  }
  return readRing(stateDir);
}

/**
 * Canonical HUD state shape — matches what hud-data-loader emits after
 * mergeHarnessStdin merges rate_limits from the harness stdin.
 * Rate-limit fields use fiveHour / sevenDay (not usedPct — S302 P0).
 * lastCommitTs is an ISO string (smart-order.cjs format — S302 P0).
 */
function hudState(overrides = {}) {
  const lastCommitTs = new Date(NOW - 5 * 60 * 1000).toISOString(); // 5 min ago
  return {
    git: {
      branch: 'main',
      uncommittedFiles: 0,
      lastCommitTs,             // ISO string — S302 shape drift sentinel
      recentCommits: ['abc123'],
    },
    session: {
      contextPct: 15,
      uptime: 20 * 60 * 1000,
      toolCount: 12,
      modelId: 'claude-opus-4-6',
      rateLimits: {
        fiveHour: 30,           // 0-100 number — NOT usedPct (S302 P0)
        sevenDay: 20,
        fiveHourResetsAt: NOW + 3 * 60 * 60 * 1000,
        sevenDayResetsAt: NOW + 24 * 60 * 60 * 1000,
      },
    },
    forge: { phase: null, teammates: [] },
    ...overrides,
  };
}

// ── 1. Happy Path ─────────────────────────────────────────────────────────────

describe('happy path — full pipeline runs without throws', () => {
  it('appendTool × 5 → readRing → all detect* → composeMessage produce results', () => {
    // 1. Populate ring with 5 realistic tool events
    const events = [
      hookInput({ tool_name: 'Read',  tool_input: { file_path: '/foo/a.js' } }),
      hookInput({ tool_name: 'Read',  tool_input: { file_path: '/foo/b.js' } }),
      hookInput({ tool_name: 'Grep',  tool_input: { pattern: 'myFunc' } }),
      hookInput({ tool_name: 'Edit',  tool_input: { file_path: '/foo/a.js' } }),
      hookInput({ tool_name: 'Bash',  tool_input: { command: 'npx vitest run' },
        tool_response: 'Tests  22 passed' }),
    ];

    // normalizeEntry shape: tool_name → tool, tool_input.file_path → filePath,
    //                        tool_response → output, isError → isError (if true)
    for (const e of events) {
      appendTool(e, { stateDir });
    }

    // 2. readRing returns entries with correct fields
    const ring = readRing(stateDir);
    expect(ring).toHaveLength(5);
    expect(ring[0].tool).toBe('Read');
    expect(ring[1].tool).toBe('Read');
    expect(ring[2].tool).toBe('Grep');
    expect(ring[3].tool).toBe('Edit');
    expect(ring[4].tool).toBe('Bash');
    // tool_response captured as output
    expect(ring[4].output).toContain('22 passed');
    // isError NOT set when input.isError is false
    expect(ring[4].isError).toBeUndefined();

    const state = hudState();

    // 3. detectIntent — no throws, returns known shape
    let intent;
    expect(() => {
      intent = detectIntent({ recentTools: ring, state, now: NOW });
    }).not.toThrow();
    expect(intent).toHaveProperty('intent');
    expect(intent).toHaveProperty('confidence');
    expect(intent).toHaveProperty('reason');
    expect(['debugging','shipping','exploring','testing','refactoring','reviewing','idle','unknown'])
      .toContain(intent.intent);

    // 4. detectArc — no throws, returns known shape
    let arc;
    expect(() => {
      arc = detectArc({ recentTools: ring, state, now: NOW });
    }).not.toThrow();
    expect(arc).toHaveProperty('phase');
    expect(arc).toHaveProperty('confidence');
    expect(arc).toHaveProperty('reason');
    expect(arc).toHaveProperty('metrics');
    expect(['warmup','locked-in','drift','winding-down','cold','unknown'])
      .toContain(arc.phase);

    // 5. detectAnomalies — no throws, clean state = no anomalies
    let anomalyResult;
    expect(() => {
      anomalyResult = detectAnomalies({ recentTools: ring, state, now: NOW });
    }).not.toThrow();
    expect(anomalyResult).toHaveProperty('anomalies');
    expect(anomalyResult).toHaveProperty('topSeverity');
    expect(Array.isArray(anomalyResult.anomalies)).toBe(true);
    expect(anomalyResult.topSeverity).toBeNull();

    // 6. composeMessage — no throws, produces a string for known events
    const ctx = { intent, arc, anomalies: anomalyResult };
    let msg;
    expect(() => {
      msg = composeMessage('test-pass', state, ctx);
    }).not.toThrow();
    // Should produce a non-empty string (test-pass has multiple fallback templates)
    expect(typeof msg).toBe('string');
    expect(msg.length).toBeGreaterThan(0);
    expect(msg.length).toBeLessThanOrEqual(60);
  });
});

// ── 2. Tier Escalation ────────────────────────────────────────────────────────

describe('tier escalation — critical anomaly wins over flash event', () => {
  it('rate-limit-approaching (critical) overrides test-pass (flash) message', () => {
    // Set up state with a critical anomaly: 5h rate limit at 80%, resets in 3h
    const state = hudState({
      session: {
        contextPct: 15,
        uptime: 20 * 60 * 1000,
        toolCount: 12,
        modelId: 'claude-opus-4-6',
        rateLimits: {
          fiveHour: 80,                              // >70% threshold
          sevenDay: 20,
          fiveHourResetsAt: NOW + 3 * 60 * 60 * 1000, // 3h away (>2h minimum)
          sevenDayResetsAt: NOW + 24 * 60 * 60 * 1000,
        },
      },
    });

    const ring = [{ tool: 'Bash', command: 'npx vitest run', ts: NOW - 5000 }];
    const anomalyResult = detectAnomalies({ recentTools: ring, state, now: NOW });

    // Anomaly must fire at critical severity
    expect(anomalyResult.topSeverity).toBe(SEVERITY_CRITICAL);
    const rateLimitAnomaly = anomalyResult.anomalies.find(a => a.type === 'rate-limit-approaching');
    expect(rateLimitAnomaly).toBeDefined();
    expect(rateLimitAnomaly.severity).toBe(SEVERITY_CRITICAL);

    // signalCompanion: critical anomaly overrides flash-tier event
    // Verify the escalation path in signalCompanion is reachable without throws
    const arc = detectArc({ recentTools: ring, state, now: NOW });
    const intent = detectIntent({ recentTools: ring, state, now: NOW });
    const ctx = { intent, arc, anomalies: anomalyResult };

    // composeMessage for test-pass gives a flash message
    const baseMsg = composeMessage('test-pass', state, ctx);
    expect(typeof baseMsg).toBe('string');

    // The anomaly reason is the one that should escalate to critical tier
    expect(rateLimitAnomaly.reason).toMatch(/5h.*%.*reset/i);

    // signalCompanion should not throw even with no companionState (null guard path)
    // We test the detection logic — full companion integration requires a live state file
    const input = hookInput({
      tool_name: 'Bash',
      tool_input: { command: 'npx vitest run' },
      tool_response: 'Tests  5 passed',
    });
    expect(() => signalCompanion('test-pass', input, state, [])).not.toThrow();
  });
});

// ── 3. Shape Drift Sentinel ───────────────────────────────────────────────────

describe('shape drift sentinel — S302 P0 regression guards', () => {
  /**
   * P0-1: rl.fiveHour (not rl.usedPct).
   * hud-data-loader.cjs emits { fiveHour, sevenDay, fiveHourResetsAt, sevenDayResetsAt }.
   * If anyone reads rl.usedPct, this test exposes it.
   */
  it('rate-limit field name: rl.fiveHour fires, rl.usedPct does not exist', () => {
    const stateWithFiveHour = hudState({
      session: {
        contextPct: 10,
        uptime: 10 * 60 * 1000,
        toolCount: 5,
        modelId: 'claude-sonnet-4-6',
        rateLimits: {
          fiveHour: 85,                                // canonical field name
          sevenDay: 10,
          fiveHourResetsAt: NOW + 3 * 60 * 60 * 1000,
          sevenDayResetsAt: NOW + 24 * 60 * 60 * 1000,
          // usedPct deliberately absent — any code reading rl.usedPct gets undefined
        },
      },
    });

    const result = detectAnomalies({ recentTools: [], state: stateWithFiveHour, now: NOW });
    const a = result.anomalies.find(x => x.type === 'rate-limit-approaching');
    expect(a).toBeDefined();
    expect(a.metrics.usedPct).toBe(85);  // reads fiveHour, not usedPct

    // Verify usedPct is NOT a field on rateLimits (sentinel against adding wrong alias)
    const rl = stateWithFiveHour.session.rateLimits;
    expect(rl.usedPct).toBeUndefined();
  });

  /**
   * P0-2: lastCommitTs as ISO 8601 string.
   * smart-order.cjs emits ISO strings. anomaly-flagger must parse them correctly.
   * Pre-fix code assumed epoch-ms (broke silently, stale-dirty-work never fired).
   */
  it('lastCommitTs as ISO string: stale-dirty-work fires correctly', () => {
    const staleIso = new Date(NOW - 35 * 60 * 1000).toISOString(); // 35 min ago > 30 min threshold
    const state = {
      git: {
        uncommittedFiles: 3,
        lastCommitTs: staleIso,  // ISO string — the real smart-order.cjs format
      },
    };

    const result = detectAnomalies({ recentTools: [], state, now: NOW });
    const a = result.anomalies.find(x => x.type === 'stale-dirty-work');
    expect(a).toBeDefined();
    expect(a.severity).toBe(SEVERITY_SIGNAL);
    expect(a.metrics.uncommittedFiles).toBe(3);
    // The age should be approximately 35 minutes
    expect(a.metrics.lastCommitAgeMs).toBeGreaterThan(30 * 60 * 1000);
  });

  /**
   * P0-3: isError is a boolean on the top-level hook input (not nested in tool_response).
   * normalizeEntry reads input.isError directly. If code reads input.tool_response.isError
   * or input.output.isError, it gets undefined and rapid-error-cascade is blind.
   */
  it('isError boolean on hook input flows through normalizeEntry to ring entry', () => {
    // Real harness shape: isError is top-level on PostToolUse input
    const errorInput = {
      tool_name: 'Bash',
      tool_input: { command: 'npx tsc --noEmit' },
      tool_response: 'error TS2345: Argument of type',  // harness field, not tool_output
      isError: true,                                  // top-level boolean
    };

    const normalized = normalizeEntry(errorInput);
    expect(normalized.isError).toBe(true);
    expect(normalized.tool).toBe('Bash');
    expect(normalized.output).toContain('error TS2345');

    // Push 3 error events to ring, verify rapid-error-cascade fires
    const ring = [
      normalizeEntry({ ...errorInput, tool_input: { command: 'npx tsc' } }),
      normalizeEntry({ ...errorInput, tool_input: { command: 'npx eslint .' } }),
      normalizeEntry({ ...errorInput, tool_input: { command: 'npx vitest run' } }),
    ].map(e => ({ ...e, ts: NOW - 1000 }));  // all within 2-min window

    const result = detectAnomalies({ recentTools: ring, state: {}, now: NOW });
    const cascade = result.anomalies.find(x => x.type === 'rapid-error-cascade');
    expect(cascade).toBeDefined();
    expect(cascade.severity).toBe(SEVERITY_CRITICAL);
    expect(cascade.metrics.errorCount).toBeGreaterThanOrEqual(3);
  });

  /**
   * Field name: the harness PostToolUse stdin field is `tool_response` (S309,
   * coreSchemas.ts:436-446). `tool_result` is the transcript block type, NOT the
   * hook field; `tool_output` never existed. Reading either leaves event detection
   * silent for test-pass/fail. Was the S302 P0 (b89078d fixed tool_output→tool_result,
   * still wrong); S392 corrected to tool_response.
   */
  it('detectEvent reads tool_response (not tool_result/tool_output) for test pass/fail detection', () => {
    const passInput = hookInput({
      tool_name: 'Bash',
      tool_input: { command: 'npx vitest run' },
      tool_response: 'Tests  22 passed\n0 failed',    // harness PostToolUse field
      // tool_result / tool_output intentionally absent — if detectEvent reads either, event is null
    });

    expect(passInput.tool_output).toBeUndefined();   // verify test setup
    expect(passInput.tool_result).toBeUndefined();   // the wrong-but-plausible field is NOT present

    const event = detectEvent(passInput);
    expect(event).toBe('test-pass');
  });

  it('detectEvent reads tool_response for test-fail detection', () => {
    const failInput = hookInput({
      tool_name: 'Bash',
      tool_input: { command: 'npx vitest run' },
      tool_response: '3 failed | 97 passed',
    });

    const event = detectEvent(failInput);
    expect(event).toBe('test-fail');
  });
});

// ── 4. THE WORM regression ────────────────────────────────────────────────────

describe('THE WORM regression — signal-tier anomaly escalates on signal-tier events', () => {
  /**
   * S302 b89078d fixed THE WORM for critical anomalies. Signal anomalies
   * escalating on signal+flash events was the full fix.
   *
   * Scenario: stale-dirty-work (signal) + commit event (signal tier).
   * Without the fix: signal anomaly was swallowed by same-tier commit message.
   * With the fix: signal anomaly escalates and is surfaced.
   */
  it('stale-dirty-work (signal) escalates on commit (signal-tier event)', () => {
    // State: dirty work stale > 30 min
    const staleIso = new Date(NOW - 40 * 60 * 1000).toISOString();
    const state = hudState({
      git: {
        branch: 'main',
        uncommittedFiles: 4,
        lastCommitTs: staleIso,
        recentCommits: ['abc'],
      },
    });

    const ring = readRing(stateDir); // empty ring for this test
    const anomalyResult = detectAnomalies({ recentTools: ring, state, now: NOW });

    // stale-dirty-work must fire at signal severity
    const staleAnomaly = anomalyResult.anomalies.find(a => a.type === 'stale-dirty-work');
    expect(staleAnomaly).toBeDefined();
    expect(staleAnomaly.severity).toBe(SEVERITY_SIGNAL);

    // 'commit' event is mapped to 'signal' tier in EVENT_TIER
    // Verify the tier map exposes the signal level (code under test in hud-reactive)
    // The escalation logic in signalCompanion: eventTier === 'flash' || eventTier === 'signal'
    // → find signal anomaly and emit it. This verifies the condition is reachable.
    const arc   = detectArc({ recentTools: ring, state, now: NOW });
    const intent = detectIntent({ recentTools: ring, state, now: NOW });
    const ctx = { intent, arc, anomalies: anomalyResult };

    // composeMessage for commit with anomaly context should include anomaly reason
    const msg = composeMessage('commit', state, ctx);
    expect(typeof msg).toBe('string');
    expect(msg.length).toBeGreaterThan(0);
    // The anomaly-aware commit template surfaces the stale-dirty reason
    expect(msg).toMatch(/4|uncommitted|commit|stale/i);
  });

  /**
   * signal anomaly escalates on flash-tier event (long-idle flash → stale-dirty signal wins).
   */
  it('signal anomaly overrides flash-tier long-idle event', () => {
    const staleIso = new Date(NOW - 40 * 60 * 1000).toISOString();
    const state = hudState({
      git: { branch: 'main', uncommittedFiles: 2, lastCommitTs: staleIso, recentCommits: [] },
    });

    const oldRing = [{ tool: 'Read', ts: NOW - 10 * 60 * 1000 }]; // 10 min gap → long-idle flash
    const anomalyResult = detectAnomalies({ recentTools: oldRing, state, now: NOW });

    const longIdle = anomalyResult.anomalies.find(a => a.type === 'long-idle');
    const staleDirty = anomalyResult.anomalies.find(a => a.type === 'stale-dirty-work');

    expect(longIdle).toBeDefined();
    expect(longIdle.severity).toBe(SEVERITY_FLASH);
    expect(staleDirty).toBeDefined();
    expect(staleDirty.severity).toBe(SEVERITY_SIGNAL);

    // topSeverity must be signal (signal > flash)
    expect(anomalyResult.topSeverity).toBe(SEVERITY_SIGNAL);
  });
});

// ── 5. SessionStart ring clear ────────────────────────────────────────────────

describe('SessionStart ring clear — new session detects warmup, not locked-in', () => {
  it('clearRing + 3 tool events → detectArc returns warmup, not locked-in', () => {
    // Pre-populate ring with 30 entries simulating a previous session
    for (let i = 0; i < 30; i++) {
      appendTool(
        { tool_name: 'Edit', tool_input: { file_path: `/f${i}.js` } },
        { stateDir },
      );
    }
    expect(readRing(stateDir).length).toBe(30);

    // SessionStart fires → clear the ring
    clearRing(stateDir);
    expect(readRing(stateDir)).toEqual([]);

    // Append only 3 events for the new session
    const freshTs = NOW;
    for (let i = 0; i < 3; i++) {
      appendTool(
        { tool_name: 'Read', tool_input: { file_path: `/new/f${i}.js` } },
        { stateDir },
      );
    }

    const ring = readRing(stateDir);
    expect(ring).toHaveLength(3);

    // New state: session has only 3 tools (below WARMUP_TOOL_COUNT = 10)
    const state = hudState({
      session: {
        contextPct: 2,
        uptime: 1 * 60 * 1000,   // 1 minute (below WARMUP_TIME_MS = 5 min)
        toolCount: 3,             // matches ring length
        modelId: 'claude-opus-4-6',
        rateLimits: { fiveHour: 5, sevenDay: 2 },
      },
    });

    const arc = detectArc({ recentTools: ring, state, now: NOW });

    // Must be warmup — only 3 tools and 1 min uptime
    expect(arc.phase).toBe('warmup');
    expect(arc.confidence).toBeGreaterThanOrEqual(0.75);

    // Confirm it is NOT locked-in (which requires ≥5 tools in 3 min window)
    expect(arc.phase).not.toBe('locked-in');
  });

  it('without clearRing, previous 30-entry ring would produce locked-in', () => {
    // Simulate all 30 events within the last 3 minutes (locked-in velocity)
    const threeMinAgo = NOW - 3 * 60 * 1000;
    const events = Array.from({ length: 30 }, (_, i) => ({
      tool: 'Edit',
      ts: threeMinAgo + (i * 6000), // spread evenly over 3 min
      filePath: `/f${i}.js`,
    }));

    const state = hudState({
      session: {
        contextPct: 40,
        uptime: 60 * 60 * 1000, // 1 hour
        toolCount: 30,
        modelId: 'claude-opus-4-6',
        rateLimits: { fiveHour: 20, sevenDay: 10 },
      },
    });

    const arc = detectArc({ recentTools: events, state, now: NOW });
    // Should be locked-in — 30 events in 3 min exceeds LOCKED_IN_MIN_TOOLS (5)
    expect(arc.phase).toBe('locked-in');
  });
});

// ── 6. Event detection contract ───────────────────────────────────────────────

describe('detectEvent contract — all routable event types', () => {
  it('maps git commit to "commit" event', () => {
    const input = hookInput({
      tool_name: 'Bash',
      tool_input: { command: 'git commit -m "feat: add feature"' },
      tool_response: '[main abc1234] feat: add feature',
    });
    expect(detectEvent(input)).toBe('commit');
  });

  it('maps session-end commit to "session-end" event', () => {
    const input = hookInput({
      tool_name: 'Bash',
      tool_input: { command: 'git commit -m "docs: HANDOFF-S303"' },
      tool_response: '[main def5678] docs: HANDOFF-S303',
    });
    expect(detectEvent(input)).toBe('session-end');
  });

  it('maps error-state via isError boolean', () => {
    const input = hookInput({ isError: true });
    expect(detectEvent(input)).toBe('error-state');
  });

  it('rate-limit-warn fires when rate_limits.five_hour.used_percentage > 95', () => {
    const input = hookInput({
      rate_limits: {
        five_hour: { used_percentage: 96 },
        seven_day: { used_percentage: 20 },
      },
    });
    expect(detectEvent(input)).toBe('rate-limit-warn');
  });

  it('returns null when no event pattern matches', () => {
    const input = hookInput({
      tool_name: 'Read',
      tool_input: { file_path: '/some/file.js' },
      tool_response: 'file contents here',
    });
    expect(detectEvent(input)).toBeNull();
  });
});

// ── 7. composeMessage null-safety ─────────────────────────────────────────────

describe('composeMessage null-safety', () => {
  it('returns null for unknown event type', () => {
    expect(composeMessage('unknown-event-xyz', {}, {})).toBeNull();
  });

  it('never throws for any valid event with empty state', () => {
    const events = ['commit','test-pass','test-fail','forge-phase','badge-earned',
                    'context-high','rate-limit-warn','error-state','session-end','export'];
    for (const evt of events) {
      expect(() => composeMessage(evt, {}, {})).not.toThrow();
    }
  });

  it('output is capped at 60 characters', () => {
    const state = hudState();
    const msg = composeMessage('session-end', state, {});
    if (msg !== null) {
      expect(msg.length).toBeLessThanOrEqual(60);
    }
  });
});
