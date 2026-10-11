// Statusline `⊥` tool count, per session (operator report 2026-09-28): counted
// from the session's own transcript, cached incrementally by session id and
// byte offset. Synthetic fixtures only.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);
const {
  countSessionToolUses,
  countToolUsesInBuffer,
  tallyToolUsesInBuffer,
  toolUseLines,
  isScratchPath,
  cacheFilePath,
} = _require('../hud-tool-count.cjs');

const SID = 'aaaaaaaa-1111-4222-8333-000000000001';

function toolUseLine(id, extra = {}) {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    sessionId: SID,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'true' } }] },
    ...extra,
  }) + '\n';
}

function toolResultLine(id, text) {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
  }) + '\n';
}

let root;
let stateDir;
let transcript;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-tool-count-'));
  stateDir = path.join(root, '_runs', 'os');
  fs.mkdirSync(stateDir, { recursive: true });
  transcript = path.join(root, `${SID}.jsonl`);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function count(opts = {}) {
  return countSessionToolUses({ transcriptPath: transcript, sessionId: SID, stateDir, ...opts });
}

describe('countToolUsesInBuffer', () => {
  it('counts only top-level, non-sidechain assistant tool_use blocks', () => {
    const lines = [
      toolUseLine('t1'),
      // two blocks in one record
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'text', text: 'x' },
        { type: 'tool_use', id: 't2', name: 'Read', input: {} },
        { type: 'tool_use', id: 't3', name: 'Grep', input: {} },
      ] } }) + '\n',
      // decoys: sidechain, progress-nested, tool_result echoing the token as text, malformed
      toolUseLine('side', { isSidechain: true }),
      JSON.stringify({ type: 'progress', data: { message: { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'p1' }] } } } }) + '\n',
      toolResultLine('t1', 'output mentions {"type":"tool_use"} as plain text'),
      '{"type":"assistant","message":{"content":[{"type":"tool_use" BROKEN\n',
    ];
    expect(countToolUsesInBuffer(Buffer.from(lines.join(''), 'utf8'))).toBe(3);
  });
});

describe('countSessionToolUses', () => {
  it('counts the transcript and writes a per-session cache at the scanned offset', () => {
    fs.writeFileSync(transcript, toolUseLine('a') + toolResultLine('a', 'ok') + toolUseLine('b'));
    const r = count();
    expect(r.count).toBe(2);
    expect(r.offset).toBe(fs.statSync(transcript).size);
    const cached = JSON.parse(fs.readFileSync(cacheFilePath(stateDir, SID), 'utf8'));
    expect(cached.count).toBe(2);
    expect(cached.offset).toBe(r.offset);
    expect(cached.sessionId).toBe(SID);
  });

  it('counts appended tool_use blocks incrementally, reading only new bytes', () => {
    fs.writeFileSync(transcript, toolUseLine('a') + toolUseLine('b'));
    const first = count();
    const sizeBefore = fs.statSync(transcript).size;
    const appended = toolResultLine('b', 'y'.repeat(2000)) + toolUseLine('c') + toolUseLine('d') + toolUseLine('e');
    fs.appendFileSync(transcript, appended);
    const second = count();
    expect(second.count).toBe(first.count + 3);
    expect(second.scannedBytes).toBe(Buffer.byteLength(appended));
    expect(second.offset).toBe(sizeBefore + Buffer.byteLength(appended));
    // a tick with no new bytes reads nothing and keeps the count
    const third = count();
    expect(third.count).toBe(second.count);
    expect(third.scannedBytes).toBe(0);
  });

  it('holds a partial trailing line back until it is complete', () => {
    const complete = toolUseLine('a');
    const partial = toolUseLine('b');
    const cut = partial.length - 10;
    fs.writeFileSync(transcript, complete + partial.slice(0, cut));
    const r1 = count();
    expect(r1.count).toBe(1);
    expect(r1.offset).toBe(Buffer.byteLength(complete));
    fs.appendFileSync(transcript, partial.slice(cut));
    const r2 = count();
    expect(r2.count).toBe(2);
  });

  it('uses the cached count on a warm tick (cache is the source, not a rescan)', () => {
    fs.writeFileSync(transcript, toolUseLine('a'));
    const r1 = count();
    // Tamper the cached count; a warm tick with no new bytes must return it
    // unchanged, proving it did not rescan from byte 0.
    const file = cacheFilePath(stateDir, SID);
    const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    cached.count = r1.count + 40;
    fs.writeFileSync(file, JSON.stringify(cached));
    expect(count().count).toBe(r1.count + 40);
  });

  it('recounts from byte 0 when the file shrinks below the cached offset', () => {
    fs.writeFileSync(transcript, toolUseLine('a') + toolUseLine('b') + toolUseLine('c'));
    count();
    fs.writeFileSync(transcript, toolUseLine('z'));
    expect(count().count).toBe(1);
  });

  it('recounts when the cache belongs to a different transcript path', () => {
    fs.writeFileSync(transcript, toolUseLine('a') + toolUseLine('b'));
    count();
    const other = path.join(root, 'other.jsonl');
    fs.writeFileSync(other, toolUseLine('x'));
    expect(countSessionToolUses({ transcriptPath: other, sessionId: SID, stateDir }).count).toBe(1);
  });

  it('keeps sessions apart: each session id has its own cache file', () => {
    const otherSid = 'bbbbbbbb-1111-4222-8333-000000000002';
    const otherTranscript = path.join(root, `${otherSid}.jsonl`);
    fs.writeFileSync(transcript, toolUseLine('a'));
    fs.writeFileSync(otherTranscript, toolUseLine('x') + toolUseLine('y') + toolUseLine('z'));
    const mine = count();
    const theirs = countSessionToolUses({ transcriptPath: otherTranscript, sessionId: otherSid, stateDir });
    expect(theirs.count).toBeGreaterThan(mine.count);
    expect(count().count).toBe(mine.count);
    expect(cacheFilePath(stateDir, SID)).not.toBe(cacheFilePath(stateDir, otherSid));
  });

  it('returns null, never a number, when the transcript is unreadable or missing inputs', () => {
    expect(count()).toBeNull(); // file does not exist
    expect(countSessionToolUses({ transcriptPath: root, sessionId: SID, stateDir })).toBeNull(); // a directory
    fs.writeFileSync(transcript, toolUseLine('a'));
    expect(countSessionToolUses({ transcriptPath: transcript, sessionId: '', stateDir })).toBeNull();
    expect(countSessionToolUses({ transcriptPath: '', sessionId: SID, stateDir })).toBeNull();
  });

  it('returns null while a backlog exceeds one tick byte budget, then catches up', () => {
    let body = '';
    for (let i = 0; i < 50; i += 1) body += toolUseLine(`t${i}`) + toolResultLine(`t${i}`, 'z'.repeat(500));
    fs.writeFileSync(transcript, body);
    const budget = 4096;
    let r = count({ maxBytesPerTick: budget });
    let ticks = 1;
    while (r === null && ticks < 100) {
      r = count({ maxBytesPerTick: budget });
      ticks += 1;
    }
    expect(ticks).toBeGreaterThan(1);
    expect(r.count).toBe(50);
  });

  it('still returns the count when there is no stateDir to cache into', () => {
    fs.writeFileSync(transcript, toolUseLine('a') + toolUseLine('b'));
    expect(countSessionToolUses({ transcriptPath: transcript, sessionId: SID }).count).toBe(2);
  });
});

