// The statusline picks its transcript by the LIVE stdin session id (SP1 D1, 2026-10-15), never
// by the session recorded in the shared session-meta.json (the S594 per-instance ruling), and
// it parses one only while a fresh reactive event shows the activity zone, the one statusline
// row that renders state.transcript. Synthetic fixtures only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);
const { loadHudData } = _require('../hud-data-loader.cjs');
const { buildProjectSlug, findTranscriptPath } = _require('../hud-transcript-source.cjs');
const { statuslineLoadOptions, renderReactiveStatuslineRows } = _require('../hud-engine.cjs');
const { resolvePalette, stripAnsi } = _require('../hud-palette.cjs');

const META_SESSION = 'meta-session';
const LIVE_SESSION = 'live-session';

const TRANSCRIPT_LINE = JSON.stringify({
  type: 'assistant',
  timestamp: '2026-10-15T01:00:00.000Z',
  message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'printf x' } }] },
});

let root;
let stateDir;
let fakeHome;
let homeSpy;

function writeTranscript(sessionId) {
  const projectDir = path.join(fakeHome, '.claude', 'projects', buildProjectSlug(root));
  fs.mkdirSync(projectDir, { recursive: true });
  const file = path.join(projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, `${TRANSCRIPT_LINE}\n`);
  return file;
}

// The reactive feed's last event, as the HUD event writer leaves it.
function writeReactive(event, triggeredAt = Date.now()) {
  fs.writeFileSync(path.join(stateDir, 'hud-last-reactive.json'), JSON.stringify({ lastEvent: { event, triggeredAt } }));
}

// Run `fn` while counting reads of the given files.
function countReads(files, fn) {
  const wanted = new Set(files.map((file) => path.resolve(file)));
  const realRead = fs.readFileSync;
  const reads = [];
  const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((filePath, ...args) => {
    if (wanted.has(path.resolve(String(filePath)))) reads.push(String(filePath));
    return realRead.call(fs, filePath, ...args);
  });
  try {
    return { result: fn(), reads };
  } finally {
    spy.mockRestore();
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-live-session-'));
  stateDir = path.join(root, '_runs', 'os');
  fakeHome = path.join(root, 'home');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'session-meta.json'), JSON.stringify({ session_id: META_SESSION }));
  homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
});

afterEach(() => {
  homeSpy.mockRestore();
  fs.rmSync(root, { recursive: true, force: true });
});

const load = (extra = {}) => loadHudData({ stateDir, cwd: root, runExpensiveProbes: false, ...extra });

describe('loadHudData transcript pick', () => {
  it('picks the transcript by the live session id, not the shared meta session', () => {
    writeTranscript(META_SESSION);
    const live = writeTranscript(LIVE_SESSION);

    const raw = load({ sessionId: LIVE_SESSION });
    expect(raw.transcript).not.toBeNull();
    expect(raw.transcript.transcriptPath).toBe(live);
  });

  it('gives a live session with no transcript none, never another session\'s', () => {
    writeTranscript(META_SESSION);

    expect(load({ sessionId: 'no-such-session' }).transcript).toBeNull();
  });

  it('treats an empty live id as no session, not as the meta session', () => {
    writeTranscript(META_SESSION);

    expect(load({ sessionId: '' }).transcript).toBeNull();
  });

  it('keeps the meta session pick for callers with no live session (fleet and full HUD)', () => {
    const meta = writeTranscript(META_SESSION);

    const raw = load();
    expect(raw.transcript).not.toBeNull();
    expect(raw.transcript.transcriptPath).toBe(meta);
  });

  it('reads no transcript at all when the caller skips it', () => {
    const meta = writeTranscript(META_SESSION);
    const live = writeTranscript(LIVE_SESSION);

    const skipped = countReads([meta, live], () => load({ sessionId: LIVE_SESSION, skipTranscript: true }));
    expect(skipped.result.transcript).toBeNull();
    expect(skipped.reads).toEqual([]);

    // Control: the same load without the flag does read the live transcript.
    const parsed = countReads([meta, live], () => load({ sessionId: LIVE_SESSION }));
    expect(parsed.reads).toEqual([live]);
  });

  it('parses nothing for the statusline load options without a fresh activity event', () => {
    const meta = writeTranscript(META_SESSION);
    const live = writeTranscript(LIVE_SESSION);
    const statusline = () => loadHudData(statuslineLoadOptions({ session_id: LIVE_SESSION }, root));

    // No reactive event.
    let run = countReads([meta, live], statusline);
    expect(run.result.transcript).toBeNull();
    expect(run.reads).toEqual([]);

    // A fresh event whose rows do not include the activity zone.
    writeReactive('commit');
    run = countReads([meta, live], statusline);
    expect(run.result.reactive.event).toBe('commit');
    expect(run.reads).toEqual([]);

    // An activity event past its 8 s lifetime.
    writeReactive('test-pass', Date.now() - 60000);
    run = countReads([meta, live], statusline);
    expect(run.result.reactive).toBeNull();
    expect(run.reads).toEqual([]);
  });

  it('parses only the live transcript for the statusline while an activity event is fresh', () => {
    const meta = writeTranscript(META_SESSION);
    const live = writeTranscript(LIVE_SESSION);
    writeReactive('test-pass');

    const { result, reads } = countReads([meta, live], () => loadHudData(
      statuslineLoadOptions({ session_id: LIVE_SESSION }, root),
    ));
    expect(result.transcript).not.toBeNull();
    expect(result.transcript.transcriptPath).toBe(live);
    expect(reads).toEqual([live]);

    // A live session with no transcript gets none, never the meta session's.
    const none = countReads([meta, live], () => loadHudData(
      statuslineLoadOptions({ session_id: 'no-such-session' }, root),
    ));
    expect(none.result.transcript).toBeNull();
    expect(none.reads).toEqual([]);
  });

  it('draws the Activity rows of a fresh test-pass event from the live transcript', () => {
    writeTranscript(META_SESSION);
    writeTranscript(LIVE_SESSION);
    writeReactive('test-pass');

    const raw = loadHudData(statuslineLoadOptions({ session_id: LIVE_SESSION }, root));
    const rows = renderReactiveStatuslineRows(raw, resolvePalette(), 8).map(stripAnsi);
    expect(rows[0]).toContain('reactive test-pass');
    expect(rows.some((row) => /Activity 1 calls/.test(row))).toBe(true);
    expect(rows.some((row) => /Bash\s+printf x/.test(row))).toBe(true);

    // Control: with no transcript the same event draws no Activity row.
    const bare = renderReactiveStatuslineRows({ ...raw, transcript: null }, resolvePalette(), 8).map(stripAnsi);
    expect(bare.some((row) => row.includes('Activity'))).toBe(false);
  });
});

describe('findTranscriptPath strict mode', () => {
  it('returns null for a session with no file instead of the newest file of any session', () => {
    const meta = writeTranscript(META_SESSION);

    expect(findTranscriptPath(root, LIVE_SESSION)).toBe(meta);
    expect(findTranscriptPath(root, LIVE_SESSION, { strict: true })).toBeNull();
    expect(findTranscriptPath(root, META_SESSION, { strict: true })).toBe(meta);
  });
});
