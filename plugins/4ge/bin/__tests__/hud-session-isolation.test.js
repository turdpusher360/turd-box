// S595 statusline per-instance isolation (operator ruling S594).
// A statusline speaks ONLY for its own session: foreign-session OS state
// (boot-status / session-meta / rig-context singletons) is SUPPRESSED, not
// labeled. Multi-instance is normal and never a warning surface. These tests
// drive applySessionIsolation() directly and through renderStatusLine().
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { loadHudData, mergeHarnessStdin, applySessionIsolation } = require('../hud-data-loader.cjs');
const { renderStatusLine } = require('../hud-engine.cjs');

const LIVE = 'live-session-0001';
const FOREIGN = 'foreign-session-9999';

const ANSI_RE = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g;
function plain(text) {
  return String(text).replace(ANSI_RE, '');
}

let root;
let stateDir;

function writeJson(rel, obj) {
  const p = path.join(stateDir, rel);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}

function writeTrio({ owner, bootedAt = new Date().toISOString(), sessionNumber = 595, rigChecks } = {}) {
  writeJson('boot-status.json', {
    session_id: owner,
    written_by: { session_id: owner, entry: 'hook' },
    booted_at: bootedAt,
    total_boot_ms: 1234,
    capabilities: { aisle: { status: 'ready', init_ms: 10 } },
  });
  writeJson('session-meta.json', {
    session_id: owner,
    session_number: sessionNumber,
    tool_count_running: 42,
    est_context_pct: 33,
    model: 'claude-opus-4-8[1m]',
  });
  writeJson('rig-context.json', {
    session_id: owner,
    generated_at: new Date().toISOString(),
    ttl_seconds: 3600,
    checks: rigChecks || {
      active_sessions: { status: 'warn', summary: '2 concurrent sessions' },
      docker_stack: { status: 'warn', summary: 'container down' },
    },
  });
}

