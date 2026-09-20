'use strict';
/**
 * fast-git.cjs — read-only git accelerator for WSL hooks on DrvFs (/mnt/*).
 *
 * Native WSL git pays a per-file 9P round-trip on /mnt/* working trees.
 * Measured on this rig 2026-07-06 (upstream): `git status` 27-31s native vs
 * 0.4s via git.exe on the same repo and index — and the untracked walk
 * (`ls-files --others`) is the dominant cost inside per-turn hooks.
 * Flagged by four perf audits (2026-06-08/22/29, 07-06) before landing here.
 *
 * Contract:
 * - gitRead(args, opts): drop-in for spawnSync('git', args, opts) with the
 *   same result shape. Callers must pass READ-ONLY commands; known write
 *   subcommands are refused exe-routing defensively and run native (a
 *   mistranslated path on a read is a failed read; on a write it is not
 *   recoverable).
 * - Routes through git.exe only when: git.exe exists, we are on Linux/WSL,
 *   and the effective cwd is a DrvFs mount. Everything else runs native.
 * - `-C <winpath>` is injected explicitly for the exe route — never rely on
 *   interop cwd translation for repo targeting.
 * - Output is CRLF-normalized so existing `split('\n')` call sites are safe.
 * - `--no-optional-locks` is enforced on every invocation (background
 *   callers must never take index locks — stale-lock incident class).
 * - git.exe reads the shared repo .git/config, so per-repo autocrlf/eol
 *   behavior matches native (this repo pins core.autocrlf=false).
 */

const { spawnSync } = require('node:child_process');
const fs = require('fs');

const GIT_EXE_CANDIDATES = [
  '/mnt/c/Program Files/Git/cmd/git.exe',
  '/mnt/c/Program Files/Git/bin/git.exe',
];

// Defensive refusal list — mutating subcommands never ride the exe route.
const WRITE_SUBCOMMANDS = new Set([
  'add', 'am', 'apply', 'checkout', 'cherry-pick', 'clean', 'clone', 'commit',
  'fetch', 'gc', 'merge', 'mv', 'pull', 'push', 'rebase', 'reset', 'restore',
  'revert', 'rm', 'stash', 'submodule', 'switch', 'tag', 'worktree',
  'update-index', 'update-ref', 'filter-branch', 'reflog',
]);

let _exePath;
function gitExePath() {
  if (_exePath !== undefined) return _exePath;
  _exePath = GIT_EXE_CANDIDATES.find((p) => {
    try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
  }) || null;
  return _exePath;
}

function isDrvfsPath(p) {
  return typeof p === 'string' && /^\/mnt\/[a-z](\/|$)/.test(p);
}

function toWinPath(p) {
  const m = /^\/mnt\/([a-z])(\/.*)?$/.exec(p);
  if (!m) return p;
  return `${m[1].toUpperCase()}:${(m[2] || '/').replace(/\//g, '\\')}`;
}

// First non-flag token, skipping the value-taking global flags.
function subcommandOf(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-C' || a === '-c' || a === '--git-dir' || a === '--work-tree') { i++; continue; }
    if (typeof a !== 'string' || a.startsWith('-')) continue;
    return a;
  }
  return null;
}

function normalizeEol(s) {
  return typeof s === 'string' ? s.replace(/\r\n/g, '\n') : s;
}

/**
 * Drop-in replacement for spawnSync('git', args, opts) for READ-ONLY git.
 * @param {string[]} args
 * @param {object} [opts] spawnSync options (cwd, timeout, env, ...)
 * @returns spawnSync-shaped result
 */
function gitRead(args, opts = {}) {
  const argv = Array.isArray(args) ? args : [];
  const cwd = opts.cwd || process.cwd();
  const baseOpts = {
    encoding: 'utf8',
    ...opts,
    cwd,
    env: { ...process.env, ...(opts.env || {}), GIT_OPTIONAL_LOCKS: '0' },
  };

  const exe = gitExePath();
  const sub = subcommandOf(argv);
  const eligible = Boolean(exe)
    && process.platform === 'linux'
    && isDrvfsPath(cwd)
    && sub !== null
    && !WRITE_SUBCOMMANDS.has(sub);

  if (eligible) {
    const hasExplicitC = argv.includes('-C');
    const winArgs = [
      '--no-optional-locks',
      ...(hasExplicitC ? [] : ['-C', toWinPath(cwd)]),
      ...argv.map((a) => (isDrvfsPath(a) ? toWinPath(a) : a)),
    ];
    const r = spawnSync(exe, winArgs, baseOpts);
    // Fall back to native only on spawn failure (ENOENT etc.) — a timeout or
    // non-zero exit is a real result the caller's error handling owns.
    if (!r.error) {
      r.stdout = normalizeEol(r.stdout);
      r.stderr = normalizeEol(r.stderr);
      return r;
    }
  }

  return spawnSync('git', ['--no-optional-locks', ...argv], baseOpts);
}

module.exports = {
  gitRead,
  _internals: { gitExePath, isDrvfsPath, toWinPath, subcommandOf, normalizeEol, WRITE_SUBCOMMANDS },
};
