import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);
const { renderGitStatusZone, ZONE_META, gitStatusVisible, timeAgo } = _require('../hud-zone-git-status.cjs');
const { resolvePalette, stripAnsi } = _require('../hud-palette.cjs');

const palette = resolvePalette({ name: 'plain' });

describe('ZONE_META', () => {
  it('has priority 2', () => {
    expect(ZONE_META.priority).toBe(2);
  });

  it('has key "gitStatus"', () => {
    expect(ZONE_META.key).toBe('gitStatus');
  });

  it('has minRows 1 and idealRows 2', () => {
    expect(ZONE_META.minRows).toBe(1);
    expect(ZONE_META.idealRows).toBe(2);
  });
});

describe('gitStatusVisible', () => {
  it('returns false when git is null', () => {
    expect(gitStatusVisible({ git: null })).toBe(false);
  });

  it('returns false when git is missing', () => {
    expect(gitStatusVisible({})).toBe(false);
  });

  it('returns false when branch is empty', () => {
    expect(gitStatusVisible({ git: { branch: '' } })).toBe(false);
  });

  it('returns true when branch is set', () => {
    expect(gitStatusVisible({ git: { branch: 'main' } })).toBe(true);
  });

  it('returns false for non-object git', () => {
    expect(gitStatusVisible({ git: 'invalid' })).toBe(false);
  });
});

describe('timeAgo', () => {
  it('returns empty string for null', () => {
    expect(timeAgo(null)).toBe('');
  });

  it('returns empty string for invalid date', () => {
    expect(timeAgo('not-a-date')).toBe('');
  });

  it('returns "just now" for recent timestamps', () => {
    const now = new Date().toISOString();
    expect(timeAgo(now)).toBe('just now');
  });

  it('returns minutes for timestamps a few minutes ago', () => {
    const fiveMinsAgo = new Date(Date.now() - 300000).toISOString();
    const result = timeAgo(fiveMinsAgo);
    expect(result).toMatch(/^\d+m ago$/);
  });

  it('returns hours for timestamps hours ago', () => {
    const twoHoursAgo = new Date(Date.now() - 7200000).toISOString();
    const result = timeAgo(twoHoursAgo);
    expect(result).toMatch(/^\d+h ago$/);
  });

  it('returns days for timestamps days ago', () => {
    const twoDaysAgo = new Date(Date.now() - 172800000).toISOString();
    const result = timeAgo(twoDaysAgo);
    expect(result).toMatch(/^\d+d ago$/);
  });
});

describe('renderGitStatusZone', () => {
  const baseState = {
    terminal: { cols: 79, rows: 24 },
    git: {
      branch: 'main',
      ahead: 4,
      behind: 0,
      dirty: true,
      uncommittedFiles: 18,
      recentCommits: [
        { sha: '45a4cf6', subject: 'fix(hooks): session ID anti-pattern', ts: new Date(Date.now() - 600000).toISOString() },
        { sha: '3b36a48', subject: 'fix(hud): 3 bugs + guard-git-scope', ts: new Date(Date.now() - 1200000).toISOString() },
      ],
      lastCommitTs: new Date(Date.now() - 600000).toISOString(),
    },
  };

  it('returns an array of strings', () => {
    const lines = renderGitStatusZone(baseState, palette);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(typeof line).toBe('string');
    }
  });

  it('includes branch name', () => {
    const lines = renderGitStatusZone(baseState, palette);
    const plain = lines.map(l => stripAnsi(l)).join(' ');
    expect(plain).toContain('main');
  });

  it('includes git label', () => {
    const lines = renderGitStatusZone(baseState, palette);
    const plain = lines.map(l => stripAnsi(l)).join(' ');
    expect(plain).toContain('git');
  });

  it('shows ahead count with up arrow', () => {
    const lines = renderGitStatusZone(baseState, palette);
    const plain = lines.map(l => stripAnsi(l)).join(' ');
    expect(plain).toContain('\u21914');
  });

  it('shows dirty file count', () => {
    const lines = renderGitStatusZone(baseState, palette);
    const plain = lines.map(l => stripAnsi(l)).join(' ');
    expect(plain).toContain('18 dirty');
  });

  it('shows clean when not dirty', () => {
    const cleanState = {
      ...baseState,
      git: { ...baseState.git, dirty: false, uncommittedFiles: 0 },
    };
    const lines = renderGitStatusZone(cleanState, palette);
    const plain = lines.map(l => stripAnsi(l)).join(' ');
    expect(plain).toContain('clean');
  });

  it('shows behind count with down arrow', () => {
    const behindState = {
      ...baseState,
      git: { ...baseState.git, behind: 3 },
    };
    const lines = renderGitStatusZone(behindState, palette);
    const plain = lines.map(l => stripAnsi(l)).join(' ');
    expect(plain).toContain('\u21933');
  });

  it('shows recent commit subject on second line', () => {
    const lines = renderGitStatusZone(baseState, palette);
    expect(lines.length).toBe(2);
    const plain = stripAnsi(lines[1]);
    expect(plain).toContain('session ID anti-pattern');
  });

  it('handles missing git data gracefully', () => {
    const state = { terminal: { cols: 79, rows: 24 }, git: { branch: 'main' } };
    const lines = renderGitStatusZone(state, palette);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const plain = stripAnsi(lines[0]);
    expect(plain).toContain('main');
    // Missing dirty data must not be rendered as a clean tree.
    expect(plain).toContain('dirty unknown');
  });

  it('renders only 1 line when no commits and no lastCommitTs', () => {
    const state = {
      terminal: { cols: 79, rows: 24 },
      git: { branch: 'feature/test', ahead: 0, behind: 0, dirty: false, uncommittedFiles: 0 },
    };
    const lines = renderGitStatusZone(state, palette);
    expect(lines.length).toBe(1);
  });

  it('truncates long commit subjects', () => {
    const state = {
      terminal: { cols: 40, rows: 24 },
      git: {
        branch: 'main',
        recentCommits: [{ sha: 'abc', subject: 'a very very very very very very very very long commit message here', ts: new Date().toISOString() }],
        lastCommitTs: new Date().toISOString(),
      },
    };
    const lines = renderGitStatusZone(state, palette);
    if (lines.length > 1) {
      const plain = stripAnsi(lines[1]);
      expect(plain).toContain('\u2026');
    }
  });
});
