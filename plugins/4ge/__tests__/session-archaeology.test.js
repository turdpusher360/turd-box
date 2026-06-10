import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fs = require('fs');

const { indexSessions, searchByDate, searchByTopic, formatSessionList } = require('../lib/session-archaeology.cjs');

describe('session-archaeology', () => {
  const sessions = [
    { id: 's1', date: '2026-04-01', topic: 'auth-refactor', branch: 'feat/auth', files: 12 },
    { id: 's2', date: '2026-04-01', topic: 'docker-health', branch: 'fix/docker', files: 5 },
    { id: 's3', date: '2026-03-31', topic: 'memory-hub', branch: 'feat/memory', files: 8 },
  ];

  beforeEach(() => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    vi.spyOn(fs, 'readFileSync').mockReturnValue('{}');
    vi.spyOn(fs, 'readdirSync').mockReturnValue([]);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('indexes forge-state files from plugin data dir', () => {
    fs.readdirSync.mockReturnValue(['forge-state-s1.json', 'forge-state-s2.json']);
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValueOnce(JSON.stringify({ session_id: 's1', topic: 'auth', started: '2026-04-01' }))
      .mockReturnValueOnce(JSON.stringify({ session_id: 's2', topic: 'docker', started: '2026-04-01' }));
    const indexed = indexSessions('/fake/data');
    expect(indexed).toHaveLength(2);
  });

  it('searches by date', () => {
    const results = searchByDate(sessions, '2026-04-01');
    expect(results).toHaveLength(2);
    expect(results.every(s => s.date === '2026-04-01')).toBe(true);
  });

  it('searches by topic (substring match)', () => {
    const results = searchByTopic(sessions, 'auth');
    expect(results).toHaveLength(1);
    expect(results[0].topic).toBe('auth-refactor');
  });

  it('returns empty for non-matching search', () => {
    const results = searchByTopic(sessions, 'nonexistent');
    expect(results).toEqual([]);
  });

  it('formats session list as readable text', () => {
    const text = formatSessionList(sessions);
    expect(text).toContain('auth-refactor');
    expect(text).toContain('2026-04-01');
  });

  it('handles empty session list', () => {
    const text = formatSessionList([]);
    expect(text).toContain('No sessions found');
  });
});
