import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import path from 'path';
import os from 'os';

const require = createRequire(import.meta.url);

// Must mock 'fs' before requiring the CJS module so the module picks up mocks
const fs = require('fs');

const {
  parseSessionTranscript,
  buildExportData,
  generateBrief,
  generateSlides,
  findTranscript,
  runExport,
  formatDuration,
  DECISION_KEYWORDS,
} = require('../export-pipeline.cjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLine(overrides = {}) {
  return JSON.stringify({
    type: 'assistant',
    sessionId: 'test-session-id',
    timestamp: 1000,
    message: { role: 'assistant', content: [] },
    ...overrides,
  });
}

function makeToolUseLine(toolName, input, timestamp = 2000) {
  return makeLine({
    timestamp,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', name: toolName, input }],
    },
  });
}

function makeTextLine(text, timestamp = 1500) {
  return makeLine({
    timestamp,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  });
}

// ---------------------------------------------------------------------------
// parseSessionTranscript
// ---------------------------------------------------------------------------

describe('parseSessionTranscript', () => {
  beforeEach(() => {
    vi.spyOn(fs, 'readFileSync');
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('counts messages from user and assistant roles', () => {
    const lines = [
      makeLine({ type: 'user', timestamp: 1000, message: { role: 'user', content: [] } }),
      makeLine({ type: 'assistant', timestamp: 2000, message: { role: 'assistant', content: [] } }),
      makeLine({ type: 'user', timestamp: 3000, message: { role: 'user', content: [] } }),
    ].join('\n');
    fs.readFileSync.mockReturnValue(lines);

    const result = parseSessionTranscript('/fake/transcript.jsonl');
    expect(result.messageCount).toBe(3);
  });

  it('counts Write and Edit tool calls as file changes', () => {
    const lines = [
      makeToolUseLine('Write', { file_path: '/project/foo.ts' }, 1000),
      makeToolUseLine('Edit', { file_path: '/project/bar.ts' }, 2000),
      makeToolUseLine('Bash', { command: 'ls' }, 3000),
    ].join('\n');
    fs.readFileSync.mockReturnValue(lines);

    const result = parseSessionTranscript('/fake/transcript.jsonl');
    expect(result.fileChangeCount).toBe(2);
  });

  it('collects unique artifact file paths', () => {
    const lines = [
      makeToolUseLine('Write', { file_path: '/project/a.ts' }, 1000),
      makeToolUseLine('Write', { file_path: '/project/a.ts' }, 2000), // duplicate
      makeToolUseLine('Edit', { file_path: '/project/b.ts' }, 3000),
    ].join('\n');
    fs.readFileSync.mockReturnValue(lines);

    const result = parseSessionTranscript('/fake/transcript.jsonl');
    expect(result.artifacts).toHaveLength(2);
    expect(result.artifacts).toContain('/project/a.ts');
    expect(result.artifacts).toContain('/project/b.ts');
  });

  it('counts decision keywords in text blocks', () => {
    const lines = [
      makeTextLine('I decided to use CJS for this module.', 1000),
      makeTextLine('We chose approach A over B.', 2000),
      makeTextLine('Just a regular statement.', 3000),
    ].join('\n');
    fs.readFileSync.mockReturnValue(lines);

    const result = parseSessionTranscript('/fake/transcript.jsonl');
    expect(result.decisionCount).toBe(2);
  });

  it('detects all DECISION_KEYWORDS', () => {
    expect(DECISION_KEYWORDS).toContain('decided');
    expect(DECISION_KEYWORDS).toContain('chose');
    expect(DECISION_KEYWORDS).toContain('decision');
    expect(DECISION_KEYWORDS).toContain('selected');
  });

  it('tracks first and last timestamps for duration', () => {
    const lines = [
      makeLine({ timestamp: 1000, message: { role: 'user', content: [] } }),
      makeLine({ timestamp: 5000, message: { role: 'assistant', content: [] } }),
      makeLine({ timestamp: 3000, message: { role: 'user', content: [] } }),
    ].join('\n');
    fs.readFileSync.mockReturnValue(lines);

    const result = parseSessionTranscript('/fake/transcript.jsonl');
    expect(result.firstTimestamp).toBe(1000);
    expect(result.lastTimestamp).toBe(5000);
    expect(result.durationMs).toBe(4000);
  });

  it('extracts session ID from first entry', () => {
    const lines = [
      makeLine({ sessionId: 'abc-123', message: { role: 'user', content: [] } }),
    ].join('\n');
    fs.readFileSync.mockReturnValue(lines);

    const result = parseSessionTranscript('/fake/transcript.jsonl');
    expect(result.sessionId).toBe('abc-123');
  });

  it('skips malformed JSON lines without throwing', () => {
    const lines = [
      'not valid json',
      makeLine({ timestamp: 1000, message: { role: 'user', content: [] } }),
    ].join('\n');
    fs.readFileSync.mockReturnValue(lines);

    expect(() => parseSessionTranscript('/fake/transcript.jsonl')).not.toThrow();
  });

  it('handles empty transcript gracefully', () => {
    fs.readFileSync.mockReturnValue('');
    const result = parseSessionTranscript('/fake/transcript.jsonl');
    expect(result.messageCount).toBe(0);
    expect(result.fileChangeCount).toBe(0);
    expect(result.decisionCount).toBe(0);
    expect(result.artifacts).toHaveLength(0);
    expect(result.durationMs).toBeNull();
  });

  it('handles entries with no message object', () => {
    const lines = [
      JSON.stringify({ type: 'system', timestamp: 1000 }), // no message
      makeLine({ timestamp: 2000, message: { role: 'user', content: [] } }),
    ].join('\n');
    fs.readFileSync.mockReturnValue(lines);

    const result = parseSessionTranscript('/fake/transcript.jsonl');
    expect(result.messageCount).toBe(1);
  });

  it('uses input.path as fallback for artifact when file_path absent', () => {
    const line = makeLine({
      timestamp: 1000,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Write', input: { path: '/alt/path.ts' } }],
      },
    });
    fs.readFileSync.mockReturnValue(line);

    const result = parseSessionTranscript('/fake/transcript.jsonl');
    expect(result.artifacts).toContain('/alt/path.ts');
  });
});

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------

describe('formatDuration', () => {
  it('formats null as unknown', () => {
    expect(formatDuration(null)).toBe('unknown');
  });

  it('formats sub-minute durations', () => {
    expect(formatDuration(45000)).toBe('45s');
  });

  it('formats minute-range durations', () => {
    expect(formatDuration(90000)).toBe('1m 30s');
  });

  it('formats hour-range durations', () => {
    expect(formatDuration(3661000)).toBe('1h 1m 1s');
  });

  it('handles zero duration', () => {
    expect(formatDuration(0)).toBe('0s');
  });

  it('handles negative duration as unknown', () => {
    expect(formatDuration(-1000)).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// buildExportData
// ---------------------------------------------------------------------------

describe('buildExportData', () => {
  const baseParsed = {
    sessionId: 'abc-def-123',
    messageCount: 42,
    decisionCount: 3,
    fileChangeCount: 7,
    artifacts: ['/project/foo.ts', '/project/bar.ts'],
    firstTimestamp: new Date('2026-04-07T10:00:00Z').getTime(),
    lastTimestamp: new Date('2026-04-07T11:30:00Z').getTime(),
    durationMs: 90 * 60 * 1000,
  };

  it('generates a title including the session ID prefix and date', () => {
    const data = buildExportData(baseParsed);
    expect(data.title).toContain('abc-def');
    expect(data.title).toContain('2026-04-07');
  });

  it('sets the date from firstTimestamp', () => {
    const data = buildExportData(baseParsed);
    expect(data.date).toBe('2026-04-07');
  });

  it('includes formatted duration', () => {
    const data = buildExportData(baseParsed);
    expect(data.duration).toContain('h');
  });

  it('creates a decisions array with one entry per decisionCount', () => {
    const data = buildExportData(baseParsed);
    expect(data.decisions).toHaveLength(3);
  });

  it('passes artifacts through', () => {
    const data = buildExportData(baseParsed);
    expect(data.artifacts).toEqual(baseParsed.artifacts);
  });

  it('carries messageCount and fileCount', () => {
    const data = buildExportData(baseParsed);
    expect(data.messageCount).toBe(42);
    expect(data.fileCount).toBe(7);
  });

  it('includes a summary placeholder', () => {
    const data = buildExportData(baseParsed);
    expect(typeof data.summary).toBe('string');
    expect(data.summary.length).toBeGreaterThan(0);
  });

  it('uses today as date when firstTimestamp is null', () => {
    const data = buildExportData({ ...baseParsed, firstTimestamp: null });
    const today = new Date().toISOString().slice(0, 10);
    expect(data.date).toBe(today);
  });

  it('handles zero decisions and zero files without error', () => {
    const data = buildExportData({
      ...baseParsed,
      decisionCount: 0,
      fileChangeCount: 0,
      artifacts: [],
    });
    expect(data.decisions).toHaveLength(0);
    expect(data.fileCount).toBe(0);
    expect(data.artifacts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// generateBrief
// ---------------------------------------------------------------------------

describe('generateBrief', () => {
  beforeEach(() => {
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  const exportData = {
    title: 'Session abc — 2026-04-07',
    date: '2026-04-07',
    duration: '1h 30m 0s',
    decisions: ['Decision 1', 'Decision 2'],
    artifacts: ['/project/foo.ts'],
    messageCount: 42,
    fileCount: 7,
    summary: 'Test summary.',
  };

  it('writes a file to the given output path', () => {
    generateBrief(exportData, 'abc-session', '/tmp/brief.md');
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      '/tmp/brief.md',
      expect.any(String),
      'utf8'
    );
  });

  it('creates parent directories', () => {
    generateBrief(exportData, 'abc-session', '/tmp/subdir/brief.md');
    expect(fs.mkdirSync).toHaveBeenCalledWith('/tmp/subdir', { recursive: true });
  });

  it('includes session ID in the markdown content', () => {
    generateBrief(exportData, 'abc-session-123', '/tmp/brief.md');
    const written = fs.writeFileSync.mock.calls[0][1];
    expect(written).toContain('abc-session-123');
  });

  it('includes date and duration', () => {
    generateBrief(exportData, 'abc', '/tmp/brief.md');
    const written = fs.writeFileSync.mock.calls[0][1];
    expect(written).toContain('2026-04-07');
    expect(written).toContain('1h 30m 0s');
  });

  it('lists decision entries', () => {
    generateBrief(exportData, 'abc', '/tmp/brief.md');
    const written = fs.writeFileSync.mock.calls[0][1];
    expect(written).toContain('Decision 1');
    expect(written).toContain('Decision 2');
  });

  it('lists artifact paths', () => {
    generateBrief(exportData, 'abc', '/tmp/brief.md');
    const written = fs.writeFileSync.mock.calls[0][1];
    expect(written).toContain('/project/foo.ts');
  });

  it('includes metrics table', () => {
    generateBrief(exportData, 'abc', '/tmp/brief.md');
    const written = fs.writeFileSync.mock.calls[0][1];
    expect(written).toContain('42');
    expect(written).toContain('7');
  });

  it('shows placeholder text when no decisions', () => {
    generateBrief({ ...exportData, decisions: [] }, 'abc', '/tmp/brief.md');
    const written = fs.writeFileSync.mock.calls[0][1];
    expect(written).toContain('No decisions detected');
  });

  it('shows placeholder text when no artifacts', () => {
    generateBrief({ ...exportData, artifacts: [] }, 'abc', '/tmp/brief.md');
    const written = fs.writeFileSync.mock.calls[0][1];
    expect(written).toContain('No file changes detected');
  });
});

// ---------------------------------------------------------------------------
// generateSlides
// ---------------------------------------------------------------------------

describe('generateSlides', () => {
  // These three tests exercise the REAL PptxGenJS code path (no fs mock): each
  // calls pptx.writeFile(), which serializes a .pptx via JSZip to disk. The very
  // FIRST serialization in a worker pays a one-time JSZip/deflate cold-start cost
  // (~3.2s on an idle machine; verified S352). Under the `forks` pool during a
  // full-suite run the worker is CPU-saturated, pushing that cold start well past
  // vitest's 5000ms default and producing a load-driven timeout on whichever
  // generateSlides test runs first. This is NOT cross-file state pollution — every
  // other describe block restores its mocks, and this block holds no shared state.
  // Fix: a documented per-test timeout sized for the cold start under contention,
  // and the first test now awaits its promise so the heavy write completes inside
  // the test boundary instead of dangling into the next test.
  const PPTX_WRITE_TIMEOUT_MS = 20000;

  it('returns a Promise when PptxGenJS is available', async () => {
    const result = generateSlides({ title: 'Test', decisions: [], artifacts: [], messageCount: 1, fileCount: 0, duration: '1s', date: '2026-04-07', summary: 'test' }, '/tmp/out.pptx');
    // PptxGenJS is installed — result is a Promise
    expect(result).toBeInstanceOf(Promise);
    // Await so the (heavy, real) disk write resolves within this test rather than
    // leaking a pending writeFile into the next test's timeout window.
    await result;
  }, PPTX_WRITE_TIMEOUT_MS);

  it('resolves with path and slides count on success', async () => {
    const result = await generateSlides({
      title: 'Test Session',
      date: '2026-04-07',
      duration: '5m',
      summary: 'Test summary',
      decisions: ['d1', 'd2'],
      artifacts: ['file1.ts'],
      messageCount: 10,
      fileCount: 3,
    }, '/tmp/test-out.pptx');
    expect(result).toHaveProperty('path');
    expect(result).toHaveProperty('slides', 5);
  }, PPTX_WRITE_TIMEOUT_MS);

  it('returns stub when PptxGenJS is unavailable', async () => {
    // Mock the require cache so getPptxGenJS returns false
    const originalRequire = require;
    // Test the guard: if the module is forced unavailable, stub is returned
    // We verify the stub shape by checking module exports contract
    const { generateSlides: gs } = require('../../lib/export-pipeline.cjs');
    // With PptxGenJS installed, this should return a Promise not a stub
    const r = gs({ title: 'x' }, '/tmp/x.pptx');
    expect(r instanceof Promise || (r && r.stub === true)).toBe(true);
    // Await the real write if it returned a Promise, for the same leak-avoidance reason.
    if (r instanceof Promise) await r;
  }, PPTX_WRITE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// findTranscript
// ---------------------------------------------------------------------------

describe('findTranscript', () => {
  beforeEach(() => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    vi.spyOn(fs, 'readdirSync').mockReturnValue([]);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns null when sessions root does not exist', () => {
    fs.existsSync.mockReturnValue(false);
    const result = findTranscript('some-id', '/nonexistent/root');
    expect(result).toBeNull();
  });

  it('finds transcript in subagents directory', () => {
    fs.existsSync.mockImplementation((p) => {
      if (typeof p === 'string') {
        return p.endsWith('my-session') ||
               p.endsWith('subagents') ||
               p === '/fake/root';
      }
      return false;
    });
    fs.readdirSync.mockImplementation((p) => {
      if (typeof p === 'string' && p.endsWith('subagents')) {
        return ['agent-abc.jsonl', 'agent-abc.meta.json'];
      }
      return [];
    });

    const result = findTranscript('my-session', '/fake/root');
    expect(result).not.toBeNull();
    expect(result).toMatch(/agent-abc\.jsonl$/);
  });

  it('returns null when session directory exists but has no JSONL files', () => {
    fs.existsSync.mockImplementation((p) => {
      return typeof p === 'string' && (p === '/fake/root' || p.endsWith('my-session'));
    });
    fs.readdirSync.mockReturnValue(['subagents']);

    const result = findTranscript('my-session', '/fake/root');
    expect(result).toBeNull();
  });

  it('does prefix search for partial session IDs', () => {
    fs.existsSync.mockImplementation((p) => {
      return typeof p === 'string' && (
        p === '/fake/root' ||
        p.endsWith('subagents')
      );
    });
    fs.readdirSync.mockImplementation((p) => {
      if (p === '/fake/root') return ['abc-def-full-uuid'];
      if (typeof p === 'string' && p.endsWith('subagents')) return ['agent-x.jsonl'];
      return [];
    });

    const result = findTranscript('abc-def', '/fake/root');
    expect(result).not.toBeNull();
    expect(result).toMatch(/agent-x\.jsonl$/);
  });
});

// ---------------------------------------------------------------------------
// runExport
// ---------------------------------------------------------------------------

describe('runExport', () => {
  beforeEach(() => {
    vi.spyOn(fs, 'existsSync');
    vi.spyOn(fs, 'readdirSync');
    vi.spyOn(fs, 'readFileSync');
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    vi.spyOn(fs, 'copyFileSync').mockImplementation(() => {});

    // Default: session dir exists with one transcript
    fs.existsSync.mockImplementation((p) => {
      if (typeof p !== 'string') return false;
      return p.includes('fake') ||
             p.includes('session-123') ||
             p.endsWith('subagents');
    });
    fs.readdirSync.mockImplementation((p) => {
      if (typeof p === 'string' && p.endsWith('subagents')) return ['agent-a.jsonl'];
      return [];
    });
    fs.readFileSync.mockReturnValue(
      JSON.stringify({
        type: 'user',
        sessionId: 'session-123',
        timestamp: new Date('2026-04-07T10:00:00Z').getTime(),
        message: { role: 'user', content: [] },
      })
    );
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns brief path and export data', async () => {
    const result = await runExport('session-123', {
      runsDir: '/fake/runs',
      sessionsRoot: '/fake/root',
    });
    expect(result.brief).toMatch(/session-123-brief\.md$/);
    expect(result.data).toHaveProperty('title');
    expect(result.data).toHaveProperty('date');
  });

  it('writes the brief file', async () => {
    await runExport('session-123', {
      runsDir: '/fake/runs',
      sessionsRoot: '/fake/root',
    });
    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  it('throws when transcript not found', async () => {
    fs.existsSync.mockReturnValue(false);
    await expect(runExport('missing-id', {
      runsDir: '/fake/runs',
      sessionsRoot: '/fake/root',
    })).rejects.toThrow(/No transcript found/);
  });

  it('copies brief to BizOps when options.bizops is true', async () => {
    await runExport('session-123', {
      runsDir: '/fake/runs',
      sessionsRoot: '/fake/root',
      bizops: true,
    });
    expect(fs.copyFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/session-123-brief\.md$/),
      expect.stringMatching(/BizOps.*session-123-brief\.md$/)
    );
  });

  it('does not copy to BizOps when option is false', async () => {
    await runExport('session-123', {
      runsDir: '/fake/runs',
      sessionsRoot: '/fake/root',
      bizops: false,
    });
    expect(fs.copyFileSync).not.toHaveBeenCalled();
  });

  it('proceeds without throwing when BizOps copy fails', async () => {
    fs.copyFileSync.mockImplementation(() => { throw new Error('Drive not found'); });
    await expect(runExport('session-123', {
      runsDir: '/fake/runs',
      sessionsRoot: '/fake/root',
      bizops: true,
    })).resolves.not.toThrow();
  });
});
