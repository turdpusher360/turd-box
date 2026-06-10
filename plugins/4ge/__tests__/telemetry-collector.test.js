// plugins/4ge/__tests__/telemetry-collector.test.js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

// Use createRequire so fs and the CJS module share the same singleton.
// vi.mock('fs') does NOT intercept CJS require('fs') — vi.spyOn is required.
const cjsRequire = createRequire(import.meta.url);
const fs = cjsRequire('fs');
const { createSessionEntry, finalizeSession, computeTrends, readSessions,
        readJsonl, aggregateByField, filterByDateRange, topN,
        mergeMultipleJsonl, readToolUsageJsonl } =
  cjsRequire('../lib/telemetry-collector.cjs');

describe('telemetry-collector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a session entry with required fields', () => {
    const entry = createSessionEntry('session-123', '/project');
    expect(entry.session_id).toBe('session-123');
    expect(entry.started_at).toBeDefined();
    expect(entry.tools_used).toEqual({});
    expect(entry.agents_spawned).toEqual([]);
  });

  it('finalizes a session with duration and counts', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'appendFileSync').mockReturnValue(undefined);

    const entry = createSessionEntry('s1', '/p');
    entry.tools_used = { Bash: 5, Read: 10, Edit: 3 };
    entry.agents_spawned = ['impl', 'reviewer'];
    const finalized = finalizeSession(entry);

    expect(finalized.duration_seconds).toBeGreaterThanOrEqual(0);
    expect(finalized.total_tool_calls).toBe(18);
    expect(finalized.agent_count).toBe(2);
  });

  it('computes trends from 10+ sessions', () => {
    const sessions = Array.from({ length: 12 }, (_, i) => ({
      session_id: `s${i}`,
      total_tool_calls: 20 + i,
      duration_seconds: 600 + i * 60,
      agent_count: i % 3,
      tools_used: {},
    }));
    const trends = computeTrends(sessions);
    expect(trends.avg_tool_calls).toBeGreaterThan(0);
    expect(trends.avg_duration_seconds).toBeGreaterThan(0);
    expect(trends.total_sessions).toBe(12);
  });

  it('returns null trends for fewer than 10 sessions', () => {
    const sessions = Array.from({ length: 5 }, (_, i) => ({
      session_id: `s${i}`,
      total_tool_calls: 10,
      duration_seconds: 300,
      agent_count: 1,
      tools_used: {},
    }));
    const trends = computeTrends(sessions);
    expect(trends).toBeNull();
  });

  it('reads sessions from JSONL file', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      '{"session_id":"s1","total_tool_calls":10}\n{"session_id":"s2","total_tool_calls":20}\n'
    );
    const sessions = readSessions('/project');
    expect(sessions).toHaveLength(2);
    expect(sessions[0].session_id).toBe('s1');
  });

  it('returns empty array when no telemetry file exists', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const sessions = readSessions('/project');
    expect(sessions).toEqual([]);
  });

  it('writes finalized session to JSONL', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    const appendSpy = vi.spyOn(fs, 'appendFileSync').mockReturnValue(undefined);

    const entry = createSessionEntry('s1', '/p');
    finalizeSession(entry);

    expect(appendSpy).toHaveBeenCalled();
  });

  // T62 additions: JSONL reader functions
  it('readJsonl parses a JSONL file into objects', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue('{"a":1}\n{"a":2}\n{"a":3}\n');
    const entries = readJsonl('/project/_runs/data.jsonl');
    expect(entries).toHaveLength(3);
    expect(entries[0].a).toBe(1);
  });

  it('readJsonl returns empty array for missing file', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const entries = readJsonl('/project/_runs/missing.jsonl');
    expect(entries).toEqual([]);
  });

  it('readJsonl skips malformed lines silently', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue('{"a":1}\nbad json\n{"a":3}\n');
    const entries = readJsonl('/project/_runs/data.jsonl');
    expect(entries).toHaveLength(2);
  });

  it('aggregateByField groups and sums a value field', () => {
    const entries = [
      { tool: 'Bash', count: 5 },
      { tool: 'Read', count: 3 },
      { tool: 'Bash', count: 7 },
    ];
    const agg = aggregateByField(entries, 'tool', 'count');
    expect(agg['Bash']).toBe(12);
    expect(agg['Read']).toBe(3);
  });

  it('aggregateByField handles missing value field gracefully', () => {
    const entries = [{ tool: 'Bash' }, { tool: 'Read', count: 5 }];
    const agg = aggregateByField(entries, 'tool', 'count');
    expect(agg['Bash']).toBe(0);
    expect(agg['Read']).toBe(5);
  });

  it('filterByDateRange returns entries within start/end (inclusive) using started_at', () => {
    const entries = [
      { started_at: '2026-04-01T10:00:00Z', data: 'a' },
      { started_at: '2026-04-02T10:00:00Z', data: 'b' },
      { started_at: '2026-04-03T10:00:00Z', data: 'c' },
    ];
    const filtered = filterByDateRange(entries, '2026-04-01', '2026-04-02');
    expect(filtered).toHaveLength(2);
    expect(filtered.map(e => e.data)).toEqual(['a', 'b']);
  });

  it('filterByDateRange falls back to ts field for OS accounting entries', () => {
    const entries = [
      { ts: '2026-04-01T10:00:00Z', tool: 'Bash' },
      { ts: '2026-04-05T10:00:00Z', tool: 'Read' },
    ];
    const filtered = filterByDateRange(entries, '2026-04-01', '2026-04-03');
    expect(filtered).toHaveLength(1);
  });

  it('topN returns top N entries by numeric field (descending)', () => {
    const entries = [
      { name: 'a', score: 10 },
      { name: 'b', score: 30 },
      { name: 'c', score: 20 },
    ];
    const top = topN(entries, 'score', 2);
    expect(top).toHaveLength(2);
    expect(top[0].name).toBe('b');
    expect(top[1].name).toBe('c');
  });

  it('mergeMultipleJsonl combines entries from multiple files', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync')
      .mockReturnValueOnce('{"a":1}\n')
      .mockReturnValueOnce('{"a":2}\n');
    const merged = mergeMultipleJsonl(['/f1.jsonl', '/f2.jsonl']);
    expect(merged).toHaveLength(2);
  });

  it('mergeMultipleJsonl returns empty array for empty path list', () => {
    const merged = mergeMultipleJsonl([]);
    expect(merged).toEqual([]);
  });

  it('readToolUsageJsonl reads OS accounting JSONL from project root', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue('{"tool":"Bash","count":5}\n');
    const entries = readToolUsageJsonl('/project');
    expect(entries).toHaveLength(1);
    expect(entries[0].tool).toBe('Bash');
  });
});
