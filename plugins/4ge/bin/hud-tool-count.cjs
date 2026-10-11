'use strict';

/**
 * hud-tool-count.cjs — the statusline `⊥` tool count and the Σ estimator's
 * deliverable-line total, per session.
 *
 * The count comes from the session's OWN transcript (statusline stdin
 * `transcript_path`), not from the shared `_runs/os/session-meta.json`
 * counter, whose owner is re-stamped by every session start and so belongs to
 * whichever lane or headless run booted last (operator report 2026-09-28).
 *
 * A tool call is one `tool_use` content block in a top-level assistant record
 * (`type: "assistant"`, not a sidechain). Each call also carries the lines it
 * changed in a deliverable file, read from its own `input` (Σ estimator E2,
 * og 2026-09-30; spec `_runs/2026-09-30/og/ctx320/result.md` Part 2):
 * Edit = max(lines of new_string, old_string), MultiEdit = the sum of that per
 * edit, Write = content lines, NotebookEdit = new_source lines; every other
 * tool 0. A path under `/_runs/`, `/tmp/`, `.claude/projects/` or
 * `.claude/agent-memory/` is scratch and counts 0, and one call counts at most
 * 60 lines. No file named in the input is ever read.
 *
 * Each statusline tick is a fresh node process, so the running totals are
 * cached on disk per session:
 *
 *   <stateDir>/hud-tool-count/<session-id>.json
 *   { v, sessionId, transcriptPath, ino, offset, count, lines }
 *
 * `offset` is the byte position just past the last complete line counted. A
 * tick reads only `[offset, size)`, counts complete lines, and never counts a
 * partial trailing line (the harness may be mid-append). A changed path or
 * inode, a file shorter than `offset`, or a cache from another CACHE_VERSION
 * discards the cache and recounts from byte 0. The cache is written only when
 * the offset moved.
 *
 * Returns `{ count, lines, offset, scannedBytes }`, or `null` when the count
 * is not known: no session id or path, an unreadable or non-regular file, or a
 * backlog larger than one tick's byte budget (progress is saved and the next
 * tick continues). The caller renders nothing for `null` — never another
 * session's count and never a stand-in 0.
 */

const fs = require('node:fs');
const path = require('node:path');

const CACHE_DIRNAME = 'hud-tool-count';
// 2 = E2 line accumulator added (og 2026-09-30); a v1 cache recounts once.
const CACHE_VERSION = 2;
const CHUNK_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_BYTES_PER_TICK = 64 * 1024 * 1024;
const CACHE_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const NEWLINE = 0x0a;
// Prefilter. Inside a JSON string every quote is escaped, so `"tool_use"`
// with bare quotes only occurs as a JSON token; `"tool_use_id"` (tool_result
// lines, often the largest) does not match. Candidate lines are then parsed.
const CANDIDATE = Buffer.from('"tool_use"', 'utf8');
const MAX_LINES_PER_CALL = 60;
// Tested against the path with `\` turned to `/` and a leading `/` added, so
// Windows paths and a relative `_runs/...` match the same way.
const SCRATCH_PATH = /\/(?:_runs|tmp)\/|\/\.claude\/(?:projects|agent-memory)\//;

function safeSessionKey(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return '';
  return sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);
}

function cacheFilePath(stateDir, sessionId) {
  const key = safeSessionKey(sessionId);
  if (!stateDir || !key) return null;
  return path.join(stateDir, CACHE_DIRNAME, `${key}.json`);
}

function isScratchPath(filePath) {
  if (typeof filePath !== 'string' || !filePath) return false;
  return SCRATCH_PATH.test(`/${filePath.replace(/\\/g, '/')}`);
}

// Lines in a text field; a trailing newline ends the last line rather than
// starting another. Stops counting at the per-call cap, which bounds the work
// on a large Write without changing any capped total.
function textLines(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  let n = 1;
  let i = text.indexOf('\n');
  while (i !== -1 && i < text.length - 1 && n < MAX_LINES_PER_CALL) {
    n += 1;
    i = text.indexOf('\n', i + 1);
  }
  return n;
}

