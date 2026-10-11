'use strict';

/**
 * os-accounting.test.js — e2e tests for the plugin os-accounting hook.
 *
 * Spawns the hook as a child process against a stub fixture root (the hook
 * cannot be require()'d in-process: its module-scope gate arms a 500ms
 * process.exit timer). The fixture provides minimal lib/os stubs under a
 * CLAUDE_PLUGIN_DATA vendor tree, the plugin-owned layer os-guard resolves
 * (BL-404: a project's own lib/os is never loaded).
 *
 * Red-proven claims:
 *   - the adaptive health refresh actually RUNS (was dead: setImmediate
 *     scheduled, then process.exit(0) killed the process before the
 *     immediate queue drained, while last_refresh_ms kept re-arming it)
 *   - session-meta.json carries the next_handoff_number schema with the
 *     session_number legacy alias (schema parity with the .claude copy)
 */

import { describe, it, expect, afterEach } from 'vitest';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const HOOK_PATH = path.resolve(__dirname, '..', 'os-accounting.cjs');

// Vendored OS stubs live under <root>/plugin-data, passed as CLAUDE_PLUGIN_DATA.
const OS = 'plugin-data/vendor/lib/os/';

const tempDirs = [];
afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'os-accounting-'));
  tempDirs.push(root);

  // Minimal vendored OS tree so os-guard resolveOsRoot() picks the fixture's
  // plugin data dir (no .claude/settings.json => not project-managed => plugin
  // path active).
  write(root, OS + 'index.cjs', 'module.exports = {};\n');
  write(root, OS + 'kernel/feature-gates.cjs',
    'module.exports = { createFeatureGates: () => ({ isEnabled: () => true }) };\n');
  write(root, OS + 'config/gates.json', '{}\n');
  write(root, OS + 'jsonl-rotate.cjs',
    "const fs = require('fs');\n" +
    'module.exports = { appendJsonl: (p, obj) => fs.appendFileSync(p, JSON.stringify(obj) + \'\\n\') };\n');
  // Marker stub: proves refreshCheap() was actually invoked.
  write(root, OS + 'health-refresh.cjs',
    "const fs = require('fs'); const path = require('path');\n" +
    'module.exports = { refreshCheap: (capDir, stateDir) => {\n' +
    "  fs.writeFileSync(path.join(stateDir, 'refresh-ran.marker'), String(Date.now()));\n" +
    '  return { stub: { ok: true } };\n' +
    '} };\n');

  // Seeded runtime state: last_refresh_ms=0 => cooldown expired => refresh due.
  write(root, '_runs/os/session-meta.json', JSON.stringify({
    session_number: 1,
    last_refresh_ms: 0,
    consecutive_healthy: 0,
  }, null, 2));
  write(root, '_runs/os/health.json', JSON.stringify({ stub: { ok: true } }));
  // Handoff marker: deriveNextHandoffNumber should yield 13.
  write(root, '_runs/HANDOFF-S12.md', '# handoff\n');
  return root;
}

function runHook(root, input) {
  const env = { ...process.env, CLAUDE_PLUGIN_DATA: path.join(root, 'plugin-data') };
  delete env.CLAUDE_PLUGIN_ROOT;
  return spawnSync(process.execPath, [HOOK_PATH], {
    cwd: root,
    env,
    input: JSON.stringify(input),
    encoding: 'utf8',
    timeout: 15000,
  });
}

function readJson(root, rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
}

const MAIN_INPUT = {
  tool_name: 'Read',
  tool_input: { file_path: '/some/file.txt' },
  tool_response: 'x'.repeat(400),
  session_id: 'test-sid',
};

describe('os-accounting.cjs (plugin copy, fixture root)', () => {
  it('runs the due health refresh before exit (dead setImmediate red-proof)', () => {
    const root = makeFixture();
    const r = runHook(root, MAIN_INPUT);

    expect(r.status).toBe(0);
    // The refresh marker proves refreshCheap() executed. Before the fix the
    // callback sat in the immediate queue when process.exit(0) fired.
    expect(fs.existsSync(path.join(root, '_runs/os/refresh-ran.marker'))).toBe(true);

    const meta = readJson(root, '_runs/os/session-meta.json');
    expect(meta.last_refresh_ms).toBeGreaterThan(0);
    expect(meta.consecutive_healthy).toBe(1); // stub health all-ok => streak +1
  });

  it('writes the next_handoff_number schema with session_number legacy alias', () => {
    const root = makeFixture();
    const r = runHook(root, MAIN_INPUT);

    expect(r.status).toBe(0);
    const meta = readJson(root, '_runs/os/session-meta.json');
    expect(meta.next_handoff_number).toBe(13);
    expect(meta.session_number).toBe(13); // legacy alias for HUD/readers
    expect(typeof meta.session_number_note).toBe('string');
  });

  it('accounts the call: ledger event, running counters, heartbeat', () => {
    const root = makeFixture();
    const r = runHook(root, MAIN_INPUT);

    expect(r.status).toBe(0);
    const ledger = fs.readFileSync(path.join(root, '_runs/os/resource-ledger.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ event: 'tool', tool: 'Read', caller: 'main', est_tokens: 100 });

    const meta = readJson(root, '_runs/os/session-meta.json');
    expect(meta.tool_count_running).toBe(1);
    expect(meta.est_tokens_running_total).toBe(100);

    const hb = readJson(root, '_runs/os/heartbeats/main.json');
    expect(hb.tool_count).toBe(1);
  });

  // est_context_pct uses a model-derived window when session-meta carries no
  // context_window (S705: Fable and Sonnet 5.x are 1M models, not 200K). The seeded
  // total is large enough that both windows give a non-zero percentage.
  function contextPctFor(model) {
    const root = makeFixture();
    write(root, '_runs/os/session-meta.json', JSON.stringify({
      session_number: 1,
      last_refresh_ms: 0,
      consecutive_healthy: 0,
      model,
      est_tokens_running_total: 100000,
    }, null, 2));
    const r = runHook(root, MAIN_INPUT);
    expect(r.status).toBe(0);
    return readJson(root, '_runs/os/session-meta.json').est_context_pct;
  }

  it('est_context_pct falls back to a 1M window for Sonnet 5.x, Fable and Opus but 200K for Sonnet 4.x', () => {
    const sonnet55 = contextPctFor('claude-sonnet-5-5');
    expect(sonnet55).toBeGreaterThan(0);
    expect(sonnet55).toBeLessThan(contextPctFor('claude-sonnet-4-6'));
    for (const model of ['claude-sonnet-5', 'claude-fable-5-1', 'claude-opus-5-5']) {
      expect(contextPctFor(model), model).toBe(sonnet55);
    }
  });

  it('never writes hud-context.json for non-main callers even mid-workflow', () => {
    const root = makeFixture();
    write(root, '.forge-session.json', JSON.stringify({ phase: 'execute' }));
    const r = runHook(root, {
      ...MAIN_INPUT,
      agent_id: 'sub1',
      agent_type: 'research',
    });

    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(root, '_runs/os/hud-context.json'))).toBe(false);
    const hb = readJson(root, '_runs/os/heartbeats/sub1.json');
    expect(hb.tool_count).toBe(1);
  });
});
