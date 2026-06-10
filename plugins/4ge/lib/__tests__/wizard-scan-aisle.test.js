import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);

// Load module once — it resolves stateDir at call time via opts.stateDir or os.homedir()
const { scanAisle } = require('../wizard-scan-aisle.cjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a stateDir layout with scanner-cache/ populated.
 * @param {string} base - tmpDir root
 * @param {Record<string, object | null>} scanners - map of id -> JSON content (null = skip file)
 * @returns {string} stateDir path
 */
function buildStateDir(base, scanners = {}) {
  const stateDir = path.join(base, 'aisle');
  const cacheDir = path.join(stateDir, 'scanner-cache');
  fs.mkdirSync(cacheDir, { recursive: true });

  for (const [id, content] of Object.entries(scanners)) {
    if (content !== null) {
      fs.writeFileSync(path.join(cacheDir, `${id}.json`), JSON.stringify(content), 'utf-8');
    }
  }

  return stateDir;
}

/** Canary schema fixture (healthy) */
function canary(id, pass = true) {
  return { scannerId: id, canaryPass: pass, timestamp: Date.now() - 5000 };
}

/** Full schema fixture */
function fullSchema(findings = []) {
  return { findings, duration: 100, cachedState: {} };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-scan-aisle-test-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('wizard-scan-aisle', () => {

  describe('missing state dir', () => {
    it('returns healthy:false and empty scanners when stateDir does not exist', () => {
      const result = scanAisle({ stateDir: path.join(tmpDir, 'nonexistent') });
      expect(result.healthy).toBe(false);
      expect(result.scanners).toEqual([]);
      expect(result.findings.security).toEqual({});
    });
  });

  describe('all canary pass', () => {
    it('returns healthy:true with 9 scanners and zero findings when all pass', () => {
      const scanners = {};
      const ids = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];
      for (const id of ids) {
        scanners[id] = canary(id, true);
      }
      const stateDir = buildStateDir(tmpDir, scanners);

      const result = scanAisle({ stateDir });

      expect(result.healthy).toBe(true);
      expect(result.scanners).toHaveLength(9);
      expect(result.scanners.every(s => s.canaryPass)).toBe(true);
      expect(result.scanners.every(s => s.findingCount === 0)).toBe(true);
      expect(result.findings.security.pin_mismatch).toBe(0);
      expect(result.findings.security.gitignore_gap).toBe(0);
    });
  });

  describe('one canary fail', () => {
    it('returns healthy:false and pin_mismatch:1 when scanner D fails', () => {
      const scanners = {
        A: canary('A', true),
        B: canary('B', true),
        C: canary('C', true),
        D: canary('D', false),  // fails
        E: canary('E', true),
        F: canary('F', true),
        G: canary('G', true),
        H: canary('H', true),
        I: canary('I', true),
      };
      const stateDir = buildStateDir(tmpDir, scanners);

      const result = scanAisle({ stateDir });

      expect(result.healthy).toBe(false);
      const scannerD = result.scanners.find(s => s.id === 'D');
      expect(scannerD.canaryPass).toBe(false);
      expect(result.findings.security.pin_mismatch).toBe(1);
      expect(result.findings.security.gitignore_gap).toBe(0);
    });
  });

  describe('full schema with findings', () => {
    it('returns gitignore_gap count when scanner E has 2 findings', () => {
      const scanners = {
        A: canary('A', true),
        B: canary('B', true),
        C: canary('C', true),
        D: canary('D', true),
        E: fullSchema([{ type: 'gap', path: 'foo' }, { type: 'gap', path: 'bar' }]),
        F: canary('F', true),
        G: canary('G', true),
        H: canary('H', true),
        I: canary('I', true),
      };
      const stateDir = buildStateDir(tmpDir, scanners);

      const result = scanAisle({ stateDir });

      expect(result.healthy).toBe(false);  // E has findings -> canaryPass false
      const scannerE = result.scanners.find(s => s.id === 'E');
      expect(scannerE.findingCount).toBe(2);
      expect(result.findings.security.gitignore_gap).toBe(2);
      expect(result.findings.security.pin_mismatch).toBe(0);
    });
  });

  describe('mixed schemas', () => {
    it('sums findings across mixed canary and full-schema scanners', () => {
      const scanners = {
        // canary schemas (A-D all pass)
        A: canary('A', true),
        B: canary('B', true),
        C: canary('C', true),
        D: canary('D', false),  // canary fail -> pin_mismatch
        // full schemas
        E: fullSchema([{ t: 'x' }]),          // 1 finding -> gitignore_gap
        F: fullSchema([{ t: 'y' }, { t: 'z' }]), // 2 findings -> gitignore_gap
        G: canary('G', true),
        H: fullSchema([]),  // 0 findings -> ok
        I: canary('I', true),
      };
      const stateDir = buildStateDir(tmpDir, scanners);

      const result = scanAisle({ stateDir });

      expect(result.healthy).toBe(false);
      expect(result.findings.security.pin_mismatch).toBe(1);   // D failed
      expect(result.findings.security.gitignore_gap).toBe(3);  // E(1) + F(2)
      expect(result.scanners).toHaveLength(9);
    });
  });

  describe('missing scanner file', () => {
    it('returns 8 scanners when A.json is absent (no error)', () => {
      const scanners = {
        // A intentionally omitted
        B: canary('B', true),
        C: canary('C', true),
        D: canary('D', true),
        E: canary('E', true),
        F: canary('F', true),
        G: canary('G', true),
        H: canary('H', true),
        I: canary('I', true),
      };
      const stateDir = buildStateDir(tmpDir, scanners);

      const result = scanAisle({ stateDir });

      expect(result.scanners).toHaveLength(8);
      expect(result.scanners.find(s => s.id === 'A')).toBeUndefined();
      // 8 scanners all pass => still healthy
      expect(result.healthy).toBe(true);
    });
  });

  describe('corrupt JSON', () => {
    it('skips a malformed scanner file gracefully', () => {
      const scanners = {
        A: canary('A', true),
        B: canary('B', true),
        C: canary('C', true),
        D: canary('D', true),
        E: canary('E', true),
        F: canary('F', true),
        G: canary('G', true),
        H: canary('H', true),
        I: canary('I', true),
      };
      const stateDir = buildStateDir(tmpDir, scanners);

      // Overwrite E.json with garbage
      fs.writeFileSync(
        path.join(stateDir, 'scanner-cache', 'E.json'),
        '{not valid json!!!',
        'utf-8'
      );

      const result = scanAisle({ stateDir });

      // E skipped; 8 scanners remain
      expect(result.scanners).toHaveLength(8);
      expect(result.scanners.find(s => s.id === 'E')).toBeUndefined();
    });
  });

  describe('empty findings array', () => {
    it('full schema with findings:[] counts as 0 and healthy', () => {
      const scanners = {
        A: canary('A', true),
        B: canary('B', true),
        C: canary('C', true),
        D: canary('D', true),
        E: fullSchema([]),  // empty findings
        F: canary('F', true),
        G: canary('G', true),
        H: canary('H', true),
        I: canary('I', true),
      };
      const stateDir = buildStateDir(tmpDir, scanners);

      const result = scanAisle({ stateDir });

      const scannerE = result.scanners.find(s => s.id === 'E');
      expect(scannerE.findingCount).toBe(0);
      expect(scannerE.canaryPass).toBe(true);
      expect(result.healthy).toBe(true);
      expect(result.findings.security.gitignore_gap).toBe(0);
    });
  });

  describe('stateDir override', () => {
    it('uses the custom stateDir provided via opts instead of computed path', () => {
      // Build a valid state dir in a subdirectory
      const customDir = path.join(tmpDir, 'custom-aisle');
      fs.mkdirSync(path.join(customDir, 'scanner-cache'), { recursive: true });
      fs.writeFileSync(
        path.join(customDir, 'scanner-cache', 'A.json'),
        JSON.stringify(canary('A', true)),
        'utf-8'
      );

      // The default stateDir (derived from homedir) would be different
      const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(path.join(tmpDir, 'fake-home'));

      const result = scanAisle({ stateDir: customDir });

      // Confirm homedir was not used (the spy is set but opts.stateDir takes priority)
      expect(result.scanners).toHaveLength(1);
      expect(result.scanners[0].id).toBe('A');
      homeSpy.mockRestore();
    });
  });

  describe('scanner status fields', () => {
    it('each scanner status has id, canaryPass, ageMs, findingCount', () => {
      const stateDir = buildStateDir(tmpDir, { A: canary('A', true) });

      const result = scanAisle({ stateDir });

      expect(result.scanners).toHaveLength(1);
      const s = result.scanners[0];
      expect(s).toHaveProperty('id', 'A');
      expect(s).toHaveProperty('canaryPass', true);
      expect(typeof s.ageMs).toBe('number');
      expect(s.ageMs).toBeGreaterThanOrEqual(0);
      expect(s).toHaveProperty('findingCount', 0);
    });
  });
});
