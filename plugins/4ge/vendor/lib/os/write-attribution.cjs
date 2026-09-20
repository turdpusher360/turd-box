// @ts-check
'use strict';
/**
 * write-attribution.cjs — writer attribution + append-only journal for the
 * shared OS state singletons (boot-status.json, health.json).
 *
 * Rung B of the upstream boot-coherence remedy ladder
 * (_runs/2026-07-18/s586/boot-coherence-findings.md). boot-status.json and
 * health.json are stomped by every surface that boots or probes the OS —
 * operator sessions, Cowork/Codex lanes, and every Agent-tool teammate spawn
 * (six full kernel boots on 2026-07-18 alone). Before this module the writing
 * surface was unattributable: session_id was minted as `session-${Date.now()}`,
 * so answering "who wrote this file?" after the fact required forensic guessing.
 *
 * This module stamps every write with a `written_by` descriptor and appends one
 * line per write event to _runs/os/boot-writers.jsonl. It does NOT change which
 * surface is *allowed* to write (that is rung A / C, deliberately out of scope);
 * it only makes each write self-identifying.
 *
 * Session-id derivation follows the runtime pattern already used by
 * capabilities/file-integrity.cjs and mandated by docs/reference/os-vocabulary.md
 * (§session-meta.json anti-pattern): the caller's explicit id wins (the
 * SessionStart hook has it on stdin — CLAUDE_SESSION_ID is ALWAYS unset in the
 * hook runtime), then _runs/os/session-meta.json (which os-boot syncs to the
 * current session before boot()), then a minted fallback that is honestly
 * stamped entry:"unknown" rather than pretending to know a surface.
 * Teammate-vs-lead classification is rung A's probe; this module records
 * whatever `entry` the caller declares.
 *
 * Exports:
 *   deriveWriter(opts)                          -> { session_id, pid, entry, surface?, ts }
 *   recordWrite(stateDir, file, writer, summary)-> void  (append one journal line; never throws)
 *   readSessionMeta(stateDir)                   -> session_id string, or '' if unavailable
 */

const fs = require('node:fs');
const path = require('node:path');
const { appendJsonl } = require('./jsonl-rotate.cjs');

/** Valid trigger kinds for a write. Rung A will start emitting 'teammate'. */
const VALID_ENTRIES = Object.freeze(['hook', 'teammate', 'cli', 'unknown']);
const JOURNAL_FILE = 'boot-writers.jsonl';
// Bound the journal well under a megabyte. Reuses the audited jsonl-rotate
// utility: rotate at ~512KB, keep a single prior (dated) generation, prune the
// rest. The byte cap is the effective bound — one write event is one short line.
const JOURNAL_MAX_BYTES = 512 * 1024;
const JOURNAL_MAX_ROTATED = 1;
// Rung A1 (upstream): a healthier existing boot-status from a DIFFERENT session only wins the
// downgrade-refusal contest while it is still plausibly current. Past this age a truly-dead
// file must never keep suppressing a real degradation forever (fail-safe = write).
const DOWNGRADE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Overall-status ordering for the downgrade gate. Higher = healthier.
const OVERALL_RANK = Object.freeze({ ready: 2, degraded: 1, failed: 0 });
const HELD_STATUS_MAX_CAPABILITIES = 64;

/** True for a usable, non-placeholder session id. */
function isRealId(v) {
  return typeof v === 'string' && v.length > 0 && v !== 'unknown';
}

/**
 * Best-effort read of the current session id from _runs/os/session-meta.json.
 * Returns '' on any failure (missing file, parse error, placeholder id).
 *
 * @param {string} stateDir - The OS state dir (_runs/os).
 * @returns {string}
 */
function readSessionMeta(stateDir) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(stateDir, 'session-meta.json'), 'utf8'));
    const id = meta && typeof meta.session_id === 'string' ? meta.session_id : '';
    return isRealId(id) ? id : '';
  } catch {
    return '';
  }
}

/**
 * Best-effort surface hint from the environment. Optional — an absent hint
 * simply omits the `surface` key. CLAUDE_CODE_ENTRYPOINT is a CC-set env var
 * when present; this never fabricates a value.
 *
 * @returns {string}
 */
function deriveSurfaceHint() {
  const ep = process.env.CLAUDE_CODE_ENTRYPOINT;
  return (typeof ep === 'string' && ep) ? ep : '';
}

