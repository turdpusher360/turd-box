import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE = path.resolve(__dirname, '..', 'hud-engine.cjs');
const _require = createRequire(import.meta.url);

// --mode=full runs the live probes (aisle, docker, `git status`/`git log`) against
// the project root: hud-data-loader.cjs:713-720 and :829, gated at hud-engine.cjs:1250.
// On a WSL drvfs checkout that costs 6.3-8.9 s solo (S705) and ran past the 10 s child
// limit under the runner. The flag tests below use an empty temp root instead: no
// lib/os/health-refresh.cjs to resolve, no git repo to probe, and no live _runs/os
// to overwrite. No test here asserts the live-probe path.
let runRoot;
let runEnv;

function run(...args) {
  return spawnSync('node', [ENGINE, ...args], {
    input: '{}', encoding: 'utf8', timeout: 10000, cwd: runRoot, env: runEnv,
  });
}

describe('hud-engine CLI --mode and --zone flags', () => {
  beforeAll(() => {
    runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-cli-flags-root-'));
    const home = path.join(runRoot, 'home');
    fs.mkdirSync(home, { recursive: true });
    runEnv = { ...process.env };
    for (const key of ['COLUMNS', 'LINES', 'FORGE_OS_STATE_DIR']) delete runEnv[key];
    runEnv.CLAUDE_PROJECT_DIR = runRoot;
    runEnv.HOME = home;
    runEnv.COMPANION_STATE_PATH = path.join(runRoot, '_runs', 'os', '.companion-state.json');
  });

  afterAll(() => {
    fs.rmSync(runRoot, { recursive: true, force: true });
  });

  it('--mode=full produces non-empty output and exits 0', { timeout: 15000 }, () => {
    const result = run('--mode=full');
    expect(result.status).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it('--mode=zone --zone=face produces non-empty output', { timeout: 15000 }, () => {
    const result = run('--mode=zone', '--zone=face');
    expect(result.status).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it('--mode=zone --zone=health produces non-empty output', { timeout: 15000 }, () => {
    const result = run('--mode=zone', '--zone=health');
    expect(result.status).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it('--mode=strip produces non-empty output (single-line statusline)', { timeout: 15000 }, () => {
    const result = run('--mode=strip');
    expect(result.status).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
  });
});

// C2.2 A2: the live statusline command as a piped child. stdout is a pipe, never
// a TTY (an in-process render on a TTY runner passes vacuously), and the child
// env goes through spawn's `env` option only. The project root is a temp dir
// seeded with fixed state, never the live repo's _runs/os.
describe('hud-engine CLI statusline width (C2.2 A2)', () => {
  const SESSION_ID = 'a2-width-session';
  // A model id no live session uses (it still renders as opus 5.5), so a
  // session-meta model write-back that escaped the temp root would be visible.
  const FIXTURE_MODEL = 'claude-opus-5-5-a2-fixture';
  // ⚡ and 中文 are 1 code unit but 2 cells, 🚀 is 2 units and 2 cells, 𝐁 is 2
  // units but 1 cell: a code-unit width check cannot pass on these rows.
  const WIDE = '\u26A1\u4E2D\u6587\u{1F680}\u{1D401}';

  function seedWidthFixture() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-a2-width-'));
    const root = path.join(tmp, `a2-${WIDE}`);
    const home = path.join(tmp, 'home');
    const stateDir = path.join(root, '_runs', 'os');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(path.join(home, '.4ge'), { recursive: true });
    // Insights off, so a companion speech line cannot replace rows 1-3.
    fs.writeFileSync(path.join(home, '.4ge', 'config.json'),
      JSON.stringify({ companion: { insights: { enabled: false } } }));
    fs.writeFileSync(path.join(stateDir, 'session-meta.json'),
      JSON.stringify({ session_id: SESSION_ID, session_number: 704, model: FIXTURE_MODEL }));
    // The branch is longer than any width under test, so row 2's anchor must be
    // truncated to exactly the effective width.
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(stateDir, 'git-state.json'), JSON.stringify({
      branch: `feat/${WIDE}-${'x'.repeat(180)}`,
      ahead: 3,
      behind: 1,
      dirty: true,
      uncommittedFiles: 4,
      recentCommits: [{ hash: 'abc1234', subject: `fix(hud): ${WIDE} fit rows ${'y'.repeat(160)}` }],
      lastCommitTs: now,
      timestamp: now,
    }));
    return { tmp, root, home };
  }

  function statuslineStdin(root, extra) {
    const now = Math.floor(Date.now() / 1000);
    return JSON.stringify({
      session_id: SESSION_ID,
      cwd: root,
      workspace: { current_dir: root, project_dir: root },
      model: { id: FIXTURE_MODEL, display_name: 'Opus 5.5' },
      // 42/30/10 is the tuple the lane's live-state guard counts in the main
      // checkout's hud-history.json, so a write outside the temp root shows there.
      context_window: { used_percentage: 42, context_window_size: 1000000, total_input_tokens: 420000 },
      rate_limits: {
        five_hour: { used_percentage: 30, resets_at: now + 2 * 3600 },
        seven_day: { used_percentage: 10, resets_at: now + 3 * 86400 },
      },
      cost: { total_cost_usd: 12.34, total_lines_added: 1200, total_lines_removed: 300 },
      ...extra,
    });
  }

  function childEnv(fx, columns) {
    const env = { ...process.env };
    for (const key of ['COLUMNS', 'LINES', 'FORGE_OS_STATE_DIR', 'COMPANION_STATE_PATH']) delete env[key];
    env.CLAUDE_PROJECT_DIR = fx.root;
    env.HOME = fx.home;
    env.COMPANION_STATE_PATH = path.join(fx.root, '_runs', 'os', '.companion-state.json');
    if (columns !== undefined) env.COLUMNS = columns;
    return env;
  }

  const CASES = [
    { name: 'COLUMNS=52', columns: '52', cols: () => 52 },
    { name: 'COLUMNS=80', columns: '80', cols: () => 80 },
    { name: 'COLUMNS=160 is capped', columns: '160', cols: (cap) => Math.min(160, cap) },
    { name: 'COLUMNS unset falls back to 80', columns: undefined, cols: () => 80 },
    { name: 'COLUMNS junk falls back to 80', columns: 'wide', cols: () => 80 },
    { name: 'COLUMNS=0 falls back to 80', columns: '0', cols: () => 80 },
    { name: 'COLUMNS negative falls back to 80', columns: '-5', cols: () => 80 },
    // The agy/Gemini `terminal_width` path is hud-gemini-adapter.cjs in strip
    // mode (still 79); this command does not read the field, so it falls back.
    { name: 'stdin terminal_width without COLUMNS falls back to 80', columns: undefined, extra: { terminal_width: 160 }, cols: () => 80 },
  ];

  for (const c of CASES) {
    it(`fits every content row to the effective width: ${c.name}`, { timeout: 20000 }, () => {
      const { displayWidth } = _require(path.resolve(__dirname, '..', 'hud-palette.cjs'));
      const { MAX_STATUSLINE_COLS } = _require(path.resolve(__dirname, '..', 'hud-state.cjs'));
      const cols = c.cols(MAX_STATUSLINE_COLS);
      expect(Number.isInteger(cols), 'effective width is an integer').toBe(true);
      const fx = seedWidthFixture();
      try {
        const result = spawnSync(process.execPath, [ENGINE, '--mode=statusline', '--max-rows=8'], {
          input: statuslineStdin(fx.root, c.extra),
          env: childEnv(fx, c.columns),
          encoding: 'utf8',
          timeout: 15000,
        });
        expect(result.status).toBe(0);
        // The four trailing blank lines (Termius pin region, f3f4edc2) stay.
        expect(result.stdout.endsWith('\n\n\n\n')).toBe(true);
        const rows = result.stdout.slice(0, -4).split('\n');
        const widths = rows.map((row) => displayWidth(row));
        for (const [i, w] of widths.entries()) {
          expect(w, `row ${i + 1} display width`).toBeLessThanOrEqual(cols);
        }
        // The width is used, not just respected: the over-long branch row is
        // truncated to exactly the effective width.
        expect(Math.max(...widths), 'widest row').toBe(cols);
        expect(rows.some((row) => /[\u26A1\u4E2D]/.test(row)), 'a wide glyph reaches a row').toBe(true);
      } finally {
        fs.rmSync(fx.tmp, { recursive: true, force: true });
      }
    });
  }

  // Sonnet 5.5 registration: the row-1 label is derived from the model id alone
  // (family + the first digit pair), so a new id needs no label code. Pin that on the
  // live command, in this fixture's temp root with insights off, because an in-process
  // render can have row 1 swapped for companion speech.
  it('labels claude-sonnet-5-5 "sonnet 5.5" and claude-sonnet-5 "sonnet 5" on row 1', { timeout: 40000 }, () => {
    const { stripAnsi } = _require(path.resolve(__dirname, '..', 'hud-palette.cjs'));
    const fx = seedWidthFixture();
    try {
      const rowOne = (id, displayName) => {
        const result = spawnSync(process.execPath, [ENGINE, '--mode=statusline', '--max-rows=8'], {
          input: statuslineStdin(fx.root, { model: { id, display_name: displayName } }),
          env: childEnv(fx, '132'),
          encoding: 'utf8',
          timeout: 15000,
        });
        expect(result.status).toBe(0);
        return stripAnsi(result.stdout.split('\n')[0]);
      };
      expect(rowOne('claude-sonnet-5-5', 'Sonnet 5.5')).toContain('sonnet 5.5');
      const sonnet5 = rowOne('claude-sonnet-5', 'Sonnet 5');
      expect(sonnet5).toContain('sonnet 5');
      expect(sonnet5).not.toContain('sonnet 5.5');
    } finally {
      fs.rmSync(fx.tmp, { recursive: true, force: true });
    }
  });
});
