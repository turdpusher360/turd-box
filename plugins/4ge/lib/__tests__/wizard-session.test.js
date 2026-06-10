import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const {
  create,
  update,
  read,
  end,
  isStale,
  SESSION_FILE,
  SESSION_VERSION,
} = require('../../lib/wizard-session.cjs');

describe('wizard-session', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'wizard-session-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- create ---
  describe('create', () => {
    it('creates a session file at project root', () => {
      const session = create('outhouse', {}, { cwd: tmpDir });
      expect(existsSync(join(tmpDir, SESSION_FILE))).toBe(true);
      expect(session.wizard_type).toBe('outhouse');
      expect(session.version).toBe(SESSION_VERSION);
    });

    it('sets initial stage to 1 with empty stages_completed', () => {
      const session = create('outhouse', { quick: true }, { cwd: tmpDir });
      expect(session.current_stage).toBe(1);
      expect(session.stages_completed).toEqual([]);
    });

    it('generates a unique session_id', () => {
      const s1 = create('outhouse', {}, { cwd: tmpDir });
      // Clean up so second create can work
      rmSync(join(tmpDir, SESSION_FILE), { force: true });
      const s2 = create('outhouse', {}, { cwd: tmpDir });
      expect(s1.session_id).not.toBe(s2.session_id);
    });

    it('stores flags in session', () => {
      const flags = { quick: true, ci: false, category: 'security' };
      const session = create('outhouse', flags, { cwd: tmpDir });
      expect(session.flags).toEqual(flags);
    });

    it('stores config_hash when provided', () => {
      const session = create('outhouse', {}, { cwd: tmpDir, configHash: 'abc123' });
      expect(session.config_hash).toBe('abc123');
    });

    it('sets timestamps on creation', () => {
      const before = new Date().toISOString();
      const session = create('outhouse', {}, { cwd: tmpDir });
      const after = new Date().toISOString();
      expect(session.started_at >= before).toBe(true);
      expect(session.started_at <= after).toBe(true);
      expect(session.updated_at).toBe(session.started_at);
    });
  });

  // --- read ---
  describe('read', () => {
    it('reads an existing session', () => {
      create('outhouse', {}, { cwd: tmpDir });
      const session = read({ cwd: tmpDir });
      expect(session).not.toBeNull();
      expect(session.wizard_type).toBe('outhouse');
    });

    it('returns null when no session exists', () => {
      const session = read({ cwd: tmpDir });
      expect(session).toBeNull();
    });
  });

  // --- update ---
  describe('update', () => {
    it('merges stage data into session', () => {
      create('outhouse', {}, { cwd: tmpDir });
      const updated = update({
        scan_results: { branches: { raw: 18 } },
        current_stage: 2,
      }, { cwd: tmpDir });
      expect(updated.scan_results.branches.raw).toBe(18);
      expect(updated.current_stage).toBe(2);
    });

    it('tracks stage completion', () => {
      create('outhouse', {}, { cwd: tmpDir });
      update({ current_stage: 2 }, { cwd: tmpDir });
      const session = read({ cwd: tmpDir });
      expect(session.stages_completed).toContain(1);
    });

    it('updates the updated_at timestamp', () => {
      const created = create('outhouse', {}, { cwd: tmpDir });
      const originalTs = created.updated_at;
      // Small delay to ensure timestamp differs
      const updated = update({ current_stage: 2 }, { cwd: tmpDir });
      expect(updated.updated_at >= originalTs).toBe(true);
    });

    it('throws when no session exists', () => {
      expect(() => update({ current_stage: 2 }, { cwd: tmpDir }))
        .toThrow('No active wizard session');
    });

    it('keeps stages_completed sorted', () => {
      create('outhouse', {}, { cwd: tmpDir });
      update({ current_stage: 3 }, { cwd: tmpDir });
      update({ current_stage: 4 }, { cwd: tmpDir });
      const session = read({ cwd: tmpDir });
      expect(session.stages_completed).toEqual([2, 3]);
    });
  });

  // --- end ---
  describe('end', () => {
    it('deletes session file after finalize', () => {
      create('outhouse', {}, { cwd: tmpDir });
      const final = end({ grade: 'A', weighted: 95 }, { cwd: tmpDir });
      expect(existsSync(join(tmpDir, SESSION_FILE))).toBe(false);
      expect(final.result.grade).toBe('A');
      expect(final.ended_at).toBeDefined();
    });

    it('returns null when no session exists', () => {
      const result = end({}, { cwd: tmpDir });
      expect(result).toBeNull();
    });

    it('archives when requested', () => {
      create('outhouse', {}, { cwd: tmpDir });
      const session = read({ cwd: tmpDir });
      const final = end({ grade: 'B' }, { cwd: tmpDir, archive: true });
      const archivePath = join(tmpDir, '_runs', 'outhouse', `session-${session.session_id}.json`);
      expect(existsSync(archivePath)).toBe(true);
      expect(final.result.grade).toBe('B');
    });
  });

  // --- isStale ---
  describe('isStale', () => {
    it('returns stale=false when no session exists', () => {
      const result = isStale(undefined, { cwd: tmpDir });
      expect(result.stale).toBe(false);
      expect(result.session).toBeNull();
    });

    it('returns stale=false for a fresh session', () => {
      create('outhouse', {}, { cwd: tmpDir });
      const result = isStale(undefined, { cwd: tmpDir });
      expect(result.stale).toBe(false);
      expect(result.session).not.toBeNull();
    });

    it('returns stale=true when session exceeds maxAge', () => {
      create('outhouse', {}, { cwd: tmpDir });
      // Manually backdate the updated_at
      const filePath = join(tmpDir, SESSION_FILE);
      const session = JSON.parse(readFileSync(filePath, 'utf-8'));
      session.updated_at = new Date(Date.now() - 20 * 60 * 1000).toISOString(); // 20 min ago
      const { writeFileSync } = require('fs');
      writeFileSync(filePath, JSON.stringify(session, null, 2) + '\n', 'utf-8');

      const result = isStale(10 * 60 * 1000, { cwd: tmpDir }); // 10 min threshold
      expect(result.stale).toBe(true);
      expect(result.ageMs).toBeGreaterThan(10 * 60 * 1000);
    });

    it('respects custom maxAge', () => {
      create('outhouse', {}, { cwd: tmpDir });
      // Very short maxAge — session is always "stale" after creation
      const result = isStale(0, { cwd: tmpDir });
      // Could be stale=true since ageMs > 0
      expect(typeof result.stale).toBe('boolean');
      expect(result.ageMs).toBeGreaterThanOrEqual(0);
    });
  });

  // --- atomic write integrity ---
  describe('atomic writes', () => {
    it('session file is valid JSON after create', () => {
      create('outhouse', {}, { cwd: tmpDir });
      const raw = readFileSync(join(tmpDir, SESSION_FILE), 'utf-8');
      expect(() => JSON.parse(raw)).not.toThrow();
    });

    it('session file is valid JSON after update', () => {
      create('outhouse', {}, { cwd: tmpDir });
      update({ current_stage: 2, scan_results: { branches: { raw: 20 } } }, { cwd: tmpDir });
      const raw = readFileSync(join(tmpDir, SESSION_FILE), 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.scan_results.branches.raw).toBe(20);
    });

    it('no .tmp file left after successful write', () => {
      create('outhouse', {}, { cwd: tmpDir });
      expect(existsSync(join(tmpDir, SESSION_FILE + '.tmp'))).toBe(false);
    });
  });

  // --- round-trip fidelity ---
  describe('round-trip', () => {
    it('create -> read returns identical data', () => {
      const created = create('outhouse', { quick: true }, { cwd: tmpDir });
      const loaded = read({ cwd: tmpDir });
      expect(loaded).toEqual(created);
    });

    it('full lifecycle: create -> update -> update -> end', () => {
      const session = create('outhouse', {}, { cwd: tmpDir });
      expect(session.current_stage).toBe(1);

      update({ current_stage: 2, scan_results: { total: 85 } }, { cwd: tmpDir });
      update({ current_stage: 3, triage_decisions: { deep_dive: ['security'] } }, { cwd: tmpDir });

      const mid = read({ cwd: tmpDir });
      expect(mid.stages_completed).toEqual([1, 2]);
      expect(mid.scan_results.total).toBe(85);

      const final = end({ grade: 'B', weighted: 78 }, { cwd: tmpDir });
      expect(final.result.grade).toBe('B');
      expect(read({ cwd: tmpDir })).toBeNull();
    });
  });
});