/**
 * Build a writer-attribution descriptor for a state write.
 *
 * @param {object} [opts]
 * @param {string} [opts.sessionId] Explicit session id (the SessionStart hook's stdin value).
 * @param {string} [opts.entry]     One of hook|teammate|cli|unknown (caller-declared trigger kind).
 * @param {string} [opts.surface]   Optional free-form surface hint (e.g. 'aisle-refresh').
 * @param {number} [opts.pid]       Override pid (defaults to process.pid).
 * @param {string} [opts.stateDir]  If given, session-meta.json is consulted as a fallback id source.
 * @returns {{session_id: string, pid: number, entry: string, surface?: string, ts: string}}
 */
function deriveWriter(opts = {}) {
  // Session id: explicit caller value → session-meta.json → env (per the vocab
  // doc, CLAUDE_SESSION_ID is inert in hooks; retained only for a non-hook
  // caller) → minted. `entry` stays independent of id-knowledge: the hook can
  // truthfully be 'hook' even when its session id had to be minted.
  let sessionId = '';
  if (isRealId(opts.sessionId)) sessionId = opts.sessionId;
  if (!sessionId && opts.stateDir) sessionId = readSessionMeta(opts.stateDir);
  if (!sessionId && isRealId(process.env.CLAUDE_SESSION_ID)) sessionId = process.env.CLAUDE_SESSION_ID;
  if (!sessionId) sessionId = `session-${Date.now()}`;

  const writer = {
    session_id: sessionId,
    pid: Number.isInteger(opts.pid) ? opts.pid : process.pid,
    entry: VALID_ENTRIES.includes(opts.entry) ? opts.entry : 'unknown',
    ts: new Date().toISOString(),
  };
  const surface = opts.surface || deriveSurfaceHint();
  if (surface) writer.surface = surface;
  return writer;
}

/**
 * Append one line to the boot-writers journal describing a state write.
 *
 * Failure-tolerant by contract: a journal error must NEVER break the state
 * write that triggered it, so every failure is swallowed to stderr. Callers
 * invoke this AFTER the state file has already been written.
 *
 * @param {string} stateDir The OS state dir (_runs/os).
 * @param {string} file     The file that was written ('boot-status.json' | 'health.json').
 * @param {object} writer   A deriveWriter() descriptor.
 * @param {string} summary  Compact status summary (e.g. 'ready', '9/9 ok').
 */
function recordWrite(stateDir, file, writer, summary) {
  try {
    const entry = {
      ts: (writer && writer.ts) ? writer.ts : new Date().toISOString(),
      file,
      session_id: writer ? writer.session_id : 'unknown',
      pid: writer ? writer.pid : process.pid,
      entry: writer ? writer.entry : 'unknown',
      overall_or_ok_summary: summary == null ? '' : String(summary),
    };
    if (writer && writer.surface) entry.surface = writer.surface;
    appendJsonl(path.join(stateDir, JOURNAL_FILE), entry, {
      maxBytes: JOURNAL_MAX_BYTES,
      maxRotated: JOURNAL_MAX_ROTATED,
    });
  } catch (err) {
    try {
      process.stderr.write(
        `[write-attribution] journal append failed: ${err && err.message ? err.message : err}\n`,
      );
    } catch { /* stderr unavailable — nothing more we can do */ }
  }
}

/** First 8 chars of a session id for compact journal/reason text. */
function shortId(id) {
  return typeof id === 'string' ? id.slice(0, 8) : String(id);
}