// Σ estimator E2 (og 2026-09-30, operator "Σ stays, improve its estimate"; spec
// _runs/2026-09-30/og/ctx320/result.md Part 2): changed lines per top-level tool
// call, read from the tool_use input, 0 for scratch paths, capped at 60 per call.
// Paths are plain strings in the input; no file is touched. Fixture paths stay
// off os.tmpdir(), which is itself scratch.
const SRC = '/abs/path/to/repo/plugins/4ge/bin/example.cjs';
const nLines = (n) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');
const block = (name, input) => ({ type: 'tool_use', id: `${name}-x`, name, input });

function recordLine(blocks, extra = {}) {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    sessionId: SID,
    message: { role: 'assistant', content: blocks },
    ...extra,
  }) + '\n';
}

describe('toolUseLines: the E2 changed-line rule per tool', () => {
  it('Edit counts the longer of new_string and old_string', () => {
    expect(toolUseLines(block('Edit', { file_path: SRC, old_string: nLines(3), new_string: nLines(7) }))).toBe(7);
    expect(toolUseLines(block('Edit', { file_path: SRC, old_string: nLines(9), new_string: nLines(2) }))).toBe(9);
    expect(toolUseLines(block('Edit', { file_path: SRC, old_string: 'a', new_string: '' }))).toBe(1);
  });

  it('MultiEdit sums the per-edit maximum', () => {
    const edits = [
      { old_string: nLines(2), new_string: nLines(5) },
      { old_string: nLines(4), new_string: nLines(1) },
    ];
    expect(toolUseLines(block('MultiEdit', { file_path: SRC, edits }))).toBe(9);
  });

  it('Write counts content lines; a trailing newline does not add a line', () => {
    expect(toolUseLines(block('Write', { file_path: SRC, content: nLines(12) }))).toBe(12);
    expect(toolUseLines(block('Write', { file_path: SRC, content: 'a\nb\n' }))).toBe(2);
    expect(toolUseLines(block('Write', { file_path: SRC, content: '' }))).toBe(0);
  });

  it('NotebookEdit counts new_source lines under notebook_path', () => {
    expect(toolUseLines(block('NotebookEdit', { notebook_path: '/abs/path/to/repo/nb/x.ipynb', new_source: nLines(4) }))).toBe(4);
  });

  it('a call with no file (Bash) or no changed text (Read) counts 0 lines', () => {
    expect(toolUseLines(block('Bash', { command: 'sed -i s/a/b/ x.cjs' }))).toBe(0);
    expect(toolUseLines(block('Read', { file_path: SRC }))).toBe(0);
    expect(toolUseLines(block('Write', { content: nLines(5) }))).toBe(0); // no path
    expect(toolUseLines(null)).toBe(0);
  });

  it('caps one call at 60 lines', () => {
    expect(toolUseLines(block('Write', { file_path: SRC, content: nLines(200) }))).toBe(60);
    expect(toolUseLines(block('Write', { file_path: SRC, content: nLines(60) }))).toBe(60);
    const edits = [1, 2, 3].map(() => ({ old_string: 'x', new_string: nLines(30) }));
    expect(toolUseLines(block('MultiEdit', { file_path: SRC, edits }))).toBe(60);
  });
});

