// Statusline readouts (operator report 2026-09-28: "in the statusline hud we
// replaced tool call counts with context measure ... different sections
// measuring and displaying the same info"). Drives the real CLI path
// (`hud-engine.cjs --mode=statusline`, stdin JSON) against a temp project root
// and a synthetic transcript, so no live _runs/os or transcript is touched.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const _require = createRequire(import.meta.url);
const ENGINE_PATH = path.resolve(__dirname, '../hud-engine.cjs');
const { stripAnsi, displayWidth } = _require('../hud-palette.cjs');

const LIVE = 'cccccccc-1111-4222-8333-00000000live';
const FOREIGN = 'dddddddd-1111-4222-8333-0000foreign';
const FOREIGN_TOOL_COUNT = 2360;
const OWN_TOOL_USES = 7;
const LAST_OUTPUT_TOKENS = 800;
const CONTEXT_INPUT_TOKENS = 420000;

let root;
let env;

function toolUseLine(id) {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    sessionId: LIVE,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'true' } }] },
  }) + '\n';
}

function writeTranscript(n) {
  const file = path.join(root, 'transcripts', `${LIVE}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let body = '';
  for (let i = 0; i < n; i += 1) {
    body += toolUseLine(`t${i}`);
    body += JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'ok' }] } }) + '\n';
  }
  fs.writeFileSync(file, body);
  return file;
}

function stdinFor(transcriptPath) {
  return {
    session_id: LIVE,
    transcript_path: transcriptPath,
    cwd: root,
    workspace: { current_dir: root, project_dir: root },
    model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
    version: '2.1.284',
    cost: { total_cost_usd: 1.5, total_duration_ms: 60000, total_lines_added: 0, total_lines_removed: 0 },
    context_window: {
      total_input_tokens: CONTEXT_INPUT_TOKENS,
      total_output_tokens: LAST_OUTPUT_TOKENS,
      context_window_size: 1000000,
      used_percentage: 42,
      remaining_percentage: 58,
      current_usage: {
        input_tokens: 12,
        output_tokens: LAST_OUTPUT_TOKENS,
        cache_creation_input_tokens: 4988,
        cache_read_input_tokens: CONTEXT_INPUT_TOKENS - 12 - 4988,
      },
    },
  };
}

function renderRaw(stdin, cols = 132, extraEnv = {}) {
  const r = spawnSync(process.execPath, [ENGINE_PATH, '--mode=statusline', '--max-rows=8'], {
    input: JSON.stringify(stdin),
    env: { ...env, COLUMNS: String(cols), ...extraEnv },
    cwd: root,
    encoding: 'utf8',
    timeout: 15000,
  });
  expect(r.status).toBe(0);
  return r.stdout;
}

function render(stdin, cols = 132, extraEnv = {}) {
  return stripAnsi(renderRaw(stdin, cols, extraEnv));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-statusline-readouts-'));
  const stateDir = path.join(root, '_runs', 'os');
  fs.mkdirSync(stateDir, { recursive: true });
  // The shared meta counter belongs to another session (the lead-pane case:
  // a lane or headless boot re-stamped the owner).
  fs.writeFileSync(path.join(stateDir, 'session-meta.json'), JSON.stringify({
    session_id: FOREIGN,
    session_number: 999,
    model: 'claude-opus-5-5',
    tool_count_running: FOREIGN_TOOL_COUNT,
  }));
  // Companion insights would replace the data rows with a speech bubble on a
  // rotation timer; switch them off so every render shows the data rows.
  fs.mkdirSync(path.join(root, '.4ge'), { recursive: true });
  fs.writeFileSync(path.join(root, '.4ge', 'config.json'), JSON.stringify({ companion: { insights: { enabled: false } } }));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  env = { ...process.env };
  for (const key of ['COLUMNS', 'LINES', 'FORGE_OS_STATE_DIR', 'NO_COLOR', 'CLICOLOR', 'CLICOLOR_FORCE',
    'FORGE_HUD_CONTEXT_LINE', 'FORGE_HUD_CONTEXT_WARN']) delete env[key];
  // Pin the palette depth so the severity colors below are the truecolor roles.
  env.COLORTERM = 'truecolor';
  env.CLAUDE_PROJECT_DIR = root;
  env.HOME = home;
  env.COMPANION_STATE_PATH = path.join(stateDir, '.companion-state.json');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('statusline ⊥ tool count', () => {
  it('renders the session\'s own transcript count and ignores a foreign session-meta owner', { timeout: 20000 }, () => {
    const out = render(stdinFor(writeTranscript(OWN_TOOL_USES)));
    expect(out).toContain(`⊥ ${OWN_TOOL_USES}`);
    expect(out).not.toContain(String(FOREIGN_TOOL_COUNT));
  });

  it('follows tool_use blocks appended between ticks', { timeout: 20000 }, () => {
    const file = writeTranscript(OWN_TOOL_USES);
    render(stdinFor(file));
    fs.appendFileSync(file, toolUseLine('late-1') + toolUseLine('late-2'));
    expect(render(stdinFor(file))).toContain(`⊥ ${OWN_TOOL_USES + 2}`);
  });

  it('renders no ⊥ at all when the transcript is unreadable', { timeout: 20000 }, () => {
    const out = render(stdinFor(path.join(root, 'missing', `${LIVE}.jsonl`)));
    expect(out).not.toContain('⊥');
    expect(out).not.toContain(String(FOREIGN_TOOL_COUNT));
  });
});

// Σ human-hours, estimator E2 (og 2026-09-30, operator "Σ stays, improve its
// estimate"; spec _runs/2026-09-30/og/ctx320/result.md Part 2): 2 min per
// top-level tool call plus 2 min per changed line in non-scratch files, capped
// at 60 lines per call, read from this session's transcript. Stdin's line
// counter (which counts _runs/ reports and scratch) no longer feeds it.
describe('statusline Σ human-hours (E2)', () => {
  const SRC = '/abs/path/to/repo/plugins/4ge/bin/example.cjs';
  const SCRATCH = '/abs/path/to/repo/_runs/2026-09-30/report.md';
  const STDIN_LINES = 700; // the old lines/30 estimate reads this as ~23h
  const body = (n) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');

  function writeCalls(calls) {
    const file = path.join(root, 'transcripts', `${LIVE}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, calls.map(([name, input], i) => JSON.stringify({
      type: 'assistant',
      isSidechain: false,
      sessionId: LIVE,
      message: { role: 'assistant', content: [{ type: 'tool_use', id: `c${i}`, name, input }] },
    }) + '\n').join(''));
    return file;
  }

  function withStdinLines(stdin) {
    stdin.cost = { ...stdin.cost, total_lines_added: STDIN_LINES, total_lines_removed: 0 };
    return stdin;
  }

  // 10 calls: 4 source Writes of 100 lines (60 each after the cap), 3 scratch
  // Writes of 100 lines (0) and 3 Bash calls (0), so
  // (2 × 10 + 2 × 240) / 60 = 8.3 → ~8h.
  function fixtureStdin() {
    return withStdinLines(stdinFor(writeCalls([
      ...Array.from({ length: 4 }, () => ['Write', { file_path: SRC, content: body(100) }]),
      ...Array.from({ length: 3 }, () => ['Write', { file_path: SCRATCH, content: body(100) }]),
      ...Array.from({ length: 3 }, () => ['Bash', { command: 'true' }]),
    ])));
  }

  it('renders the E2 value from the transcript, not the stdin line counter', { timeout: 20000 }, () => {
    const row2 = render(fixtureStdin()).split('\n')[1];
    expect(row2).toContain('Σ ~8h');
    expect(row2).toContain('⊥ 10');
  });

  it.each([80, 132])('keeps Σ on row 2, after the companion orb, inside %i columns', { timeout: 20000 }, (cols) => {
    const rows = render(fixtureStdin(), cols).split('\n');
    expect(rows[1]).toContain('Σ ~8h');
    expect(displayWidth(rows[1])).toBeLessThanOrEqual(cols);
    // The orb prefix opens row 2 (Braille blank, then the orb glyphs).
    expect(rows[1].startsWith('⠀')).toBe(true);
  });

  it('rounds any work under an hour up to ~1h, as before', { timeout: 20000 }, () => {
    const row2 = render(stdinFor(writeCalls([['Bash', { command: 'true' }]]))).split('\n')[1];
    expect(row2).toContain('Σ ~1h');
  });

  it('renders no Σ when the transcript is unreadable, whatever the stdin line counter says', { timeout: 20000 }, () => {
    const out = render(withStdinLines(stdinFor(path.join(root, 'missing', `${LIVE}.jsonl`))));
    expect(out).not.toContain('Σ');
  });
});

