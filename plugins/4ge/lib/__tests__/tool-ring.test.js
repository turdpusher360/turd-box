import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const { appendTool, readRing, clearRing, normalizeEntry, RING_FILENAME } = require('../tool-ring.cjs');

let stateDir;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-ring-'));
});

afterEach(() => {
  try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('normalizeEntry', () => {
  it('returns null for empty input', () => {
    expect(normalizeEntry(null)).toBeNull();
    expect(normalizeEntry({})).toBeNull();
  });

  it('extracts tool_name from hook input shape', () => {
    const e = normalizeEntry({ tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect(e.tool).toBe('Bash');
    expect(e.command).toBe('ls');
    expect(typeof e.ts).toBe('number');
  });

  it('extracts file_path and replace_all', () => {
    const e = normalizeEntry({
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/x.js', replace_all: true },
    });
    expect(e.filePath).toBe('/tmp/x.js');
    expect(e.replaceAll).toBe(true);
  });

  it('truncates long bash commands', () => {
    const longCmd = 'a'.repeat(500);
    const e = normalizeEntry({ tool_name: 'Bash', tool_input: { command: longCmd } });
    expect(e.command.length).toBeLessThanOrEqual(200);
  });

  it('preserves isError flag from hook input (DFE P0 / sonnet-execute P0)', () => {
    const e = normalizeEntry({
      tool_name: 'Bash',
      tool_input: { command: 'tsc' },
      isError: true,
    });
    expect(e.isError).toBe(true);
  });

  it('does not set isError when input.isError is false or missing', () => {
    const e1 = normalizeEntry({ tool_name: 'Read', tool_input: { file_path: 'a' } });
    expect(e1.isError).toBeUndefined();
    const e2 = normalizeEntry({ tool_name: 'Read', tool_input: { file_path: 'a' }, isError: false });
    expect(e2.isError).toBeUndefined();
  });

  it('captures tool_response preview (string)', () => {
    const e = normalizeEntry({
      tool_name: 'Bash',
      tool_input: { command: 'vitest' },
      tool_response: 'FAIL src/foo.test.js\n  Expected true but got false',
    });
    expect(e.output).toContain('FAIL');
  });

  it('extracts text from object tool_response (stdout/stderr, not JSON)', () => {
    const e = normalizeEntry({
      tool_name: 'Bash',
      tool_input: { command: 'x' },
      tool_response: { stdout: 'ok', stderr: '' },
    });
    // coerceToolOutput extracts the non-empty stdout/stderr text — 'ok' — rather
    // than JSON-stringifying the whole object (cleaner for substring matching).
    expect(e.output).toBe('ok');
  });

  it('caps tool_response preview at 400 chars', () => {
    const e = normalizeEntry({
      tool_name: 'Bash',
      tool_input: { command: 'x' },
      tool_response: 'a'.repeat(5000),
    });
    expect(e.output.length).toBeLessThanOrEqual(400);
  });
});

describe('appendTool + readRing', () => {
  it('reads empty array when ring does not exist', () => {
    expect(readRing(stateDir)).toEqual([]);
  });

  it('appends entries in order', () => {
    appendTool({ tool_name: 'Read', tool_input: { file_path: 'a' } }, { stateDir });
    appendTool({ tool_name: 'Edit', tool_input: { file_path: 'a' } }, { stateDir });
    const ring = readRing(stateDir);
    expect(ring).toHaveLength(2);
    expect(ring[0].tool).toBe('Read');
    expect(ring[1].tool).toBe('Edit');
  });

  it('rotates when over capacity', () => {
    for (let i = 0; i < 10; i++) {
      appendTool({ tool_name: 'Read', tool_input: { file_path: `f${i}` } }, { stateDir, capacity: 5 });
    }
    const ring = readRing(stateDir);
    expect(ring).toHaveLength(5);
    expect(ring[0].filePath).toBe('f5'); // oldest kept
    expect(ring[4].filePath).toBe('f9'); // newest
  });

  it('is fail-safe on bad state dir', () => {
    expect(() => appendTool({ tool_name: 'Read' }, { stateDir: '/dev/null/nope' })).not.toThrow();
  });

  it('silently ignores null tool input', () => {
    appendTool(null, { stateDir });
    appendTool({}, { stateDir });
    expect(readRing(stateDir)).toEqual([]);
  });
});

describe('clearRing', () => {
  it('removes the ring file', () => {
    appendTool({ tool_name: 'Read', tool_input: { file_path: 'a' } }, { stateDir });
    expect(readRing(stateDir).length).toBeGreaterThan(0);
    clearRing(stateDir);
    expect(readRing(stateDir)).toEqual([]);
  });

  it('no-op when file does not exist', () => {
    expect(() => clearRing(stateDir)).not.toThrow();
  });
});

// ── New tests for JSONL format ─────────────────────────────────────────────

describe('JSONL storage format', () => {
  it('writes newline-delimited JSON on disk', () => {
    appendTool({ tool_name: 'Read', tool_input: { file_path: 'a.js' } }, { stateDir });
    appendTool({ tool_name: 'Edit', tool_input: { file_path: 'b.js' } }, { stateDir });

    const raw = fs.readFileSync(path.join(stateDir, RING_FILENAME), 'utf8');
    const lines = raw.split('\n').filter(l => l.trim());

    // Every non-empty line must be valid JSON with a `tool` field
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const obj = JSON.parse(line);
      expect(obj).toHaveProperty('tool');
      expect(obj).toHaveProperty('ts');
    }
  });

  it('tolerates a malformed line in the file without dropping valid entries', () => {
    const p = path.join(stateDir, RING_FILENAME);
    // Pre-seed the file with one valid line, one corrupt line, one valid line
    fs.writeFileSync(
      p,
      '{"tool":"Read","ts":1}\nNOT_JSON_AT_ALL\n{"tool":"Edit","ts":2}\n',
      'utf8',
    );

    const ring = readRing(stateDir);
    expect(ring).toHaveLength(2);
    expect(ring[0].tool).toBe('Read');
    expect(ring[1].tool).toBe('Edit');
  });

  it('trim-on-overflow rewrites file to capacity when appends exceed capacity', () => {
    const capacity = 5;
    const total = capacity + 3; // 8 entries — enough to trigger trim

    for (let i = 0; i < total; i++) {
      appendTool(
        { tool_name: 'Read', tool_input: { file_path: `f${i}` } },
        { stateDir, capacity },
      );
    }

    // File must now contain exactly `capacity` non-empty lines
    const raw = fs.readFileSync(path.join(stateDir, RING_FILENAME), 'utf8');
    const lineCount = raw.split('\n').filter(l => l.trim()).length;
    expect(lineCount).toBe(capacity);

    // readRing returns the correct last `capacity` entries
    const ring = readRing(stateDir, capacity);
    expect(ring).toHaveLength(capacity);
    expect(ring[ring.length - 1].filePath).toBe(`f${total - 1}`); // newest
  });

  it('readRing returns correct shape after JSONL conversion', () => {
    appendTool(
      { tool_name: 'Bash', tool_input: { command: 'echo hello' } },
      { stateDir },
    );
    appendTool(
      { tool_name: 'Edit', tool_input: { file_path: '/x.ts', replace_all: true } },
      { stateDir },
    );

    const ring = readRing(stateDir);
    expect(ring).toHaveLength(2);

    const [bash, edit] = ring;
    expect(bash.tool).toBe('Bash');
    expect(bash.command).toBe('echo hello');
    expect(typeof bash.ts).toBe('number');

    expect(edit.tool).toBe('Edit');
    expect(edit.filePath).toBe('/x.ts');
    expect(edit.replaceAll).toBe(true);
    expect(typeof edit.ts).toBe('number');
  });
});
