import { describe, it, expect } from 'vitest';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function withTempDir(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archaeology-'));
  try {
    fn(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function freshModule() {
  const modPath = require.resolve('../session-archaeology.cjs');
  delete require.cache[modPath];
  return require(modPath);
}

function writeSession(dir, filename, data) {
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(data));
}

describe('session-archaeology', () => {
  describe('indexSessions', () => {
    it('includes state field from file data', () => {
      withTempDir((dir) => {
        writeSession(dir, 'forge-state-abc.json', {
          session_id: 'abc',
          started: '2026-04-12T10:00:00Z',
          topic: 'test',
          state: 'staged',
        });
        const mod = freshModule();
        const sessions = mod.indexSessions(dir);
        expect(sessions).toHaveLength(1);
        expect(sessions[0].state).toBe('staged');
      });
    });

    it('defaults missing state to parked', () => {
      withTempDir((dir) => {
        writeSession(dir, 'forge-state-old.json', {
          session_id: 'old',
          started: '2026-01-01T00:00:00Z',
          topic: 'legacy',
        });
        const mod = freshModule();
        const sessions = mod.indexSessions(dir);
        expect(sessions).toHaveLength(1);
        expect(sessions[0].state).toBe('parked');
      });
    });

    it('returns empty array for non-existent directory', () => {
      const mod = freshModule();
      expect(mod.indexSessions('/nonexistent/path')).toEqual([]);
    });

    it('returns empty array for directory with no forge-state files', () => {
      withTempDir((dir) => {
        fs.writeFileSync(path.join(dir, 'other.json'), '{}');
        const mod = freshModule();
        expect(mod.indexSessions(dir)).toEqual([]);
      });
    });
  });

  describe('filterByState', () => {
    const sessions = [
      { id: '1', state: 'staged' },
      { id: '2', state: 'parked' },
      { id: '3', state: 'shipped' },
      { id: '4', state: 'staged' },
    ];

    it('returns only sessions with matching state', () => {
      const mod = freshModule();
      const result = mod.filterByState(sessions, 'staged');
      expect(result).toHaveLength(2);
      expect(result.every(s => s.state === 'staged')).toBe(true);
    });

    it('returns all sessions when state is null', () => {
      const mod = freshModule();
      expect(mod.filterByState(sessions, null)).toHaveLength(4);
    });

    it('returns all sessions when state is undefined', () => {
      const mod = freshModule();
      expect(mod.filterByState(sessions, undefined)).toHaveLength(4);
    });

    it('returns empty when no sessions match', () => {
      const mod = freshModule();
      expect(mod.filterByState(sessions, 'executing')).toHaveLength(0);
    });
  });

  describe('formatSessionList', () => {
    it('includes State column header', () => {
      const mod = freshModule();
      const output = mod.formatSessionList([
        { date: '2026-04-12', topic: 'test', branch: 'main', state: 'staged', files: 3 },
      ]);
      expect(output).toContain('| State |');
      expect(output).toContain('| staged |');
    });

    it('returns no-sessions message for empty array', () => {
      const mod = freshModule();
      expect(mod.formatSessionList([])).toBe('No sessions found.');
    });
  });
});
