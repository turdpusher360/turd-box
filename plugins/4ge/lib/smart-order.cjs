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
const GIT_PROBE_TIMEOUT_MS = (() => {
  const parsed = Number.parseInt(process.env.FORGE_GIT_PROBE_TIMEOUT_MS || '1200', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1200;
})();

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
 * Read git status signals: uncommitted changes, branch name, last commit age.
 * @returns {{ hasUncommitted: boolean, branch: string, commitAgeMs: number }}
 */
function readGitStatus() {
  // Each git probe is isolated so one slow or failing call cannot poison the
  // others — in particular the branch name (a cheap rev-parse) must survive a
  // slow `git status`. On a large working tree over a WSL /mnt mount, dirty
  // probes can wedge long enough to break HUD rendering. Keep the probe budget
  // short and return unknown dirty state instead of claiming the tree is clean.
  const run = (args) => execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: GIT_PROBE_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
  });

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
    });
    const files = diffOut.split('\n').map((l) => l.trim());
    return {
      hasTypeScriptEdits: files.some((f) => /\.(ts|tsx)/.test(f)),
      hasTestEdits:       files.some((f) => /\.(test|spec)\.(js|ts|cjs)/.test(f)),
      hasHookEdits:       files.some((f) => /\.claude\/hooks/.test(f) || /\.cjs$/.test(f)),
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
 * @returns {Array<{ sha: string, subject: string, ts: string }>}
 */
function readRecentCommits(n) {
  try {
    const out = execFileSync('git', ['log', `-${n}`, '--format=%h\t%s\t%cI'], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 3000,
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
 * @returns {{ branch: string, ahead: number, behind: number, dirty: boolean, uncommittedFiles: number, recentCommits: Array, lastCommitTs: string|null, timestamp: string }}
 */
function buildFreshGitState() {
  const git = readGitStatus();
  return {
    branch: git.branch || 'main',
    ahead: git.ahead || 0,
    behind: git.behind || 0,
    dirty: typeof git.hasUncommitted === 'boolean' ? git.hasUncommitted : null,
    uncommittedFiles: typeof git.uncommittedFiles === 'number' ? git.uncommittedFiles : null,
    recentCommits: readRecentCommits(5),
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
 * Write git-state to disk atomically (tmp + rename).
 * @param {object} state
 */
function writeGitState(state) {
  try {
    const dir = path.dirname(GIT_STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = GIT_STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, GIT_STATE_FILE);
  } catch {
    // best-effort; callers are resilient to missing state
  }
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
  // Git state API (C-10)
  readGitState,
  writeGitState,
  buildFreshGitState,
  readRecentCommits,
  // Engine
  reorderOptions,
  getOrderedOptions,
};
