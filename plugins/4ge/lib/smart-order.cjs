'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// --- Paths ---
// Resolve the repo root deterministically rather than trusting process.cwd():
// when a SessionStart hook (smart-order-writer.cjs) runs with a cwd that is not
// the repo, the git probes below fire in the wrong directory and readGitStatus
// falls back to branch:'unknown'. Prefer the harness-provided project dir, then
// walk up from this file to the enclosing .git, then cwd as a last resort.
const REPO_ROOT = (() => {
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
})();
const OS_DIR = process.env.FORGE_OS_STATE_DIR
  ? path.resolve(process.env.FORGE_OS_STATE_DIR)
  : path.join(REPO_ROOT, '_runs', 'os');
const HUD_CONTEXT_FILE = path.join(OS_DIR, 'hud-context.json');
const LAST_TEST_FILE = path.join(REPO_ROOT, '_runs', '.last-test-result.json');
const GIT_STATE_FILE = path.join(OS_DIR, 'git-state.json');
// Per-command budget for the synchronous git probes (readGitState({ refresh: true }),
// getOrderedOptions). `git status` on the drvfs checkout takes 2.7-5.7 s, so dirty
// comes back unknown there (the statusline then shows `+?`). The tool-call hooks do not
// use this path: they call spawnDetachedRefresh, which probes in a detached child with
// the long REFRESH_* budgets below. FORGE_GIT_PROBE_TIMEOUT_MS overrides it.
const GIT_PROBE_DEFAULT_TIMEOUT_MS = 1200;

