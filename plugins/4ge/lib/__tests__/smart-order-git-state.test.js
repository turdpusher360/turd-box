import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
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
});
