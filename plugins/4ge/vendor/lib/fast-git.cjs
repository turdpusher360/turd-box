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
 *   and both the cwd and the effective target (after folding any global -C)
 *   are on a DrvFs mount. Everything else runs native.
 * - `-C <winpath>` is injected explicitly for the exe route — never rely on
 *   interop cwd translation for repo targeting.
 * - Output is CRLF-normalized so existing `split('\n')` call sites are safe.
 * - The exe route falls back to native git when the spawn fails, times out,
 *   or WSL interop is down (isInteropFailure). Any other non-zero exit is
 *   git's own result and is returned as is.
 * - `--no-optional-locks` is enforced on every invocation (background
 *   callers must never take index locks — stale-lock incident class).
 * - git.exe reads the shared repo .git/config, so per-repo autocrlf/eol
 *   behavior matches native (this repo pins core.autocrlf=false).
 * - A linked worktree created by WSL git has a .git file pointing at a POSIX
 *   `gitdir: /mnt/...` path that git.exe cannot resolve ("not a git
 *   repository"; every WSL worktree on DrvFs, found 2026-09-23). Reads in
 *   such a worktree route to native git. Passing the translated admin dir as
 *   explicit --git-dir/--work-tree would make git.exe work, but explicit
 *   selectors skip Git for Windows' discovery-time owner-SID check
 *   (safe.directory), which WSL cannot observe on DrvFs; two review rounds
 *   rejected that. Native git runs its own discovery and ownership check, so
 *   no trust decision is made here. Windows-written pointers (drive letter,
 *   or UNC in either slash style) and relative pointers still take the exe
 *   route. Faster options for later: WSL git >= 2.48
 *   `worktree add --relative-paths` (git.exe then discovers the worktree
 *   itself), or a Windows-side ownership helper.
 * - A global -C given as a Windows path (`O:\...`, `\\server\share`,
 *   `//server/share`) routes native: its target cannot be inspected from WSL.
 */

const { spawnSync } = require('node:child_process');
const fs = require('fs');
const path = require('path');

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

// Test seam (BL-713): point the exe route at a stub executable. Returns the
// previous value; pass it back (undefined restores discovery) to undo.
function setGitExePathForTest(p) {
  const prev = _exePath;
  _exePath = p;
  return prev;
}

function isDrvfsPath(p) {
  return typeof p === 'string' && /^\/mnt\/[a-z](\/|$)/.test(p);
}

function toWinPath(p) {
  const m = /^\/mnt\/([a-z])(\/.*)?$/.exec(p);
  if (!m) return p;
  return `${m[1].toUpperCase()}:${(m[2] || '/').replace(/\//g, '\\')}`;
}

// Drive-letter or UNC root in either slash style (`\\server\share`,
// `//server/share`). WSL cannot inspect what such a path points at.
function isWindowsFormPath(p) {
  return typeof p === 'string' && /^(?:[A-Za-z]:|\\\\|\/\/)/.test(p);
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

// WSL interop down (captured live 2026-10-06, BL-713): git.exe never starts,
// and the WSL launcher exits 1 with empty stdout after about 10 s, printing
// "<3>WSL (<pid> - ) ERROR: UtilAcceptVsock:273: accept4 failed 110" on
// stderr. That is not a git result. The stderr signature is required: a
// non-zero exit with empty stdout alone also describes `git grep -l` finding
// nothing, which is a real result.
const INTEROP_FAILURE_RE = /UtilAcceptVsock|accept4 failed/;

function isInteropFailure(r) {
  if (!r || r.error || r.status === 0) return false;
  const out = r.stdout == null ? '' : String(r.stdout);
  const err = r.stderr == null ? '' : String(r.stderr);
  return out === '' && INTEROP_FAILURE_RE.test(err);
}

// git's own gitfile limit (setup.c read_gitfile_gently).
const GITFILE_MAX_BYTES = 1 << 20;

// Mirrors git's gitfile grammar: the file must begin with exactly "gitdir: ",
// only trailing CR/LF is stripped, and a pointer with an embedded newline or
// NUL is rejected. Returns the pointer text or null.
function parseGitFile(text) {
  if (typeof text !== 'string' || !text.startsWith('gitdir: ')) return null;
  const pointer = text.slice('gitdir: '.length).replace(/[\r\n]+$/, '');
  if (!pointer || /[\r\n\0]/.test(pointer)) return null;
  return pointer;
}

// Global options precede the subcommand. git applies every -C in order, each
// relative to the previous directory, so fold them the same way. Reports
// whether any global -C was given and whether one was a Windows-form path.
function repoTargetOf(args, cwd) {
  let dir = cwd;
  let hasGlobalC = false;
  let windowsTarget = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a !== 'string') continue;
    if (a === '-C') {
      hasGlobalC = true;
      const v = args[i + 1];
      if (typeof v === 'string') {
        if (isWindowsFormPath(v)) windowsTarget = true;
        else dir = path.resolve(dir, v);
      }
      i++;
      continue;
    }
    if (a === '-c' || a === '--git-dir' || a === '--work-tree') { i++; continue; }
    if (!a.startsWith('-')) break; // subcommand reached
  }
  return { dir, hasGlobalC, windowsTarget };
}

