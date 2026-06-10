#!/usr/bin/env node
// capture.cjs -- renders the real hud-engine in a sanitized environment for the
// screenshot truth pass, then writes ANSI captures to _runs/s404/*.ansi.
// Approach: build a synthetic clean state dir (generic boot/health/session-meta),
// feed sanitized harness stdin, run the REAL renderer, then scrub any value that
// leaks through the live-git path. Disk-first tooling, not committed.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = '/mnt/o/Sand_Box_Dev';
const OUT = path.join(ROOT, '_runs', 's404');
// Sandbox project root whose basename becomes the repo label in the statusline.
const SANDBOX = path.join(OUT, 'my-app');
const CLEAN = path.join(SANDBOX, '_runs', 'os');
fs.mkdirSync(CLEAN, { recursive: true });

// --- Synthetic, generic, fully-honest state (all 9 caps ready; a realistic boot) ---
const bootedAt = new Date(Date.now() - 73 * 60 * 1000).toISOString(); // 73m uptime
const caps = {
  aisle: { status: 'ready', init_ms: 194 },
  audit: { status: 'ready', init_ms: 54 },
  autoresearch: { status: 'ready', init_ms: 49 },
  'file-integrity': { status: 'ready', init_ms: 55 },
  'forge-session': { status: 'ready', init_ms: 46 },
  forge: { status: 'ready', init_ms: 44, depends_on: ['forge-session'] },
  git: { status: 'ready', init_ms: 23 },
  infra: { status: 'ready', init_ms: 1013 },
  'process-health': { status: 'ready', init_ms: 47 },
};
const bootStatus = {
  session_id: 'session-generic',
  booted_at: bootedAt,
  capabilities: caps,
  overall: 'ready',
  total_boot_ms: 1287,
};
const health = {
  aisle: { ok: true, mode: 'advisory' },
  audit: { ok: true, mode: 'agent-delegated' },
  autoresearch: { ok: true },
  'file-integrity': { ok: true, tracked_files: 0 },
  'forge-session': { ok: true, active_session: false },
  forge: { ok: true, active_session: false },
  git: { ok: true, version: 'git version 2.43.0' },
  infra: { ok: true, dockerVersion: 'deferred' },
  'process-health': { ok: true },
};
const sessionMeta = {
  session_id: 'session-generic',
  model: 'claude-fable-5',
  est_context_pct: 19,
  tool_count_running: 368,
};

fs.writeFileSync(path.join(CLEAN, 'boot-status.json'), JSON.stringify(bootStatus, null, 2));
fs.writeFileSync(path.join(CLEAN, 'health.json'), JSON.stringify(health, null, 2));
fs.writeFileSync(path.join(CLEAN, 'session-meta.json'), JSON.stringify(sessionMeta, null, 2));

// Clean companion state using the REAL companion-state.cjs schema. Goal:
// detectState() resolves 'idle' -> STATE_MAP.idle -> 'proud joy' eyes [block block]
// (the resting between-turns face the statusLine shows). Requirements:
// - lastToolAt 90s ago: idleS in (idleThresholdS=30, longIdleS=300) window -> 'idle'
// - totalOutputTokens EQUAL to stdin output tokens: not-less (no session-boundary
//   reset) and not-greater (no 'tool-running'/thinking eye-swap)
// - lastSessionId matches stdin session_id: no resume-guard reset
// - no active message: DATA view, not speech bubble
const COMPANION_STATE = path.join(CLEAN, '.companion-state.json');
const nowMs = Date.now();
fs.writeFileSync(COMPANION_STATE, JSON.stringify({
  expression: 'proud joy',
  gaze: 'forward',
  mode: 'standard',
  stateKey: 'idle',
  bootActive: false,
  lastToolAt: nowMs - 90 * 1000,
  changedAt: nowMs - 90 * 1000,
  totalOutputTokens: 31200,
  lastSessionId: 'session-generic',
  toolCount: 368,
}, null, 2));

