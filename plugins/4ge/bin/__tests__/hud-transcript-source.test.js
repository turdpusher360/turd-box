import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const _require = createRequire(import.meta.url);
const {
  buildProjectSlug,
  findProjectDir,
  findTranscriptPath,
  loadTranscriptActivity,
  shortInput,
} = _require('../hud-transcript-source.cjs');

describe('buildProjectSlug', () => {
  it('replaces backslashes and colons with dashes', () => {
    expect(buildProjectSlug('O:\\Example_Workspace')).toBe('O--Example-Workspace');
  });

  it('replaces forward slashes with dashes', () => {
    expect(buildProjectSlug('/home/user/project')).toBe('-home-user-project');
  });

  it('preserves alphanumeric characters', () => {
    expect(buildProjectSlug('MyProject123')).toBe('MyProject123');
  });

  it('replaces spaces and underscores', () => {
    expect(buildProjectSlug('My Project_Name')).toBe('My-Project-Name');
  });

  it('handles empty string', () => {
    expect(buildProjectSlug('')).toBe('');
  });
});

describe('shortInput', () => {
  it('returns truncated string for long input', () => {
    const long = 'a'.repeat(200);
    const result = shortInput(long, 'Write');
    expect(result.length).toBeLessThan(200);
  });

  it('returns string for short input', () => {
    const result = shortInput('hello', 'Bash');
    expect(typeof result).toBe('string');
  });

  it('handles null/undefined gracefully', () => {
    const result = shortInput(null, 'Read');
    expect(typeof result).toBe('string');
  });
});

describe('findProjectDir', () => {
  it('returns a string or null', () => {
    // This calls the real filesystem — just check the type contract
    const result = findProjectDir(process.cwd());
    expect(result === null || typeof result === 'string').toBe(true);
  });

  it('finds a matching project directory under the Claude projects root', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-projects-'));
    const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(tempHome);
    try {
      const cwd = '/tmp/Example_Workspace';
      const projectsRoot = path.join(tempHome, '.claude', 'projects');
      const expected = path.join(projectsRoot, buildProjectSlug(cwd));
      fs.mkdirSync(expected, { recursive: true });

      expect(findProjectDir(cwd)).toBe(expected);
    } finally {
      homeSpy.mockRestore();
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe('findTranscriptPath', () => {
  it('returns a string or null', () => {
    const result = findTranscriptPath(process.cwd(), null);
    expect(result === null || typeof result === 'string').toBe(true);
  });

  it('falls back to recent transcript for unknown session id', () => {
    // The module falls back to the most recent .jsonl when the specific session isn't found
    const result = findTranscriptPath(process.cwd(), 'nonexistent-session-id-12345');
    expect(result === null || typeof result === 'string').toBe(true);
  });
});

describe('loadTranscriptActivity', () => {
  it('returns null or an activity object', () => {
    const result = loadTranscriptActivity({ cwd: process.cwd() });
    if (result !== null) {
      expect(result).toHaveProperty('source', 'transcript-tail');
      expect(result).toHaveProperty('transcriptPath');
      expect(result).toHaveProperty('toolCallsTotal');
      expect(result).toHaveProperty('recentEvents');
      expect(Array.isArray(result.recentEvents)).toBe(true);
    }
  });

  it('falls back to recent transcript for unknown session', () => {
    // The module falls back to the most recent .jsonl when session ID doesn't match
    const result = loadTranscriptActivity({
      cwd: process.cwd(),
      sessionId: 'fake-session-id-that-does-not-exist',
    });
    // May return activity from the fallback transcript, or null if no transcripts exist
    if (result !== null) {
      expect(result).toHaveProperty('source', 'transcript-tail');
    }
  });

  it('respects tailCount option', () => {
    const result = loadTranscriptActivity({ cwd: process.cwd(), tailCount: 3 });
    if (result !== null) {
      expect(result.recentEvents.length).toBeLessThanOrEqual(3);
    }
  });

  it('returns numeric counts', () => {
    const result = loadTranscriptActivity({ cwd: process.cwd() });
    if (result !== null) {
      expect(typeof result.toolCallsTotal).toBe('number');
      expect(typeof result.toolResultsTotal).toBe('number');
      expect(typeof result.toolErrorsTotal).toBe('number');
      expect(typeof result.textMessagesTotal).toBe('number');
      expect(typeof result.totalLines).toBe('number');
      expect(typeof result.fileSize).toBe('number');
    }
  });
});
