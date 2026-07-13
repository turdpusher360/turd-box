import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);

const CLI = path.resolve(__dirname, '../hud-board.cjs');
const cli = _require(CLI); // top-level requires only; main() is require.main-guarded
const store = _require(path.resolve(__dirname, '../../lib/hud-board-store.cjs'));
const loader = _require(path.resolve(__dirname, '../hud-data-loader.cjs'));
const engine = _require(path.resolve(__dirname, '../hud-engine.cjs'));

// eslint-disable-next-line no-control-regex
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-board-cli-'));
});
afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function runCli(args) {
  return execFileSync('node', [CLI, ...args], {
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, NO_COLOR: '1' },
    encoding: 'utf8',
  });
}

describe('hud-board CLI — parseLine', () => {
  it('splits a known "level:text" prefix', () => {
    expect(cli.parseLine('warn:cron is late')).toEqual({ level: 'warn', text: 'cron is late' });
  });
  it('treats an unknown prefix as plain info text', () => {
    expect(cli.parseLine('bogus:still text')).toEqual({ level: 'info', text: 'bogus:still text' });
  });
  it('defaults a prefix-less line to info', () => {
    expect(cli.parseLine('just a note')).toEqual({ level: 'info', text: 'just a note' });
  });
});

describe('hud-board CLI — parseArgs', () => {
  it('collects title, repeated lines, ttl and priority', () => {
    const parsed = cli.parseArgs([
      '--title', 'Deploy', '--line', 'ok:green', '--line', 'warn:watch', '--ttl', '600', '--priority', '7',
    ]);
    expect(parsed.title).toBe('Deploy');
    expect(parsed.lines).toHaveLength(2);
    expect(parsed.ttl).toBe(600);
    expect(parsed.priority).toBe(7);
  });
  it('supports --flag=value form', () => {
    const parsed = cli.parseArgs(['--title=Deploy', '--line=ok:green']);
    expect(parsed.title).toBe('Deploy');
    expect(parsed.lines[0]).toEqual({ level: 'ok', text: 'green' });
  });
});

describe('hud-board CLI — set / show / clear (child process)', () => {
  it('set writes to CLAUDE_PROJECT_DIR/_runs/os and show renders it', () => {
    const setOut = runCli(['set', '--title', 'R2 backup', '--line', 'ok:verified', '--line', 'warn:defect queued']);
    expect(setOut).toContain('board set');
    expect(fs.existsSync(path.join(dir, '_runs', 'os', 'hud-board.json'))).toBe(true);

    const showOut = runCli(['show']);
    expect(showOut).toContain('R2 backup');
    expect(showOut).toContain('verified');
    expect(showOut).toContain('defect queued');
  });

  it('clear removes the board so show reports none', () => {
    runCli(['set', '--line', 'info:temporary']);
    runCli(['clear']);
    expect(runCli(['show'])).toContain('no active board');
  });

  it('set with no lines exits non-zero', () => {
    let code = 0;
    try {
      runCli(['set', '--title', 'oops']);
    } catch (e) {
      code = e.status;
    }
    expect(code).toBe(2);
  });
});

describe('hud-board — engine-level presence / absence', () => {
  function renderStatusline() {
    const stateDir = path.join(dir, '_runs', 'os');
    const raw = loader.loadHudData({ stateDir, cwd: dir, runExpensiveProbes: false });
    return stripAnsi(engine.renderStatusLine(raw, 8));
  }

  it('a fresh board appears on the statusline', () => {
    const stateDir = path.join(dir, '_runs', 'os');
    store.writeBoard(stateDir, { title: 'LIVE BOARD', lines: [{ level: 'ok', text: 'shipping' }] });
    expect(renderStatusline()).toContain('LIVE BOARD');
  });

  it('an expired board does not appear on the statusline', () => {
    const stateDir = path.join(dir, '_runs', 'os');
    // createdAt 100s ago, ttl 10s → expired by the time the loader reads it.
    store.writeBoard(stateDir, { title: 'STALE BOARD', lines: [{ level: 'ok', text: 'old' }], ttlSec: 10 }, Date.now() - 100_000);
    expect(renderStatusline()).not.toContain('STALE BOARD');
  });

  it('no board file → statusline still renders (no crash, no board)', () => {
    const out = renderStatusline();
    expect(typeof out).toBe('string');
    expect(out).not.toContain('▐'); // no board marker
  });
});
