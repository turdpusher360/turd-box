import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);

// Load module once — it reads files relative to projectRoot at call time
const { scanOs } = require('../wizard-scan-os.cjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Write a JSON file to a path, creating directories as needed.
 */
function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Returns paths for the 3 OS state files under a given projectRoot.
 */
function osPaths(projectRoot) {
  const runsDir = path.join(projectRoot, '_runs', 'os');
  return {
    boot: path.join(runsDir, 'boot-status.json'),
    health: path.join(runsDir, 'health.json'),
    git: path.join(runsDir, 'git-state.json'),
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeBootStatus(overrides = {}) {
  return {
    total_boot_ms: 3303,
    capabilities: [
      { name: 'memory', status: 'ready' },
      { name: 'git', status: 'ready' },
      { name: 'forge', status: 'ready' },
      { name: 'audit', status: 'ready' },
      { name: 'blueprint', status: 'ready' },
      { name: 'autoresearch', status: 'ready' },
      { name: 'hitchhiker', status: 'ready' },
      { name: 'infra', status: 'ready' },
      { name: 'llm', status: 'ready' },
    ],
    ...overrides,
  };
}

function makeHealth(overrides = {}) {
  return {
    aisle: { ok: true, state: 'operational' },
    autoresearch: { ok: true, harness: 'present' },
    git: { ok: true, version: 'git version 2.52.0' },
    ...overrides,
  };
}

function makeGitState(overrides = {}) {
  return {
    branch: 'main',
    ahead: 0,
    behind: 0,
    dirty: false,
    uncommittedFiles: 0,
    recentCommits: [],
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-scan-os-test-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('wizard-scan-os', () => {

  describe('all files present, healthy', () => {
    it('parses 9 ready caps, allOk, clean git', () => {
      const p = osPaths(tmpDir);
      writeJson(p.boot, makeBootStatus());
      writeJson(p.health, makeHealth());
      writeJson(p.git, makeGitState());

      const result = scanOs(tmpDir);

      expect(result.boot.capsReady).toBe(9);
      expect(result.boot.capsDegraded).toBe(0);
      expect(result.boot.bootMs).toBe(3303);
      expect(result.boot.degradedList).toEqual([]);
      expect(result.health.allOk).toBe(true);
      expect(result.health.failedCaps).toEqual([]);
      expect(result.git.branch).toBe('main');
      expect(result.git.dirty).toBe(false);
      expect(result.git.uncommitted).toBe(0);
      expect(result.git.ahead).toBe(0);
      expect(result.git.behind).toBe(0);
    });
  });

  describe('degraded capabilities', () => {
    it('reports 2 degraded caps and their names', () => {
      const bootData = {
        total_boot_ms: 4500,
        capabilities: [
          { name: 'memory', status: 'ready' },
          { name: 'git', status: 'degraded' },
          { name: 'forge', status: 'ready' },
          { name: 'audit', status: 'degraded' },
          { name: 'blueprint', status: 'ready' },
          { name: 'autoresearch', status: 'ready' },
          { name: 'hitchhiker', status: 'ready' },
          { name: 'infra', status: 'ready' },
          { name: 'llm', status: 'ready' },
        ],
      };
      const p = osPaths(tmpDir);
      writeJson(p.boot, bootData);
      writeJson(p.health, makeHealth());
      writeJson(p.git, makeGitState());

      const result = scanOs(tmpDir);

      expect(result.boot.capsReady).toBe(7);
      expect(result.boot.capsDegraded).toBe(2);
      expect(result.boot.degradedList).toContain('git');
      expect(result.boot.degradedList).toContain('audit');
      expect(result.boot.bootMs).toBe(4500);
    });
  });

  describe('health failures', () => {
    it('populates failedCaps when a capability has ok:false', () => {
      const p = osPaths(tmpDir);
      writeJson(p.boot, makeBootStatus());
      writeJson(p.health, makeHealth({ aisle: { ok: false, state: 'error' } }));
      writeJson(p.git, makeGitState());

      const result = scanOs(tmpDir);

      expect(result.health.allOk).toBe(false);
      expect(result.health.failedCaps).toContain('aisle');
    });
  });

  describe('missing boot-status', () => {
    it('returns zero cap counts when boot-status.json is absent', () => {
      const p = osPaths(tmpDir);
      // Only write health and git
      writeJson(p.health, makeHealth());
      writeJson(p.git, makeGitState());

      const result = scanOs(tmpDir);

      expect(result.boot.capsReady).toBe(0);
      expect(result.boot.capsDegraded).toBe(0);
      expect(result.boot.bootMs).toBe(0);
      expect(result.boot.degradedList).toEqual([]);
    });
  });

  describe('missing health.json', () => {
    it('returns allOk:true when health.json is absent', () => {
      const p = osPaths(tmpDir);
      writeJson(p.boot, makeBootStatus());
      // Skip health
      writeJson(p.git, makeGitState());

      const result = scanOs(tmpDir);

      expect(result.health.allOk).toBe(true);
      expect(result.health.failedCaps).toEqual([]);
    });
  });

  describe('missing git-state', () => {
    it('returns defaults (main, not dirty) when git-state.json is absent', () => {
      const p = osPaths(tmpDir);
      writeJson(p.boot, makeBootStatus());
      writeJson(p.health, makeHealth());
      // Skip git-state

      const result = scanOs(tmpDir);

      expect(result.git.branch).toBe('main');
      expect(result.git.dirty).toBe(false);
      expect(result.git.uncommitted).toBe(0);
      expect(result.git.ahead).toBe(0);
      expect(result.git.behind).toBe(0);
    });
  });

  describe('all files missing', () => {
    it('returns all defaults without crashing', () => {
      // Write nothing — tmpDir has no _runs/os/ subdirectory
      const result = scanOs(tmpDir);

      expect(result.boot).toEqual({ capsReady: 0, capsDegraded: 0, bootMs: 0, degradedList: [] });
      expect(result.health).toEqual({ allOk: true, failedCaps: [] });
      expect(result.git.branch).toBe('main');
      expect(result.git.dirty).toBe(false);
      expect(result.git.uncommitted).toBe(0);
    });
  });

  describe('dirty git state', () => {
    it('extracts uncommitted:4 and dirty:true', () => {
      const p = osPaths(tmpDir);
      writeJson(p.boot, makeBootStatus());
      writeJson(p.health, makeHealth());
      writeJson(p.git, makeGitState({ dirty: true, uncommittedFiles: 4, branch: 'feat/wizard-session-2' }));

      const result = scanOs(tmpDir);

      expect(result.git.dirty).toBe(true);
      expect(result.git.uncommitted).toBe(4);
      expect(result.git.branch).toBe('feat/wizard-session-2');
    });
  });

  describe('git ahead/behind', () => {
    it('extracts ahead and behind counts', () => {
      const p = osPaths(tmpDir);
      writeJson(p.boot, makeBootStatus());
      writeJson(p.health, makeHealth());
      writeJson(p.git, makeGitState({ ahead: 3, behind: 1 }));

      const result = scanOs(tmpDir);

      expect(result.git.ahead).toBe(3);
      expect(result.git.behind).toBe(1);
    });
  });

  describe('corrupt JSON files', () => {
    it('returns defaults when all files contain invalid JSON', () => {
      const runsDir = path.join(tmpDir, '_runs', 'os');
      fs.mkdirSync(runsDir, { recursive: true });
      fs.writeFileSync(path.join(runsDir, 'boot-status.json'), '{bad json', 'utf-8');
      fs.writeFileSync(path.join(runsDir, 'health.json'), '{bad json', 'utf-8');
      fs.writeFileSync(path.join(runsDir, 'git-state.json'), '{bad json', 'utf-8');

      const result = scanOs(tmpDir);

      expect(result.boot.capsReady).toBe(0);
      expect(result.health.allOk).toBe(true);
      expect(result.git.branch).toBe('main');
    });
  });

  describe('capabilities as object map', () => {
    it('handles capabilities as {name: {status}} object instead of array', () => {
      const bootData = {
        total_boot_ms: 2000,
        capabilities: {
          memory: { status: 'ready' },
          git: { status: 'ready' },
          forge: { status: 'degraded' },
        },
      };
      const p = osPaths(tmpDir);
      writeJson(p.boot, bootData);
      writeJson(p.health, makeHealth());
      writeJson(p.git, makeGitState());

      const result = scanOs(tmpDir);

      expect(result.boot.capsReady).toBe(2);
      expect(result.boot.capsDegraded).toBe(1);
      expect(result.boot.degradedList).toContain('forge');
    });
  });
});