function resolveGitProbeTimeoutMs(env = process.env) {
  const parsed = Number.parseInt((env && env.FORGE_GIT_PROBE_TIMEOUT_MS) || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : GIT_PROBE_DEFAULT_TIMEOUT_MS;
}

const GIT_PROBE_TIMEOUT_MS = resolveGitProbeTimeoutMs();

// Detached refresh budgets. The child is off every tool call's critical path, so it
// can wait for `git status`: 15 s per command is ~2.6x the worst measured (5.7 s with
// other lanes loading the disk), and 30 s bounds the whole child (status at its cap plus
// the four cheap calls, ~0.5 s measured together).
const REFRESH_PER_COMMAND_TIMEOUT_MS = 15000;
const REFRESH_TOTAL_BUDGET_MS = 30000;
// A lock older than the budget plus this grace belongs to a child that died or wedged.
const REFRESH_LOCK_GRACE_MS = 5000;
const REFRESH_LOCK_STALE_MS = REFRESH_TOTAL_BUDGET_MS + REFRESH_LOCK_GRACE_MS;
const REFRESH_LOCK_NAME = 'git-state.refresh.lock';
// Carries the lock token from the hook that took the lock to the child that releases it.
const REFRESH_TOKEN_ENV = 'FORGE_GIT_REFRESH_LOCK_TOKEN';

// --- Option ID patterns for signal-to-option mapping ---
const FORGE_IDS     = /^(forge|plan|spec|ship|phase)/i;
const FIX_IDS       = /^(fix|test|debug|repair|patch)/i;
const COMMIT_IDS    = /^(commit|push|ship|pr|pull-request|release)/i;
const EXPLORE_IDS   = /^(explore|browse|search|audit|review|research)/i;

// How much to multiply baseScore when a signal matches
const BOOST = 2.5;

// --- Signal readers ---
// Each returns a plain object describing observed state.
// All are wrapped in try/catch — on error they return neutral (empty) state.

/**
 * Timeout for one git command: the per-command cap, cut to what is left of the
 * deadline when one is set. Zero or less means the budget is spent.
 * @param {number} timeoutMs
 * @param {number|null} deadline epoch ms
 * @param {number} [now]
 * @returns {number}
 */
function commandBudgetMs(timeoutMs, deadline, now = Date.now()) {
  if (typeof deadline !== 'number' || !Number.isFinite(deadline)) return timeoutMs;
  return Math.min(timeoutMs, deadline - now);
}

/**
 * Read git status signals: uncommitted changes, branch name, last commit age.
 * @param {{ cwd?: string, timeoutMs?: number, deadline?: number|null }} [opts]
 * @returns {{ hasUncommitted: boolean, branch: string, commitAgeMs: number }}
 */
function readGitStatus({ cwd = REPO_ROOT, timeoutMs = GIT_PROBE_TIMEOUT_MS, deadline = null } = {}) {
  // Each git probe is isolated so one slow or failing call cannot poison the
  // others — in particular the branch name (a cheap rev-parse) must survive a
  // slow `git status`. On a large working tree over a WSL /mnt mount, dirty
  // probes can wedge long enough to break HUD rendering. Keep the probe budget
  // short and return unknown dirty state instead of claiming the tree is clean.
  // execFileSync blocks the event loop, so a deadline is enforced per command.
  const run = (args) => {
    const budget = commandBudgetMs(timeoutMs, deadline);
    if (budget <= 0) throw new Error('git probe budget spent');
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: budget,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
  };

  let branch = 'unknown';
  try {
    branch = run(['rev-parse', '--abbrev-ref', 'HEAD']).trim() || 'unknown';
  } catch {
    // branch unresolved — leave 'unknown'
  }

  let hasUncommitted = null;
  let uncommittedFiles = null;
  try {
    const statusLines = run(['status', '--porcelain', '--untracked-files=no']).trim();
    hasUncommitted = statusLines.length > 0;
    uncommittedFiles = hasUncommitted ? statusLines.split('\n').length : 0;
  } catch {
    // status unavailable — leave dirty state unknown
  }

  // ahead/behind upstream
  let ahead = 0;
  let behind = 0;
  try {
    const parts = run(['rev-list', '--count', '--left-right', '@{upstream}...HEAD']).trim().split(/\s+/);
    behind = parseInt(parts[0], 10) || 0;
    ahead = parseInt(parts[1], 10) || 0;
  } catch {
    // no upstream configured — 0/0 is correct
  }

  let commitAgeMs = Infinity;
  let lastCommitTs = null;
  try {
    const logParts = run(['log', '-1', '--format=%ct %cI']).trim().split(' ');
    const commitEpoch = parseInt(logParts[0], 10);
    commitAgeMs = Number.isNaN(commitEpoch) ? Infinity : Date.now() - commitEpoch * 1000;
    lastCommitTs = logParts[1] || null;
  } catch {
    // log unavailable
  }

  return { hasUncommitted, uncommittedFiles, branch, ahead, behind, commitAgeMs, lastCommitTs };
}

/**
 * Read forge session state from hud-context.json.
 * @returns {{ forgeActive: boolean, forgePhase: string|null }}
 */
function readForgeState() {
  try {
    const raw = fs.readFileSync(HUD_CONTEXT_FILE, 'utf8');
    const data = JSON.parse(raw);
    const session = data.forge || data.session || {};
    const forgeActive = Boolean(
      session.active || session.phase || data.forgeActive
    );
    const forgePhase = session.phase || data.forgePhase || null;
    return { forgeActive, forgePhase };
  } catch {
    return { forgeActive: false, forgePhase: null };
  }
}

/**
 * Read last test result from _runs/.last-test-result.json.
 * @returns {{ testsFailing: boolean, testsPassing: boolean }}
 */
function readTestState() {
  try {
    const raw = fs.readFileSync(LAST_TEST_FILE, 'utf8');
    const data = JSON.parse(raw);
    const testsFailing = Boolean(data.failed > 0 || data.status === 'fail' || data.testsFailing);
    const testsPassing = !testsFailing && Boolean(data.passed > 0 || data.status === 'pass');
    return { testsFailing, testsPassing };
  } catch {
    return { testsFailing: false, testsPassing: false };
  }
}

/**
 * Read recently modified file patterns via git diff --stat.
 * @returns {{ hasTypeScriptEdits: boolean, hasTestEdits: boolean, hasHookEdits: boolean, hasDocEdits: boolean }}
 */
function readRecentEdits() {
  try {
    const diffOut = execFileSync('git', ['diff', '--stat', 'HEAD~1', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 3000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    const files = diffOut.split('\n').map((l) => l.trim());
    return {
      hasTypeScriptEdits: files.some((f) => /\.(ts|tsx)/.test(f)),
      hasTestEdits:       files.some((f) => /\.(test|spec)\.(js|ts|cjs)/.test(f)),
      hasHookEdits:       files.some((f) => /\.claude\/hooks/.test(f) || f.endsWith('.cjs')),
      hasDocEdits:        files.some((f) => /\.(md|txt|json)$/.test(f)),
    };
  } catch {
    return {
      hasTypeScriptEdits: false,
      hasTestEdits: false,
      hasHookEdits: false,
      hasDocEdits: false,
    };
  }
}

// --- Git State API (C-10) ---

/**
 * Read N recent commits as structured objects.
 * @param {number} n
 * @param {{ cwd?: string, timeoutMs?: number, deadline?: number|null }} [opts]
 * @returns {Array<{ sha: string, subject: string, ts: string }>}
 */
function readRecentCommits(n, { cwd = REPO_ROOT, timeoutMs = 3000, deadline = null } = {}) {
  try {
    const budget = commandBudgetMs(timeoutMs, deadline);
    if (budget <= 0) return [];
    const out = execFileSync('git', ['log', `-${n}`, '--format=%h\t%s\t%cI'], {
      cwd, encoding: 'utf8', timeout: budget,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    return out.trim().split('\n').filter(Boolean).map(line => {
      const [sha, subject, ts] = line.split('\t');
      return { sha, subject, ts };
    });
  } catch {
    return [];
  }
}

/**
 * Build a fresh git-state snapshot from live git data.
 * @param {{ cwd?: string, timeoutMs?: number, deadline?: number|null }} [opts] passed to both probes;
 *   omitted fields keep each probe's own default
 * @returns {{ branch: string, ahead: number, behind: number, dirty: boolean, uncommittedFiles: number, recentCommits: Array, lastCommitTs: string|null, timestamp: string }}
 */
function buildFreshGitState(opts = {}) {
  const git = readGitStatus(opts);
  return {
    branch: git.branch || 'main',
    ahead: git.ahead || 0,
    behind: git.behind || 0,
    dirty: typeof git.hasUncommitted === 'boolean' ? git.hasUncommitted : null,
    uncommittedFiles: typeof git.uncommittedFiles === 'number' ? git.uncommittedFiles : null,
    recentCommits: readRecentCommits(5, opts),
    lastCommitTs: git.lastCommitTs || null,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Read cached git-state from disk. Only refresh when explicitly requested.
 * @param {{ refresh?: boolean }} opts
 * @returns {{ branch: string|null, ahead: number, behind: number, dirty: boolean|null, uncommittedFiles: number|null, recentCommits: Array, lastCommitTs: string|null, timestamp: string }|null}
 */
function readGitState({ refresh = false } = {}) {
  let state = null;
  try {
    if (fs.existsSync(GIT_STATE_FILE)) {
      state = JSON.parse(fs.readFileSync(GIT_STATE_FILE, 'utf8'));
    }
  } catch {
    state = null;
  }
  // Security: only run live git probes when explicitly requested.
  // Statusline mode calls this with refresh:false and must not execute git.
  if (refresh) {
    const fresh = buildFreshGitState();
    writeGitState(fresh);
    return fresh;
  }
  // If no cache exists yet, return an unknown snapshot without probing git.
  // Do not assert clean: callers must not render clean-tree messaging from
  // a state that was not actually observed.
  if (!state) {
    return {
      branch: null,
      ahead: 0,
      behind: 0,
      dirty: null,
      uncommittedFiles: null,
      recentCommits: [],
      lastCommitTs: null,
      timestamp: new Date().toISOString(),
    };
  }
  // Preserve cached state as-is (even if stale) until an explicit refresh.
  return state;
}

/**
 * Write git-state to disk atomically (tmp + rename). The tmp name carries the pid:
 * a detached refresh child and a `--mode=full` HUD render can write at the same
 * time, and a shared tmp would let one rename the other's half-written file.
 * @param {object} state
 * @param {string} [stateFile]
 * @returns {boolean} whether the cache was replaced
 */
function writeGitState(state, stateFile = GIT_STATE_FILE) {
  const tmp = `${stateFile}.${process.pid}.tmp`;
  try {
    const dir = path.dirname(stateFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, stateFile);
    return true;
  } catch {
    // best-effort; callers are resilient to missing state. Leave no tmp behind.
    try { fs.unlinkSync(tmp); } catch { /* never created */ }
    return false;
  }
}

// --- Detached refresh (GATE 1(b), option A) ---
// The tool-call hooks must not run git inline: `git status` on the drvfs checkout
// takes seconds and the hooks have a 5 s timeout. spawnDetachedRefresh takes a
// single-flight lock, starts `node smart-order.cjs --refresh <repoRoot>` detached and
// returns; the child probes with the long budget, writes the cache and releases the lock.

/**
 * @param {string} [stateFile]
 * @returns {string} lock path beside the cache
 */
function refreshLockPath(stateFile = GIT_STATE_FILE) {
  return path.join(path.dirname(stateFile), REFRESH_LOCK_NAME);
}

/**
 * @param {number} pid
 * @returns {boolean} true when the pid exists (EPERM means it exists under another user)
 */
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'EPERM');
  }
}

/**
 * A lock is stale when its owner pid is dead or it is older than the refresh budget
 * plus grace. A lock that does not parse yet is held (its writer is mid-handover)
 * until it ages out by mtime.
 * @param {string} lockPath
 * @param {{ now?: number, isAlive?: (pid: number) => boolean, staleMs?: number }} [opts]
 * @returns {boolean}
 */
function isRefreshLockStale(lockPath, { now = Date.now(), isAlive = isPidAlive, staleMs = REFRESH_LOCK_STALE_MS } = {}) {
  let stat;
  try { stat = fs.statSync(lockPath); } catch { return false; }
  let info;
  try { info = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { info = null; }
  const startedAt = info && Number.isFinite(info.startedAt) ? info.startedAt : stat.mtimeMs;
  if (now - startedAt > staleMs) return true;
  if (info && Number.isInteger(info.pid) && !isAlive(info.pid)) return true;
  return false;
}

/**
 * Take the lock with O_EXCL, recovering it once if the current holder is stale.
 * @param {string} lockPath
 * @param {{ pid: number, token: string, now?: number, isAlive?: Function, staleMs?: number }} opts
 * @returns {boolean} whether this caller now holds the lock
 */
function acquireRefreshLock(lockPath, { pid, token, now = Date.now(), isAlive = isPidAlive, staleMs = REFRESH_LOCK_STALE_MS }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fd = fs.openSync(lockPath, 'wx');
    } catch (err) {
      if (!err || err.code !== 'EEXIST') return false;
      if (attempt > 0 || !isRefreshLockStale(lockPath, { now, isAlive, staleMs })) return false;
      try { fs.unlinkSync(lockPath); } catch { /* another trigger recovered it first */ }
      continue;
    }
    try {
      fs.writeSync(fd, JSON.stringify({ pid, startedAt: now, token }));
      fs.closeSync(fd);
      return true;
    } catch {
      try { fs.closeSync(fd); } catch { /* already closed */ }
      try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
      return false;
    }
  }
  return false;
}

/**
 * Rewrite the lock's owner in place. Opening with r+ (not w) means a lock the child
 * already released is not re-created.
 * @param {string} lockPath
 * @param {object} owner
 */
function rewriteRefreshLockOwner(lockPath, owner) {
  let fd;
  try { fd = fs.openSync(lockPath, 'r+'); } catch { return; }
  try {
    const buf = Buffer.from(JSON.stringify(owner));
    fs.writeSync(fd, buf, 0, buf.length, 0);
    fs.ftruncateSync(fd, buf.length);
  } catch {
    // best-effort; an unreadable lock ages out by mtime
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Release the lock only if it still carries this token, so a lock recovered by
 * another trigger is never removed by the child it was taken from.
 * @param {string} lockPath
 * @param {string} token
 */
function releaseRefreshLock(lockPath, token) {
  try {
    const info = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (info && info.token === token) fs.unlinkSync(lockPath);
  } catch {
    // gone or unreadable; nothing to release
  }
}

/**
 * Probe git with the long budget and write the cache. Runs in the detached child;
 * also safe to run by hand (without a token it takes the lock itself or stands down).
 * @param {string} [repoRoot]
 * @param {{ stateFile?: string, token?: string, perCommandTimeoutMs?: number, budgetMs?: number }} [opts]
 * @returns {{ refreshed: boolean, reason?: string, state?: object }}
 */
function runRefresh(repoRoot = REPO_ROOT, opts = {}) {
  const stateFile = opts.stateFile || GIT_STATE_FILE;
  const lockPath = refreshLockPath(stateFile);
  const started = Date.now();
  let token = opts.token || '';
  if (!token) {
    token = `${process.pid}-${started}-manual`;
    if (!acquireRefreshLock(lockPath, { pid: process.pid, token, now: started })) {
      return { refreshed: false, reason: 'in-flight' };
    }
  }
  try {
    const state = buildFreshGitState({
      cwd: repoRoot,
      timeoutMs: opts.perCommandTimeoutMs || REFRESH_PER_COMMAND_TIMEOUT_MS,
      deadline: started + (opts.budgetMs || REFRESH_TOTAL_BUDGET_MS),
    });
    const written = writeGitState(state, stateFile);
    return written ? { refreshed: true, state } : { refreshed: false, reason: 'write-failed', state };
  } finally {
    releaseRefreshLock(lockPath, token);
  }
}

/**
 * Start a detached refresh and return at once. No-op while a refresh is in flight.
 * The child gets no stdio: Claude Code waits for a hook's stdout/stderr to close,
 * so an inherited pipe would make the hook wait out the whole probe.
 * @param {string} [repoRoot]
 * @param {{ stateFile?: string, spawn?: Function, isPidAlive?: Function, now?: number }} [opts]
 *   spawn / isPidAlive / now are test seams
 * @returns {{ spawned: boolean, reason?: string, pid?: number }}
 */
function spawnDetachedRefresh(repoRoot = REPO_ROOT, opts = {}) {
  const stateFile = opts.stateFile || GIT_STATE_FILE;
  const lockPath = refreshLockPath(stateFile);
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const isAlive = opts.isPidAlive || isPidAlive;
  const spawnFn = opts.spawn || require('child_process').spawn;
  const token = `${process.pid}-${now}-${Math.random().toString(36).slice(2, 10)}`;
  if (!acquireRefreshLock(lockPath, { pid: process.pid, token, now, isAlive })) {
    return { spawned: false, reason: 'in-flight' };
  }
  let child;
  try {
    child = spawnFn(process.execPath, [__filename, '--refresh', repoRoot, '--state-file', stateFile], {
      cwd: repoRoot,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, CLAUDE_PROJECT_DIR: repoRoot, [REFRESH_TOKEN_ENV]: token },
    });
  } catch {
    child = null;
  }
  // A failed spawn (bad cwd, missing node) leaves pid undefined and reports later via 'error'.
  if (!child || !Number.isInteger(child.pid)) {
    releaseRefreshLock(lockPath, token);
    return { spawned: false, reason: 'spawn-failed' };
  }
  if (typeof child.on === 'function') child.on('error', () => { /* lock ages out */ });
  if (typeof child.unref === 'function') child.unref();
  rewriteRefreshLockOwner(lockPath, { pid: child.pid, startedAt: now, token });
  return { spawned: true, pid: child.pid };
}

// --- Core engine ---

/**
 * Apply signal multipliers to a set of options and return them sorted
 * descending by effective score, with the top pick marked recommended:true.
 *
 * @param {Array<{ id: string, label: string, baseScore: number }>} options
 * @param {{
 *   gitStatus?: ReturnType<typeof readGitStatus>,
 *   forgeState?: ReturnType<typeof readForgeState>,
 *   testState?: ReturnType<typeof readTestState>,
 *   recentEdits?: ReturnType<typeof readRecentEdits>,
 * }} signals
 * @returns {Array<{ id: string, label: string, baseScore: number, effectiveScore: number, recommended: boolean }>}
 */
function reorderOptions(options, signals) {
  if (!Array.isArray(options) || options.length === 0) return [];

  const git    = signals.gitStatus   || {};
  const forge  = signals.forgeState  || {};
  const test   = signals.testState   || {};
  const edits  = signals.recentEdits || {};

  const scored = options.map((opt) => {
    let score = typeof opt.baseScore === 'number' ? opt.baseScore : 0;
    const id = opt.id || '';

    // Active forge session → boost forge-related options
    if (forge.forgeActive && FORGE_IDS.test(id)) {
      score *= BOOST;
    }

    // Failing tests → boost fix/test options
    if (test.testsFailing && FIX_IDS.test(id)) {
      score *= BOOST;
    }

    // Uncommitted changes → boost commit/ship options
    if (git.hasUncommitted && COMMIT_IDS.test(id)) {
      score *= BOOST;
    }

    // Recent test/hook edits → boost fix/test options
    if ((edits.hasTestEdits || edits.hasHookEdits) && FIX_IDS.test(id)) {
      score *= BOOST;
    }

    // Idle session (no forge, no failures, no uncommitted) → boost explore options
    const isIdle = !forge.forgeActive && !test.testsFailing && !git.hasUncommitted;
    if (isIdle && EXPLORE_IDS.test(id)) {
      score *= BOOST;
    }

    return { ...opt, effectiveScore: score, recommended: false };
  });

  // Sort descending by effective score, then stable by original index
  scored.sort((a, b) => b.effectiveScore - a.effectiveScore);

  // Mark top pick
  if (scored.length > 0) {
    scored[0] = { ...scored[0], recommended: true };
  }

  return scored;
}

/**
 * Convenience: read all signals then reorder the given option set.
 *
 * @param {string} commandId - Identifier of the calling command (unused in scoring, reserved for future per-command weighting)
 * @param {Array<{ id: string, label: string, baseScore: number }>} optionSet
 * @returns {Array<{ id: string, label: string, baseScore: number, effectiveScore: number, recommended: boolean }>}
 */
function getOrderedOptions(commandId, optionSet) {
  const signals = {
    gitStatus:   readGitStatus(),
    forgeState:  readForgeState(),
    testState:   readTestState(),
    recentEdits: readRecentEdits(),
  };
  return reorderOptions(optionSet, signals);
}

module.exports = {
  // Signal readers (exported for testing)
  readGitStatus,
  readForgeState,
  readTestState,
  readRecentEdits,
  // Probe budget (exported for testing)
  GIT_PROBE_DEFAULT_TIMEOUT_MS,
  GIT_PROBE_TIMEOUT_MS,
  resolveGitProbeTimeoutMs,
  // Git state API (C-10)
  readGitState,
  writeGitState,
  buildFreshGitState,
  readRecentCommits,
  // Detached refresh (GATE 1(b))
  REFRESH_PER_COMMAND_TIMEOUT_MS,
  REFRESH_TOTAL_BUDGET_MS,
  REFRESH_LOCK_STALE_MS,
  REFRESH_TOKEN_ENV,
  commandBudgetMs,
  refreshLockPath,
  isPidAlive,
  isRefreshLockStale,
  acquireRefreshLock,
  releaseRefreshLock,
  runRefresh,
  spawnDetachedRefresh,
  // Engine
  reorderOptions,
  getOrderedOptions,
};

// `node smart-order.cjs --refresh <repoRoot> [--state-file <path>]`: the detached child.
// Exits 0 whatever happens; nobody is waiting on it.
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--refresh') {
    const repoRoot = args[1] && !args[1].startsWith('--') ? args[1] : REPO_ROOT;
    const at = args.indexOf('--state-file');
    const stateFile = at > 0 && args[at + 1] ? path.resolve(args[at + 1]) : GIT_STATE_FILE;
    try {
      runRefresh(repoRoot, { stateFile, token: process.env[REFRESH_TOKEN_ENV] || '' });
    } catch {
      // the lock is released in runRefresh's finally, or ages out
    }
  }
  process.exit(0);
}
