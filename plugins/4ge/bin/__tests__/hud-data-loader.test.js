import { describe, it, expect, beforeEach, afterEach } from 'vitest';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { loadHudData, buildCapabilities, computeUptime, deriveOverall, mergeHarnessStdin } = require('../hud-data-loader.cjs');

describe('hud-data-loader', () => {
  let tmpStateDir;
  let tmpCwd;

  beforeEach(() => {
    tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hdl-state-'));
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hdl-cwd-'));
  });

  afterEach(() => {
    fs.rmSync(tmpStateDir, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  it('buildCapabilities merges boot-status + flat health (no .capabilities key)', () => {
    const boot = {
      capabilities: {
        git: { status: 'ready', init_ms: 5 },
        forge: { status: 'degraded', init_ms: 3, reason: 'stale' },
      },
    };
    // Flat health map -- NO wrapper
    const health = {
      git: { ok: true, version: '2.45' },
      forge: { ok: false, reason: 'no session' },
    };
    const caps = buildCapabilities(boot, health);
    expect(caps.git.ok).toBe(true);
    expect(caps.git.init_ms).toBe(5);
    expect(caps.forge.ok).toBe(false);
    expect(caps.forge.reason).toBe('no session');
  });

  it('computeUptime returns ms since booted_at', () => {
    const booted = new Date(Date.now() - 10_000).toISOString();
    const uptime = computeUptime({ booted_at: booted });
    expect(uptime).toBeGreaterThanOrEqual(10_000);
    expect(uptime).toBeLessThan(15_000);
  });

  it('deriveOverall reports failed > degraded > ready', () => {
    expect(deriveOverall({ a: { status: 'ready' } })).toBe('ready');
    expect(deriveOverall({ a: { status: 'degraded' } })).toBe('degraded');
    expect(deriveOverall({ a: { status: 'failed' } })).toBe('failed');
    expect(deriveOverall({})).toBe('unknown');
  });

  it('loadHudData reads flat health.json and produces contextLabel/toolCount/rateLimits N/A', () => {
    fs.writeFileSync(
      path.join(tmpStateDir, 'health.json'),
      JSON.stringify({ git: { ok: true } })
    );
    fs.writeFileSync(
      path.join(tmpStateDir, 'boot-status.json'),
      JSON.stringify({
        session_id: 'boot-sess',
        booted_at: new Date(Date.now() - 1000).toISOString(),
        capabilities: { git: { status: 'ready', init_ms: 7 } },
        total_boot_ms: 42,
      })
    );
    fs.writeFileSync(
      path.join(tmpStateDir, 'session-meta.json'),
      JSON.stringify({
        model: 'claude-opus-4-6[1m]',
        session_id: 'meta-sess',
        est_context_pct: 23,
        tool_count_running: 47,
        context_window: 1000000,
      })
    );

    const raw = loadHudData({ stateDir: tmpStateDir, cwd: tmpCwd, runExpensiveProbes: false });
    expect(raw.session.model).toBe('claude-opus-4-6[1m]');
    expect(raw.session.contextLabel).toBe('');  // est_context_pct is truthy (23), so label cleared
    expect(raw.session.contextPct).toBe(23);
    expect(raw.session.toolCount).toBe(47);
    expect(raw.session.rateLimits).toBe('N/A');
    expect(raw.os.capabilities.git.ok).toBe(true);
    expect(raw.os.bootTime).toBe(42);
    expect(raw.os.overallHealth).toBe('ready');
  });

  it('stdinOverride wins over file-assembled state per-key', () => {
    fs.writeFileSync(
      path.join(tmpStateDir, 'session-meta.json'),
      JSON.stringify({ model: 'claude-sonnet-4-6', tool_count_running: 5 })
    );
    const raw = loadHudData({
      stateDir: tmpStateDir,
      cwd: tmpCwd,
      runExpensiveProbes: false,
      stdinOverride: { theme: { name: 'dark' } },
    });
    expect(raw.theme).toEqual({ name: 'dark' });
    expect(raw.session.model).toBe('claude-sonnet-4-6');
  });

  // 2026-04-27 Task 2: hud-context.json TTL guard. The file persists across
  // sessions and is never reset on workflow end — stale labels were leaking
  // into the HUD context zone for days. Reads older than 6 hours should be
  // treated as empty.
  it('loadHudData treats hud-context.json older than 6h as empty', () => {
    const stale = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(
      path.join(tmpStateDir, 'hud-context.json'),
      JSON.stringify({ label: 'forge:phase3', updated_at: stale }),
    );
    const raw = loadHudData({ stateDir: tmpStateDir, cwd: tmpCwd, runExpensiveProbes: false });
    expect(raw.context.event).toBeNull();
  });

  it('loadHudData surfaces hud-context.json when it is fresh (within 6h)', () => {
    const fresh = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    fs.writeFileSync(
      path.join(tmpStateDir, 'hud-context.json'),
      JSON.stringify({ label: 'forge:phase3', updated_at: fresh }),
    );
    const raw = loadHudData({ stateDir: tmpStateDir, cwd: tmpCwd, runExpensiveProbes: false });
    expect(raw.context.event).toBe('forge:phase3');
  });

  it('loadHudData treats hud-context.json without updated_at as empty', () => {
    fs.writeFileSync(
      path.join(tmpStateDir, 'hud-context.json'),
      JSON.stringify({ label: 'no-timestamp' }),
    );
    const raw = loadHudData({ stateDir: tmpStateDir, cwd: tmpCwd, runExpensiveProbes: false });
    expect(raw.context.event).toBeNull();
  });

  it('loadHudData treats hud-context.json with unparseable updated_at as empty', () => {
    fs.writeFileSync(
      path.join(tmpStateDir, 'hud-context.json'),
      JSON.stringify({ label: 'bogus', updated_at: 'not-a-date' }),
    );
    const raw = loadHudData({ stateDir: tmpStateDir, cwd: tmpCwd, runExpensiveProbes: false });
    expect(raw.context.event).toBeNull();
  });

  it('loadHudData defaults gracefully when files are missing', () => {
    const raw = loadHudData({ stateDir: tmpStateDir, cwd: tmpCwd, runExpensiveProbes: false });
    expect(raw.session.model).toBe('unknown');
    expect(raw.session.rateLimits).toBe('N/A');
    expect(raw.os.overallHealth).toBe('unknown');
    expect(raw.forge.active).toBe(false);
  });
});

describe('mergeHarnessStdin', () => {
  function makeBaseState() {
    return {
      session: {
        id: '',
        model: 'unknown',
        contextPct: 0,
        contextLabel: 'est.',
        toolCount: 0,
        uptime: 0,
        rateLimits: 'N/A',
      },
    };
  }

  it('maps model display_name into session.model', () => {
    const state = makeBaseState();
    mergeHarnessStdin(state, { model: { model_id: 'claude-opus-4-6', display_name: 'Opus 4.6' } });
    expect(state.session.model).toBe('Opus 4.6');
  });

  it('falls back to model.id when display_name is absent', () => {
    const state = makeBaseState();
    mergeHarnessStdin(state, { model: { id: 'claude-opus-4-6' } });
    expect(state.session.model).toBe('claude-opus-4-6');
  });

  it('maps context_window.used_percentage into session.contextPct', () => {
    const state = makeBaseState();
    mergeHarnessStdin(state, { context_window: { used_percentage: 42 } });
    expect(state.session.contextPct).toBe(42);
  });

  it('sets contextLabel to "of 1M" for 1000000 token window', () => {
    const state = makeBaseState();
    mergeHarnessStdin(state, { context_window: { used_percentage: 10, total_tokens: 1000000 } });
    expect(state.session.contextLabel).toBe('of 1M');
  });

  it('sets contextLabel to "of 200K" for 200000 token window', () => {
    const state = makeBaseState();
    mergeHarnessStdin(state, { context_window: { used_percentage: 10, total_tokens: 200000 } });
    expect(state.session.contextLabel).toBe('of 200K');
  });

  it('maps rate_limits into session.rateLimits object replacing N/A sentinel', () => {
    const state = makeBaseState();
    mergeHarnessStdin(state, {
      rate_limits: {
        five_hour: { used_percentage: 30 },
        seven_day: { used_percentage: 10 },
      },
    });
    expect(state.session.rateLimits).toEqual({ fiveHour: 30, sevenDay: 10, fiveHourResetsAt: null, sevenDayResetsAt: null });
  });

  it('maps session_id into state.session.id', () => {
    const state = makeBaseState();
    mergeHarnessStdin(state, { session_id: 'session-abc-123' });
    expect(state.session.id).toBe('session-abc-123');
  });

  it('maps cost.total_cost_usd into state.session.cost', () => {
    const state = makeBaseState();
    mergeHarnessStdin(state, { cost: { total_cost_usd: 2.87 } });
    expect(state.session.cost).toBeCloseTo(2.87);
  });

  it('handles null harness gracefully (no-op)', () => {
    const state = makeBaseState();
    const result = mergeHarnessStdin(state, null);
    expect(result.session.model).toBe('unknown');
    expect(result.session.rateLimits).toBe('N/A');
  });

  it('handles partial harness data gracefully', () => {
    const state = makeBaseState();
    mergeHarnessStdin(state, { model: { display_name: 'Sonnet 4.6' } });
    expect(state.session.model).toBe('Sonnet 4.6');
    expect(state.session.rateLimits).toBe('N/A');
    expect(state.session.contextPct).toBe(0);
  });

  it('handles missing rate_limit sub-fields gracefully (defaults to 0)', () => {
    const state = makeBaseState();
    mergeHarnessStdin(state, { rate_limits: { five_hour: {}, seven_day: {} } });
    expect(state.session.rateLimits).toEqual({ fiveHour: 0, sevenDay: 0, fiveHourResetsAt: null, sevenDayResetsAt: null });
  });

  it('returns the same state reference (mutation in-place)', () => {
    const state = makeBaseState();
    const result = mergeHarnessStdin(state, { session_id: 'x' });
    expect(result).toBe(state);
  });
});