function editLines(edit) {
  if (!edit || typeof edit !== 'object') return 0;
  return Math.max(textLines(edit.new_string), textLines(edit.old_string));
}

/**
 * Deliverable lines one tool_use block changed, from its own input: 0 for a
 * tool that edits no file, a missing path or a scratch path; at most 60.
 * @param {object} block  a `tool_use` content block
 * @returns {number}
 */
function toolUseLines(block) {
  if (!block || block.type !== 'tool_use') return 0;
  const input = block.input;
  if (!input || typeof input !== 'object') return 0;
  let file;
  let n = 0;
  switch (block.name) {
    case 'Edit':
      file = input.file_path;
      n = editLines(input);
      break;
    case 'MultiEdit':
      file = input.file_path;
      if (Array.isArray(input.edits)) {
        for (const edit of input.edits) {
          n += editLines(edit);
          if (n >= MAX_LINES_PER_CALL) break;
        }
      }
      break;
    case 'Write':
      file = input.file_path;
      n = textLines(input.content);
      break;
    case 'NotebookEdit':
      file = input.notebook_path;
      n = textLines(input.new_source);
      break;
    default:
      return 0;
  }
  if (typeof file !== 'string' || !file || isScratchPath(file)) return 0;
  return Math.min(n, MAX_LINES_PER_CALL);
}

function tallyRecord(obj, tally) {
  if (!obj || typeof obj !== 'object') return;
  if (obj.type !== 'assistant' || obj.isSidechain === true) return;
  const content = obj.message && obj.message.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block && block.type === 'tool_use') {
      tally.calls += 1;
      tally.lines += toolUseLines(block);
    }
  }
}

function countToolUsesInRecord(obj) {
  const tally = { calls: 0, lines: 0 };
  tallyRecord(obj, tally);
  return tally.calls;
}

/**
 * Tally tool_use blocks and their deliverable lines in a buffer of complete
 * JSONL lines. Only lines that contain the `"tool_use"` token are decoded and
 * parsed; a malformed line counts nothing.
 * @param {Buffer} buf
 * @returns {{calls:number, lines:number}}
 */
function tallyToolUsesInBuffer(buf) {
  const tally = { calls: 0, lines: 0 };
  let from = 0;
  while (from < buf.length) {
    const hit = buf.indexOf(CANDIDATE, from);
    if (hit === -1) break;
    const start = hit === 0 ? 0 : buf.lastIndexOf(NEWLINE, hit - 1) + 1;
    let end = buf.indexOf(NEWLINE, hit);
    if (end === -1) end = buf.length;
    let obj;
    try { obj = JSON.parse(buf.toString('utf8', start, end)); } catch { obj = null; }
    tallyRecord(obj, tally);
    from = end + 1;
  }
  return tally;
}

/**
 * Count tool_use blocks in a buffer of complete JSONL lines.
 * @param {Buffer} buf
 * @returns {number}
 */
function countToolUsesInBuffer(buf) {
  return tallyToolUsesInBuffer(buf).calls;
}

function readCache(file) {
  if (!file) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || raw.v !== CACHE_VERSION) return null;
    if (typeof raw.offset !== 'number' || raw.offset < 0) return null;
    if (typeof raw.count !== 'number' || raw.count < 0) return null;
    if (typeof raw.lines !== 'number' || raw.lines < 0) return null;
    return raw;
  } catch {
    return null;
  }
}

function pruneStaleCaches(dir, keepFile, now) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    const full = path.join(dir, name);
    if (full === keepFile) continue;
    try {
      if (now - fs.statSync(full).mtimeMs > CACHE_MAX_AGE_MS) fs.unlinkSync(full);
    } catch { /* best-effort */ }
  }
}

