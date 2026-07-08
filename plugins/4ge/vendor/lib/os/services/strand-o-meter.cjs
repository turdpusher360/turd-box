'use strict';

/**
 * strand-o-meter.cjs
 *
 * Postmortem P2 (_runs/2026-07-02/postmortem-ecosystem-stranded-work.md):
 * work strands portfolio-wide (unpushed branches, dirty trees, sole-copy
 * stashes) with no liveness signal until an operator notices by intuition.
 * This module gives that class a heartbeat: per configured repo, it reports
 * branches ahead of their upstream, dirty-tree entry count + oldest-file
 * age, and stash count + oldest age.
 *
 * PERFORMANCE CONTRACT: scanning N repos with several `git` subprocess calls
 * each is too slow for the SessionStart boot budget, especially on drvfs
 * (Windows drive) mounts where git can take seconds per call (see file-integrity's
 * boot() comment on the same class of slowness). This module is therefore
 * split into a fast, boot-safe read path and a slow, detached write path:
 *
 *   - `loadCachedStatus()` / `summarizeStrandStatus()` — read the last scan
 *     result from `_runs/os/strand-status.json`. Near-instant.
 *   - `isCacheStale()` — true when the cache is missing or older than
 *     `DEFAULT_STALENESS_HOURS` (6h). Documents the staleness window: a
 *     strand can be up to ~6h old before the boot brief reflects it, in
 *     exchange for zero synchronous scan cost at boot.
 *   - `kickBackgroundRefresh()` — spawns THIS FILE as a detached,
 *     stdio-ignored child process with `--refresh`, which runs the actual
 *     `scanPortfolio()` work and writes the cache atomically, then exits.
 *     Debounced via a `.strand-refreshing` sentinel (10 min) so rapid
 *     SessionStarts (compact, /clear) don't stack concurrent scans.
 *
 * The SessionStart caller (os-boot.cjs) should call `loadCachedStatus()` +
 * `summarizeStrandStatus()` for the brief line, and separately call
 * `isCacheStale()` + `kickBackgroundRefresh()` to queue the next scan — but
 * MUST NOT await the refresh or call `scanPortfolio()` inline at boot.
 *
 * Fail-open throughout: a missing repo, a non-git directory, or a timed-out
 * git call is skipped with a `note`, never thrown. This is an advisory
 * instrument, not a gate.
 *
 * SAFETY HARDENING (upstream, post-incident — see git blame / heartbeats-build-
 * report.md §9 for the full incident writeup):
 *   - Every git call runs with `GIT_OPTIONAL_LOCKS=0` — never take the index
 *     lock (a live incident: a background scan's stray git process left a
 *     stale `.git/index.lock` that blocked all commits for 38 minutes).
 *   - Dirty-tree scanning uses `--untracked-files=normal`, not `=all` — the
 *     deep per-file untracked enumeration was the dominant cost of a
 *     measured 24.9s worst-case `git status` call on this repo.
 *   - `scanPortfolio([])` and `kickBackgroundRefresh()` both treat an empty
 *     repo list as "nothing to scan, exit immediately" — no git call, no
 *     spawn. (A prior bug conflated "explicit empty array" with "no array
 *     provided" and silently fell back to the real default config, which is
 *     exactly how an empty-repos TEST fixture leaked two real, long-running
 *     scans of this rig's actual portfolio.)
 *   - The `--refresh` CLI child self-terminates past `MAX_RUNTIME_MS` and
 *     writes its own pid into the sentinel file for diagnosability — see
 *     the honest limitations noted at `MAX_RUNTIME_MS`'s definition.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { gitRead } = require('../../fast-git.cjs');

// upstream fix: the repo list is WORKSPACE-scoped rig data (absolute host
// paths), not shippable code — it previously lived at lib/os/config/
// portfolio-repos.json, which sync-plugin-os.cjs vendors into the public
// plugin, and its internal-reference tripwire correctly refused to ship it
// (one of the configured rig paths matched an existing forbidden-pattern
// anchor). `.4ge/` sits entirely outside the vendored dirs (lib/os,
// lib/aisle) — same reasoning as the infra.cjs container registry, which
// loads its rig-specific stack list from `.4ge/config.json`
// `infra.containers` rather than a hardcoded array.
// Resolved as a function (not a module-load-time constant) so it always
// reflects the CALLER's cwd, matching tier-gate.cjs's `_licensePath()`
// pattern ("resolved dynamically so cwd/homedir mocks work in tests").
function defaultConfigPath() {
  return path.join(process.cwd(), '.4ge', 'portfolio-repos.json');
}

const CACHE_FILENAME = 'strand-status.json';
const SENTINEL_FILENAME = '.strand-refreshing';
const DEFAULT_STALENESS_HOURS = 6;
// Measured live on this repo (upstream): `git status --porcelain --untracked-
// files=all` alone took 24.9s on Windows-mounted drvfs — consistent with the
// postmortem's file-integrity.cjs precedent ("13-20s CONSISTENTLY"). A
// 15s timeout silently produced dirtyCount:null (timed out, not clean) in
// the same smoke test. 45s comfortably covers that with headroom, and costs
// nothing at boot because this only runs in the detached background
// process — never in the SessionStart hook itself.
const GIT_TIMEOUT_MS = 45000;
const REFRESH_DEBOUNCE_MS = 10 * 60 * 1000;
// Upper bound on one refresh child's total wall-clock: 7 repos x 3 git
// calls each x 45s worst-case GIT_TIMEOUT_MS = ~15.75min pathological
// ceiling if every single call maxed out. 15min gives no extra headroom on
// purpose — this is a last-resort self-terminate for a genuinely runaway
// scan, not a normal-case bound. HONEST LIMITATION: this timer can only
// fire once control returns to the event loop between synchronous
// `spawnSync` git calls — it cannot preempt a single git call already
// blocked in kernel D-state (uninterruptible I/O wait, e.g. a wedged drvfs
// mount), which is the exact state the 40+min leaked processes were found
// in. For that class, GIT_OPTIONAL_LOCKS=0 (above) is the effective
// defense — it stops the hung process from EVER holding .git/index.lock in
// the first place, independent of whether the process itself terminates.
const MAX_RUNTIME_MS = 15 * 60 * 1000;

/**
 * Load the list of portfolio repo roots from a JSON config file. Defaults to
 * `<cwd>/.4ge/portfolio-repos.json` — a workspace-local, gitignored file
 * (rig-specific absolute paths). Fail-open: a fresh install / missing file /
 * malformed content / non-array shape all return [] (no scan, no crash) —
 * `summarizeStrandStatus()` already renders that as "no scan yet".
 *
 * @param {string} [configPath]
 * @returns {string[]}
 */
