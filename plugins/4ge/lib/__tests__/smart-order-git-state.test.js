import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);

// Resolve module path for cache clearing
const MODULE_PATH = path.resolve(__dirname, '../smart-order.cjs');
const STATE_DIR_ENV = 'FORGE_OS_STATE_DIR';

function loadFresh() {
  delete require.cache[MODULE_PATH];
  return require(MODULE_PATH);
}

function gitStateFile() {
  return path.join(process.env[STATE_DIR_ENV], 'git-state.json');
}

describe('git-state API (C-10)', () => {
  let tmpDir;
  let originalStateDir;

  beforeEach(() => {
    // Keep these tests off the live _runs/os/git-state.json. The full suite has
    // other runtime-state tests/hooks that can rewrite that file concurrently.
    originalStateDir = process.env[STATE_DIR_ENV];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-order-test-'));
    process.env[STATE_DIR_ENV] = path.join(tmpDir, 'os');
    fs.mkdirSync(process.env[STATE_DIR_ENV], { recursive: true });
  });

  afterEach(() => {
    delete require.cache[MODULE_PATH];
    if (originalStateDir === undefined) delete process.env[STATE_DIR_ENV];
    else process.env[STATE_DIR_ENV] = originalStateDir;
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  });

  describe('readRecentCommits', () => {
    it('returns array of commit objects with sha/subject/ts', () => {
      const { readRecentCommits } = loadFresh();
      const commits = readRecentCommits(3);
      expect(Array.isArray(commits)).toBe(true);
      expect(commits.length).toBeLessThanOrEqual(3);
      if (commits.length > 0) {
        expect(commits[0]).toHaveProperty('sha');
        expect(commits[0]).toHaveProperty('subject');
        expect(commits[0]).toHaveProperty('ts');
        expect(typeof commits[0].sha).toBe('string');
        expect(commits[0].sha.length).toBeGreaterThan(0);
      }
    });

    it('returns empty array for n=0', () => {
      const { readRecentCommits } = loadFresh();
      const commits = readRecentCommits(0);
      expect(commits).toEqual([]);
    });
  });

  describe('buildFreshGitState', () => {
    it('returns object with all rich schema fields', () => {
      const { buildFreshGitState } = loadFresh();
      const state = buildFreshGitState();

      expect(state).toHaveProperty('branch');
      expect(state).toHaveProperty('ahead');
      expect(state).toHaveProperty('behind');
      expect(state).toHaveProperty('dirty');
      expect(state).toHaveProperty('uncommittedFiles');
      expect(state).toHaveProperty('recentCommits');
      expect(state).toHaveProperty('lastCommitTs');
      expect(state).toHaveProperty('timestamp');

      expect(typeof state.branch).toBe('string');
      expect(typeof state.ahead).toBe('number');
      expect(typeof state.behind).toBe('number');
      expect(state.dirty === null || typeof state.dirty === 'boolean').toBe(true);
      expect(state.uncommittedFiles === null || typeof state.uncommittedFiles === 'number').toBe(true);
      expect(Array.isArray(state.recentCommits)).toBe(true);
      expect(typeof state.timestamp).toBe('string');
    });

    it('produces ISO timestamp', () => {
      const { buildFreshGitState } = loadFresh();
      const state = buildFreshGitState();
      const parsed = new Date(state.timestamp);
      expect(parsed.toISOString()).toBe(state.timestamp);
    });

    it('includes no more than 5 recent commits', () => {
      const { buildFreshGitState } = loadFresh();
      const state = buildFreshGitState();
      expect(Array.isArray(state.recentCommits)).toBe(true);
      expect(state.recentCommits.length).toBeLessThanOrEqual(5);
    });
  });

  describe('writeGitState + readGitState round-trip', () => {
    it('writes and reads back identical state', () => {
      const { writeGitState, readGitState } = loadFresh();
      const state = {
        branch: 'test-branch',
        ahead: 2,
        behind: 1,
        dirty: true,
        uncommittedFiles: 3,
        recentCommits: [{ sha: 'abc1234', subject: 'test commit', ts: '2026-04-09T12:00:00Z' }],
        lastCommitTs: '2026-04-09T12:00:00Z',
        timestamp: new Date().toISOString(),
      };

      writeGitState(state);
      const read = readGitState();

      expect(read).toEqual(state);
    });

    it('returns a safe empty state when no file exists and refresh is false', () => {
      const { readGitState } = loadFresh();
      const stateFile = gitStateFile();
      if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
      const read = readGitState();
      expect(read).not.toBeNull();
      expect(read.branch).toBeNull();
      expect(read.dirty).toBeNull();
      expect(read.uncommittedFiles).toBeNull();
      expect(read).toHaveProperty('timestamp');
    });

    it('returns a safe empty state on corrupted JSON when refresh is false', () => {
      const { readGitState } = loadFresh();
      fs.writeFileSync(gitStateFile(), '{invalid json!!!');
      const read = readGitState();
      expect(read).not.toBeNull();
      expect(read.branch).toBeNull();
      expect(read.dirty).toBeNull();
      expect(read.uncommittedFiles).toBeNull();
      expect(read).toHaveProperty('timestamp');
    });
  });

  describe('readGitState refresh', () => {
    it('returns cached state when fresh (within 60s)', () => {
      // Call readGitState() without refresh:true so the cache-hit path executes.
      // refresh:true means "force rebuild even when fresh" (per production code
      // comment: "The `refresh` flag now means force even if fresh"). The test
      // intent is to verify the cache-hit path — do NOT pass refresh:true.
      const { writeGitState, readGitState } = loadFresh();
      const cached = {
        branch: 'cached-branch',
        ahead: 0, behind: 0, dirty: false, uncommittedFiles: 0,
        recentCommits: [],
        lastCommitTs: null,
        timestamp: new Date().toISOString(), // just written = fresh (age < 60s)
      };
      writeGitState(cached);
      const result = readGitState(); // no refresh flag → cache-hit path
      expect(result.branch).toBe('cached-branch');
    });

    it('returns stale cached state without running git when refresh is false', () => {
      const childProcess = require('child_process');
      const execSpy = vi.spyOn(childProcess, 'execFileSync').mockImplementation(() => {
        throw new Error('git probe should not run in refresh:false mode');
      });

      try {
        const { writeGitState, readGitState } = loadFresh();
        const stale = {
          branch: 'stale-branch',
          ahead: 0, behind: 0, dirty: false, uncommittedFiles: 0,
          recentCommits: [],
          lastCommitTs: null,
          timestamp: new Date(Date.now() - 120000).toISOString(),
        };
        writeGitState(stale);
        const result = readGitState();

        expect(result).toEqual(stale);
        expect(execSpy).not.toHaveBeenCalled();
      } finally {
        execSpy.mockRestore();
      }
    });

    it('refreshes when stale (timestamp > 60s ago)', () => {
      const { writeGitState, readGitState } = loadFresh();
      const stale = {
        branch: 'stale-branch',
        ahead: 0, behind: 0, dirty: false, uncommittedFiles: 0,
        recentCommits: [],
        lastCommitTs: null,
        timestamp: new Date(Date.now() - 120000).toISOString(), // 2 min ago
      };
      writeGitState(stale);
      const result = readGitState({ refresh: true });
      // Should have refreshed — branch comes from live git, not 'stale-branch'
      expect(result.branch).not.toBe('stale-branch');
      expect(result.timestamp).not.toBe(stale.timestamp);
    });

    it('refreshes when file is missing and refresh=true', () => {
      const { readGitState } = loadFresh();
      const stateFile = gitStateFile();
      if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
      const result = readGitState({ refresh: true });
      expect(result).not.toBeNull();
      expect(result).toHaveProperty('branch');
      expect(result).toHaveProperty('timestamp');
    });
  });

  describe('atomic write', () => {
    it('does not leave .tmp file on success', () => {
      const { writeGitState } = loadFresh();
      writeGitState({ branch: 'main', timestamp: new Date().toISOString() });
      const stateFile = gitStateFile();
      expect(fs.existsSync(stateFile + '.tmp')).toBe(false);
      expect(fs.existsSync(stateFile)).toBe(true);
    });
  });

  describe('readGitStatus extended fields', () => {
    it('returns ahead/behind/uncommittedFiles/lastCommitTs', () => {
      const { readGitStatus } = loadFresh();
      const status = readGitStatus();
      expect(status).toHaveProperty('ahead');
      expect(status).toHaveProperty('behind');
      expect(status).toHaveProperty('uncommittedFiles');
      expect(status).toHaveProperty('lastCommitTs');
      expect(typeof status.ahead).toBe('number');
      expect(typeof status.behind).toBe('number');
      expect(status.uncommittedFiles === null || typeof status.uncommittedFiles === 'number').toBe(true);
    });
  });

  // `git status` on a drvfs checkout outlasts the probe budget, and the refresh
  // callers run inside tool-call hooks (hooks.json timeout 5), so the default is
  // not raised here; the env override is the lever. Assert how the value resolves,
  // not what it is.
  describe('probe timeout resolution', () => {
    it('falls back to the default when the override is unset, blank, non-numeric, zero or negative', () => {
      const { resolveGitProbeTimeoutMs, GIT_PROBE_DEFAULT_TIMEOUT_MS } = loadFresh();
      expect(Number.isInteger(GIT_PROBE_DEFAULT_TIMEOUT_MS)).toBe(true);
      expect(GIT_PROBE_DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
      for (const value of [undefined, '', '   ', 'abc', '0', '-5']) {
        const env = value === undefined ? {} : { FORGE_GIT_PROBE_TIMEOUT_MS: value };
        expect(resolveGitProbeTimeoutMs(env)).toBe(GIT_PROBE_DEFAULT_TIMEOUT_MS);
      }
    });

    it('lets FORGE_GIT_PROBE_TIMEOUT_MS win over the default', () => {
      const { resolveGitProbeTimeoutMs, GIT_PROBE_DEFAULT_TIMEOUT_MS } = loadFresh();
      const override = GIT_PROBE_DEFAULT_TIMEOUT_MS + 1234;
      expect(resolveGitProbeTimeoutMs({ FORGE_GIT_PROBE_TIMEOUT_MS: String(override) })).toBe(override);
      expect(resolveGitProbeTimeoutMs({ FORGE_GIT_PROBE_TIMEOUT_MS: '1' })).toBe(1);
    });

    it('resolves the module-level budget from the process env at load time', () => {
      const previous = process.env.FORGE_GIT_PROBE_TIMEOUT_MS;
      try {
        process.env.FORGE_GIT_PROBE_TIMEOUT_MS = '4321';
        expect(loadFresh().GIT_PROBE_TIMEOUT_MS).toBe(4321);
        delete process.env.FORGE_GIT_PROBE_TIMEOUT_MS;
        const unset = loadFresh();
        expect(unset.GIT_PROBE_TIMEOUT_MS).toBe(unset.GIT_PROBE_DEFAULT_TIMEOUT_MS);
      } finally {
        if (previous === undefined) delete process.env.FORGE_GIT_PROBE_TIMEOUT_MS;
        else process.env.FORGE_GIT_PROBE_TIMEOUT_MS = previous;
      }
    });
  });
});

// GATE 1(b), option A: the tool-call hooks start a detached `--refresh` child
// instead of probing git inline. These tests cover the single-flight lock, stale-lock
// recovery, the atomic cache write and the child entry point on a real temp repo.
describe('detached refresh (GATE 1(b))', () => {
  let tmpDir;
  let stateFile;
  let lockPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-order-refresh-'));
    stateFile = path.join(tmpDir, 'os', 'git-state.json');
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    lockPath = path.join(tmpDir, 'os', 'git-state.refresh.lock');
    // Every call below names stateFile; this only guards the live cache if one does not.
    vi.stubEnv(STATE_DIR_ENV, path.dirname(stateFile));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    delete require.cache[MODULE_PATH];
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  // A spawn stand-in: records calls and hands back a child with the given pid.
  function fakeSpawn(pid) {
    const calls = [];
    const fn = (cmd, args, opts) => {
      const child = { pid, unref: vi.fn(), on: vi.fn() };
      calls.push({ cmd, args, opts, child });
      return child;
    };
    fn.calls = calls;
    return fn;
  }

  // A pid that has already exited (reaped by spawnSync).
  function deadPid() {
    return spawnSync(process.execPath, ['-e', '']).pid;
  }

  function readLock() {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  }

  function readState(file = stateFile) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  }

  function git(cwd, args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 10000 }).trim();
  }

  function makeRepo() {
    const root = path.join(tmpDir, 'repo');
    fs.mkdirSync(root, { recursive: true });
    git(root, ['init', '-b', 'main']);
    git(root, ['config', 'user.email', 'test@example.invalid']);
    git(root, ['config', 'user.name', 'Test User']);
    // Temp repos should not inherit workstation signing/PIN state.
    git(root, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(root, 'README.md'), '# test\n', 'utf8');
    git(root, ['add', 'README.md']);
    git(root, ['commit', '-m', 'init']);
    return root;
  }

  async function pollFor(check, timeoutMs = 20000, intervalMs = 50) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const value = check();
      if (value) return value;
      if (Date.now() > end) return null;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  describe('spawnDetachedRefresh: single flight', () => {
    it('spawns at most one child for repeated triggers inside one refresh window', () => {
      const { spawnDetachedRefresh } = loadFresh();
      // The fake child's pid is this test process, so the lock owner stays alive.
      const spawn = fakeSpawn(process.pid);
      const base = Date.now();

      const results = [0, 1, 2, 3, 4].map((i) =>
        spawnDetachedRefresh(tmpDir, { stateFile, spawn, now: base + i * 1000 }));

      expect(spawn.calls).toHaveLength(1);
      expect(results[0]).toEqual({ spawned: true, pid: process.pid });
      for (const r of results.slice(1)) expect(r).toEqual({ spawned: false, reason: 'in-flight' });
      const lock = readLock();
      expect(lock.pid).toBe(process.pid);
      expect(lock.startedAt).toBe(base);
      expect(typeof lock.token).toBe('string');
    });

    it('starts the child detached, with no stdio, and hands it the lock token', () => {
      const { spawnDetachedRefresh, REFRESH_TOKEN_ENV } = loadFresh();
      const spawn = fakeSpawn(process.pid);

      spawnDetachedRefresh(tmpDir, { stateFile, spawn });

      const { cmd, args, opts, child } = spawn.calls[0];
      expect(cmd).toBe(process.execPath);
      expect(args).toEqual([MODULE_PATH, '--refresh', tmpDir, '--state-file', stateFile]);
      expect(opts).toMatchObject({ cwd: tmpDir, detached: true, stdio: 'ignore', windowsHide: true });
      expect(opts.env.CLAUDE_PROJECT_DIR).toBe(tmpDir);
      expect(opts.env[REFRESH_TOKEN_ENV]).toBe(readLock().token);
      expect(child.unref).toHaveBeenCalledTimes(1);
      expect(child.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('lets the next trigger spawn once the running child releases the lock', () => {
      const { spawnDetachedRefresh, releaseRefreshLock } = loadFresh();
      const spawn = fakeSpawn(process.pid);

      expect(spawnDetachedRefresh(tmpDir, { stateFile, spawn }).spawned).toBe(true);
      releaseRefreshLock(lockPath, readLock().token);
      expect(fs.existsSync(lockPath)).toBe(false);
      expect(spawnDetachedRefresh(tmpDir, { stateFile, spawn }).spawned).toBe(true);
      expect(spawn.calls).toHaveLength(2);
    });

    it('releases the lock when the spawn fails', () => {
      const { spawnDetachedRefresh } = loadFresh();
      const noPid = fakeSpawn(undefined);
      const throws = () => { throw new Error('EAGAIN'); };

      expect(spawnDetachedRefresh(tmpDir, { stateFile, spawn: noPid })).toEqual({ spawned: false, reason: 'spawn-failed' });
      expect(fs.existsSync(lockPath)).toBe(false);
      expect(spawnDetachedRefresh(tmpDir, { stateFile, spawn: throws })).toEqual({ spawned: false, reason: 'spawn-failed' });
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('does not re-create a lock the child already released', () => {
      const { spawnDetachedRefresh, REFRESH_TOKEN_ENV } = loadFresh();
      // The child finishes (and releases) before the parent records its pid.
      const spawn = (cmd, args, opts) => {
        if (readLock().token === opts.env[REFRESH_TOKEN_ENV]) fs.unlinkSync(lockPath);
        return { pid: process.pid, unref() {}, on() {} };
      };

      expect(spawnDetachedRefresh(tmpDir, { stateFile, spawn }).spawned).toBe(true);
      expect(fs.existsSync(lockPath)).toBe(false);
    });
  });

  describe('spawnDetachedRefresh: stale-lock recovery', () => {
    it('recovers a lock whose owner pid is dead', () => {
      const { spawnDetachedRefresh } = loadFresh();
      const now = Date.now();
      fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid(), startedAt: now, token: 'dead-owner' }));
      const spawn = fakeSpawn(process.pid);

      expect(spawnDetachedRefresh(tmpDir, { stateFile, spawn, now }).spawned).toBe(true);
      expect(spawn.calls).toHaveLength(1);
      expect(readLock().token).not.toBe('dead-owner');
    });

    it('recovers a lock older than the refresh budget even if its pid is alive', () => {
      const { spawnDetachedRefresh, REFRESH_LOCK_STALE_MS } = loadFresh();
      const now = Date.now();
      fs.writeFileSync(lockPath, JSON.stringify({
        pid: process.pid, startedAt: now - REFRESH_LOCK_STALE_MS - 1, token: 'wedged',
      }));
      const spawn = fakeSpawn(process.pid);

      expect(spawnDetachedRefresh(tmpDir, { stateFile, spawn, now }).spawned).toBe(true);
      expect(readLock().token).not.toBe('wedged');
    });

    it('keeps a young lock held by a live pid', () => {
      const { spawnDetachedRefresh } = loadFresh();
      const now = Date.now();
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: now - 1000, token: 'running' }));
      const spawn = fakeSpawn(process.pid);

      expect(spawnDetachedRefresh(tmpDir, { stateFile, spawn, now })).toEqual({ spawned: false, reason: 'in-flight' });
      expect(spawn.calls).toHaveLength(0);
      expect(readLock().token).toBe('running');
    });

    it('uses the injected liveness check', () => {
      const { spawnDetachedRefresh } = loadFresh();
      const now = Date.now();
      fs.writeFileSync(lockPath, JSON.stringify({ pid: 424242, startedAt: now, token: 'other' }));
      const isPidAlive = vi.fn(() => false);

      expect(spawnDetachedRefresh(tmpDir, { stateFile, spawn: fakeSpawn(process.pid), now, isPidAlive }).spawned).toBe(true);
      expect(isPidAlive).toHaveBeenCalledWith(424242);
    });

    it('treats an unparsable lock as held until it ages out by mtime', () => {
      const { spawnDetachedRefresh, REFRESH_LOCK_STALE_MS } = loadFresh();
      const spawn = fakeSpawn(process.pid);
      fs.writeFileSync(lockPath, '');

      expect(spawnDetachedRefresh(tmpDir, { stateFile, spawn }).spawned).toBe(false);

      const old = (Date.now() - REFRESH_LOCK_STALE_MS - 1000) / 1000;
      fs.utimesSync(lockPath, old, old);
      expect(spawnDetachedRefresh(tmpDir, { stateFile, spawn }).spawned).toBe(true);
      expect(spawn.calls).toHaveLength(1);
    });

    it('isPidAlive: live for this process, dead for an exited or invalid pid', () => {
      const { isPidAlive } = loadFresh();
      expect(isPidAlive(process.pid)).toBe(true);
      expect(isPidAlive(deadPid())).toBe(false);
      expect(isPidAlive(0)).toBe(false);
      expect(isPidAlive(-1)).toBe(false);
      expect(isPidAlive(Number.NaN)).toBe(false);
    });
  });

  describe('writeGitState: atomic replace', () => {
    it('keeps the previous cache readable when a write fails, and leaves no tmp', () => {
      const { writeGitState } = loadFresh();
      expect(writeGitState({ branch: 'main', dirty: false }, stateFile)).toBe(true);

      const circular = {};
      circular.self = circular;
      expect(writeGitState(circular, stateFile)).toBe(false);

      expect(readState()).toEqual({ branch: 'main', dirty: false });
      expect(fs.readdirSync(path.dirname(stateFile)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    });

    it('cleans up the tmp when the rename fails', () => {
      const { writeGitState } = loadFresh();
      // A non-empty directory at the target makes rename fail after the tmp exists.
      const target = path.join(tmpDir, 'os', 'blocked.json');
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'keep'), 'x');

      expect(writeGitState({ branch: 'main' }, target)).toBe(false);
      expect(fs.readdirSync(path.dirname(target)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    });

    it('writes through a pid-suffixed tmp so concurrent writers never share one', () => {
      const { writeGitState } = loadFresh();
      const writes = [];
      const real = fs.writeFileSync;
      vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...rest) => {
        writes.push(String(file));
        return real(file, ...rest);
      });

      expect(writeGitState({ branch: 'main' }, stateFile)).toBe(true);
      expect(writes).toEqual([`${stateFile}.${process.pid}.tmp`]);
    });
  });

  describe('runRefresh and the --refresh entry point', () => {
    it('--refresh writes real dirty and uncommittedFiles for a repo with a modified tracked file', () => {
      const root = makeRepo();
      fs.appendFileSync(path.join(root, 'README.md'), 'changed\n');
      const env = { ...process.env };
      delete env.FORGE_GIT_REFRESH_LOCK_TOKEN;

      const result = spawnSync(process.execPath, [MODULE_PATH, '--refresh', root, '--state-file', stateFile], {
        env, encoding: 'utf8', timeout: 30000,
      });

      expect(result.status).toBe(0);
      const state = readState();
      expect(state).toMatchObject({ branch: 'main', dirty: true, uncommittedFiles: 1 });
      expect(state.recentCommits[0].subject).toBe('init');
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('reports a clean tree as dirty:false with zero files', () => {
      const root = makeRepo();
      const { runRefresh } = loadFresh();

      const result = runRefresh(root, { stateFile });

      expect(result.refreshed).toBe(true);
      expect(readState()).toMatchObject({ branch: 'main', dirty: false, uncommittedFiles: 0 });
    });

    it('stands down without probing while a live refresh holds the lock', () => {
      const root = makeRepo();
      const { runRefresh } = loadFresh();
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now(), token: 'running' }));

      expect(runRefresh(root, { stateFile })).toEqual({ refreshed: false, reason: 'in-flight' });
      expect(fs.existsSync(stateFile)).toBe(false);
      expect(readLock().token).toBe('running');
    });

    it('releases a handed-over lock only while it still carries its token', () => {
      const root = makeRepo();
      const { runRefresh } = loadFresh();

      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now(), token: 'mine' }));
      expect(runRefresh(root, { stateFile, token: 'mine' }).refreshed).toBe(true);
      expect(fs.existsSync(lockPath)).toBe(false);

      // Recovered by another trigger in the meantime: not ours to remove.
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now(), token: 'theirs' }));
      expect(runRefresh(root, { stateFile, token: 'mine' }).refreshed).toBe(true);
      expect(readLock().token).toBe('theirs');
    });

    it('a spent deadline skips the probes and leaves the answer unknown', () => {
      const root = makeRepo();
      const { buildFreshGitState, commandBudgetMs } = loadFresh();
      const now = Date.now();

      expect(commandBudgetMs(15000, null, now)).toBe(15000);
      expect(commandBudgetMs(15000, now + 2000, now)).toBe(2000);
      expect(commandBudgetMs(15000, now - 1, now)).toBeLessThanOrEqual(0);

      const state = buildFreshGitState({ cwd: root, timeoutMs: 15000, deadline: now - 1 });
      expect(state).toMatchObject({ branch: 'unknown', dirty: null, uncommittedFiles: null, recentCommits: [] });
    });

    it('a real detached refresh lands the cache and releases the lock', async () => {
      const root = makeRepo();
      fs.appendFileSync(path.join(root, 'README.md'), 'changed\n');
      const { spawnDetachedRefresh } = loadFresh();

      const started = spawnDetachedRefresh(root, { stateFile });

      expect(started.spawned).toBe(true);
      const state = await pollFor(() => readState());
      expect(state).toMatchObject({ branch: 'main', dirty: true, uncommittedFiles: 1 });
      expect(await pollFor(() => !fs.existsSync(lockPath))).toBe(true);
    });
  });
});