/**
 * Rung A1 (upstream boot-coherence ladder) — the downgrade-refusing write gate.
 *
 * The upstream harm is NOT "a second write happened" — it is "a write carrying a WORSE,
 * WRONG view (a teammate / stripped-env boot that sees Docker missing + AISLE
 * unresolvable) overwrote a GOOD view from a different, healthy session." So this gate
 * keys on the CONTENT, never on trying to detect who the caller is (which would depend
 * on the still-unresolved upstream teammate-SessionStart probe — rung A2, deliberately out
 * of scope here).
 *
 * SUPPRESS the shared boot-status write only when ALL hold:
 *   1. incoming.overall is `degraded` or `failed`         (a healthy write ALWAYS lands)
 *   2. an existing file exists AND its writer session differs (a session degrading its OWN
 *      from the incoming writer session                        view always lands — honest self-report)
 *   3. rank(existing.overall) > rank(incoming.overall)     (existing is STRICTLY healthier)
 *   4. existing.booted_at age < maxAgeMs (default 24h)     (a truly-dead file never wins forever)
 *
 * Fail-safe is WRITE: any missing precondition, unparseable field, or equal rank returns
 * `{ suppress: false }`, matching the kernel's fail-open boot philosophy (availability
 * over suppression). The gate can only ever HOLD a degraded/failed write over a
 * strictly-healthier live file from another surface — never hide a legitimate one.
 *
 * @param {object|null} existing  The boot-status currently on disk (or null if absent/unreadable).
 * @param {object} incoming       The boot-status about to be written.
 * @param {{ now?: number, maxAgeMs?: number }} [opts]
 * @returns {{ suppress: boolean, reason: string }}
 */
function shouldSuppressWrite(existing, incoming, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const maxAgeMs = Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : DOWNGRADE_MAX_AGE_MS;
  const rankOf = (o) => (o && Object.prototype.hasOwnProperty.call(OVERALL_RANK, o.overall))
    ? OVERALL_RANK[o.overall]
    : -1;
  const sessionOf = (o) => {
    const attributed = o && o.written_by && o.written_by.session_id;
    const fallback = o && o.session_id;
    if (isRealId(attributed)) return attributed;
    return isRealId(fallback) ? fallback : '';
  };

  // 1. Only a degraded/failed incoming write is ever a candidate for suppression.
  if (!incoming || (incoming.overall !== 'degraded' && incoming.overall !== 'failed')) {
    return { suppress: false, reason: 'incoming healthy or unknown — write' };
  }
  // 2. Need a real existing file owned by a DIFFERENT session.
  if (!existing || typeof existing !== 'object') {
    return { suppress: false, reason: 'no existing boot-status — write' };
  }
  const existingSessionId = sessionOf(existing);
  const incomingSessionId = sessionOf(incoming);
  if (!existingSessionId || !incomingSessionId || existingSessionId === incomingSessionId) {
    return { suppress: false, reason: 'same session or unattributable — write' };
  }
  // 3. Existing must be STRICTLY healthier (equal rank falls through to write).
  if (!(rankOf(existing) > rankOf(incoming))) {
    return { suppress: false, reason: 'existing not strictly healthier — write' };
  }
  // 4. Existing must be recent enough to still be trusted.
  const existingBootedMs = Date.parse(existing.booted_at);
  const ageMs = now - existingBootedMs;
  if (!Number.isFinite(existingBootedMs) || ageMs < 0 || ageMs >= maxAgeMs) {
    return { suppress: false, reason: 'existing missing booted_at or older than max age — write' };
  }
  const ageMin = Math.round(ageMs / 60000);
  return {
    suppress: true,
    reason: `held ${incoming.overall} write from ${shortId(incomingSessionId)}: `
      + `existing ${existing.overall} from ${shortId(existingSessionId)} is healthier and ${ageMin}m old`,
  };
}

/**
 * Keep suppression diagnostics useful without retaining arbitrary capability error text.
 * Capability names and states are bounded; free-form reasons become a boolean marker.
 */
function summarizeHeldStatus(heldStatus) {
  const source = heldStatus && typeof heldStatus === 'object' ? heldStatus : {};
  const summary = {
    session_id: typeof source.session_id === 'string' ? source.session_id.slice(0, 128) : '',
    overall: Object.prototype.hasOwnProperty.call(OVERALL_RANK, source.overall) ? source.overall : 'unknown',
    capabilities: {},
  };
  if (typeof source.booted_at === 'string') summary.booted_at = source.booted_at.slice(0, 64);
  if (Number.isFinite(source.total_boot_ms)) summary.total_boot_ms = source.total_boot_ms;

  const capabilities = source.capabilities && typeof source.capabilities === 'object'
    ? Object.entries(source.capabilities)
    : [];
  for (const [rawName, rawCapability] of capabilities.slice(0, HELD_STATUS_MAX_CAPABILITIES)) {
    const name = String(rawName).slice(0, 80);
    const status = rawCapability && Object.prototype.hasOwnProperty.call(OVERALL_RANK, rawCapability.status)
      ? rawCapability.status
      : 'unknown';
    summary.capabilities[name] = {
      status,
      ...(rawCapability && rawCapability.reason ? { has_reason: true } : {}),
    };
  }
  if (capabilities.length > HELD_STATUS_MAX_CAPABILITIES) {
    summary.capabilities_truncated = capabilities.length - HELD_STATUS_MAX_CAPABILITIES;
  }
  return summary;
}