// True when the first .git entry at or above dir is a gitfile whose pointer
// is a POSIX absolute path (written by WSL git): git.exe cannot resolve it.
// A .git directory, a Windows-form (drive or UNC) or relative pointer, an
// unparseable or oversized gitfile, or no .git at all returns false.
function isWslGitfileWorktree(dir) {
  let cur = dir;
  for (;;) {
    const dotGit = path.join(cur, '.git');
    let st = null;
    try { st = fs.statSync(dotGit); } catch { /* not here — keep walking */ }
    if (st) {
      if (!st.isFile() || st.size > GITFILE_MAX_BYTES) return false;
      let pointer = null;
      try { pointer = parseGitFile(fs.readFileSync(dotGit, 'utf8')); } catch { return false; }
      return Boolean(pointer) && pointer.startsWith('/') && !isWindowsFormPath(pointer);
    }
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

// Pure routing decision. `env` carries the machine facts
// ({ exe, platform, isWslWorktree }) so tests can drive every branch without
// git.exe or a DrvFs mount.
function routeDecision(argv, cwd, env) {
  if (!env.exe || env.platform !== 'linux' || !isDrvfsPath(cwd)) return 'native';
  const sub = subcommandOf(argv);
  if (sub === null || WRITE_SUBCOMMANDS.has(sub)) return 'native';
  const target = repoTargetOf(argv, cwd);
  // The folded target must itself be on DrvFs: git.exe cannot reach an ext4
  // path such as `-C /tmp`, and a Windows-form target cannot be inspected.
  if (target.windowsTarget || !isDrvfsPath(target.dir)) return 'native';
  if (env.isWslWorktree(target.dir)) return 'native';
  return 'exe';
}

// 'exe' when git.exe can serve this read, otherwise 'native'.
function routeFor(argv, cwd) {
  return routeDecision(argv, cwd, {
    exe: Boolean(gitExePath()), platform: process.platform, isWslWorktree: isWslGitfileWorktree,
  });
}

// git.exe argv for a read: explicit -C to the Windows cwd first, then the
// caller's args with DrvFs paths translated. git applies -C in order, so a
// relative caller -C resolves against that explicit cwd rather than git.exe's
// interop-translated process cwd, and an absolute caller -C still overrides
// it (BL-270). repoTargetOf folds from cwd the same way, so routing agrees.
function exeArgs(argv, cwd) {
  return [
    '--no-optional-locks',
    '-C', toWinPath(cwd),
    ...argv.map((a) => (isDrvfsPath(a) ? toWinPath(a) : a)),
  ];
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

  if (routeFor(argv, cwd) === 'exe') {
    const r = spawnSync(gitExePath(), exeArgs(argv, cwd), baseOpts);
    // spawnSync sets r.error on a spawn failure (ENOENT etc.) and on a
    // timeout; both fall back to native, as does a WSL interop failure. Any
    // other non-zero exit is a real git result the caller's handling owns.
    if (!r.error && !isInteropFailure(r)) {
      r.stdout = normalizeEol(r.stdout);
      r.stderr = normalizeEol(r.stderr);
      return r;
    }
  }

  return spawnSync('git', ['--no-optional-locks', ...argv], baseOpts);
}

module.exports = {
  gitRead,
  _internals: {
    gitExePath, isDrvfsPath, toWinPath, subcommandOf, normalizeEol, WRITE_SUBCOMMANDS,
    parseGitFile, repoTargetOf, isWslGitfileWorktree, routeFor, exeArgs, GITFILE_MAX_BYTES,
    isWindowsFormPath, routeDecision, isInteropFailure, INTEROP_FAILURE_RE, setGitExePathForTest,
  },
};