function loadPortfolioConfig(configPath) {
  const p = configPath || defaultConfigPath();
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x) => typeof x === 'string' && x.length > 0);
  } catch {
    return [];
  }
}

/**
 * Run a git subcommand in a given repo, tolerating timeout/spawn failure.
 * Distinguishes a real failure from a clean/empty result — mirrors the
 * file-integrity.cjs pattern of not conflating "git could not run" with "git
 * ran and found nothing".
 *
 * @param {string[]} args
 * @param {string} cwd
 * @returns {{ ok: boolean, stdout: string, reason: string|null }}
 */
function runGit(args, cwd) {
  try {
    const result = gitRead(args, {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      // A background/status-style scan must NEVER take git's optional locks
      // (index refresh, untracked-cache write-back) — a background caller
      // holding .git/index.lock, even briefly, collides with real git work
      // (commits, `git status` from the operator) and can strand a stale
      // lock if the background process is killed mid-write. This is the
      // standard mechanism for exactly this class of caller (VS Code's git
      // integration sets the same env var for its background status polls).
      // Real incident, this session: a strand-o-meter-era git process left
      // a 0-byte .git/index.lock that blocked all commits for 38 minutes.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    if (result.error || result.signal) {
      const reason = result.error ? (result.error.code || result.error.message) : `killed:${result.signal}`;
      return { ok: false, stdout: '', reason };
    }
    if (result.status !== 0) {
      const reason = (result.stderr || '').trim().split('\n')[0] || `exit:${result.status}`;
      return { ok: false, stdout: result.stdout || '', reason };
    }
    return { ok: true, stdout: result.stdout || '', reason: null };
  } catch (err) {
    return { ok: false, stdout: '', reason: (err && err.message) || 'unknown error' };
  }
}

/**
 * Count local branches that are ahead of their configured upstream by 1+
 * commits (branches with no upstream are not counted — nothing to strand).
 *
 * @param {string} repoPath
 * @returns {{ count: number|null, reason: string|null }}
 */
function countAheadBranches(repoPath) {
  const r = runGit(['for-each-ref', '--format=%(refname:short)|%(upstream:track)', 'refs/heads'], repoPath);
  if (!r.ok) return { count: null, reason: r.reason };
  let count = 0;
  for (const line of r.stdout.split('\n')) {
    if (!line) continue;
    const m = line.match(/ahead (\d+)/);
    if (m && parseInt(m[1], 10) > 0) count += 1;
  }
  return { count, reason: null };
}

/**
 * Count dirty-tree entries (modified/staged files, plus untracked files —
 * untracked DIRECTORIES count as one entry, not recursively expanded) and
 * the age in days of the oldest one.
 *
 * Uses git's default `--untracked-files=normal` (one line per untracked dir,
 * not per file inside it) rather than `=all`. Measured live on this repo
 * (upstream): the deep `=all` enumeration was the dominant cost of the 24.9s
 * worst-case `git status` call this module's timeout is sized around — a
 * large untracked directory (build output, caches) forces git to stat every
 * file inside it individually. `=normal` trades exact untracked-file-count
 * precision for a bounded, much cheaper scan; a stranded untracked directory
 * still shows up as (at least) one flagged entry, which is enough for the
 * heartbeat's purpose (detect that something is there, not enumerate it).
 *
 * @param {string} repoPath
 * @returns {{ count: number|null, oldestAgeDays: number|null, reason: string|null }}
 */
function scanDirtyTree(repoPath) {
  const r = runGit(['status', '--porcelain', '--untracked-files=normal'], repoPath);
  if (!r.ok) return { count: null, oldestAgeDays: null, reason: r.reason };
  const lines = r.stdout.split('\n').filter(Boolean);
  let oldestMtime = null;
  for (const line of lines) {
    // Porcelain v1: "XY PATH" or "XY PATH -> PATH2" (renames use the new path).
    let rel = line.length > 3 ? line.slice(3) : '';
    const arrow = rel.indexOf(' -> ');
    if (arrow !== -1) rel = rel.slice(arrow + 4);
    if (rel.startsWith('"') && rel.endsWith('"')) rel = rel.slice(1, -1);
    if (!rel) continue;
    try {
      const st = fs.statSync(path.join(repoPath, rel));
      if (oldestMtime === null || st.mtimeMs < oldestMtime) oldestMtime = st.mtimeMs;
    } catch {
      // Deleted/renamed-away path — still counts as a dirty entry, just has
      // no age contribution.
    }
  }
  const oldestAgeDays = oldestMtime === null ? null : Math.floor((Date.now() - oldestMtime) / 86400000);
  return { count: lines.length, oldestAgeDays, reason: null };
}

/**
 * Count stashes and the age in days of the oldest one.
 *
 * @param {string} repoPath
 * @returns {{ count: number|null, oldestAgeDays: number|null, reason: string|null }}
 */
function scanStashes(repoPath) {
  const r = runGit(['stash', 'list', '--format=%gd|%ci'], repoPath);
  if (!r.ok) return { count: null, oldestAgeDays: null, reason: r.reason };
  const lines = r.stdout.split('\n').filter(Boolean);
  let oldestMs = null;
  for (const line of lines) {
    const sep = line.indexOf('|');
    if (sep === -1) continue;
    const dateStr = line.slice(sep + 1);
    const t = Date.parse(dateStr);
    if (Number.isFinite(t) && (oldestMs === null || t < oldestMs)) oldestMs = t;
  }
  const oldestAgeDays = oldestMs === null ? null : Math.floor((Date.now() - oldestMs) / 86400000);
  return { count: lines.length, oldestAgeDays, reason: null };
}

/**
 * Scan one repo. Fail-open: a missing path, a non-git directory, or a git
 * failure across all three checks produces `{ ok: false, note }` rather than
 * throwing.
 *
 * @param {string} repoPath
 * @returns {object}
 */
function scanRepo(repoPath) {
  if (!repoPath || typeof repoPath !== 'string') {
    return { repo: String(repoPath), path: repoPath || null, ok: false, note: 'invalid repo path' };
  }
  const name = path.basename(repoPath);
  try {
    if (!fs.existsSync(repoPath)) {
      return { repo: name, path: repoPath, ok: false, note: 'repo not found' };
    }
    if (!fs.existsSync(path.join(repoPath, '.git'))) {
      return { repo: name, path: repoPath, ok: false, note: 'not a git repo' };
    }
  } catch {
    return { repo: name, path: repoPath, ok: false, note: 'stat failed' };
  }

  const ahead = countAheadBranches(repoPath);
  const dirty = scanDirtyTree(repoPath);
  const stash = scanStashes(repoPath);

  if (ahead.count === null && dirty.count === null && stash.count === null) {
    const reason = ahead.reason || dirty.reason || stash.reason || 'unknown';
    return { repo: name, path: repoPath, ok: false, note: `git unavailable (${reason})` };
  }

  return {
    repo: name,
    path: repoPath,
    ok: true,
    branchesAhead: ahead.count,
    dirtyCount: dirty.count,
    dirtyOldestAgeDays: dirty.oldestAgeDays,
    stashCount: stash.count,
    stashOldestAgeDays: stash.oldestAgeDays,
  };
}

/**
 * Scan every configured repo. This is the SLOW path — never call inline
 * from a SessionStart hook; run it via `kickBackgroundRefresh()` instead.
 *
 * `repoPaths` is honored EXACTLY as passed when it's an array — an explicit
 * `[]` means "scan zero repos" and returns instantly with no git calls.
 * Only `undefined`/non-array falls back to `loadPortfolioConfig()`. (upstream:
 * a prior version checked `repoPaths.length` as part of the discriminator,
 * which silently treated a real, intentional `[]` the same as "not
 * provided" and re-read the DEFAULT config instead — the exact mechanism
 * that turned an empty-repos test fixture into a real scan of this rig's
 * actual portfolio, leaking two long-running `git status` processes.)
 *
 * @param {string[]} [repoPaths] - defaults to `loadPortfolioConfig()`
 * @param {{ configPath?: string }} [opts]
 * @returns {{ scannedAt: string, results: object[] }}
 */
function scanPortfolio(repoPaths, opts) {
  const options = opts || {};
  const paths = Array.isArray(repoPaths) ? repoPaths : loadPortfolioConfig(options.configPath);
  const results = paths.map(scanRepo);
  return { scannedAt: new Date().toISOString(), results };
}

function cachePath(stateDir) {
  return path.join(stateDir || path.join(process.cwd(), '_runs', 'os'), CACHE_FILENAME);
}

/**
 * Read the last scan result. Fail-open: returns null on any missing/corrupt
 * file rather than throwing.
 *
 * @param {string} filePath - full path to strand-status.json
 * @returns {{ scannedAt: string, results: object[] }|null}
 */
function loadCachedStatus(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.results)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * @param {{scannedAt?:string}|null} cached
 * @param {{ thresholdHours?: number }} [opts]
 * @returns {boolean} true when a refresh should be kicked (missing, corrupt, or older than the threshold)
 */
function isCacheStale(cached, opts) {
  const options = opts || {};
  const thresholdHours = Number.isFinite(options.thresholdHours) ? options.thresholdHours : DEFAULT_STALENESS_HOURS;
  if (!cached || !cached.scannedAt) return true;
  const scannedMs = Date.parse(cached.scannedAt);
  if (!Number.isFinite(scannedMs)) return true;
  return (Date.now() - scannedMs) > thresholdHours * 3600000;
}

function describeAge(ms) {
  const mins = Math.max(0, Math.floor(ms / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Build the one-line (or few-clause) boot-brief summary from a cached scan.
 * Never throws; degrades to an explanatory string when the cache is empty.
 *
 * @param {{scannedAt?:string, results?:object[]}|null} cached
 * @returns {string}
 */
function summarizeStrandStatus(cached) {
  if (!cached || !Array.isArray(cached.results) || cached.results.length === 0) {
    return 'no scan yet — refresh queued';
  }
  const scannedMs = Date.parse(cached.scannedAt);
  const ageLabel = describeAge(Number.isFinite(scannedMs) ? Date.now() - scannedMs : 0);

  const flagged = [];
  let scannedOk = 0;
  let skipped = 0;
  for (const r of cached.results) {
    if (!r) continue;
    if (r.ok === false) { skipped += 1; continue; }
    scannedOk += 1;
    const bits = [];
    if (r.branchesAhead > 0) bits.push(`${r.branchesAhead} branch${r.branchesAhead === 1 ? '' : 'es'} ahead`);
    if (r.dirtyCount > 0) {
      const age = r.dirtyOldestAgeDays !== null && r.dirtyOldestAgeDays !== undefined ? ` (oldest ${r.dirtyOldestAgeDays}d)` : '';
      bits.push(`dirty ${r.dirtyCount}${age}`);
    }
    if (r.stashCount > 0) {
      const age = r.stashOldestAgeDays !== null && r.stashOldestAgeDays !== undefined ? ` (oldest ${r.stashOldestAgeDays}d)` : '';
      bits.push(`${r.stashCount} stash${r.stashCount === 1 ? '' : 'es'}${age}`);
    }
    if (bits.length) flagged.push(`${r.repo}: ${bits.join(', ')}`);
  }

  const skippedNote = skipped > 0 ? `, ${skipped} skipped` : '';
  if (flagged.length === 0) {
    return `all ${scannedOk} repos clean (scanned ${ageLabel} ago${skippedNote})`;
  }
  return `${flagged.length}/${scannedOk} repos flagged (scanned ${ageLabel} ago${skippedNote}) — ${flagged.join('; ')}`;
}

/**
 * Spawn this file as a detached, output-ignored refresh child. Debounced via
 * a sentinel file so repeated SessionStarts within `REFRESH_DEBOUNCE_MS`
 * don't stack concurrent scans. Never blocks — the child's own completion is
 * irrelevant to the caller; the NEXT boot's `loadCachedStatus()` picks up
 * whatever the child wrote.
 *
 * Nothing configured = nothing to scan: if the repo list resolves to zero
 * entries, returns immediately WITHOUT touching the sentinel or spawning
 * anything (upstream — second, independent guard against the same failure
 * class as the `scanPortfolio([])` fix above: a fresh install, or a test
 * fixture with an intentionally empty repo list, must never fork a process,
 * let alone shell out to git).
 *
 * @param {{ stateDir?: string, configPath?: string }} [opts]
 * @returns {{ kicked: boolean, reason?: string, pid?: number }}
 */
function kickBackgroundRefresh(opts) {
  const options = opts || {};
  const stateDir = options.stateDir || path.join(process.cwd(), '_runs', 'os');
  const configPath = options.configPath || defaultConfigPath();
  const sentinelPath = path.join(stateDir, SENTINEL_FILENAME);

  if (loadPortfolioConfig(configPath).length === 0) {
    return { kicked: false, reason: 'no repos configured' };
  }

  try {
    const st = fs.statSync(sentinelPath);
    if ((Date.now() - st.mtimeMs) < REFRESH_DEBOUNCE_MS) {
      return { kicked: false, reason: 'debounced' };
    }
  } catch {
    // no sentinel present — proceed
  }

  try {
    fs.mkdirSync(stateDir, { recursive: true });
    // Provisional pidfile-shaped sentinel — pid is null until the child
    // overwrites it with its own pid at startup (see the CLI entry below).
    // Written before spawning so a second caller racing in immediately
    // after still sees a fresh sentinel and debounces correctly.
    fs.writeFileSync(sentinelPath, JSON.stringify({ pid: null, startedAt: new Date().toISOString() }));
  } catch (err) {
    return { kicked: false, reason: (err && err.message) || 'cannot write sentinel' };
  }

  try {
    const child = spawn(
      process.execPath,
      [__filename, '--refresh', '--state-dir', stateDir, '--config-path', configPath],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
    return { kicked: true, pid: child.pid };
  } catch (err) {
    return { kicked: false, reason: (err && err.message) || 'spawn failed' };
  }
}

function writeJsonAtomic(filePath, data) {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, filePath);
}

// ---------------------------------------------------------------------------
// CLI refresh entry point — invoked only via kickBackgroundRefresh() as a
// detached child. Not exercised by unit tests (which call scanPortfolio()
// directly); the CLI wrapper is intentionally a thin, untested shell.
// ---------------------------------------------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--refresh')) {
    const stateDirIdx = args.indexOf('--state-dir');
    const configIdx = args.indexOf('--config-path');
    const stateDir = stateDirIdx !== -1 ? args[stateDirIdx + 1] : path.join(process.cwd(), '_runs', 'os');
    const configPath = configIdx !== -1 ? args[configIdx + 1] : defaultConfigPath();
    const sentinelPath = path.join(stateDir, SENTINEL_FILENAME);

    // Defense-in-depth self-terminate — see MAX_RUNTIME_MS comment for its
    // honest scope (protects the ordinary/JS-hang case; a D-state-stuck git
    // call is a separate, kernel-level problem GIT_OPTIONAL_LOCKS=0 exists
    // to prevent in the first place). unref()'d so it never delays a normal
    // on-time exit.
    const killTimer = setTimeout(() => {
      try { fs.unlinkSync(sentinelPath); } catch { /* non-fatal */ }
      process.exit(1);
    }, MAX_RUNTIME_MS);
    killTimer.unref();

    // Overwrite the parent's provisional (pid:null) sentinel with this
    // process's real pid so a stuck scan is diagnosable: read the sentinel,
    // `ps -p <pid>` to check liveness, `kill <pid>` if it's genuinely dead
    // weight. Best-effort — a failed write still leaves the sentinel usable
    // for mtime-based debounce even without a pid.
    try {
      fs.writeFileSync(sentinelPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    } catch { /* non-fatal */ }

    try {
      const repoPaths = loadPortfolioConfig(configPath);
      const status = scanPortfolio(repoPaths);
      writeJsonAtomic(cachePath(stateDir), status);
    } catch {
      // Best-effort refresh — a failed background scan simply leaves the
      // prior cache in place for the next boot to read.
    } finally {
      try { fs.unlinkSync(sentinelPath); } catch { /* non-fatal */ }
    }
  }
}

module.exports = {
  defaultConfigPath,
  DEFAULT_STALENESS_HOURS,
  loadPortfolioConfig,
  scanRepo,
  scanPortfolio,
  cachePath,
  loadCachedStatus,
  isCacheStale,
  summarizeStrandStatus,
  kickBackgroundRefresh,
};