function protectedWriterOf(status) {
  const writer = status && status.written_by;
  if (!writer || !isRealId(writer.session_id) || typeof writer.ts !== 'string') return null;
  return { session_id: writer.session_id.slice(0, 128), ts: writer.ts.slice(0, 64) };
}

/**
 * Verify that a protected writer already has a journal chain of trust. A matching actual
 * write is authoritative; a prior suppression is reusable only when it was itself verified.
 */
function hasProtectedWriterProof(stateDir, protectedWriter) {
  if (!protectedWriter) return false;
  try {
    const raw = fs.readFileSync(path.join(stateDir, JOURNAL_FILE), 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean).slice(-200);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      let event;
      try { event = JSON.parse(lines[i]); } catch { continue; }
      if (!event || event.file !== 'boot-status.json') continue;
      if (event.event === 'suppressed_write') {
        const prior = event.protected_written_by;
        if (event.protected_writer_verified === true
          && prior
          && prior.session_id === protectedWriter.session_id
          && prior.ts === protectedWriter.ts) return true;
        continue;
      }
      return event.session_id === protectedWriter.session_id && event.ts === protectedWriter.ts;
    }
  } catch { /* absent/unreadable journal means no proof */ }
  return false;
}

/**
 * Append a `suppressed_write` line to the boot-writers journal: the write rung A1 HELD,
 * carrying a bounded structural status summary plus the reason. Free-form capability error
 * text is deliberately not retained in the append-only journal. The protected file's writer
 * identity is recorded so rung D can validate coherence after tail exhaustion or rotation.
 * Failure-tolerant like recordWrite (a journal error must never break the caller).
 *
 * NOTE for rung D: this line uses `file: 'boot-status.json'` (it IS about that file) but
 * carries `event: 'suppressed_write'`. It is not an actual write; D4 validates its
 * `protected_written_by` proof instead of treating the held candidate as the newest write.
 *
 * @param {string} stateDir   The OS state dir (_runs/os).
 * @param {string} file       The file whose write was held ('boot-status.json').
 * @param {object} writer     A deriveWriter() descriptor for the held write.
 * @param {object} heldStatus The full status object that would have been written.
 * @param {string} reason     Why it was held (from shouldSuppressWrite).
 * @param {object} protectedStatus The healthier on-disk status that remained protected.
 */
function recordSuppressedWrite(stateDir, file, writer, heldStatus, reason, protectedStatus) {
  try {
    const entry = {
      ts: (writer && writer.ts) ? writer.ts : new Date().toISOString(),
      file,
      event: 'suppressed_write',
      session_id: writer ? writer.session_id : 'unknown',
      pid: writer ? writer.pid : process.pid,
      entry: writer ? writer.entry : 'unknown',
      reason: reason == null ? '' : String(reason).slice(0, 512),
      held_overall: (heldStatus && heldStatus.overall) ? heldStatus.overall : '',
      held_status: summarizeHeldStatus(heldStatus),
    };
    const protectedWriter = protectedWriterOf(protectedStatus);
    if (protectedWriter) {
      entry.protected_written_by = protectedWriter;
      entry.protected_writer_verified = hasProtectedWriterProof(stateDir, protectedWriter);
    }
    if (writer && writer.surface) entry.surface = writer.surface;
    appendJsonl(path.join(stateDir, JOURNAL_FILE), entry, {
      maxBytes: JOURNAL_MAX_BYTES,
      maxRotated: JOURNAL_MAX_ROTATED,
    });
  } catch (err) {
    try {
      process.stderr.write(
        `[write-attribution] suppressed-write journal append failed: ${err && err.message ? err.message : err}\n`,
      );
    } catch { /* stderr unavailable — nothing more we can do */ }
  }
}

module.exports = {
  deriveWriter,
  recordWrite,
  readSessionMeta,
  shouldSuppressWrite,
  recordSuppressedWrite,
  VALID_ENTRIES,
  JOURNAL_FILE,
  DOWNGRADE_MAX_AGE_MS,
  OVERALL_RANK,
};
