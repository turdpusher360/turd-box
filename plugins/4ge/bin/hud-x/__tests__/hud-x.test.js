import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const engine = require('../engine.cjs');
const { baseVM } = require('../demo.cjs');

const {
  renderStatusline,
  renderFull,
  frameWidth,
  breakpoint,
  visibleWidth,
  stripAnsi,
  fit,
  gauge,
  gaugeColor,
  arbitrate,
  collectCandidates,
  resolveUptime,
  buildViewModel,
  readUsageState,
  readSentinelState,
  fmtCountdown,
  fmtAge,
  fmtDuration,
  shortModel,
} = engine;

function rows(output) {
  return output.split('\n');
}

let tmpDir;

beforeEach(() => {
  process.env.HUDX_NO_INSIGHT = '1';
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hudx-test-'));
});

afterEach(() => {
  delete process.env.HUDX_NO_INSIGHT;
  delete process.env.HUDX_NO_COLOR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('render smoke + fixed geometry', () => {
  it('renders exactly 4 rows at standard width, each exactly frame-width wide', () => {
    const out = renderStatusline(baseVM(), { cols: 100 });
    const lines = rows(out);
    expect(lines).toHaveLength(4);
    const width = frameWidth(100, breakpoint(100));
    for (const line of lines) {
      expect(visibleWidth(line)).toBe(width);
    }
  });

  it('holds 4 rows and exact width at narrow (phone) width', () => {
    const out = renderStatusline(baseVM(), { cols: 44 });
    const lines = rows(out);
    expect(lines).toHaveLength(4);
    for (const line of lines) {
      expect(visibleWidth(line)).toBe(44);
    }
  });

  it('geometry is identical across scenario content (anti-ghost invariant)', () => {
    const quiet = baseVM();
    const loud = baseVM();
    loud.sentinel = { red: ['agent-cap-8'], overdue: 2, ok: 13, total: 15 };
    loud.context.pct = 91;
    loud.forge = { active: true, phase: 'execute', scope: 'x', teammates: 2, progressPct: 40 };
    const widthsQuiet = rows(renderStatusline(quiet, { cols: 100 })).map(visibleWidth);
    const widthsLoud = rows(renderStatusline(loud, { cols: 100 })).map(visibleWidth);
    expect(widthsLoud).toEqual(widthsQuiet);
  });

  it('honors --max-rows by dropping rows from the bottom', () => {
    expect(rows(renderStatusline(baseVM(), { cols: 100, maxRows: 2 }))).toHaveLength(2);
    expect(rows(renderStatusline(baseVM(), { cols: 100, maxRows: 8 }))).toHaveLength(4);
  });

  it('is byte-stable: same view-model renders identical bytes', () => {
    const vm = baseVM();
    expect(renderStatusline(vm, { cols: 100 })).toBe(renderStatusline(vm, { cols: 100 }));
  });

  it('narrow drops commit subject and token counts', () => {
    const plain = stripAnsi(renderStatusline(baseVM(), { cols: 44 }));
    expect(plain).not.toContain('constraint register');
    expect(plain).not.toContain('180k');
  });

  it('HUDX_NO_COLOR strips all ANSI', () => {
    process.env.HUDX_NO_COLOR = '1';
    const out = renderStatusline(baseVM(), { cols: 100 });
    expect(out).not.toContain('\x1b');
  });

  it('renderFull produces a panel with the section labels', () => {
    const plain = stripAnsi(renderFull(baseVM(), { cols: 100 }));
    expect(plain).toContain('CTX');
    expect(plain).toContain('7D');
    expect(plain).toContain('OS');
    expect(plain).toContain('GIT');
    expect(plain).toContain('SENT');
  });
});

describe('arbiter priority ladder', () => {
  it('sentinel red outranks everything', () => {
    const vm = baseVM();
    vm.sentinel = { red: ['disable-auto-compact'], overdue: 0, ok: 14, total: 15 };
    vm.os.degraded = ['aisle'];
    vm.context.pct = 95;
    const { voice } = arbitrate(vm);
    expect(voice.kind).toBe('sentinel');
    expect(voice.sev).toBe('red');
  });

  it('OS degraded outranks burn and context warnings', () => {
    const vm = baseVM();
    vm.os.degraded = ['infra'];
    vm.usage.sevenDayPct = 90;
    const { voice } = arbitrate(vm);
    expect(voice.kind).toBe('os-degraded');
  });

  it('suppressed warn+ alerts light the annunciator', () => {
    const vm = baseVM();
    vm.sentinel = { red: ['a'], overdue: 0, ok: 14, total: 15 };
    vm.usage.sevenDayPct = 85;
    vm.context.pct = 90;
    const verdict = arbitrate(vm);
    expect(verdict.suppressed).toBe(2);
    expect(verdict.suppressedRed).toBe(false);
  });

  it('falls through to the quiet line when nothing is wrong', () => {
    const vm = baseVM();
    vm.session.uptimeMs = 60 * 60 * 1000; // outside momentum window
    const { voice } = arbitrate(vm);
    expect(voice.kind).toBe('quiet');
    expect(voice.text).toContain('9/9 ready');
  });

  it('momentum speaks only inside the session-start window', () => {
    const vm = baseVM();
    vm.session.uptimeMs = 3 * 60 * 1000;
    expect(arbitrate(vm).voice.kind).toBe('momentum');
    vm.session.uptimeMs = 30 * 60 * 1000;
    expect(arbitrate(vm).voice.kind).not.toBe('momentum');
  });

  it('companion message wins over momentum but loses to alerts', () => {
    const vm = baseVM();
    vm.session.uptimeMs = 3 * 60 * 1000;
    vm.companion.message = { text: 'hello from Anvil', tier: 'signal' };
    expect(arbitrate(vm).voice.kind).toBe('message');
    vm.usage.fiveHourPct = 92;
    expect(arbitrate(vm).voice.kind).toBe('burn-5h');
  });
});

describe('eye expressions', () => {
  it('maps state to lid apertures per the design table', () => {
    const calm = baseVM();
    calm.session.active = false;
    calm.session.uptimeMs = 60 * 60 * 1000;
    expect(arbitrate(calm).eyes).toBe('calm');

    const red = baseVM();
    red.sentinel = { red: ['x'], overdue: 0, ok: 14, total: 15 };
    expect(arbitrate(red).eyes).toBe('alert');

    const warn = baseVM();
    warn.usage.sevenDayPct = 85;
    expect(arbitrate(warn).eyes).toBe('concern');

    const happy = baseVM();
    happy.session.uptimeMs = 60 * 60 * 1000;
    happy.reactive = { event: 'commit', ageMs: 5000 };
    expect(arbitrate(happy).eyes).toBe('happy');

    const resting = baseVM();
    resting.session.active = false;
    resting.session.uptimeMs = 60 * 60 * 1000;
    resting.session.idleMs = 20 * 60 * 1000;
    expect(arbitrate(resting).eyes).toBe('resting');

    const asleep = baseVM();
    asleep.session.active = false;
    asleep.session.uptimeMs = 60 * 60 * 1000;
    asleep.session.idleMs = 50 * 60 * 1000;
    expect(arbitrate(asleep).eyes).toBe('asleep');
  });
});

describe('multi-session-safe uptime anchor', () => {
  it('keeps independent anchors for concurrent sessions (no clobber)', () => {
    const dir = path.join(tmpDir, 'hud-x');
    const t0 = 1000000;
    const a = resolveUptime({ dir, sessionId: 'session-aaa', now: t0, toolCountRunning: 100 });
    const b = resolveUptime({ dir, sessionId: 'session-bbb', now: t0 + 5 * 60000, toolCountRunning: 400 });
    expect(a.uptimeMs).toBe(0);
    expect(b.uptimeMs).toBe(0);

    // Session A re-renders later: its anchor must be intact, not reset by B.
    const a2 = resolveUptime({ dir, sessionId: 'session-aaa', now: t0 + 10 * 60000, toolCountRunning: 160 });
    expect(a2.uptimeMs).toBe(10 * 60000);
    expect(a2.toolCount).toBe(60); // 160 running - 100 base

    const b2 = resolveUptime({ dir, sessionId: 'session-bbb', now: t0 + 10 * 60000, toolCountRunning: 460 });
    expect(b2.uptimeMs).toBe(5 * 60000);
    expect(b2.toolCount).toBe(60); // 460 - 400

    const anchors = fs.readdirSync(dir).filter((n) => n.startsWith('uptime-'));
    expect(anchors).toHaveLength(2);
  });

  it('handles missing session id without writing anything', () => {
    const dir = path.join(tmpDir, 'hud-x');
    const result = resolveUptime({ dir, sessionId: '', now: 5000 });
    expect(result).toEqual({ uptimeMs: 0, toolCount: null });
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('prunes anchors older than 48h when a new anchor is created', () => {
    const dir = path.join(tmpDir, 'hud-x');
    fs.mkdirSync(dir, { recursive: true });
    const stale = path.join(dir, 'uptime-old-session.json');
    fs.writeFileSync(stale, JSON.stringify({ session_id: 'old-session', started_at_ms: 1 }));
    const past = (Date.now() - 72 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(stale, past, past);
    resolveUptime({ dir, sessionId: 'fresh-session', now: Date.now() });
    expect(fs.existsSync(stale)).toBe(false);
  });
});

describe('state-file absence tolerance', () => {
  it('renders a full 4-row frame from a completely empty state dir', () => {
    const vm = buildViewModel({ cwd: tmpDir, stateDir: path.join(tmpDir, 'os'), stdin: null, now: Date.now() });
    const out = renderStatusline(vm, { cols: 100 });
    const lines = rows(out);
    expect(lines).toHaveLength(4);
    const plain = stripAnsi(out);
    expect(plain).toContain('OS state unknown');
    expect(plain).toContain('—'); // gauge placeholders
  });

  it('merges harness stdin as the authoritative source', () => {
    const stdin = {
      session_id: 'stdin-session',
      model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
      context_window: { used_percentage: 42, total_tokens: 1000000 },
      rate_limits: {
        seven_day: { used_percentage: 55, resets_at: new Date(Date.now() + 86400000).toISOString() },
        five_hour: { used_percentage: 12, resets_at: new Date(Date.now() + 3600000).toISOString() },
      },
      cost: { total_cost_usd: 7.5, input_tokens: 1000, output_tokens: 200 },
    };
    const vm = buildViewModel({ cwd: tmpDir, stateDir: path.join(tmpDir, 'os'), stdin, now: Date.now() });
    expect(vm.context.pct).toBe(42);
    expect(vm.usage.sevenDayPct).toBe(55);
    expect(vm.session.costUsd).toBe(7.5);
    expect(vm.modelShort).toBe('opus');
    const plain = stripAnsi(renderStatusline(vm, { cols: 100 }));
    expect(plain).toContain('42%');
    expect(plain).toContain('$7.50');
  });
});

describe('extra state readers (new consumers)', () => {
  it('reads fresh usage-state.json and rejects stale', () => {
    const dir = path.join(tmpDir, 'os');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'usage-state.json');
    const fresh = {
      updated_at: new Date().toISOString(),
      available: true,
      plan: 'Max',
      posture: 'ABUNDANT',
      projected_weekly: 22.2,
      seven_day: { pct: 17, resets_at: new Date(Date.now() + 86400000).toISOString() },
      five_hour: { pct: 33, resets_at: new Date(Date.now() + 3600000).toISOString() },
    };
    fs.writeFileSync(file, JSON.stringify(fresh));
    const read = readUsageState(dir, Date.now());
    expect(read.posture).toBe('ABUNDANT');
    expect(read.sevenDayPct).toBe(17);

    fresh.updated_at = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(file, JSON.stringify(fresh));
    expect(readUsageState(dir, Date.now())).toBeNull();
  });

  it('reads sentinel-status.json summary including overdue counts', () => {
    const dir = path.join(tmpDir, 'os');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sentinel-status.json'), JSON.stringify({
      ran_at: new Date().toISOString(),
      summary: {
        enforced_ok: 14,
        enforced_total: 15,
        red: ['disable-auto-compact'],
        doctrine_only_overdue: ['x'],
        retiring_overdue: ['y', 'z'],
      },
    }));
    const read = readSentinelState(dir, Date.now());
    expect(read.red).toEqual(['disable-auto-compact']);
    expect(read.overdue).toBe(3);
    expect(read.ok).toBe(14);
  });
});

describe('units', () => {
  it('fit truncates styled text to exact visible width without SGR bleed', () => {
    const styled = `\x1b[38;5;39mabcdefghij\x1b[0m`;
    const out = fit(styled, 5);
    expect(visibleWidth(out)).toBe(5);
    expect(out.endsWith('\x1b[0m')).toBe(true);
    expect(fit('ab', 6)).toBe('ab    ');
  });

  it('gauge quantizes to eighths and colors by threshold', () => {
    expect(stripAnsi(gauge(100, 5))).toBe('⣿⣿⣿⣿⣿');
    expect(stripAnsi(gauge(0, 5))).toBe('⣀⣀⣀⣀⣀');
    expect(visibleWidth(gauge(62, 5))).toBe(5);
    expect(gaugeColor(50)).toBe(39);
    expect(gaugeColor(75)).toBe(214);
    expect(gaugeColor(90)).toBe(196);
  });

  it('formats durations, countdowns, and ages at byte-stable granularity', () => {
    expect(fmtDuration(2 * 3600000 + 14 * 60000)).toBe('2h14m');
    expect(fmtCountdown(1.6 * 86400000)).toBe('1.6d');
    expect(fmtCountdown(125 * 60000)).toBe('2h05');
    expect(fmtAge(3 * 60000)).toBe('now');
    expect(fmtAge(23 * 60000)).toBe('20m'); // 5-minute quanta
    expect(fmtAge(3 * 3600000)).toBe('3h');
  });

  it('shortens model names', () => {
    expect(shortModel('Fable 5')).toBe('fable');
    expect(shortModel('claude-opus-4-8')).toBe('opus');
    expect(shortModel('Sonnet 5')).toBe('sonnet');
    expect(shortModel('')).toBe('?');
  });
});

describe('voice candidates completeness', () => {
  it('always terminates with the quiet line', () => {
    const candidates = collectCandidates(baseVM());
    expect(candidates[candidates.length - 1].kind).toBe('quiet');
  });
});
