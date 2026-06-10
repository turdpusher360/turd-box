import { describe, it, expect, vi } from 'vitest';

const fs = require('fs');
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return { ...actual, existsSync: vi.fn(() => false), readFileSync: vi.fn(() => ''), appendFileSync: vi.fn(), mkdirSync: vi.fn() };
});

const { extractWins, formatSessionSummary, formatAllTimeReport } = require('../lib/checkpoint-buddy.cjs');

describe('checkpoint-buddy', () => {
  it('extracts wins from git diff stat', () => {
    const diffStat = '15 files changed, 420 insertions(+), 32 deletions(-)';
    const wins = extractWins(diffStat);
    expect(wins.files_changed).toBe(15);
    expect(wins.insertions).toBe(420);
    expect(wins.deletions).toBe(32);
  });

  it('handles empty diff stat', () => {
    const wins = extractWins('');
    expect(wins.files_changed).toBe(0);
    expect(wins.insertions).toBe(0);
    expect(wins.deletions).toBe(0);
  });

  it('formats a session summary', () => {
    const summary = formatSessionSummary({
      session_id: 's1',
      files_changed: 5,
      insertions: 100,
      deletions: 20,
      agents_used: ['impl', 'reviewer'],
    });
    expect(summary).toContain('5 files');
    expect(summary).toContain('100');
  });

  it('formats all-time report from multiple sessions', () => {
    const sessions = [
      { files_changed: 5, insertions: 100, deletions: 20 },
      { files_changed: 10, insertions: 300, deletions: 50 },
    ];
    const report = formatAllTimeReport(sessions);
    expect(report).toContain('15 files');
    expect(report).toContain('400 insertions');
    expect(report).toContain('2 sessions');
  });

  it('handles empty session history', () => {
    const report = formatAllTimeReport([]);
    expect(report).toContain('No sessions recorded');
  });
});