describe('statusline context readouts', () => {
  it('row 3 shows the last response\'s output tokens, not the context size', { timeout: 20000 }, () => {
    const out = render(stdinFor(writeTranscript(1)));
    const rows = out.split('\n');
    expect(rows[2]).toContain(`·  ${LAST_OUTPUT_TOKENS}`);
    expect(out).not.toContain('420.0K');
    expect(out).not.toContain('420.8K');
  });

  it.each([80, 132])('has exactly one context readout at %i columns', { timeout: 20000 }, (cols) => {
    const out = render(stdinFor(writeTranscript(1)), cols);
    expect(out.match(/◈ /g) || []).toHaveLength(1);
    expect(out).not.toContain('ctx budget');
    expect(out).not.toMatch(/\d+k left/);
  });
});

function writeGitState(fields) {
  fs.writeFileSync(path.join(root, '_runs', 'os', 'git-state.json'), JSON.stringify({
    branch: 'main',
    ahead: 0,
    behind: 0,
    recentCommits: [],
    lastCommitTs: null,
    timestamp: new Date().toISOString(),
    ...fields,
  }));
}

describe('statusline dirty marker', () => {
  it('renders +? when the git probe never answered (dirty null)', { timeout: 20000 }, () => {
    writeGitState({ dirty: null, uncommittedFiles: null });
    const rows = render(stdinFor(writeTranscript(1))).split('\n');
    expect(rows[1]).toContain('main+?');
  });

  it('renders +? when the cache carries no dirty field at all', { timeout: 20000 }, () => {
    writeGitState({});
    const rows = render(stdinFor(writeTranscript(1))).split('\n');
    expect(rows[1]).toContain('main+?');
  });

  it('renders +? when the tree is dirty but the file count is unknown', { timeout: 20000 }, () => {
    writeGitState({ dirty: true, uncommittedFiles: null });
    const rows = render(stdinFor(writeTranscript(1))).split('\n');
    expect(rows[1]).toContain('main+?');
  });

  it('renders the file count for a dirty tree, as before', { timeout: 20000 }, () => {
    writeGitState({ dirty: true, uncommittedFiles: 5 });
    const rows = render(stdinFor(writeTranscript(1))).split('\n');
    expect(rows[1]).toContain('main+5');
    expect(rows[1]).not.toContain('+?');
  });

  it('renders no marker for a clean tree, as before', { timeout: 20000 }, () => {
    writeGitState({ dirty: false, uncommittedFiles: 0 });
    const rows = render(stdinFor(writeTranscript(1))).split('\n');
    expect(rows[1]).toContain('main');
    expect(rows[1]).not.toMatch(/main\+/);
  });
});