function writeCache(file, entry, { isNew, now }) {
  if (!file) return;
  try {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${now}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entry), 'utf8');
    fs.renameSync(tmp, file);
    if (isNew) pruneStaleCaches(dir, file, now);
  } catch { /* best-effort: the count is still right for this tick */ }
}

/**
 * @param {object} opts
 * @param {string} opts.transcriptPath  statusline stdin `transcript_path`
 * @param {string} opts.sessionId       statusline stdin `session_id`
 * @param {string} [opts.stateDir]      `_runs/os`; no stateDir = no cache
 * @param {number} [opts.maxBytesPerTick]
 * @param {number} [opts.now]
 * @returns {{count:number, lines:number, offset:number, scannedBytes:number} | null}
 */
function countSessionToolUses({
  transcriptPath,
  sessionId,
  stateDir,
  maxBytesPerTick = DEFAULT_MAX_BYTES_PER_TICK,
  now = Date.now(),
} = {}) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null;
  if (!safeSessionKey(sessionId)) return null;

  let st;
  try { st = fs.statSync(transcriptPath); } catch { return null; }
  if (!st.isFile()) return null;

  const file = cacheFilePath(stateDir, sessionId);
  const cached = readCache(file);
  const valid = !!cached
    && cached.sessionId === sessionId
    && cached.transcriptPath === transcriptPath
    && cached.ino === st.ino
    && cached.offset <= st.size;
  const startOffset = valid ? cached.offset : 0;
  let count = valid ? cached.count : 0;
  let lines = valid ? cached.lines : 0;
  let committed = startOffset;
  let scannedBytes = 0;
  let reachedEnd = startOffset >= st.size;

  if (startOffset < st.size) {
    let fd;
    try { fd = fs.openSync(transcriptPath, 'r'); } catch { return null; }
    try {
      let pos = startOffset;
      let carry = null;
      while (pos < st.size) {
        // Stop at the byte budget, but only once this tick has committed at
        // least one line, so a single line longer than the budget cannot
        // stall the count.
        const remaining = maxBytesPerTick - scannedBytes;
        if (remaining <= 0 && committed > startOffset) break;
        const len = Math.min(CHUNK_BYTES, st.size - pos, remaining > 0 ? remaining : CHUNK_BYTES);
        const chunk = Buffer.allocUnsafe(len);
        const n = fs.readSync(fd, chunk, 0, len, pos);
        if (n <= 0) break;
        pos += n;
        scannedBytes += n;
        const data = carry ? Buffer.concat([carry, chunk.subarray(0, n)]) : chunk.subarray(0, n);
        const lastNl = data.lastIndexOf(NEWLINE);
        if (lastNl === -1) { carry = data; continue; }
        const tally = tallyToolUsesInBuffer(data.subarray(0, lastNl + 1));
        count += tally.calls;
        lines += tally.lines;
        committed = pos - (data.length - (lastNl + 1));
        carry = lastNl + 1 < data.length ? Buffer.from(data.subarray(lastNl + 1)) : null;
      }
      reachedEnd = pos >= st.size;
    } catch {
      return null;
    } finally {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }

  if (!valid || committed !== startOffset) {
    writeCache(file, {
      v: CACHE_VERSION,
      sessionId,
      transcriptPath,
      ino: st.ino,
      offset: committed,
      count,
      lines,
    }, { isNew: !cached, now });
  }

  // A backlog past the byte budget is not a count yet: the next tick resumes
  // from `committed`. A trailing partial line at end of file is normal (the
  // harness is mid-append) and does not hold the count back.
  if (!reachedEnd) return null;
  return { count, lines, offset: committed, scannedBytes };
}

module.exports = {
  countSessionToolUses,
  countToolUsesInBuffer,
  countToolUsesInRecord,
  tallyToolUsesInBuffer,
  toolUseLines,
  isScratchPath,
  cacheFilePath,
  CACHE_DIRNAME,
  CACHE_VERSION,
  MAX_LINES_PER_CALL,
};