describe('isScratchPath', () => {
  it.each([
    '/abs/path/to/repo/_runs/2026-09-30/og/r.md',
    '_runs/relative/r.md',
    'D:\\repo\\_runs\\2026-09-30\\r.md',
    '/tmp/claude-1000/scratch/x.txt',
    '/home/you/.claude/projects/-abs-path-to-repo/memory/m.md',
    'C:\\Users\\you\\.claude\\projects\\p\\memory\\m.md',
    '/abs/path/to/repo/.claude/agent-memory/sonnet-execute/n.md',
  ])('treats %s as scratch, and its lines count 0', (p) => {
    expect(isScratchPath(p)).toBe(true);
    expect(toolUseLines(block('Write', { file_path: p, content: nLines(10) }))).toBe(0);
  });

  it.each([
    SRC,
    'D:\\repo\\docs\\hud\\HUD-STANDARDS.md',
    '/abs/path/to/repo/.claude/hooks/example.cjs',
    '/abs/path/to/repo/runs/not-scratch.md',
  ])('treats %s as deliverable', (p) => {
    expect(isScratchPath(p)).toBe(false);
    expect(toolUseLines(block('Write', { file_path: p, content: nLines(10) }))).toBe(10);
  });
});

describe('tallyToolUsesInBuffer', () => {
  it('adds every top-level call and only its capped, non-scratch lines', () => {
    const lines = [
      recordLine([block('Write', { file_path: SRC, content: nLines(100) })]), // 60 (cap)
      recordLine([block('Write', { file_path: '/abs/path/to/repo/_runs/r.md', content: nLines(300) })]), // 0
      recordLine([
        block('Edit', { file_path: SRC, old_string: nLines(1), new_string: nLines(5) }), // 5
        block('Bash', { command: 'true' }), // 0
      ]),
      recordLine([block('Read', { file_path: SRC })]), // 0
      // a sidechain record neither counts a call nor lines
      recordLine([block('Write', { file_path: SRC, content: nLines(40) })], { isSidechain: true }),
      toolResultLine('x', 'echo {"type":"tool_use","name":"Write"} as text'),
    ];
    const t = tallyToolUsesInBuffer(Buffer.from(lines.join(''), 'utf8'));
    expect(t).toEqual({ calls: 5, lines: 65 });
    expect(countToolUsesInBuffer(Buffer.from(lines.join(''), 'utf8'))).toBe(5);
  });
});

describe('countSessionToolUses: E2 line accumulator', () => {
  it('returns and caches lines alongside the count, and adds appended lines incrementally', () => {
    fs.writeFileSync(transcript, recordLine([block('Write', { file_path: SRC, content: nLines(10) })]) + toolUseLine('b'));
    const first = count();
    expect(first).toMatchObject({ count: 2, lines: 10 });
    expect(JSON.parse(fs.readFileSync(cacheFilePath(stateDir, SID), 'utf8')).lines).toBe(10);
    const appended = recordLine([block('Edit', { file_path: SRC, old_string: 'a', new_string: nLines(3) })]);
    fs.appendFileSync(transcript, appended);
    const second = count();
    expect(second).toMatchObject({ count: 3, lines: 13 });
    expect(second.scannedBytes).toBe(Buffer.byteLength(appended));
  });

  it('recounts once from a pre-E2 (v1) cache, then reads the new cache', () => {
    fs.writeFileSync(transcript, recordLine([block('Write', { file_path: SRC, content: nLines(10) })]) + toolUseLine('b'));
    const st = fs.statSync(transcript);
    const file = cacheFilePath(stateDir, SID);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // The on-disk shape every cache had before E2: version 1, no lines field.
    fs.writeFileSync(file, JSON.stringify({ v: 1, sessionId: SID, transcriptPath: transcript, ino: st.ino, offset: st.size, count: 999 }));
    const first = count();
    expect(first).toMatchObject({ count: 2, lines: 10 });
    expect(first.scannedBytes).toBe(st.size);
    const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(cached.v).not.toBe(1);
    expect(cached.lines).toBe(10);
    const second = count();
    expect(second).toMatchObject({ count: 2, lines: 10, scannedBytes: 0 });
  });
});