// The rig compacts by hand at the operator's line and warns at 282k
// (scripts/context-now.cjs:29-30), so row 1's `◈` reads against that line, not against
// the 1M window. The line is read from context-now's exports, which holds the HUD's
// RIG_CONTEXT_LINE/WARN twin to it and survives a moved line (353k -> 320k, 2026-09-30).
const { LINE, WARN } = _require('../../../../scripts/context-now.cjs');
const kFloor = (n) => `${Math.floor(n / 1000)}k`;
const LINE_K = kFloor(LINE);

function stdinWithContext(tokens, contextWindow = {}) {
  const stdin = stdinFor(writeTranscript(1));
  const cacheCreation = Math.floor(tokens / 4);
  stdin.context_window = {
    total_output_tokens: LAST_OUTPUT_TOKENS,
    context_window_size: 1000000,
    used_percentage: Math.round(tokens / 10000),
    current_usage: {
      input_tokens: 5,
      output_tokens: LAST_OUTPUT_TOKENS,
      cache_creation_input_tokens: cacheCreation,
      cache_read_input_tokens: tokens - 5 - cacheCreation,
    },
    ...contextWindow,
  };
  return stdin;
}

// SGR sequence that colors the text after the ◈ glyph, or null when there is none.
function ctxColor(raw) {
  const m = raw.match(/◈\x1b\[0m (\x1b\[[0-9;]*m)/);
  return m ? m[1] : null;
}

describe('statusline ◈ against the rig context line', () => {
  it('renders used/line and picks three distinct severities around the warn and line thresholds', { timeout: 30000 }, () => {
    const normal = ctxColor(renderRaw(stdinWithContext(100000)));
    const warn = ctxColor(renderRaw(stdinWithContext(WARN + Math.floor((LINE - WARN) / 2))));
    const alert = ctxColor(renderRaw(stdinWithContext(LINE + 80000)));
    expect(new Set([normal, warn, alert]).size).toBe(3);
    // Normal keeps today's sky-blue.
    expect(normal).toBe('\x1b[38;5;75m');

    const cases = [
      [100000, 'normal', normal],
      [WARN - 1, 'normal', normal],
      [WARN, 'warn', warn],
      [LINE - 1, 'warn', warn],
      [LINE, 'alert', alert],
      [LINE + 100000, 'alert', alert],
    ];
    for (const [tokens, , color] of cases) {
      expect(ctxColor(renderRaw(stdinWithContext(tokens)))).toBe(color);
    }
    // Used tokens floor to the k, so the label never reads at a line it has not reached.
    expect(render(stdinWithContext(WARN - 1)).split('\n')[0]).toContain(`◈ ${kFloor(WARN - 1)}/${LINE_K}`);
    expect(render(stdinWithContext(WARN)).split('\n')[0]).toContain(`◈ ${kFloor(WARN)}/${LINE_K}`);
    expect(render(stdinWithContext(LINE)).split('\n')[0]).toContain(`◈ ${LINE_K}/${LINE_K}`);
  });

  it('appends compact at and over the line, and never below it', { timeout: 30000 }, () => {
    for (const tokens of [100000, WARN, LINE - 1]) {
      const row1 = render(stdinWithContext(tokens)).split('\n')[0];
      expect(row1).toContain(`◈ ${kFloor(tokens)}/${LINE_K}`);
      expect(row1).not.toContain('compact');
    }
    for (const tokens of [LINE, LINE + 5000]) {
      expect(render(stdinWithContext(tokens)).split('\n')[0]).toContain(`◈ ${kFloor(tokens)}/${LINE_K} compact`);
    }
    // The word is the nudge that survives NO_COLOR, where every palette role is empty.
    const plain = renderRaw(stdinWithContext(LINE), 132, { NO_COLOR: '1' });
    expect(stripAnsi(plain).split('\n')[0]).toContain(`◈ ${LINE_K}/${LINE_K} compact`);
  });

  it('falls back to exactly today\'s ◈ N% when stdin carries no token data', { timeout: 20000 }, () => {
    const stdin = stdinFor(writeTranscript(1));
    stdin.context_window = { used_percentage: 33 };
    const raw = renderRaw(stdin);
    expect(raw).toContain('\x1b[1m\x1b[38;5;75m◈\x1b[0m \x1b[38;5;75m33%\x1b[0m');
    expect(stripAnsi(raw)).not.toContain(`/${LINE_K}`);
  });

  it('derives an approximate figure (~) from used_percentage x window size when current_usage is absent', { timeout: 20000 }, () => {
    const stdin = stdinFor(writeTranscript(1));
    stdin.context_window = { used_percentage: 33.5, context_window_size: 1000000 };
    expect(render(stdin).split('\n')[0]).toContain(`◈ ~335k/${LINE_K}`);
  });

  it('keeps the plain percent when the window is smaller than the rig line', { timeout: 20000 }, () => {
    const out = render(stdinWithContext(150000, { context_window_size: 200000, used_percentage: 75 }));
    expect(out.split('\n')[0]).toContain('◈ 75%');
    expect(out).not.toContain(`/${LINE_K}`);
  });

  it('applies FORGE_HUD_CONTEXT_LINE and FORGE_HUD_CONTEXT_WARN', { timeout: 30000 }, () => {
    const warnRef = ctxColor(renderRaw(stdinWithContext(300000)));
    const alertRef = ctxColor(renderRaw(stdinWithContext(400000)));
    const overrides = { FORGE_HUD_CONTEXT_LINE: '100000', FORGE_HUD_CONTEXT_WARN: '50000' };

    const warnRaw = renderRaw(stdinWithContext(60000), 132, overrides);
    expect(stripAnsi(warnRaw).split('\n')[0]).toContain('◈ 60k/100k');
    expect(ctxColor(warnRaw)).toBe(warnRef);

    const alertRaw = renderRaw(stdinWithContext(100000), 132, overrides);
    expect(stripAnsi(alertRaw).split('\n')[0]).toContain('◈ 100k/100k compact');
    expect(ctxColor(alertRaw)).toBe(alertRef);
  });

  it.each([
    // '400k' is the trap: a lenient parseInt would read it as 400 tokens.
    [{ FORGE_HUD_CONTEXT_LINE: '400k', FORGE_HUD_CONTEXT_WARN: '-5' }],
    [{ FORGE_HUD_CONTEXT_LINE: 'abc', FORGE_HUD_CONTEXT_WARN: '0' }],
    [{ FORGE_HUD_CONTEXT_LINE: '', FORGE_HUD_CONTEXT_WARN: '  ' }],
  ])('ignores junk override values %j', { timeout: 20000 }, (overrides) => {
    const out = render(stdinWithContext(300000), 132, overrides);
    expect(out.split('\n')[0]).toContain(`◈ 300k/${LINE_K}`);
  });

  it.each([80, 132])('keeps row 1 inside %i columns with the widest readout', { timeout: 20000 }, (cols) => {
    // Widest: the ~ estimate, a three-digit figure, over the line with the nudge.
    const stdin = stdinFor(writeTranscript(1));
    stdin.context_window = { used_percentage: 99.9, context_window_size: 1000000 };
    const raw = renderRaw(stdin, cols);
    const row1 = stripAnsi(raw).split('\n')[0];
    // `◈` never drops for the nudge, and keeps the over-the-line color either way.
    expect(row1).toContain(`◈ ~999k/${LINE_K}`);
    expect(displayWidth(row1)).toBeLessThanOrEqual(cols);
    expect(ctxColor(raw)).toBe(ctxColor(renderRaw(stdinWithContext(LINE + 80000))));
    // The word shows exactly when it fits. `◈` ends this row (no rate limits, effort or
    // think segments on this stdin), so it fits when the row plus ' compact' stays in `cols`.
    const hasWord = row1.includes(`◈ ~999k/${LINE_K} compact`);
    const wordFits = displayWidth(row1) + (hasWord ? 0 : ' compact'.length) <= cols;
    expect(hasWord).toBe(wordFits);
  });

  it.each([
    ['empty object', {}],
    ['null stdin', null],
    ['context_window null', { context_window: null }],
    ['context_window empty', { context_window: {} }],
    ['malformed token fields', { context_window: { used_percentage: 'x', context_window_size: 'big', current_usage: { input_tokens: 'x', cache_read_input_tokens: -5 } } }],
  ])('still renders a ◈ readout on minimal stdin: %s', { timeout: 20000 }, (_name, stdin) => {
    const out = render(stdin);
    expect(typeof out).toBe('string');
    expect(out).toContain('◈ ');
  });
});