// Sanitized harness stdin (what CC passes to the statusLine command).
// COMPLETE per HUD-STANDARDS 2.1 + mergeHarnessStdin contract: model,
// context_window (used_percentage), rate_limits (five_hour/seven_day with
// used_percentage + resets_at epoch-seconds), cost (usd + token + line counts).
// rate_limits drives the 5h tracker (row 1) and 7d tracker (row 2); cost
// drives the $usd + token-total slots on row 3.
const nowSec = Math.floor(Date.now() / 1000);
const harnessStdin = JSON.stringify({
  model: { display_name: 'claude-fable-5', id: 'claude-fable-5' },
  workspace: { project_dir: '/home/dev/projects/my-app' },
  cwd: '/home/dev/projects/my-app',
  session_id: 'session-generic',
  context_window: { used_percentage: 19 },
  rate_limits: {
    five_hour: { used_percentage: 38, resets_at: nowSec + (2 * 60 + 47) * 60 },
    seven_day: { used_percentage: 54, resets_at: nowSec + (3 * 24 + 11) * 3600 },
  },
  cost: {
    total_cost_usd: 69.42,
    input_tokens: 24800,
    output_tokens: 31200,
    cache_read_tokens: 1830000,
    cache_creation_tokens: 92000,
    total_lines_added: 412,
    total_lines_removed: 169,
  },
});

const ENGINE = path.join(ROOT, 'plugins', '4ge', 'bin', 'hud-engine.cjs');

function render(mode, extraArgs = []) {
  const args = [ENGINE, `--mode=${mode}`, ...extraArgs];
  const out = execFileSync('node', args, {
    input: harnessStdin,
    cwd: ROOT,
    env: { ...process.env, CLAUDE_PROJECT_DIR: SANDBOX, COMPANION_STATE_PATH: COMPANION_STATE },
    maxBuffer: 1024 * 1024,
  });
  return out.toString('utf8');
}

// --- Post-render sanitizer: scrub any value that leaks through live git/disk paths ---
function sanitize(text) {
  let t = text;
  // Project name leaks (workspace dir basename, repo name).
  t = t.replace(/Sand_Box_Dev/g, 'my-app');
  // Session markers like S404, S320 (no leading \b: an ANSI 'm' precedes the S).
  t = t.replace(/S\d{3}(?=\D|$)/g, '');
  // Branch / PR / commit subject leaks from live git.
  t = t.replace(/feat\/s\d+-[a-z0-9-]+/gi, 'feat/add-pricing');
  t = t.replace(/Merge pull request #\d+ from [^\n]*/g, 'feat(pricing): hero section + CSS grid pricing');
  t = t.replace(/turdpusher360\/[^\s]*/g, 'add-pricing');
  // Real branch name (we are on main or a fix/* branch). Force a generic branch.
  t = t.replace(/\bfix\/[a-z0-9-]+\b/gi, 'main');
  // Model label scrub: any fable/opus-4-8 etc. -> generic opus 4.
  // S404 operator call: fable IS the shipping flagship label — engine rainbowizes it natively.
  return t;
}

const modes = [
  { name: 'statusline', mode: 'statusline', args: ['--max-rows=8'] },
  { name: 'full', mode: 'full', args: [] },
];

for (const m of modes) {
  const raw = render(m.mode, m.args);
  // Trim trailing blank lines: the xterm wrapper derives rows from line count,
  // so trailing empties would render as dead rows.
  const clean = sanitize(raw).replace(/\n[\s\n]*$/, '\n');
  fs.writeFileSync(path.join(OUT, `${m.name}.ansi`), clean);
  process.stdout.write(`captured ${m.name} (${clean.length} bytes)\n`);
  if (m.name === 'statusline') {
    // Also feed the xterm-based screenshot frame directly.
    fs.writeFileSync(path.join(ROOT, '.claude-plugin', 'screenshots', 'statusline.ansi'), clean);
  }
}

// Report visible width per statusline line so the xterm cols setting can be checked.
const slText = fs.readFileSync(path.join(OUT, 'statusline.ansi'), 'utf8');
slText.replace(/\n$/, '').split('\n').forEach((l, i) => {
  const vis = l.replace(/\x1b\[[0-9;]*m/g, '');
  process.stdout.write(`line ${i} width ${[...vis].length}\n`);
});
