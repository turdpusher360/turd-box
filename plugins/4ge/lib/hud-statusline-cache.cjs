'use strict';
// Per-session render cache for `hud-engine.cjs --mode=statusline`.
//
// Claude Code polls the statusline every 2 s in every live session. A full
// render requires ~25 modules and reads OS state from the Windows drive mount (drvfs, 9p),
// which piles up as D-state processes when a dozen sessions poll at once.
// This cache lets an idle session answer from one small file on os.tmpdir()
// (WSL ext4) and exit before any of that work.
//
// Key: session_id (one file per session). A hit also needs a matching
// fingerprint of the inputs that change the output (the stdin JSON minus its
// wall-clock duration counters, the transcript's mtime and size, argv and the
// project-dir env) and an entry younger than CACHE_TTL_MS. Anything missing,
// corrupt or unreadable is a miss, and the caller renders in full.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// Longest a cached frame is reused while the inputs stay the same. Disk-backed
// state that is not in the fingerprint (companion messages, board, reactive
// events, git) can lag by at most this much.
const CACHE_TTL_MS = 10000;
const CACHE_VERSION = 1;

function defaultCacheDir() {
  return path.join(os.tmpdir(), '4ge-hud-statusline-cache');
}

function cacheFileFor(sessionId, dir) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);
  if (!safe) return null;
  return path.join(dir || defaultCacheDir(), `${safe}.json`);
}

// Stdin fields that tick every poll without changing anything the statusline
// draws at minute resolution. Dropped from the fingerprint so an idle session
// can hit.
function stripVolatile(stdin) {
  const copy = Object.assign({}, stdin);
  if (copy.cost && typeof copy.cost === 'object') {
    const cost = Object.assign({}, copy.cost);
    delete cost.total_duration_ms;
    delete cost.total_api_duration_ms;
    copy.cost = cost;
  }
  return copy;
}

function transcriptStamp(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return null;
  try {
    const st = fs.statSync(transcriptPath);
    return [st.mtimeMs, st.size];
  } catch {
    return 'missing';
  }
}

function computeFingerprint(stdin, extra) {
  const parts = {
    stdin: stripVolatile(stdin),
    transcript: transcriptStamp(stdin.transcript_path),
    extra: extra || null,
  };
  return crypto.createHash('sha1').update(JSON.stringify(parts)).digest('hex');
}

function parseStdin(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// Returns the cached output string on a hit, otherwise null.
function lookup(stdin, opts = {}) {
  try {
    if (!stdin || typeof stdin !== 'object') return null;
    const file = cacheFileFor(stdin.session_id, opts.dir);
    if (!file) return null;
    const now = typeof opts.now === 'number' ? opts.now : Date.now();
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!entry || entry.v !== CACHE_VERSION) return null;
    if (entry.sid !== stdin.session_id) return null;
    if (typeof entry.out !== 'string' || !entry.out) return null;
    if (typeof entry.at !== 'number' || now - entry.at < 0) return null;
    const ttl = typeof opts.ttlMs === 'number' ? opts.ttlMs : CACHE_TTL_MS;
    if (now - entry.at >= ttl) return null;
    if (entry.fp !== computeFingerprint(stdin, opts.extra)) return null;
    return entry.out;
  } catch {
    return null;
  }
}

// Best-effort atomic write: temp file in the same directory, then rename.
function store(stdin, output, opts = {}) {
  try {
    if (!stdin || typeof stdin !== 'object') return false;
    if (typeof output !== 'string' || !output) return false;
    const dir = opts.dir || defaultCacheDir();
    const file = cacheFileFor(stdin.session_id, dir);
    if (!file) return false;
    fs.mkdirSync(dir, { recursive: true });
    const entry = {
      v: CACHE_VERSION,
      sid: stdin.session_id,
      at: typeof opts.now === 'number' ? opts.now : Date.now(),
      fp: computeFingerprint(stdin, opts.extra),
      out: output,
    };
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entry));
    try {
      fs.renameSync(tmp, file);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* already gone */ }
      throw err;
    }
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  CACHE_TTL_MS,
  CACHE_VERSION,
  defaultCacheDir,
  cacheFileFor,
  computeFingerprint,
  parseStdin,
  lookup,
  store,
};