function loadMerged(stdin) {
  const raw = loadHudData({ stateDir, cwd: root });
  if (stdin) mergeHarnessStdin(raw, stdin);
  applySessionIsolation(raw, {
    stateDir,
    liveSessionId: stdin && stdin.session_id,
    stdin,
  });
  return raw;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-iso-'));
  stateDir = path.join(root, '_runs', 'os');
  fs.mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('applySessionIsolation — ownership flags', () => {
  it('suppresses all three slices when the trio is foreign-owned', () => {
    writeTrio({ owner: FOREIGN });
    const raw = loadMerged({ session_id: LIVE, model: { id: 'claude-opus-4-8[1m]' } });

    expect(raw.sessionIsolation).toMatchObject({
      liveSessionId: LIVE,
      bootOwn: false,
      metaOwn: false,
      rigOwn: false,
      selfFork: false,
    });
    expect(raw.session.sessionNumber).toBe(0);
    expect(raw.session.toolCount).toBe(0);
    expect(raw.rigContext).toBeNull();
  });

  it('keeps everything when the trio is own', () => {
    writeTrio({ owner: LIVE });
    const raw = loadMerged({ session_id: LIVE, model: { id: 'claude-opus-4-8[1m]' } });

    expect(raw.sessionIsolation).toMatchObject({ bootOwn: true, metaOwn: true, rigOwn: true });
    expect(raw.session.sessionNumber).toBe(595);
    expect(raw.rigContext).not.toBeNull();
  });

  it('treats a self-fork boot (ancestor stamp within ±60s of own start) as own', () => {
    const now = Date.now();
    writeTrio({ owner: 'ancestor-x', bootedAt: new Date(now - 10000).toISOString() });
    writeJson('session-uptime.json', {
      version: 2,
      sessions: { [LIVE]: { started_at_ms: now - 5000, tool_count_base: 0, last_seen_ms: now } },
    });
    const raw = loadMerged({ session_id: LIVE, model: { id: 'claude-opus-4-8[1m]' } });

    expect(raw.sessionIsolation.selfFork).toBe(true);
    expect(raw.sessionIsolation.bootOwn).toBe(true);
    expect(raw.sessionIsolation.metaOwn).toBe(true);
    expect(raw.sessionIsolation.rigOwn).toBe(true);
    expect(raw.session.sessionNumber).toBe(595);
    expect(raw.rigContext).not.toBeNull();
  });

  it('is a no-op without a live session id (ownership undecidable)', () => {
    writeTrio({ owner: FOREIGN });
    const raw = loadHudData({ stateDir, cwd: root });
    applySessionIsolation(raw, { stateDir, liveSessionId: undefined });

    expect(raw.sessionIsolation).toMatchObject({
      liveSessionId: null,
      bootOwn: true,
      metaOwn: true,
      rigOwn: true,
    });
    expect(raw.session.sessionNumber).toBe(595);
    expect(raw.rigContext).not.toBeNull();
    expect(raw.rigContext.issues.some((i) => i.name === 'active_sessions')).toBe(true);
  });

  it('preserves stdin-provided context pct through a foreign meta suppression', () => {
    writeTrio({ owner: FOREIGN });
    const raw = loadMerged({
      session_id: LIVE,
      model: { id: 'claude-opus-4-8[1m]' },
      context_window: { used_percentage: 47 },
    });

    expect(raw.sessionIsolation.metaOwn).toBe(false);
    expect(raw.session.contextPct).toBe(47); // live stdin value survives
    expect(raw.session.sessionNumber).toBe(0); // foreign label still gone
  });
});

describe('applySessionIsolation — own rig active_sessions filter', () => {
  it('drops active_sessions but keeps other issues (multi-instance is normal)', () => {
    writeTrio({ owner: LIVE });
    const raw = loadMerged({ session_id: LIVE, model: { id: 'claude-opus-4-8[1m]' } });

    const names = raw.rigContext.issues.map((i) => i.name);
    expect(names).not.toContain('active_sessions');
    expect(names).toContain('docker_stack');
    expect(raw.rigContext.issueCount).toBe(1);
    expect(raw.rigContext.status).toBe('warn');
    expect(raw.rigContext.headline).toBe('1 rig check needs attention');
  });

  it('goes fully ok when active_sessions was the only issue', () => {
    writeTrio({
      owner: LIVE,
      rigChecks: {
        active_sessions: { status: 'warn', summary: '3 concurrent sessions' },
        docker_stack: { status: 'ok', summary: 'up' },
      },
    });
    const raw = loadMerged({ session_id: LIVE, model: { id: 'claude-opus-4-8[1m]' } });

    expect(raw.rigContext.issues).toHaveLength(0);
    expect(raw.rigContext.issueCount).toBe(0);
    expect(raw.rigContext.status).toBe('ok');
    expect(raw.rigContext.headline).toBe('rig context ok');
  });
});

describe('renderStatusLine — foreign state never renders (suppression, not labeling)', () => {
  it('drops foreign S-label, caps ratio, boot-pulse, and coherence banner', () => {
    writeTrio({ owner: FOREIGN }); // fresh booted_at → boot-pulse WOULD fire without the gate
    const raw = loadMerged({ session_id: LIVE, model: { id: 'claude-opus-4-8[1m]' } });
    raw.git = {}; // keep live-repo commit subjects out of the assertion surface

    const out = plain(renderStatusLine(raw, 8));

    expect(out).not.toContain('S595');       // foreign session label
    expect(out).not.toContain('OS BOOT');    // foreign boot-pulse
    expect(out).not.toContain('1/1');        // foreign caps ratio
    expect(out).not.toMatch(/boot .*foreign/i); // no d1 banner — suppressed, not labeled
    expect(out).not.toContain('concurrent sessions');
  });

  it('renders own state unchanged (S-label, caps, boot-pulse all present)', () => {
    writeTrio({ owner: LIVE }); // fresh booted_at → boot-pulse path (wins over companion msg)
    const raw = loadMerged({ session_id: LIVE, model: { id: 'claude-opus-4-8[1m]' } });
    raw.git = {};

    const out = plain(renderStatusLine(raw, 8));

    expect(out).toContain('OS BOOT');
    expect(out).toContain('S595');
    expect(out).toContain('(1234ms)');
  });

  it('renders legacy (no isolation applied) exactly as before', () => {
    writeTrio({ owner: FOREIGN });
    const raw = loadHudData({ stateDir, cwd: root });
    raw.git = {};

    const out = plain(renderStatusLine(raw, 8));

    // Without a live id nothing is suppressed — foreign bleed is the documented
    // legacy behavior for disk-only renders (fleet visibility preserved).
    expect(out).toContain('OS BOOT');
    expect(out).toContain('S595');
  });
});
